/**
 * 小手机「报纸」模块 ·「往期新闻」时间线整理。
 *
 * 流程：
 *   1. extractWorldTimelineFromLore：把 agent 的 lore（lore-memory.md + always-on canonical 条目）
 *      丢给模型，整理出一组「世界 / 地区 / 重要 NPC」级别的事件。**禁止 agent-user 互动事件**。
 *   2. expandTimelineWithAI：当用户觉得事件数量不够时，让模型再补 N 条；
 *      已有事件会做为反重复锚点（不让模型重写已经在列表里的事件）。
 *
 * 故意不持久化：用户选择「每次都现整理」，不写入 storage；
 * lore 更新后下一次「整理」会自动跟上。
 *
 * 这里**只负责整理时间线**——把时间线灌给报纸生成端是 xingye-news-ai.ts 的事。
 */

import { hanaFetch } from '../hooks/use-hana-fetch';
import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import { XINGYE_LORE_CATEGORY_LABELS, listLoreEntries } from './xingye-lore-store';
import { getXingyePersistenceStorage } from './xingye-persistence';
import { postXingyeStorage } from './xingye-storage-api';

/** 事件的「波及范围」。决定生成时这条事件能撑起的版面（头版 vs 次条 vs 短讯）。 */
export type WorldTimelineScope = 'world' | 'region' | 'character';

export const WORLD_TIMELINE_SCOPES: readonly WorldTimelineScope[] = ['world', 'region', 'character'];

export const WORLD_TIMELINE_SCOPE_LABELS: Record<WorldTimelineScope, string> = {
  world: '世界级',
  region: '地区级',
  character: '角色 / NPC 级',
};

export type WorldTimelineEvent = {
  /** 列表本地唯一 id（增删用）。 */
  id: string;
  /**
   * 自由文本日期标签——「景和七年·秋」「2087-03-15」「魔法历 412 年」都可。
   * UI 不解析；只在 prompt 里照搬，让生成端在写 issueDate 之外保持世界观时间感。
   */
  dateLabel: string;
  /** 事件短标题，≤ 24 字。 */
  title: string;
  /** 一句话概述，≤ 80 字。 */
  summary: string;
  /** 波及范围。 */
  scope: WorldTimelineScope;
};

/** 单条事件字段上限。normalize 截断用，与 UI 输入限制保持一致。 */
const FIELD_LIMITS = {
  dateLabel: 32,
  title: 24,
  summary: 80,
} as const;

/** 模型最多一次返回多少条；防止失控。 */
const MAX_EVENTS_PER_CALL = 40;

/* ─────────────────────────────────────────────────────────────────────────────
   Lore 块：与 xingye-news-ai 同款，但这里**只**用 lore，不掺 recent / relationship。
───────────────────────────────────────────────────────────────────────────── */

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

