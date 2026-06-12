/**
 * 联系人详情（iOS 风格详情页）的 LLM 管线：账号ID / IP属地 / 个性签名 / 联系记录。
 *
 * 设计要点（与用户确认过）：
 *  - 懒初始化：首次点开详情页才逐条生成（不在批量新增联系人后立刻打请求风暴）；
 *  - 后续更新：详情页手动「更新」按钮 + 心跳低频（HEARTBEAT_CONTACT_LOG_APPEND_RATE）追加；
 *  - 三类联系人（virtual_contact / agent / user）都生成；
 *  - 每条只喂「与该联系人对应的」素材：匹配到的关系/角色类 lore、提到 TA 的最近聊天、
 *    与 TA 的短信、与 TA 相关的邮件——任意一块缺失都优雅降级为（无）；
 *  - 年代/载体不做本地判断：世界观 lore 已在 prompt 里，让模型自己选联系载体
 *    （现代：面谈/电话/短信/微信；玄幻：灵鹤传书/傀儡传讯/符纸……）；
 *  - 防重复：prompt 端喂已有联系记录锚点（短摘要，不喂正文之外的东西）+
 *    store 端 dedupeContactLogCandidates 硬去重（归一化等值 + bigram 相似度）；
 *  - accountId 初始化一次后不变；ip/签名「通常不变」，变更时旧值进 history（store 层保证）。
 */

import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import { readXingyeRoleProfile } from './xingye-profile-store';
import { buildLoreContextForPhone, requestPhoneAi } from './xingye-phone-ai';
import {
  applyContactProfileAiUpdate,
  getContactProfile,
  getPhoneContacts,
  getSmsThread,
  initializeContactProfile,
  type XingyeContactLogEntryInput,
  type XingyeContactLogSource,
  type XingyeContactProfile,
  type XingyePhoneContactView,
} from './xingye-phone-store';
import { listLoreEntries, type XingyeLoreCategory } from './xingye-lore-store';
import { matchContactNamesToLore } from './xingye-contact-lore-link';
import { collectRecentContextForAgent } from './xingye-recent-context';
import { resolveXingyeSpeakerUserName } from './xingye-speaker-context';
import { listMailMessages } from './xingye-mail-store';

/** 与 xingye-contact-lore-link 的 IDENTITY_MATCH_LORE_CATEGORIES 同源：按名字对人只看这两类。 */
const PROFILE_LORE_CATEGORIES: ReadonlySet<XingyeLoreCategory> = new Set(['relationship', 'character']);

const MAX_MATCHED_LORE_ENTRIES = 4;
const MAX_MATCHED_LORE_CONTENT_CHARS = 400;
const MAX_CHAT_LINES = 10;
const MAX_SMS_LINES = 12;
const MAX_MAIL_LINES = 6;
const MAX_LOG_ANCHORS = 20;

const ACCOUNT_ID_MAX = 24;
const IP_MAX = 20;
const SIGNATURE_MAX = 60;
const CHANNEL_MAX = 14;
const WHEN_LABEL_MAX = 14;
const SUMMARY_MAX = 60;
const INIT_LOG_MAX = 8;

function clampText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return Array.from(trimmed).slice(0, max).join('');
}

function normalizeDirection(value: unknown): XingyeContactLogEntryInput['direction'] {
  return value === 'incoming' || value === 'outgoing' || value === 'mutual' ? value : 'mutual';
}

function normalizeLogEntries(value: unknown, max: number): XingyeContactLogEntryInput[] {
  if (!Array.isArray(value)) return [];
  const out: XingyeContactLogEntryInput[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const r = raw as Record<string, unknown>;
    const channel = clampText(r.channel, CHANNEL_MAX);
    const summary = clampText(r.summary, SUMMARY_MAX);
    if (!channel || !summary) continue;
    out.push({
      channel,
      direction: normalizeDirection(r.direction),
      whenLabel: clampText(r.whenLabel, WHEN_LABEL_MAX) ?? '',
      summary,
    });
    if (out.length >= max) break;
  }
  return out;
}

export type XingyeContactProfileInitResult = {
  accountId?: string;
  ipAddress?: string;
  signature?: string;
  contactLog: XingyeContactLogEntryInput[];
};

