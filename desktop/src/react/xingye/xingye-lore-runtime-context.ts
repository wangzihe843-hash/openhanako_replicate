/**
 * xingye-lore-runtime-context.ts — Runtime-only Xingye lore (设定库) context helper.
 *
 * 用途：在生成小手机 / 秘密空间分类 AI 等输出时，按需把"星野设定库"里
 *      `enabled === true` && `visibility === "canonical"` 的条目挑选出来，
 *      作为 prompt 段落参考，不写入 identity/ishiki，不写入任何持久层。
 *
 * 约束（与设计文档一致）：
 * - 只读 lore-store，且仅读传入 agentId 自身的条目。
 * - `always` 条目：默认包含（可通过 includeAlways=false 关闭）。
 * - `keyword` 条目：默认包含（可通过 includeKeyword=false 关闭），并且 keywords 须命中
 *   `options.queryText` 或 `options.keywords`（大小写不敏感；中文用普通 substring）。
 * - `manual` 条目：永远不自动包含。
 * - 排序：`priority` 高的优先；同 priority 时 `updatedAt` 新的优先。
 * - `maxChars` 默认 2000。超额：跳过剩余条目；不进行无界拼接。
 * - 不使用正则；不递归激活；不做向量检索。
 * - `purpose` 仅做记录/调试用途，不做复杂分支。
 */

import { getXingyePersistenceStorage } from './xingye-persistence';
import {
  XINGYE_LORE_CATEGORY_LABELS,
  listLoreEntries,
  type XingyeLoreCategory,
  type XingyeLoreEntry,
} from './xingye-lore-store';

/**
 * Purpose 枚举：`phone_*`、`relationship_state` 已用于对应链路；`secret_space_*` 由
 * `xingye-secret-space-ai-context.buildSecretSpaceLoreRuntimeOptions` 传入；`journal_draft` 用于
 * 小手机日记草稿的 keyword 命中检索。仅供调试/记录（不在 lore-store 内分支）。
 */
export type XingyeLoreRuntimeContextPurpose =
  | 'phone_contacts'
  | 'phone_sms'
  /** 梦境类秘密空间生成（lore 运行时 keyword 查询等） */
  | 'secret_space_dream'
  /** 草稿回复类秘密空间生成 */
  | 'secret_space_draft_reply'
  /** 未发送朋友圈草稿类秘密空间生成 */
  | 'secret_space_unsent_moment'
  /** 收藏摘录类秘密空间生成 */
  | 'secret_space_saved_item'
  /** 记忆碎片 lore 用途（与普通 JSONL 生成分开；记忆候选见 memory-candidate-store） */
  | 'secret_space_memory_fragment'
  | 'relationship_state'
  /** 小手机日记草稿：仅 keyword 命中设定（与 stable 块分离） */
  | 'journal_draft'
  | 'generic';

export type XingyeLoreRuntimeContextOptions = {
  purpose?: XingyeLoreRuntimeContextPurpose;
  queryText?: string;
  keywords?: string[];
  maxChars?: number;
  includeAlways?: boolean;
  includeKeyword?: boolean;
};

export type XingyeLoreRuntimeContextEntry = {
  id: string;
  title: string;
  category: XingyeLoreCategory;
  content: string;
  /** 哪些 keyword 命中触发了本条；`always` 模式为空数组 */
  matchedKeywords: string[];
  /** 命中原因：`always` 或 `keyword` */
  reason: 'always' | 'keyword';
  priority: number;
  updatedAt: string;
};

export type XingyeLoreRuntimeContext = {
  agentId: string;
  purpose: XingyeLoreRuntimeContextPurpose;
  entries: XingyeLoreRuntimeContextEntry[];
  /** 已选入 entries 的总字符数（仅算 formatted block 主体） */
  totalChars: number;
  /** 是否因 maxChars 超限而丢弃了至少一条候选 */
  truncated: boolean;
  /** 候选总数（在 maxChars 截断之前，符合规则的全部条目数） */
  candidateCount: number;
};

const DEFAULT_MAX_CHARS = 2_000;

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function normalizeKeyword(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.toLowerCase();
}

