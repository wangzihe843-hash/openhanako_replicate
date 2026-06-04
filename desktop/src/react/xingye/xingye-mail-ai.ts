import { hanaFetch } from '../hooks/use-hana-fetch';
import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import { peekDeskHeartbeatUiOutcome } from './xingye-desk-heartbeat-memory';
import {
  buildMailContinuityAnchorBlock,
  filterMailDraftsByDuplicates,
} from './xingye-mail-dedupe';
import {
  buildMailInitPrompt,
  MAIL_AI_FROM_KINDS,
  MAIL_AI_MAILBOXES,
  type XingyeMailAiFromKind,
  type XingyeMailAiMailbox,
} from './xingye-mail-prompts';
import {
  applyCategoryBoostOrder,
  buildXingyeLoreRuntimeQueryText,
  collectXingyeLoreRuntimeContext,
  formatXingyeLoreRuntimeContextBlock,
} from './xingye-lore-runtime-context';
import { XINGYE_LORE_CATEGORY_LABELS, listLoreEntries, type XingyeLoreCategory } from './xingye-lore-store';
import { getXingyePersistenceStorage } from './xingye-persistence';
import {
  collectRecentContextForAgent,
  describeRecentContextForPrompt,
} from './xingye-recent-context';
import {
  buildXingyeRecentChatExcerpts,
  formatXingyeRecentChatExcerptsForPrompt,
  resolveXingyeSpeakerUserName,
} from './xingye-speaker-context';
import { getRelationshipState } from './xingye-state-store';
import { postXingyeStorage } from './xingye-storage-api';
import { buildContactLoreHints } from './xingye-contact-lore-link';
import { listMailMessages, type XingyeMailMessageDraft } from './xingye-mail-store';

export type XingyeMailAiDraft = {
  mailbox: XingyeMailAiMailbox;
  from: { name: string; address: string; kind: XingyeMailAiFromKind };
  /** AI 指定的收件人；通常仅 sent / drafts 会用到。 */
  to?: { name: string; address: string }[];
  subject: string;
  body: string;
  /** 仅 drafts 邮件：agent 没把这封邮件发出的理由（一句话）。 */
  draftReason?: string;
  isRead: boolean;
  isStarred: boolean;
  autoStarred: boolean;
  labels: string[];
};