export function normalizeContactProfileInitResult(raw: unknown): XingyeContactProfileInitResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('解析失败：联系人详情返回不是对象');
  }
  const r = raw as Record<string, unknown>;
  const result: XingyeContactProfileInitResult = {
    accountId: clampText(r.accountId, ACCOUNT_ID_MAX),
    ipAddress: clampText(r.ipAddress, IP_MAX),
    signature: clampText(r.signature, SIGNATURE_MAX),
    contactLog: normalizeLogEntries(r.contactLog, INIT_LOG_MAX),
  };
  if (!result.accountId && !result.ipAddress && !result.signature && !result.contactLog.length) {
    throw new Error('解析失败：联系人详情返回没有任何可用字段');
  }
  return result;
}

export type XingyeContactProfileUpdateResult = {
  newContactLog: XingyeContactLogEntryInput[];
  ipAddress?: string;
  signature?: string;
  changeReason?: string;
};

export function normalizeContactProfileUpdateResult(raw: unknown, maxNewEntries: number): XingyeContactProfileUpdateResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('解析失败：联系记录更新返回不是对象');
  }
  const r = raw as Record<string, unknown>;
  return {
    newContactLog: normalizeLogEntries(r.newContactLog, maxNewEntries),
    ipAddress: clampText(r.ipAddress, IP_MAX),
    signature: clampText(r.signature, SIGNATURE_MAX),
    changeReason: clampText(r.changeReason, 120),
  };
}

// ---------------------------------------------------------------------------
// 素材采集（每个联系人只喂自己相关的；任何一块读不到都降级为空）
// ---------------------------------------------------------------------------

export type XingyeContactProfileSourceInputs = {
  matchedLore: { title: string; content: string }[];
  chatLines: string[];
  smsLines: string[];
  mailLines: string[];
};