function collectMatchedKeywords(
  entryKeywords: ReadonlyArray<string>,
  queryText: string,
  explicitKeywords: ReadonlyArray<string>,
): string[] {
  if (!entryKeywords.length) return [];
  const haystack = queryText.toLowerCase();
  const explicit = new Set(
    explicitKeywords
      .map((k) => normalizeKeyword(k))
      .filter((k): k is string => !!k),
  );
  const matched: string[] = [];
  for (const raw of entryKeywords) {
    const lk = normalizeKeyword(raw);
    if (!lk) continue;
    if (explicit.has(lk)) {
      matched.push(raw);
      continue;
    }
    if (haystack && haystack.includes(lk)) {
      matched.push(raw);
    }
  }
  return matched;
}

/**
 * 将多段输入（owner profile / 最近对话摘要 / 短信摘要 / contact 字段 / 变更原因等）
 * 拼成一段空白归一化、去重的 query 文本，供 `queryText` 使用。
 */
export function buildXingyeLoreRuntimeQueryText(
  parts: ReadonlyArray<string | null | undefined>,
): string {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const part of parts) {
    if (typeof part !== 'string') continue;
    const cleaned = part.replace(/\s+/g, ' ').trim();
    if (!cleaned) continue;
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    tokens.push(cleaned);
  }
  return tokens.join(' ');
}

function formatEntryBlock(entry: XingyeLoreRuntimeContextEntry): string {
  const label = XINGYE_LORE_CATEGORY_LABELS[entry.category] ?? entry.category;
  return `- 标题：${entry.title}\n  分类：${label}\n  内容：${entry.content}`;
}

function toCandidate(entry: XingyeLoreEntry, reason: 'always' | 'keyword', matchedKeywords: string[]): XingyeLoreRuntimeContextEntry {
  return {
    id: entry.id,
    title: entry.title,
    category: entry.category,
    content: entry.content,
    matchedKeywords,
    reason,
    priority: entry.priority,
    updatedAt: entry.updatedAt,
  };
}

export function collectXingyeLoreRuntimeContext(
  agentId: string | null | undefined,
  options: XingyeLoreRuntimeContextOptions = {},
  storage: StorageLike | null = getXingyePersistenceStorage(),
): XingyeLoreRuntimeContext {
  const purpose: XingyeLoreRuntimeContextPurpose = options.purpose ?? 'generic';
  const maxChars = Math.max(0, Math.floor(options.maxChars ?? DEFAULT_MAX_CHARS));
  const includeAlways = options.includeAlways !== false;
  const includeKeyword = options.includeKeyword !== false;
  const queryText = typeof options.queryText === 'string' ? options.queryText : '';
  const explicitKeywords = Array.isArray(options.keywords)
    ? options.keywords.filter((value): value is string => typeof value === 'string' && !!value.trim())
    : [];

  const result: XingyeLoreRuntimeContext = {
    agentId: typeof agentId === 'string' ? agentId : '',
    purpose,
    entries: [],
    totalChars: 0,
    truncated: false,
    candidateCount: 0,
  };

  if (!agentId) return result;

  /** listLoreEntries 已按 priority desc / updatedAt desc 排序，符合本模块对 always 与 keyword 共同排序的要求。 */
  const all = listLoreEntries(agentId, storage);
  if (!all.length) return result;

  const candidates: XingyeLoreRuntimeContextEntry[] = [];
  for (const entry of all) {
    if (!entry.enabled) continue;
    if (entry.visibility !== 'canonical') continue;
    if (entry.insertionMode === 'manual') continue;

    if (entry.insertionMode === 'always') {
      if (!includeAlways) continue;
      candidates.push(toCandidate(entry, 'always', []));
      continue;
    }
    if (entry.insertionMode === 'keyword') {
      if (!includeKeyword) continue;
      const matched = collectMatchedKeywords(entry.keywords, queryText, explicitKeywords);
      if (!matched.length) continue;
      candidates.push(toCandidate(entry, 'keyword', matched));
    }
  }

  result.candidateCount = candidates.length;

  let total = 0;
  for (const candidate of candidates) {
    const blockText = formatEntryBlock(candidate);
    const blockLength = blockText.length;
    if (total + blockLength > maxChars) {
      result.truncated = true;
      continue;
    }
    result.entries.push(candidate);
    total += blockLength;
  }
  result.totalChars = total;
  return result;
}

/**
 * 渲染成可塞入 prompt 的 `【星野设定参考】` 段落。
 * 没有任何条目时返回空字符串（调用方据此判断是否插入这一段）。
 */
export function formatXingyeLoreRuntimeContextBlock(
  context: XingyeLoreRuntimeContext | null | undefined,
): string {
  if (!context || !context.entries.length) return '';
  const body = context.entries.map(formatEntryBlock).join('\n');
  return `【星野设定参考】\n${body}`;
}