function truncateChars(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1))}…`;
}

async function readLoreMemoryMarkdown(agentId: string): Promise<string | null> {
  const aid = agentId.trim();
  if (!aid) return null;
  try {
    const data = (await postXingyeStorage({
      action: 'read',
      agentId: aid,
      relativePath: 'lore-memory.md',
      binary: false,
    })) as { missing?: boolean; content?: unknown };
    if (data?.missing || typeof data?.content !== 'string') return null;
    let text = data.content.trim();
    text = text.replace(/^<!--[\s\S]*?-->\s*/m, '').trim();
    return text || null;
  } catch {
    return null;
  }
}

function buildStableLoreFromAlwaysEntries(
  agentId: string,
  maxChars: number,
  boostCategories: ReadonlyArray<XingyeLoreCategory> = [],
): string {
  try {
    const storage = getXingyePersistenceStorage();
    const entries = listLoreEntries(agentId, storage).filter(
      (e) => e.enabled && e.visibility === 'canonical' && e.insertionMode === 'always',
    );
    if (!entries.length) return '';
    // boostCategories 命中的分类置顶后再按预算截断；不传则保持 listLoreEntries 的 priority/updatedAt 序。
    const ordered = applyCategoryBoostOrder(entries, boostCategories);
    const lines: string[] = [];
    let used = 0;
    for (const e of ordered) {
      const label = XINGYE_LORE_CATEGORY_LABELS[e.category] ?? e.category;
      const block = `- 《${e.title}》（${label}）\n${e.content.trim()}`;
      if (used + block.length > maxChars && lines.length > 0) break;
      lines.push(block);
      used += block.length + 2;
      if (used >= maxChars) break;
    }
    return lines.join('\n\n');
  } catch {
    return '';
  }
}

async function buildStableLoreBlock(
  agentId: string,
  boostCategories: ReadonlyArray<XingyeLoreCategory> = [],
): Promise<string> {
  const fromFile = await readLoreMemoryMarkdown(agentId);
  // markdown 形态是自由文本、无分类维度，无法提权——只能原样截断；提权仅作用于 always 条目回退路径。
  if (fromFile && fromFile.trim()) return truncateChars(fromFile, 3200);
  return buildStableLoreFromAlwaysEntries(agentId, 2800, boostCategories).trim();
}

function formatRelationshipBlock(agentId: string): string {
  try {
    const storage = getXingyePersistenceStorage();
    const state = getRelationshipState(agentId, storage);
    if (!state) return '';
    return JSON.stringify(
      {
        mood: state.mood,
        relationshipLabel: state.relationshipLabel,
        stateSummary: state.stateSummary,
        lastReason: state.lastReason,
        affection: state.affection,
        trust: state.trust,
      },
      null,
      2,
    );
  } catch {
    return '';
  }
}

function profilePartsForQuery(profile: XingyeRoleProfile | null | undefined): string[] {
  if (!profile) return [];
  return [
    profile.displayName,
    profile.shortBio,
    profile.identitySummary,
    profile.backgroundSummary,
    profile.personalitySummary,
    profile.relationshipLabel,
    profile.values,
    profile.taboos,
    profile.relationshipMode,
  ].filter((part): part is string => typeof part === 'string' && part.trim().length > 0);
}

function normalizeMailbox(value: unknown): XingyeMailAiMailbox | null {
  return (MAIL_AI_MAILBOXES as readonly string[]).includes(value as string)
    ? (value as XingyeMailAiMailbox)
    : null;
}

function normalizeFromKind(value: unknown, mailbox: XingyeMailAiMailbox): XingyeMailAiFromKind {
  if ((MAIL_AI_FROM_KINDS as readonly string[]).includes(value as string)) {
    return value as XingyeMailAiFromKind;
  }
  if (mailbox === 'promotions') return 'promotion';
  if (mailbox === 'spam') return 'spam';
  if (mailbox === 'sent' || mailbox === 'drafts') return 'agent';
  return 'virtual_contact';
}

function normalizeAiAddressList(value: unknown): { name: string; address: string }[] {
  if (!Array.isArray(value)) return [];
  const out: { name: string; address: string }[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const raw = item as Record<string, unknown>;
    const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 80) : '';
    const address = typeof raw.address === 'string' ? raw.address.trim().slice(0, 160) : '';
    if (!address) continue;
    out.push({ name: name || address, address });
    if (out.length >= 5) break;
  }
  return out;
}

function normalizeLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    out.push(trimmed.slice(0, 24));
    if (out.length >= 5) break;
  }
  return out;
}

function normalizeOneDraft(raw: unknown): XingyeMailAiDraft | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const mailbox = normalizeMailbox(record.mailbox);
  if (!mailbox) return null;
  const fromRaw = record.from && typeof record.from === 'object' && !Array.isArray(record.from)
    ? (record.from as Record<string, unknown>)
    : null;
  const fromName = typeof fromRaw?.name === 'string' ? fromRaw.name.trim().slice(0, 80) : '';
  const fromAddress = typeof fromRaw?.address === 'string' ? fromRaw.address.trim().slice(0, 160) : '';
  if (!fromAddress) return null;
  const subject = typeof record.subject === 'string' ? record.subject.trim().slice(0, 200) : '';
  const body = typeof record.body === 'string' ? record.body.trim().slice(0, 4000) : '';
  if (!subject && !body) return null;
  const toList = normalizeAiAddressList(record.to);
  const draftReasonRaw = typeof record.draftReason === 'string' ? record.draftReason.trim() : '';
  const draftReason = draftReasonRaw ? draftReasonRaw.slice(0, 120) : undefined;
  return {
    mailbox,
    from: {
      name: fromName || fromAddress,
      address: fromAddress,
      kind: normalizeFromKind(fromRaw?.kind, mailbox),
    },
    to: toList.length ? toList : undefined,
    subject: subject || '（无主题）',
    body,
    draftReason: mailbox === 'drafts' ? draftReason : undefined,
    isRead: Boolean(record.isRead),
    isStarred: Boolean(record.isStarred),
    autoStarred: Boolean(record.autoStarred),
    labels: normalizeLabels(record.labels),
  };
}

export function normalizeMailInitResult(raw: unknown): XingyeMailAiDraft[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { messages?: unknown }).messages)
      ? ((raw as { messages: unknown[] }).messages)
      : [];
  const out: XingyeMailAiDraft[] = [];
  for (const item of list) {
    const normalized = normalizeOneDraft(item);
    if (normalized) out.push(normalized);
    if (out.length >= 12) break;
  }
  return out;
}

/**
 * 调 `POST /api/xingye/phone-generate`（kind: mail_init），返回一份模拟历史邮件清单。
 *
 * 不写入邮箱存储，调用方负责把结果合并成 `XingyeMailMessageDraft[]` 写入。
 * 任意上下文（profile/lore/recent chat/heartbeat/relationship/contacts）缺失都会优雅降级为「（无）」。
 */
export async function generateMailInitDraftsWithAI(params: {
  agent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  ownerAddress: string;
  userName?: string;
  timeoutMs?: number;
}): Promise<XingyeMailAiDraft[]> {
  const { agent, ownerProfile, ownerAddress } = params;
  const timeoutMs = params.timeoutMs ?? 90_000;
  const userName = await resolveXingyeSpeakerUserName(params.userName);
  const agentName = ownerProfile?.displayName?.trim() || agent.name || '当前角色';

  // —— 共享上下文（两段生成共用，只算一次）——
  // 跨期反重复锚点的原料：拉已有邮箱 messages。listMailMessages 失败 → 空数组（不阻断；首次 init 也是空的）。
  // 锚点 block 不在此处统一构建——而是在 runPass 内按 scope 过滤后再构建，避免私人发件人/主题泄漏进 bulk 段。
  let existingMailMessages: Awaited<ReturnType<typeof listMailMessages>> = [];
  try {
    existingMailMessages = await listMailMessages(agent.id);
  } catch {
    existingMailMessages = [];
  }

  let recentContext;
  try {
    recentContext = collectRecentContextForAgent({ agentId: agent.id });
  } catch {
    recentContext = { messages: [], summaryText: '' } as unknown as ReturnType<typeof collectRecentContextForAgent>;
  }

  let recentSceneBlock = '';
  try {
    const recentChatExcerpts = buildXingyeRecentChatExcerpts({
      context: recentContext,
      userName,
      agentName,
    });
    recentSceneBlock =
      formatXingyeRecentChatExcerptsForPrompt(recentChatExcerpts) ||
      describeRecentContextForPrompt(recentContext);
  } catch {
    try {
      recentSceneBlock = describeRecentContextForPrompt(recentContext);
    } catch {
      recentSceneBlock = '';
    }
  }

  const relationshipBlock = formatRelationshipBlock(agent.id);
  const heartbeatLine = peekDeskHeartbeatUiOutcome(agent.id);
  const heartbeatBlock = heartbeatLine ? heartbeatLine.trim() : '';

  // 通讯录候选池：带昵称（remark/备注名优先）+ 印象 + 与设定库的身份对齐（loreAliases）。
  // buildContactLoreHints 内部已对读取失败优雅降级为空数组。
  const virtualContacts = buildContactLoreHints(agent.id);

  // —— 单段构造 + 调用 ——
  // personal（inbox/sent/drafts）吃 relationship 提权的 lore + 通讯录 + 关系状态；
  // bulk（promotions/spam）吃 worldview 提权的 lore，不喂私人关系/通讯录，硬隔离避免私人信息泄漏到垃圾/推广。
  const runPass = async (
    scope: 'personal' | 'bulk',
    boost: XingyeLoreCategory[],
  ): Promise<{ drafts: XingyeMailAiDraft[]; error?: Error }> => {
    try {
      const isPersonal = scope === 'personal';
      // 该 scope 允许的 mailbox：personal=私人三类，bulk=推广/垃圾两类。既用于过滤产物，也用于过滤锚点原料。
      const inScope = (mb: string): boolean =>
        isPersonal
          ? mb === 'inbox' || mb === 'sent' || mb === 'drafts'
          : mb === 'promotions' || mb === 'spam';
      // 跨期反重复锚点按 scope 隔离：bulk 段只看 promotions/spam 历史，不让私人发件人名/主题进它的 prompt。
      const continuityAnchorBlock = buildMailContinuityAnchorBlock(
        existingMailMessages.filter((m) => inScope(m.mailbox)),
      );
      const stableLoreBlock = await buildStableLoreBlock(agent.id, boost);
      const queryText = buildXingyeLoreRuntimeQueryText([
        ...profilePartsForQuery(ownerProfile ?? null),
        userName,
        agentName,
        typeof recentContext.summaryText === 'string' ? recentContext.summaryText : '',
        // personal 用关系/联系人帮 keyword 命中；bulk 不喂这些，靠世界观文本命中。
        isPersonal ? relationshipBlock : '',
        stableLoreBlock.slice(0, 2000),
        heartbeatLine ?? '',
        isPersonal ? virtualContacts.map((c) => c.displayName).join(' ') : '',
      ]);

      let keywordLoreBlock = '';
      try {
        const keywordCtx = collectXingyeLoreRuntimeContext(agent.id, {
          purpose: 'generic',
          queryText,
          maxChars: 2000,
          includeAlways: false,
          includeKeyword: true,
          priorityBoostCategories: boost,
        });
        keywordLoreBlock = formatXingyeLoreRuntimeContextBlock(keywordCtx);
      } catch {
        keywordLoreBlock = '';
      }

      const prompt = buildMailInitPrompt({
        agent,
        userName,
        profile: ownerProfile,
        ownerAddress,
        scope,
        virtualContacts: isPersonal ? virtualContacts : [],
        recentSceneBlock,
        stableLoreBlock,
        keywordLoreBlock,
        relationshipBlock: isPersonal ? relationshipBlock : '',
        heartbeatBlock,
        continuityAnchorBlock,
      });

      const response = await hanaFetch('/api/xingye/phone-generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        timeout: timeoutMs,
        body: JSON.stringify({
          kind: 'mail_init',
          ownerAgentId: agent.id,
          agentId: agent.id,
          prompt,
          timeoutMs,
        }),
      });

      let data: { ok?: boolean; error?: string; result?: unknown; details?: unknown };
      try {
        data = await response.json();
      } catch {
        throw new Error('解析服务器响应失败');
      }
      if (!response.ok || data?.ok === false || data?.error) {
        const details = Array.isArray(data?.details)
          ? `：${(data.details as { message?: string }[]).map((item) => item.message ?? '').join('；')}`
          : '';
        throw new Error(`${data?.error || '模型调用失败'}${details}`);
      }
      // scope 硬过滤：把模型越界生成的 mailbox（如 bulk 段吐出一封 inbox 私人邮件）丢弃，
      // 把 prompt 软指令升级为本地确定性兜底，与项目其它模块的后处理范式一致。
      const drafts = normalizeMailInitResult(data?.result).filter((d) => inScope(d.mailbox));
      return { drafts };
    } catch (err) {
      return { drafts: [], error: err instanceof Error ? err : new Error(String(err)) };
    }
  };

  // 两段独立、并行发起以缩短墙钟。
  const [personal, bulk] = await Promise.all([
    runPass('personal', ['relationship']),
    runPass('bulk', ['worldview']),
  ]);

  const normalized = [...personal.drafts, ...bulk.drafts];
  if (!normalized.length) {
    // 两段都没产出：抛可读错误（优先 personal——它是主内容）。
    throw personal.error ?? bulk.error ?? new Error('模型返回无效：未生成任何模拟邮件');
  }
  if (personal.error) {
    console.warn(`[xingye-mail-ai] 私人邮件生成失败，仅返回推广/垃圾：${personal.error.message}`);
  }
  if (bulk.error) {
    console.warn(`[xingye-mail-ai] 推广/垃圾邮件生成失败，仅返回私人邮件：${bulk.error.message}`);
  }

  // 后置硬过滤：anchor block 已经提示过模型按发件人换主题，但模型仍可能复读
  // 同一封 newsletter 主题、或批内自重复。两段合并后一起按 fromAddress 分桶比对主题，
  // 丢掉 exact_dup；similar 保留（避免把整批过滤光，邮件列表本来就允许相近主题）。
  const { kept, dropped } = filterMailDraftsByDuplicates(
    normalized.map((d) => ({
      from: { address: d.from.address, name: d.from.name },
      subject: d.subject,
      body: d.body,
      __original: d,
    })),
    existingMailMessages,
  );
  if (dropped.length > 0) {
    console.warn(
      `[xingye-mail-ai] 丢弃 ${dropped.length} 封与已有邮箱重复的草稿（同发件人 + 同/近主题）。`,
    );
  }
  const keptDrafts = kept.map((k) => k.__original);
  if (!keptDrafts.length) {
    // 全部都被判为 exact_dup 的极端情况：直接返回原列表，避免阻塞 init 流程。
    // anchor block 下一次会更严，模型应该会换主题；如果还不换，用户可以手动整理。
    return normalized;
  }
  return keptDrafts;
}

/**
 * 当 AI 失败或不可用时，提供一份本地降级的模拟历史邮件，确保 MVP 可用。
 */
export function buildFallbackMailDrafts(params: {
  ownerAddress: string;
  displayName: string;
}): XingyeMailAiDraft[] {
  const { ownerAddress, displayName } = params;
  const safeName = (displayName || 'TA').slice(0, 24);
  return [
    {
      mailbox: 'inbox',
      from: {
        name: '邮箱系统',
        address: `noreply@${ownerAddress.split('@')[1] || 'hana.mail'}`,
        kind: 'system',
      },
      subject: `欢迎使用 ${safeName} 的小手机邮箱`,
      body: [
        `你好 ${safeName}，`,
        '',
        '这是 TA 在小手机里启用的模拟邮箱：收件箱、发件箱、草稿箱、推广邮件与垃圾邮件都只是本地虚构数据，不会真的发送邮件，也不会连接 Gmail / Outlook 等真实邮件服务。',
        '',
        '你可以在这里查看历史邮件、手动星标、整理草稿；如果觉得列表空了，再生成一次「整理历史邮件」即可。',
        '',
        '—— 小手机邮箱',
      ].join('\n'),
      isRead: false,
      isStarred: false,
      autoStarred: true,
      labels: ['系统'],
    },
    {
      mailbox: 'promotions',
      from: {
        name: '生活方式小报',
        address: 'newsletter@promo.demo',
        kind: 'promotion',
      },
      subject: '本周精选 · 慢生活专题',
      body: [
        '本周我们整理了五个让晚间更舒缓的小习惯，包含一份可下载的纸质清单。',
        '',
        '订阅后每周日早上送达；不喜欢可在邮件底部退订。',
        '',
        '—— 生活方式小报',
      ].join('\n'),
      isRead: false,
      isStarred: false,
      autoStarred: false,
      labels: ['促销'],
    },
    {
      mailbox: 'spam',
      from: {
        name: '中奖通知',
        address: 'winner@spam.junk',
        kind: 'spam',
      },
      subject: '【恭喜】您的账户被随机抽中',
      body: [
        '尊敬的用户：',
        '',
        '您被随机抽中获得限时礼包，请尽快点击链接完成身份核验，否则名额将转让他人。',
        '',
        '（这看起来像一封钓鱼邮件，请勿回复。）',
      ].join('\n'),
      isRead: false,
      isStarred: false,
      autoStarred: false,
      labels: ['垃圾'],
    },
    {
      mailbox: 'drafts',
      from: {
        name: safeName,
        address: ownerAddress,
        kind: 'agent',
      },
      to: [{ name: '一个还没敢发的人', address: 'someone@hana.mail' }],
      subject: '（写了又没发）那天的事',
      body: [
        '其实那天我有点想找你聊聊，',
        '只是话到嘴边又咽回去了——怕显得我反应过度，又怕不说会一直堵在心里。',
        '',
        '先写在这里好了，等真的想清楚再决定要不要发。',
      ].join('\n'),
      draftReason: '写完又怕显得太黏，没敢发',
      isRead: true,
      isStarred: false,
      autoStarred: false,
      labels: ['未发出'],
    },
  ];
}

/**
 * 把 AI 返回的 draft 列表转成可写入存储的 `XingyeMailMessageDraft[]`。
 *
 * - inbox / promotions / spam：收件人统一填为 owner (recipient)，from 用 AI 输出。
 * - sent：from 由 owner 覆盖，to 用 AI 指定的虚拟收件人，缺失则填本人备份地址。
 * - drafts：from 由 owner 覆盖，to 用 AI 指定的虚拟收件人；draftReason 作为正文开头的引言保留，
 *   并加上「未发出」标签，方便 UI 区分。
 */
export function toMailMessageDrafts(
  drafts: XingyeMailAiDraft[],
  recipient: { name: string; address: string },
): XingyeMailMessageDraft[] {
  return drafts.map((d) => {
    const ownerFrom = { name: recipient.name, address: recipient.address, kind: 'agent' as const };
    if (d.mailbox === 'drafts') {
      const aiTo = d.to?.length ? d.to : [];
      const reason = d.draftReason?.trim();
      const body = reason ? `（未发出 · ${reason}）\n\n${d.body}` : d.body;
      const labels = Array.from(new Set([...(d.labels ?? []), '未发出'])).slice(0, 5);
      return {
        mailbox: 'drafts',
        from: ownerFrom,
        to: aiTo,
        subject: d.subject,
        body,
        isRead: true,
        isStarred: d.isStarred,
        autoStarred: false,
        labels,
        source: 'mail_init',
      } satisfies XingyeMailMessageDraft;
    }
    if (d.mailbox === 'sent') {
      const aiTo = d.to?.length ? d.to : [{ name: recipient.name, address: recipient.address }];
      return {
        mailbox: 'sent',
        from: ownerFrom,
        to: aiTo,
        subject: d.subject,
        body: d.body,
        isRead: true,
        isStarred: d.isStarred,
        autoStarred: d.autoStarred,
        labels: d.labels,
        source: 'mail_init',
      } satisfies XingyeMailMessageDraft;
    }
    return {
      mailbox: d.mailbox,
      from: d.from,
      to: [{ name: recipient.name, address: recipient.address }],
      subject: d.subject,
      body: d.body,
      isRead: d.isRead,
      isStarred: d.isStarred,
      autoStarred: d.autoStarred,
      labels: d.labels,
      source: 'mail_init',
    } satisfies XingyeMailMessageDraft;
  });
}