function collectContactMatchNames(contact: XingyePhoneContactView, userName: string): string[] {
  const names = contact.targetType === 'user'
    ? [userName, '你']
    : [contact.remark, contact.displayName, contact.originalName];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = (raw ?? '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** 单字名包含匹配噪声太大，提及过滤只用 ≥2 字的名字（与 lore-link 的 MIN_MATCH_TOKEN_LENGTH 同理）。 */
function mentionNames(names: string[]): string[] {
  return names.filter(n => Array.from(n).length >= 2);
}

export async function collectContactProfileSourceInputs(params: {
  ownerAgentId: string;
  contact: XingyePhoneContactView;
  userName: string;
}): Promise<XingyeContactProfileSourceInputs> {
  const { ownerAgentId, contact, userName } = params;
  const names = collectContactMatchNames(contact, userName);

  let matchedLore: { title: string; content: string }[] = [];
  try {
    const loreEntries = listLoreEntries(ownerAgentId).filter(e => e.enabled && PROFILE_LORE_CATEGORIES.has(e.category));
    const matchedTitles = new Set(matchContactNamesToLore(names, loreEntries, MAX_MATCHED_LORE_ENTRIES));
    matchedLore = loreEntries
      .filter(e => matchedTitles.has(e.title))
      .slice(0, MAX_MATCHED_LORE_ENTRIES)
      .map(e => ({ title: e.title, content: Array.from(e.content).slice(0, MAX_MATCHED_LORE_CONTENT_CHARS).join('') }));
  } catch {
    matchedLore = [];
  }

  let chatLines: string[] = [];
  try {
    const recent = collectRecentContextForAgent({ agentId: ownerAgentId });
    const needles = mentionNames(names);
    const relevant = contact.targetType === 'user'
      ? recent.messages
      : recent.messages.filter(m => needles.some(n => m.content.includes(n)));
    chatLines = relevant.slice(-MAX_CHAT_LINES).map(m => {
      const speaker = m.role === 'user' ? userName : (m.role === 'assistant' ? 'TA' : m.role);
      return `${speaker}：${Array.from(m.content).slice(0, 120).join('')}`;
    });
  } catch {
    chatLines = [];
  }

  let smsLines: string[] = [];
  if (contact.targetType === 'agent' || contact.targetType === 'virtual_contact') {
    try {
      const thread = getSmsThread(ownerAgentId, contact.targetType, contact.targetId);
      smsLines = (thread?.messages ?? []).slice(-MAX_SMS_LINES).map(m => {
        const from = m.fromAgentId === ownerAgentId ? 'TA' : contact.remark;
        return `${from}：${Array.from(m.content).slice(0, 100).join('')}`;
      });
    } catch {
      smsLines = [];
    }
  }

  let mailLines: string[] = [];
  // user 条目不喂邮件：用户要求 user 的联系记录只由最近聊天 + lore 驱动（TA 的邮箱内容与 user 的往来无关）。
  if (contact.targetType === 'user') {
    return { matchedLore, chatLines, smsLines, mailLines };
  }
  try {
    const needles = mentionNames(names);
    const mails = await listMailMessages(ownerAgentId);
    const related = mails.filter(mail => {
      const fromName = mail.from?.name?.trim() ?? '';
      const toNames = (mail.to ?? []).map(t => t.name?.trim() ?? '');
      return needles.some(n => fromName.includes(n) || toNames.some(t => t.includes(n)));
    });
    related.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    mailLines = related.slice(0, MAX_MAIL_LINES).map(mail => {
      const snippet = (mail.snippet ?? mail.body ?? '').trim();
      return `《${mail.subject}》${Array.from(snippet).slice(0, 60).join('')}（${mail.from?.name ?? '?'}）`;
    });
  } catch {
    mailLines = [];
  }

  return { matchedLore, chatLines, smsLines, mailLines };
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function formatBlock(title: string, lines: string[]): string {
  return `【${title}】\n${lines.length ? lines.map(l => `- ${l}`).join('\n') : '（无）'}`;
}

function contactCardBlock(contact: XingyePhoneContactView, userName: string): string {
  const isUser = contact.targetType === 'user';
  const lines = [
    `- 备注：${contact.remark}${contact.originalName && contact.originalName !== contact.remark ? `（原名：${contact.originalName}）` : ''}`,
    isUser ? `- 这是 ${userName}（user 本人）在 TA 通讯录里的条目。` : `- 关系类型：${contact.kind ?? 'unknown'}${contact.relationshipHint ? `；关系线索：${contact.relationshipHint}` : ''}`,
    `- 标签：${(contact.tags ?? []).join('、') || '（无）'}；阵营：${contact.faction ?? '（无）'}；状态：${contact.status}`,
    `- TA 对其当前印象：${contact.impression}`,
  ];
  if (contact.shortBio?.trim()) lines.push(`- 简介：${contact.shortBio.trim()}`);
  return `【联系人卡片（TA 通讯录里的这个人）】\n${lines.join('\n')}`;
}

function sourceBlocks(inputs: XingyeContactProfileSourceInputs): string {
  return [
    formatBlock('与该联系人对应的关系/角色设定（如有；同一人按同一人写，勿打架）', inputs.matchedLore.map(e => `《${e.title}》${e.content}`)),
    formatBlock('最近聊天里与这个人相关的片段（如有）', inputs.chatLines),
    formatBlock('与这个人的短信往来（最近，如有）', inputs.smsLines),
    formatBlock('与这个人相关的邮件（最近，如有）', inputs.mailLines),
  ].join('\n\n');
}

const CHANNEL_GUIDE = [
  '- 粒度=「一次往来」：一通电话 / 一次会面 / 一段同主题的短信往来只记**一条**；同一话题的多轮消息严禁拆成多条，summary 用一句话概括整次往来的来龙去脉。',
  '- channel（联系载体）按上面的世界观/设定自行判断，不要混用时代：',
  '  现代背景可用：面谈 / 电话 / 短信 / 微信 / 邮件 / 视频通话；',
  '  古风、玄幻等非现代背景改用贴设定的方式：飞鸽传书 / 灵鹤传书 / 傀儡传讯 / 符纸 / 托梦 / 捎口信 / 当面拜访……（按 lore 选，名字可以自己起，2-6 字）。',
  '- direction：incoming=对方联系TA，outgoing=TA主动，mutual=面谈/相互往来。',
  '- whenLabel：口语时间标签（如「昨夜」「三天前」「上月」），从近到远。',
  '- summary：一行内容简介（≤40字），优先呼应上面给的聊天/短信/邮件素材；没有素材就按关系线索写合理的日常往来，不要凭空编重大事件。',
].join('\n');

const STATUS_GUIDE = '- 联系人状态为 blocked：联系记录应体现冷淡、冲突或拉黑前的收尾；deleted：记录更久远，像断联的旧关系，不要有近期热络。';

/** user 条目：TA 的手机没有与 user 的短信/邮件（素材采集也不喂），联系记录只能从最近聊天与设定来。 */
function userContactRule(contact: XingyePhoneContactView): string | null {
  if (contact.targetType !== 'user') return null;
  return '- 这位是 user 本人：联系记录**只能**依据上面的最近聊天与设定生成（TA 的手机没有与 user 的短信/邮件往来，不要虚构这两类）；没有依据就少写几条。';
}

export function buildContactProfileInitPrompt(params: {
  ownerAgent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  contact: XingyePhoneContactView;
  userName: string;
  loreContextText: string;
  inputs: XingyeContactProfileSourceInputs;
}): string {
  const { ownerAgent, ownerProfile, contact, userName, loreContextText, inputs } = params;
  const ownerName = ownerProfile?.displayName || ownerAgent.name;
  return [
    `你在为「${ownerName}」的小手机通讯录生成一位联系人的详情页数据（一切都是 ${ownerName} 视角、TA 手机里看到的样子）。`,
    contactCardBlock(contact, userName),
    loreContextText,
    sourceBlocks(inputs),
    '【要求】',
    [
      '- accountId：一个贴世界观的账号ID（现代≈微信号/手机号风格；古风玄幻≈名帖款识/符牌编号/传讯印记等），8-20 字符，生成一次后永不再变。',
      '- ipAddress：IP属地/所在之地（现代是省市；非现代用城邦/界域/山门等地名），2-12 字。',
      `- signature：这个人自己写的一句话个性签名（贴其人设与关系线索，≤40 字，不是 ${ownerName} 写的）。`,
      '- contactLog：3-6 条联系记录（类似通话记录），从近到远。',
      CHANNEL_GUIDE,
      STATUS_GUIDE,
      userContactRule(contact),
    ].filter(Boolean).join('\n'),
    '只输出 JSON（不要解释）：',
    '{"accountId":"...","ipAddress":"...","signature":"...","contactLog":[{"channel":"...","direction":"incoming|outgoing|mutual","whenLabel":"...","summary":"..."}]}',
  ].join('\n\n');
}

export function buildContactProfileUpdatePrompt(params: {
  ownerAgent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  contact: XingyePhoneContactView;
  profile: XingyeContactProfile;
  userName: string;
  loreContextText: string;
  inputs: XingyeContactProfileSourceInputs;
  maxNewEntries: number;
}): string {
  const { ownerAgent, ownerProfile, contact, profile, userName, loreContextText, inputs, maxNewEntries } = params;
  const ownerName = ownerProfile?.displayName || ownerAgent.name;
  const anchors = profile.contactLog.slice(0, MAX_LOG_ANCHORS).map(e => `${e.channel}｜${e.whenLabel}｜${e.summary}`);
  return [
    `你在为「${ownerName}」的小手机通讯录里这位联系人**追加**最近的联系记录（TA 视角）。`,
    contactCardBlock(contact, userName),
    loreContextText,
    [
      '【已有详情（锚点，仅供避免重复，勿照抄）】',
      `- 账号ID：${profile.accountId ?? '（无）'}（不可变）`,
      `- 当前IP属地：${profile.ipAddress ?? '（无）'}；当前个性签名：${profile.signature ?? '（无）'}`,
      formatBlock('已有联系记录（channel｜时间｜简介）', anchors),
    ].join('\n'),
    sourceBlocks(inputs),
    '【要求】',
    [
      `- 新增 1-${maxNewEntries} 条联系记录，必须是**新的往来**：不得与已有条目重复或主题高度相似；whenLabel 应比已有最近一条更近或合理交错。`,
      CHANNEL_GUIDE,
      STATUS_GUIDE,
      userContactRule(contact),
      '- ipAddress / signature 通常保持不变，省略即可；只有当新素材明确显示变动（搬家/换号/心境剧变）才返回新值，并在 changeReason 里说明一句。accountId 永不返回。',
    ].filter(Boolean).join('\n'),
    '只输出 JSON（不要解释）：',
    '{"newContactLog":[{"channel":"...","direction":"incoming|outgoing|mutual","whenLabel":"...","summary":"..."}],"ipAddress":"（可选）","signature":"（可选）","changeReason":"（可选）"}',
  ].join('\n\n');
}

// ---------------------------------------------------------------------------
// 流程
// ---------------------------------------------------------------------------

/** 懒初始化的双发守卫：同一联系人在途时复用同一个 Promise（store 的幂等是最后一道）。 */
const initInFlight = new Map<string, Promise<{ status: 'created' | 'already' }>>();

export async function ensureContactProfileInitializedWithAI(params: {
  ownerAgent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  contact: XingyePhoneContactView;
}): Promise<{ status: 'created' | 'already' }> {
  const { ownerAgent, ownerProfile, contact } = params;
  const key = `${ownerAgent.id}::${contact.targetType}::${contact.targetId}`;
  const existing = getContactProfile(ownerAgent.id, contact.targetType, contact.targetId);
  if (existing?.initializedAt) return { status: 'already' };
  const inFlight = initInFlight.get(key);
  if (inFlight) return inFlight;

  const run = (async () => {
    const userName = await resolveXingyeSpeakerUserName();
    const inputs = await collectContactProfileSourceInputs({ ownerAgentId: ownerAgent.id, contact, userName });
    const recentContext = collectRecentContextForAgent({ agentId: ownerAgent.id });
    const loreContextText = buildLoreContextForPhone({
      agentId: ownerAgent.id,
      purpose: 'phone_contacts',
      ownerProfile,
      contacts: [contact],
      recentContext,
    });
    const prompt = buildContactProfileInitPrompt({ ownerAgent, ownerProfile, contact, userName, loreContextText, inputs });
    const { raw } = await requestPhoneAi({
      kind: 'contact_profile_init',
      ownerAgentId: ownerAgent.id,
      ownerProfile,
      contacts: [contact],
      prompt,
      timeoutMs: 90_000,
    });
    const result = normalizeContactProfileInitResult(raw);
    initializeContactProfile(ownerAgent.id, contact.targetType, contact.targetId, result);
    return { status: 'created' as const };
  })().finally(() => {
    initInFlight.delete(key);
  });
  initInFlight.set(key, run);
  return run;
}

export async function updateContactProfileWithAI(params: {
  ownerAgent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  contact: XingyePhoneContactView;
  source?: XingyeContactLogSource;
  maxNewEntries?: number;
}): Promise<{ appended: number; droppedAsDuplicate: number; ipChanged: boolean; signatureChanged: boolean }> {
  const { ownerAgent, ownerProfile, contact } = params;
  const profile = getContactProfile(ownerAgent.id, contact.targetType, contact.targetId);
  if (!profile?.initializedAt) {
    throw new Error('详情还没初始化，请先打开详情页生成。');
  }
  const maxNewEntries = Math.max(1, Math.min(params.maxNewEntries ?? 3, 5));
  const userName = await resolveXingyeSpeakerUserName();
  const inputs = await collectContactProfileSourceInputs({ ownerAgentId: ownerAgent.id, contact, userName });
  const recentContext = collectRecentContextForAgent({ agentId: ownerAgent.id });
  const loreContextText = buildLoreContextForPhone({
    agentId: ownerAgent.id,
    purpose: 'phone_contacts',
    ownerProfile,
    contacts: [contact],
    recentContext,
  });
  const prompt = buildContactProfileUpdatePrompt({
    ownerAgent,
    ownerProfile,
    contact,
    profile,
    userName,
    loreContextText,
    inputs,
    maxNewEntries,
  });
  const { raw } = await requestPhoneAi({
    kind: 'contact_profile_update',
    ownerAgentId: ownerAgent.id,
    ownerProfile,
    contacts: [contact],
    prompt,
    timeoutMs: 90_000,
  });
  const result = normalizeContactProfileUpdateResult(raw, maxNewEntries);
  return applyContactProfileAiUpdate(ownerAgent.id, contact.targetType, contact.targetId, {
    ipAddress: result.ipAddress,
    signature: result.signature,
    newContactLog: result.newContactLog,
    source: params.source ?? 'manual_update',
  });
}

/**
 * 批量详情初始化：给所有还没有详情的联系人**串行**逐条生成（懒初始化的批量入口，
 * 解决"初始化后每个联系人都要点开等"的痛点）。
 * - 串行而非并发：8-16 条逐个打模型，避免请求风暴/限流；
 * - 已初始化的在入口处过滤掉（不计入 total）；单条失败计数后继续，不打断整批；
 * - shouldCancel 每条开始前检查，UI 的「停止」与组件卸载都靠它；
 * - 复用 ensureContactProfileInitializedWithAI：与点开详情页的懒初始化同一条路、同一套守卫。
 */
export async function batchInitializeContactProfilesWithAI(params: {
  ownerAgent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  contacts: XingyePhoneContactView[];
  /** done = 已处理条数；current = 正要处理的联系人（结束时以 null 收尾）。 */
  onProgress?: (done: number, total: number, current: XingyePhoneContactView | null) => void;
  shouldCancel?: () => boolean;
}): Promise<{ total: number; created: number; skipped: number; failed: number; cancelled: boolean }> {
  const { ownerAgent, ownerProfile } = params;
  const pendingList = params.contacts.filter(
    c => !getContactProfile(ownerAgent.id, c.targetType, c.targetId)?.initializedAt,
  );
  const total = pendingList.length;
  let created = 0;
  let skipped = 0;
  let failed = 0;
  let cancelled = false;
  let done = 0;
  for (const contact of pendingList) {
    if (params.shouldCancel?.()) {
      cancelled = true;
      break;
    }
    params.onProgress?.(done, total, contact);
    try {
      const result = await ensureContactProfileInitializedWithAI({ ownerAgent, ownerProfile, contact });
      if (result.status === 'created') created += 1;
      else skipped += 1;
    } catch (error) {
      failed += 1;
      console.warn('[xingye-contact-profile-ai] batch init failed for', contact.targetId, error);
    }
    done += 1;
  }
  params.onProgress?.(done, total, null);
  return { total, created, skipped, failed, cancelled };
}

export const HEARTBEAT_CONTACT_LOG_APPEND_RATE = 0.1;

/**
 * 心跳成功后调用：以低概率给一个已初始化详情的虚拟联系人追加一条联系记录，
 * 制造「TA 的社交在自己流动」的感觉。失败全部 swallow——这是 best-effort，
 * 不能影响心跳 UI（与 tryRelockHiddenFolderAfterHeartbeat 同模式）。
 */
export async function maybeAppendContactLogAfterHeartbeat(
  agent: Agent | null,
  options: { probability?: number; randomSource?: () => number } = {},
): Promise<{ appended: boolean }> {
  if (!agent?.id) return { appended: false };
  try {
    const random = options.randomSource ?? Math.random;
    const probability = options.probability ?? HEARTBEAT_CONTACT_LOG_APPEND_RATE;
    if (random() >= probability) return { appended: false };
    /** agents 传空数组：心跳侧只追加 virtual_contact，不需要 agent 联系人视图。 */
    const candidates = getPhoneContacts(agent.id, [], {})
      .filter(v => v.targetType === 'virtual_contact' && v.status === 'active')
      .filter(v => getContactProfile(agent.id, v.targetType, v.targetId)?.initializedAt);
    if (!candidates.length) return { appended: false };
    const pick = candidates[Math.floor(random() * candidates.length) % candidates.length];
    const ownerProfile = await readXingyeRoleProfile(agent.id);
    const result = await updateContactProfileWithAI({
      ownerAgent: agent,
      ownerProfile,
      contact: pick,
      source: 'heartbeat',
      maxNewEntries: 1,
    });
    return { appended: result.appended > 0 };
  } catch (error) {
    console.warn('[xingye-contact-profile-ai] heartbeat append failed:', error);
    return { appended: false };
  }
}