function buildAlwaysOnLoreFallback(agentId: string, maxChars: number): string {
  try {
    const storage = getXingyePersistenceStorage();
    const entries = listLoreEntries(agentId, storage).filter(
      (e) => e.enabled && e.visibility === 'canonical' && e.insertionMode === 'always',
    );
    if (!entries.length) return '';
    const lines: string[] = [];
    let used = 0;
    for (const e of entries) {
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

/**
 * 把 agent 的「稳定 lore」拼一个尽量完整的块，喂给时间线提取器。
 *
 * 优先级：lore-memory.md > always-on canonical 条目。比生成报纸时给的额度
 * 略大（5000 字），因为时间线提取是"信息抽取"任务，越完整越好。
 */
async function buildTimelineLoreBlock(agentId: string): Promise<string> {
  const fromFile = await readLoreMemoryMarkdown(agentId);
  if (fromFile && fromFile.trim()) return truncateChars(fromFile, 5000);
  return buildAlwaysOnLoreFallback(agentId, 4500).trim();
}

/**
 * 拼 background 提示：给 obituary 那条「无感情线则不写」铁律用的判断材料。
 * 这里只回 profile 里 background / personality 字段拼起来的文本——
 * 模型读了之后能自己判断 agent 是否有"前任 / 前夫 / 前妻 / 已故亲人"这类感情线。
 */
function profileBackgroundForPrompt(profile: XingyeRoleProfile | null | undefined): string {
  if (!profile) return '';
  const parts = [
    profile.shortBio,
    profile.identitySummary,
    profile.backgroundSummary,
    profile.personalitySummary,
    profile.values,
  ].filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
  return parts.join('\n').trim();
}

/* ─────────────────────────────────────────────────────────────────────────────
   Prompt
───────────────────────────────────────────────────────────────────────────── */

function buildTimelineExtractPrompt(args: {
  agent: Pick<Agent, 'id' | 'name' | 'yuan'>;
  agentName: string;
  loreBlock: string;
  backgroundBlock: string;
  requestedCount: number;
}): string {
  const { agent, agentName, loreBlock, backgroundBlock, requestedCount } = args;

  // 给模型一个"目标条数"，但不强制——让它优先按 lore 实际素材量来。
  // 上限 MAX_EVENTS_PER_CALL，避免一次召回过多 token 浪费。
  const targetCount = Math.max(3, Math.min(MAX_EVENTS_PER_CALL, requestedCount));

  return [
    '你是星野模式「小手机报纸 · 往期」时间线整理器。只返回严格 JSON，不要 Markdown，不要解释。',
    '',
    '## 任务',
    `从下方 ${agentName} 的角色 lore 中，整理出**${agentName} 所在世界**已经发生过的事件，组成一个时间线。`,
    `请尽量整理出 **${targetCount} 条**事件（若 lore 信息不足以撑起这么多，宁可少返回也不要瞎编）。`,
    '',
    '## 必读铁律',
    `- 这是「世界时间线」，不是「${agentName} 个人感情日记」。事件应当是 ${agentName} 所处世界**已经发生过**的可被旁人记叙的事。`,
    `- **严禁**生成任何"${agentName} 与用户互动"的事件（约会 / 暧昧 / 吵架 / 牵手 / 一起做某事都不行）。`,
    '  这一类内容根本不属于报纸的世界时间线，是私人记忆，必须剔除。',
    `- 允许的事件：世界 / 国家 / 地区级大事；${agentName} 的亲朋好友 / 前同事 / 师门 / 重要 NPC 的事；`
    + `${agentName} 自己在世界中的某段早期经历（成长 / 转折 / 重大遭遇），但**不能**与用户挂钩。`,
    `- 关于 ${agentName} 已逝亲人 / 师长 / 旧友 / 前任的事件**只能在 lore 中确实写过的前提下**纳入；`
    + 'lore 没明写就不要凭空虚构感情对象。',
    '- 时间标签（dateLabel）请贴合该世界的纪年方式（古代用「景和七年·秋」「贞观三年」之类、'
    + '西幻用「魔法历 412 年」「第三纪 217 年」之类、现代用「2087-03-15」之类）；'
    + '若 lore 里没明写时间，可用「数年前」「TA 入门第一年」「事件 A 之后第二年」这类相对时间。',
    '- 同一事件不要拆成多条；不同事件不要合并成一条。',
    '',
    '## scope 字段判定',
    '- `world`：影响整个世界 / 国家 / 文明的事件（战争 / 政变 / 灾异 / 时代更迭）。',
    '- `region`：影响某个地区 / 城市 / 组织的事件（瘟疫 / 商路 / 派系冲突 / 重大建筑落成）。',
    `- \`character\`：与 ${agentName} 直接相关，或与某个**${agentName} 已知的 NPC** 相关的事件（NPC 的死亡 / 失踪 / 婚变 / 重要决定）。`,
    '- 一条事件 scope 选最匹配的一个；如果一条事件横跨多 scope，按"主要受影响层"判。',
    '',
    '## 当前角色',
    JSON.stringify({ id: agent.id, name: agent.name, yuan: agent.yuan }, null, 2),
    '',
    '## 角色 background / 性格（用来判断 TA 是否有可被纪念的感情线 / 旧关系）',
    backgroundBlock || '（无）',
    '',
    '## 角色 lore（**唯一**事件素材来源；不允许凭空虚构）',
    loreBlock || '（无）',
    '',
    '## 输出 JSON schema',
    JSON.stringify(
      {
        events: [
          {
            dateLabel: '紧贴世界观的时间标签，≤ 32 字',
            title: '事件标题，≤ 24 字',
            summary: '一句话概述，≤ 80 字',
            scope: 'world | region | character',
          },
        ],
      },
      null,
      2,
    ),
    '',
    '## 输出顺序',
    '- 按时间**升序**返回（从最早 → 最近）。',
    '',
    '## 收尾',
    '现在生成 JSON 对象本身。不要 ```json``` 围栏，不要解释文字。',
  ].join('\n');
}

function buildTimelineExpandPrompt(args: {
  agent: Pick<Agent, 'id' | 'name' | 'yuan'>;
  agentName: string;
  loreBlock: string;
  backgroundBlock: string;
  existing: WorldTimelineEvent[];
  neededExtra: number;
}): string {
  const { agent, agentName, loreBlock, backgroundBlock, existing, neededExtra } = args;
  const existingLines = existing.length
    ? existing.map((e) => `- [${WORLD_TIMELINE_SCOPE_LABELS[e.scope]}] ${e.dateLabel}｜${e.title}｜${e.summary}`).join('\n')
    : '（无）';
  const want = Math.max(1, Math.min(MAX_EVENTS_PER_CALL, neededExtra));
  return [
    '你是星野模式「小手机报纸 · 往期」时间线**补全**器。只返回严格 JSON，不要 Markdown，不要解释。',
    '',
    '## 任务',
    `刚刚从 lore 里整理出的时间线**不够多**，需要你额外补 **${want}** 条事件。`,
    `补的事件**必须**与下方"已有事件"在主题 / 时间 / 范围上**有差异**，不要重复同一个事件。`,
    '',
    '## 必读铁律（同首次整理）',
    `- 严禁与「用户」相关的互动事件。`,
    `- 优先从 ${agentName} 的 lore 现有素材中"展开细节"——例如 lore 提到「五年前北境战乱」，可以再写「战乱第二年春节，旧京失守」这种衍生事件。`,
    '- 若 lore 素材确实贫乏，可以按下方 lore **已经描绘出来的世界规则**做合理外推（"按世界观补全"），'
    + '但不要引入 lore 没暗示的新势力 / 新种族 / 新设定。',
    `- 关于 ${agentName} 已故亲人 / 前任 / 旧友的事件**只能在 lore 写过这个对象的前提下**纳入；不要凭空发明。`,
    '',
    '## 已有事件（请避免重复主题 / 重复时间点）',
    existingLines,
    '',
    '## 当前角色',
    JSON.stringify({ id: agent.id, name: agent.name, yuan: agent.yuan }, null, 2),
    '',
    '## 角色 background',
    backgroundBlock || '（无）',
    '',
    '## 角色 lore',
    loreBlock || '（无）',
    '',
    '## 输出 JSON schema',
    JSON.stringify(
      {
        events: [
          {
            dateLabel: '紧贴世界观的时间标签，≤ 32 字',
            title: '事件标题，≤ 24 字',
            summary: '一句话概述，≤ 80 字',
            scope: 'world | region | character',
          },
        ],
      },
      null,
      2,
    ),
    '',
    '## 收尾',
    `只输出新增的 ${want} 条事件本身（不要把已有事件复读回来）。JSON 对象本身，无围栏。`,
  ].join('\n');
}

/* ─────────────────────────────────────────────────────────────────────────────
   Normalize：模型返回 → WorldTimelineEvent[]
───────────────────────────────────────────────────────────────────────────── */

function makeEventId(): string {
  return `te_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function isScope(value: unknown): value is WorldTimelineScope {
  return typeof value === 'string'
    && (WORLD_TIMELINE_SCOPES as readonly string[]).includes(value);
}

function normalizeOneEvent(raw: unknown): WorldTimelineEvent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const dateLabel = typeof r.dateLabel === 'string' ? r.dateLabel.trim() : '';
  const title = typeof r.title === 'string' ? r.title.trim() : '';
  const summary = typeof r.summary === 'string' ? r.summary.trim() : '';
  if (!dateLabel || !title || !summary) return null;
  const scope: WorldTimelineScope = isScope(r.scope) ? r.scope : 'region';
  return {
    id: makeEventId(),
    dateLabel: truncateChars(dateLabel, FIELD_LIMITS.dateLabel),
    title: truncateChars(title, FIELD_LIMITS.title),
    summary: truncateChars(summary, FIELD_LIMITS.summary),
    scope,
  };
}

function normalizeEventsFromModelResult(raw: unknown, max: number): WorldTimelineEvent[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const r = raw as Record<string, unknown>;
  const arr = Array.isArray(r.events) ? r.events : Array.isArray(raw) ? (raw as unknown[]) : [];
  const out: WorldTimelineEvent[] = [];
  for (const item of arr) {
    const evt = normalizeOneEvent(item);
    if (!evt) continue;
    out.push(evt);
    if (out.length >= Math.max(1, Math.min(MAX_EVENTS_PER_CALL, max))) break;
  }
  return out;
}

/* ─────────────────────────────────────────────────────────────────────────────
   公开 API
───────────────────────────────────────────────────────────────────────────── */

export type ExtractWorldTimelineParams = {
  agent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  /** 期望整理出多少条事件（给模型的目标值；最终条数取决于 lore 素材量）。 */
  requestedCount: number;
  timeoutMs?: number;
};

/**
 * 从 agent 的 lore 中整理出一组世界时间线事件。
 * 返回 0 条不抛错（调用方判断「素材不足」并提示用户）。
 */
export async function extractWorldTimelineFromLore(
  params: ExtractWorldTimelineParams,
): Promise<WorldTimelineEvent[]> {
  const { agent, ownerProfile } = params;
  const timeoutMs = params.timeoutMs ?? 90_000;
  const agentName = ownerProfile?.displayName?.trim() || agent.name || '当前角色';
  const loreBlock = await buildTimelineLoreBlock(agent.id);
  const backgroundBlock = profileBackgroundForPrompt(ownerProfile);

  const prompt = buildTimelineExtractPrompt({
    agent,
    agentName,
    loreBlock,
    backgroundBlock,
    requestedCount: params.requestedCount,
  });

  // 调试落盘（与 news-ai 同款，单独文件名以免覆盖）。fire-and-forget。
  void postXingyeStorage({
    action: 'write',
    agentId: agent.id,
    relativePath: 'news/.debug/last-timeline-extract-prompt.txt',
    content: [
      `# 时间：${new Date().toISOString()}`,
      `# agentId：${agent.id}`,
      `# requestedCount：${params.requestedCount}`,
      '',
      '## prompt',
      prompt,
    ].join('\n'),
    encoding: 'utf8',
  }).catch(() => {});

  const response = await hanaFetch('/api/xingye/phone-generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeout: timeoutMs,
    body: JSON.stringify({
      kind: 'news_timeline_extract',
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
      ? `：${(data.details as { message?: string }[]).map((it) => it.message ?? '').join('；')}`
      : '';
    throw new Error(`${data?.error || '模型调用失败'}${details}`);
  }

  return normalizeEventsFromModelResult(data?.result, params.requestedCount);
}

export type ExpandTimelineParams = {
  agent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  existing: WorldTimelineEvent[];
  /** 还差几条；模型按此目标返回。 */
  neededExtra: number;
  timeoutMs?: number;
};

/**
 * 让模型再补 N 条事件。返回**新增**的事件列表（调用方自行 merge 到现有列表）。
 */
export async function expandTimelineWithAI(
  params: ExpandTimelineParams,
): Promise<WorldTimelineEvent[]> {
  const { agent, ownerProfile, existing, neededExtra } = params;
  const timeoutMs = params.timeoutMs ?? 90_000;
  if (neededExtra <= 0) return [];
  const agentName = ownerProfile?.displayName?.trim() || agent.name || '当前角色';
  const loreBlock = await buildTimelineLoreBlock(agent.id);
  const backgroundBlock = profileBackgroundForPrompt(ownerProfile);

  const prompt = buildTimelineExpandPrompt({
    agent,
    agentName,
    loreBlock,
    backgroundBlock,
    existing,
    neededExtra,
  });

  void postXingyeStorage({
    action: 'write',
    agentId: agent.id,
    relativePath: 'news/.debug/last-timeline-expand-prompt.txt',
    content: [
      `# 时间：${new Date().toISOString()}`,
      `# agentId：${agent.id}`,
      `# neededExtra：${neededExtra}`,
      `# existingCount：${existing.length}`,
      '',
      '## prompt',
      prompt,
    ].join('\n'),
    encoding: 'utf8',
  }).catch(() => {});

  const response = await hanaFetch('/api/xingye/phone-generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeout: timeoutMs,
    body: JSON.stringify({
      kind: 'news_timeline_extract',
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
      ? `：${(data.details as { message?: string }[]).map((it) => it.message ?? '').join('；')}`
      : '';
    throw new Error(`${data?.error || '模型调用失败'}${details}`);
  }
  return normalizeEventsFromModelResult(data?.result, neededExtra);
}

/* ─────────────────────────────────────────────────────────────────────────────
   工具：把时间线切成 N 期（每期挑若干事件喂给报纸生成端）
───────────────────────────────────────────────────────────────────────────── */

/**
 * 把已确认的时间线切成 issueCount 份。
 *
 * 切法：按时间顺序均匀切片——前面的事件分到"更早的那期"。
 * 每期至少 1 条；剩余 (total % issueCount) 条优先匀给前面的期。
 *
 * 例：events=[A,B,C,D,E,F,G,H,I,J]，issueCount=3 →
 *   期 1（最早）：A B C D
 *   期 2：E F G
 *   期 3（最近）：H I J
 *
 * 若 events.length === 0 返回 issueCount 个空数组（调用方应当在这之前已经
 * 用警告拦住用户，不会真的走到这里）。
 */
export function partitionTimelineForIssues(
  events: WorldTimelineEvent[],
  issueCount: number,
): WorldTimelineEvent[][] {
  const safeCount = Math.max(1, Math.floor(issueCount));
  const out: WorldTimelineEvent[][] = [];
  for (let i = 0; i < safeCount; i += 1) out.push([]);
  const total = events.length;
  if (total === 0) return out;
  const base = Math.floor(total / safeCount);
  const extra = total % safeCount;
  let cursor = 0;
  for (let i = 0; i < safeCount; i += 1) {
    const take = base + (i < extra ? 1 : 0);
    out[i] = events.slice(cursor, cursor + take);
    cursor += take;
  }
  return out;
}

/**
 * 算出每期对应的 issueDateIso。
 *
 * - daysBack 是"最早一期"距今的天数（最远）
 * - 把 daysBack 平均切成 issueCount 段，每期落到一个时间点上
 * - 期 0 最早（daysBack 天前），期 issueCount-1 最近（约 daysBack/issueCount 天前）
 *
 * 例：daysBack=30, issueCount=3 → [30天前, 20天前, 10天前]
 */
export function computeIssueDatesForBackfill(
  daysBack: number,
  issueCount: number,
  now: Date = new Date(),
): string[] {
  const safeDays = Math.max(1, Math.floor(daysBack));
  const safeCount = Math.max(1, Math.floor(issueCount));
  const step = safeDays / safeCount;
  const out: string[] = [];
  for (let i = 0; i < safeCount; i += 1) {
    // 期 0 最远；期 safeCount-1 最近
    const offsetDays = safeDays - i * step;
    const d = new Date(now.getTime() - offsetDays * 24 * 60 * 60 * 1000);
    out.push(d.toISOString());
  }
  return out;
}

/** 「不足时」需要的事件总数：UI 警告阈值 = issueCount × 3。 */
export const TIMELINE_EVENTS_PER_ISSUE_TARGET = 3;

export function computeTimelineShortfall(
  eventCount: number,
  issueCount: number,
): number {
  const target = Math.max(1, Math.floor(issueCount)) * TIMELINE_EVENTS_PER_ISSUE_TARGET;
  return Math.max(0, target - eventCount);
}
