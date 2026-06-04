import { hanaFetch } from '../hooks/use-hana-fetch';
import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import {
  folderBoostCategories,
  formatRelationshipBlock,
  normalizeOptional,
  normalizeTags,
  truncateChars,
} from './xingye-files-ai';
import {
  buildContactLoreHints,
  formatContactLoreSection,
  type XingyeContactLoreHint,
} from './xingye-contact-lore-link';
import {
  appendFileDraft,
  appendFileEntry,
  DuplicateFileEntryError,
  resolveFolderIdFromHint,
  resolveTargetEntry,
  type XingyeFileEntry,
  type XingyeFileFolder,
  type XingyePendingFileDraft,
} from './xingye-files-store';
import {
  detectCrossFolderDuplicate,
  detectFilesDuplicate,
  normalizeTitleForDedup,
  type CrossFolderDedupEntry,
} from './xingye-files-dedupe';
import {
  buildFilesBatchAddEntryPrompt,
  buildFilesBatchPlanPrompt,
  buildFilesBatchUpdateEntryPrompt,
  buildFilesInitEntryPrompt,
  buildFilesInitPlanPrompt,
  formatLoreCatalogBlock,
  formatSelectedLoreBlock,
  type FilesLoreCatalogItem,
  type FilesPlanExistingEntry,
  type FilesPlanFolderHint,
  type FilesSelectedLoreItem,
} from './xingye-files-batch-prompts';
import { XINGYE_LORE_CATEGORY_LABELS, listLoreEntries } from './xingye-lore-store';
import { getXingyePersistenceStorage } from './xingye-persistence';
import { collectRecentContextForAgent } from './xingye-recent-context';
import { buildXingyeRecentChatExcerpts, resolveXingyeSpeakerUserName } from './xingye-speaker-context';

/** lore 目录条目：精简字段外发给 Phase-1，content 仅本地留存供 Phase-2 取用。 */
export type FilesLoreCatalogEntry = {
  id: string;
  title: string;
  categoryLabel: string;
  keywords: string[];
  content: string;
};

export type FilesInitPlanItem = {
  folderName: string;
  title: string;
  focus: string;
  loreIds: string[];
};

export type FilesBatchPlanItem = {
  folderName: string;
  title: string;
  focus: string;
  loreIds: string[];
  chatRefs: number[];
  action: 'add' | 'update';
  targetTitle?: string;
};

export type FilesEntryAddResult = { title: string; body: string; summary?: string; tags?: string[] };
export type FilesEntryUpdateResult = { bodyAppend: string; summary?: string; tags?: string[] };

export type FilesBatchSummary = {
  created: number;
  skipped: number;
  failed: number;
  /** 规划产出的有效条目数超过本轮 maxItems 上限、被截断未执行的条数（>0 时 UI 提示可再点一次续跑）。 */
  truncated: number;
};

const DEFAULT_PLAN_TIMEOUT_MS = 90_000;
const DEFAULT_ENTRY_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_ITEMS = 15;
const ENTRY_CONCURRENCY = 3;

// ─────────────────────────────────────────────────────────────────────────
//  共享：phone-generate 调用 + lore 目录
// ─────────────────────────────────────────────────────────────────────────

async function postPhoneGenerate(params: {
  kind: string;
  agentId: string;
  prompt: string;
  timeoutMs: number;
}): Promise<unknown> {
  const response = await hanaFetch('/api/xingye/phone-generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeout: params.timeoutMs,
    body: JSON.stringify({
      kind: params.kind,
      ownerAgentId: params.agentId,
      agentId: params.agentId,
      prompt: params.prompt,
      timeoutMs: params.timeoutMs,
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
  return data?.result;
}

/**
 * 建 lore 目录：enabled + canonical 的全部条目（含 manual——这是用户主动「挖 lore
 * 进资料柜」，不走运行期注入的三态规则）。content 留在本地 Map 供 Phase-2 取用，
 * Phase-1 只外发标题/分类/关键词。任何失败返回 []（空目录由调用方早退处理）。
 */
export function buildFilesLoreCatalog(agentId: string): FilesLoreCatalogEntry[] {
  try {
    const storage = getXingyePersistenceStorage();
    return listLoreEntries(agentId, storage)
      .filter((e) => e.enabled && e.visibility === 'canonical')
      .map((e) => ({
        id: e.id,
        title: e.title,
        categoryLabel: XINGYE_LORE_CATEGORY_LABELS[e.category] ?? e.category,
        keywords: Array.isArray(e.keywords) ? e.keywords : [],
        content: e.content,
      }));
  } catch {
    return [];
  }
}

function toCatalogItems(catalog: FilesLoreCatalogEntry[]): FilesLoreCatalogItem[] {
  return catalog.map((c) => ({ id: c.id, title: c.title, categoryLabel: c.categoryLabel, keywords: c.keywords }));
}

function selectLore(loreById: Map<string, FilesLoreCatalogEntry>, ids: string[]): FilesSelectedLoreItem[] {
  const out: FilesSelectedLoreItem[] = [];
  for (const id of ids) {
    const e = loreById.get(id);
    if (e) out.push({ title: e.title, categoryLabel: e.categoryLabel, content: e.content });
  }
  return out;
}

function toExistingPlanEntries(
  entries: XingyeFileEntry[],
  folders: XingyeFileFolder[],
): FilesPlanExistingEntry[] {
  const nameOf = (id: string) => folders.find((f) => f.id === id)?.name ?? '（其它）';
  return entries.slice(0, 40).map((e) => ({ folderName: nameOf(e.folderId), title: e.title, summary: e.summary }));
}

/** 该文件夹是否属于「人际关系 / 关于 user」等关系类——决定要不要给 Phase-2 正文喂通讯录。 */
function isRelationshipFolderName(folderName: string): boolean {
  return folderBoostCategories({ name: folderName }).includes('relationship');
}

// ─────────────────────────────────────────────────────────────────────────
//  归一（导出供测试）
// ─────────────────────────────────────────────────────────────────────────

function extractItemsArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object' && Array.isArray((raw as { items?: unknown }).items)) {
    return (raw as { items: unknown[] }).items;
  }
  return [];
}

function normStr(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

function normalizeLoreIds(value: unknown, idSet: Set<string>, max = 4): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (!id || !idSet.has(id) || out.includes(id)) continue;
    out.push(id);
    if (out.length >= max) break;
  }
  return out;
}

function normalizeChatRefs(value: unknown, count: number, max = 6): number[] {
  if (!Array.isArray(value) || count <= 0) return [];
  const out: number[] = [];
  for (const item of value) {
    const n = typeof item === 'number' ? Math.floor(item) : Number.parseInt(String(item), 10);
    if (!Number.isFinite(n) || n < 0 || n >= count || out.includes(n)) continue;
    out.push(n);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 归一不再「break 即丢」：先收齐全部合法条目，再按 maxItems 截断，并把被截掉的条数
 * （`truncated`）一并返回，让调用方能向用户「可见地」报告还有多少没整理（可再点一次续跑）。
 * 注意 truncated 只数**合法**条目的超额部分——因格式无效被丢的条目不计入。
 */
export function normalizeFilesInitPlan(
  raw: unknown,
  catalog: FilesLoreCatalogEntry[],
  maxItems = DEFAULT_MAX_ITEMS,
): { items: FilesInitPlanItem[]; truncated: number } {
  const idSet = new Set(catalog.map((c) => c.id));
  const valid: FilesInitPlanItem[] = [];
  for (const item of extractItemsArray(raw)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const r = item as Record<string, unknown>;
    const folderName = normStr(r.folderName, 80);
    const title = normStr(r.title, 160);
    if (!folderName || !title) continue;
    const loreIds = normalizeLoreIds(r.loreIds, idSet, 4);
    if (!loreIds.length) continue; // init 必须 lore-grounded，无有效 loreId 就丢
    valid.push({ folderName, title, focus: normStr(r.focus, 200), loreIds });
  }
  const items = valid.slice(0, Math.max(0, maxItems));
  return { items, truncated: valid.length - items.length };
}

export function normalizeFilesBatchPlan(
  raw: unknown,
  catalog: FilesLoreCatalogEntry[],
  recentChatCount: number,
  maxItems = DEFAULT_MAX_ITEMS,
): { items: FilesBatchPlanItem[]; truncated: number } {
  const idSet = new Set(catalog.map((c) => c.id));
  const valid: FilesBatchPlanItem[] = [];
  for (const item of extractItemsArray(raw)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const r = item as Record<string, unknown>;
    const folderName = normStr(r.folderName, 80);
    const title = normStr(r.title, 160);
    if (!folderName || !title) continue;
    const loreIds = normalizeLoreIds(r.loreIds, idSet, 4);
    const chatRefs = normalizeChatRefs(r.chatRefs, recentChatCount, 6);
    if (!loreIds.length && !chatRefs.length) continue; // 至少要一个来源
    const targetTitle = normStr(r.targetTitle, 160);
    // update 缺 targetTitle 时退化成 add（仍是合法的新增草稿，比直接丢更不浪费）
    const action: 'add' | 'update' = r.action === 'update' && targetTitle ? 'update' : 'add';
    valid.push({
      folderName,
      title,
      focus: normStr(r.focus, 200),
      loreIds,
      chatRefs,
      action,
      targetTitle: action === 'update' ? targetTitle : undefined,
    });
  }
  const items = valid.slice(0, Math.max(0, maxItems));
  return { items, truncated: valid.length - items.length };
}

export function normalizeFilesEntryResult(raw: unknown): FilesEntryAddResult | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const title = typeof r.title === 'string' ? r.title.trim() : '';
  const body = typeof r.body === 'string' ? r.body.trim() : '';
  if (!title || !body) return null;
  return {
    title: truncateChars(title, 160),
    body: truncateChars(body, 2000),
    summary: normalizeOptional(r.summary, 240),
    tags: normalizeTags(r.tags),
  };
}

export function normalizeFilesEntryUpdateResult(raw: unknown): FilesEntryUpdateResult | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const bodyAppend = typeof r.bodyAppend === 'string' ? r.bodyAppend.trim() : '';
  if (!bodyAppend) return null;
  return {
    bodyAppend: truncateChars(bodyAppend, 2000),
    summary: normalizeOptional(r.summary, 240),
    tags: normalizeTags(r.tags),
  };
}

// ─────────────────────────────────────────────────────────────────────────
//  Phase 1 — 规划调用
// ─────────────────────────────────────────────────────────────────────────

export async function planFilesInitWithAI(params: {
  agent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  catalog: FilesLoreCatalogEntry[];
  folderOptions: FilesPlanFolderHint[];
  existingEntries: FilesPlanExistingEntry[];
  /** 通讯录候选池（让规划器按真人规划人际类条目，并与设定库做身份去重）。 */
  contacts?: XingyeContactLoreHint[];
  maxItems?: number;
  userName?: string;
  timeoutMs?: number;
}): Promise<{ items: FilesInitPlanItem[]; truncated: number }> {
  const maxItems = params.maxItems ?? DEFAULT_MAX_ITEMS;
  const timeoutMs = params.timeoutMs ?? DEFAULT_PLAN_TIMEOUT_MS;
  const userName = await resolveXingyeSpeakerUserName(params.userName);
  const prompt = buildFilesInitPlanPrompt({
    agent: params.agent,
    userName,
    profile: params.ownerProfile,
    loreCatalogBlock: formatLoreCatalogBlock(toCatalogItems(params.catalog)),
    folderOptions: params.folderOptions,
    existingEntries: params.existingEntries,
    maxItems,
    relationshipBlock: formatRelationshipBlock(params.agent.id),
    contactsBlock: formatContactLoreSection(params.contacts ?? []),
  });
  const result = await postPhoneGenerate({ kind: 'files_init_plan', agentId: params.agent.id, prompt, timeoutMs });
  return normalizeFilesInitPlan(result, params.catalog, maxItems);
}

export async function planFilesBatchWithAI(params: {
  agent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  catalog: FilesLoreCatalogEntry[];
  folderOptions: FilesPlanFolderHint[];
  existingEntries: FilesPlanExistingEntry[];
  /** 已抽取的最近聊天片段（每条形如「[说话者] 文本」）；chatRefs 即其下标。 */
  chatExcerpts: string[];
  /** 通讯录候选池（让规划器把聊天里聊到的人对齐到联系人，并与设定库做身份去重）。 */
  contacts?: XingyeContactLoreHint[];
  maxItems?: number;
  userName?: string;
  timeoutMs?: number;
}): Promise<{ items: FilesBatchPlanItem[]; truncated: number }> {
  const maxItems = params.maxItems ?? DEFAULT_MAX_ITEMS;
  const timeoutMs = params.timeoutMs ?? DEFAULT_PLAN_TIMEOUT_MS;
  const userName = await resolveXingyeSpeakerUserName(params.userName);
  const recentChatBlock = params.chatExcerpts.map((text, i) => `[#${i}] ${text}`).join('\n');
  const prompt = buildFilesBatchPlanPrompt({
    agent: params.agent,
    userName,
    profile: params.ownerProfile,
    loreCatalogBlock: formatLoreCatalogBlock(toCatalogItems(params.catalog)),
    folderOptions: params.folderOptions,
    existingEntries: params.existingEntries,
    recentChatBlock,
    recentChatCount: params.chatExcerpts.length,
    maxItems,
    relationshipBlock: formatRelationshipBlock(params.agent.id),
    contactsBlock: formatContactLoreSection(params.contacts ?? []),
  });
  const result = await postPhoneGenerate({ kind: 'files_batch_plan', agentId: params.agent.id, prompt, timeoutMs });
  return normalizeFilesBatchPlan(result, params.catalog, params.chatExcerpts.length, maxItems);
}

// ─────────────────────────────────────────────────────────────────────────
//  Phase 2 — 逐条生成调用
// ─────────────────────────────────────────────────────────────────────────

export async function generateFilesInitEntryWithAI(params: {
  agent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  folderName: string;
  focus: string;
  selectedLore: FilesSelectedLoreItem[];
  sameFolderExistingTitles: string[];
  /** 人际类文件夹的正文才传：通讯录候选（昵称/印象 + 与设定库的身份对齐去重）。 */
  contacts?: XingyeContactLoreHint[];
  userName?: string;
  timeoutMs?: number;
}): Promise<FilesEntryAddResult> {
  const timeoutMs = params.timeoutMs ?? DEFAULT_ENTRY_TIMEOUT_MS;
  const userName = await resolveXingyeSpeakerUserName(params.userName);
  const prompt = buildFilesInitEntryPrompt({
    agent: params.agent,
    userName,
    profile: params.ownerProfile,
    folderName: params.folderName,
    focus: params.focus,
    selectedLoreBlock: formatSelectedLoreBlock(params.selectedLore),
    sameFolderExistingTitles: params.sameFolderExistingTitles,
    contactsBlock: formatContactLoreSection(params.contacts ?? []),
  });
  const result = await postPhoneGenerate({ kind: 'files_init_entry', agentId: params.agent.id, prompt, timeoutMs });
  const normalized = normalizeFilesEntryResult(result);
  if (!normalized) throw new Error('模型返回无效：缺少 title/body');
  return normalized;
}

export async function generateFilesBatchAddEntryWithAI(params: {
  agent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  folderName: string;
  focus: string;
  selectedLore: FilesSelectedLoreItem[];
  selectedChat: string[];
  sameFolderExistingTitles: string[];
  /** 人际类文件夹的正文才传：通讯录候选（昵称/印象 + 与设定库的身份对齐去重）。 */
  contacts?: XingyeContactLoreHint[];
  userName?: string;
  timeoutMs?: number;
}): Promise<FilesEntryAddResult> {
  const timeoutMs = params.timeoutMs ?? DEFAULT_ENTRY_TIMEOUT_MS;
  const userName = await resolveXingyeSpeakerUserName(params.userName);
  const prompt = buildFilesBatchAddEntryPrompt({
    agent: params.agent,
    userName,
    profile: params.ownerProfile,
    folderName: params.folderName,
    focus: params.focus,
    selectedLoreBlock: formatSelectedLoreBlock(params.selectedLore),
    selectedChatBlock: params.selectedChat.map((t) => `- ${t}`).join('\n'),
    sameFolderExistingTitles: params.sameFolderExistingTitles,
    contactsBlock: formatContactLoreSection(params.contacts ?? []),
  });
  const result = await postPhoneGenerate({ kind: 'files_batch_entry', agentId: params.agent.id, prompt, timeoutMs });
  const normalized = normalizeFilesEntryResult(result);
  if (!normalized) throw new Error('模型返回无效：缺少 title/body');
  return normalized;
}

export async function generateFilesBatchUpdateEntryWithAI(params: {
  agent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  focus: string;
  selectedLore: FilesSelectedLoreItem[];
  selectedChat: string[];
  target: { title: string; summary?: string; body: string };
  userName?: string;
  timeoutMs?: number;
}): Promise<FilesEntryUpdateResult> {
  const timeoutMs = params.timeoutMs ?? DEFAULT_ENTRY_TIMEOUT_MS;
  const userName = await resolveXingyeSpeakerUserName(params.userName);
  const prompt = buildFilesBatchUpdateEntryPrompt({
    agent: params.agent,
    userName,
    profile: params.ownerProfile,
    focus: params.focus,
    selectedLoreBlock: formatSelectedLoreBlock(params.selectedLore),
    selectedChatBlock: params.selectedChat.map((t) => `- ${t}`).join('\n'),
    target: params.target,
  });
  const result = await postPhoneGenerate({ kind: 'files_batch_entry', agentId: params.agent.id, prompt, timeoutMs });
  const normalized = normalizeFilesEntryUpdateResult(result);
  if (!normalized) throw new Error('模型返回无效：缺少 bodyAppend');
  return normalized;
}

// ─────────────────────────────────────────────────────────────────────────
//  并发 + 编排器
// ─────────────────────────────────────────────────────────────────────────

/** 受限并发 map：永不抛错（单条失败落 rejected），onSettled 在每条完成后回调一次。 */
async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  onSettled?: (index: number) => void,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= items.length) return;
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i], i) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
      onSettled?.(i);
    }
  });
  await Promise.all(workers);
  return results;
}

const EMPTY_SUMMARY: FilesBatchSummary = { created: 0, skipped: 0, failed: 0, truncated: 0 };

/**
 * 初始化编排：规划（喂目录）→ 逐条生成（只喂选中 lore 全文）→ **直接写入 entries**。
 * 空目录 / 空计划早退零 summary 且不发 LLM。单条失败/重复不打断整批。
 */
export async function runFilesInit(params: {
  agent: Agent;
  ownerAgentId: string;
  ownerProfile: XingyeRoleProfile | null | undefined;
  folders: XingyeFileFolder[];
  existingEntries: XingyeFileEntry[];
  userName?: string;
  maxItems?: number;
  onProgress?: (done: number, total: number) => void;
}): Promise<{ summary: FilesBatchSummary; createdEntries: XingyeFileEntry[] }> {
  const { agent, ownerAgentId, ownerProfile, folders, existingEntries } = params;
  const catalog = buildFilesLoreCatalog(ownerAgentId);
  if (!catalog.length) return { summary: { ...EMPTY_SUMMARY }, createdEntries: [] };

  // 通讯录候选：规划阶段全程可见（让人际类条目按真人规划 + 与设定库去重），
  // 逐条生成阶段只在人际类文件夹注入。一次性构建，避免每条 entry 重复读存储。
  const contactHints = buildContactLoreHints(ownerAgentId);

  const existingSummary = toExistingPlanEntries(existingEntries, folders);
  const { items: plan, truncated } = await planFilesInitWithAI({
    agent,
    ownerProfile,
    catalog,
    folderOptions: folders.map((f) => ({ name: f.name, description: f.description })),
    existingEntries: existingSummary,
    contacts: contactHints,
    maxItems: params.maxItems ?? DEFAULT_MAX_ITEMS,
    userName: params.userName,
  });
  if (!plan.length) return { summary: { created: 0, skipped: 0, failed: 0, truncated }, createdEntries: [] };

  const loreById = new Map(catalog.map((c) => [c.id, c]));
  const total = plan.length;
  let done = 0;
  params.onProgress?.(0, total);
  const settled = await runWithConcurrency(
    plan,
    ENTRY_CONCURRENCY,
    async (item) => {
      const selectedLore = selectLore(loreById, item.loreIds);
      const sameFolderExistingTitles = existingSummary
        .filter((e) => e.folderName === item.folderName)
        .map((e) => e.title);
      const result = await generateFilesInitEntryWithAI({
        agent,
        ownerProfile,
        folderName: item.folderName,
        focus: item.focus,
        selectedLore,
        sameFolderExistingTitles,
        contacts: isRelationshipFolderName(item.folderName) ? contactHints : [],
        userName: params.userName,
      });
      return { item, result };
    },
    () => {
      done += 1;
      params.onProgress?.(done, total);
    },
  );

  const summary: FilesBatchSummary = { created: 0, skipped: 0, failed: 0, truncated };
  const createdEntries: XingyeFileEntry[] = [];
  const knownEntries = [...existingEntries];
  for (const res of settled) {
    if (res.status === 'rejected') {
      summary.failed += 1;
      continue;
    }
    const { item, result } = res.value;
    const folderId = folders.length ? resolveFolderIdFromHint(folders, item.folderName) : '';
    if (!folderId) {
      summary.failed += 1;
      continue;
    }
    // 跨文件夹查重：模型常把同一内容塞进不同夹（appendFileEntry 的同夹查重拦不到）。
    // 命中（与别的夹里已有/本批已写条目几乎一样）就跳过不写，计入 skipped。
    const cross = detectCrossFolderDuplicate(
      { title: result.title, body: result.body, folderId },
      knownEntries,
    );
    if (cross.kind === 'cross_dup') {
      summary.skipped += 1;
      continue;
    }
    try {
      const entry = await appendFileEntry(
        ownerAgentId,
        {
          folderId,
          title: result.title,
          body: result.body,
          summary: result.summary,
          tags: result.tags,
          source: 'xingye-files-init',
        },
        { knownEntries },
      );
      createdEntries.push(entry);
      knownEntries.unshift(entry); // 让同批后续条目也能对刚写入的去重
      summary.created += 1;
    } catch (err) {
      if (err instanceof DuplicateFileEntryError) summary.skipped += 1;
      else summary.failed += 1;
    }
  }
  return { summary, createdEntries };
}

/**
 * 批量新增编排：取最近聊天 → 规划（喂聊天+目录）→ 逐条生成（只喂选中 lore 全文 +
 * 选中聊天片段；update 再喂目标 entry 现状）→ **写入待确认草稿**（add/update）。
 * 空聊天 / 空计划早退。update 目标解析不到则跳过（不臆造）。
 */
export async function runFilesBatchAdd(params: {
  agent: Agent;
  ownerAgentId: string;
  ownerProfile: XingyeRoleProfile | null | undefined;
  folders: XingyeFileFolder[];
  existingEntries: XingyeFileEntry[];
  /** 当前尚未确认的待确认草稿——并入查重已知集，避免重复点击对同一主题反复提案。 */
  pendingDrafts?: XingyePendingFileDraft[];
  userName?: string;
  maxItems?: number;
  onProgress?: (done: number, total: number) => void;
}): Promise<{ summary: FilesBatchSummary; appendedDrafts: XingyePendingFileDraft[] }> {
  const { agent, ownerAgentId, ownerProfile, folders, existingEntries } = params;
  const pendingDrafts = params.pendingDrafts ?? [];

  const userName = await resolveXingyeSpeakerUserName(params.userName);
  const agentName = ownerProfile?.displayName?.trim() || agent.name || '当前角色';
  let chatExcerpts: string[] = [];
  try {
    const ctx = collectRecentContextForAgent({ agentId: ownerAgentId });
    chatExcerpts = buildXingyeRecentChatExcerpts({ context: ctx, userName, agentName }).map(
      (e) => `[${e.speakerLabel}] ${e.text}`,
    );
  } catch {
    chatExcerpts = [];
  }
  if (!chatExcerpts.length) return { summary: { ...EMPTY_SUMMARY }, appendedDrafts: [] };

  const catalog = buildFilesLoreCatalog(ownerAgentId);
  // 通讯录候选：规划全程可见，逐条生成只在人际类文件夹注入。一次性构建。
  const contactHints = buildContactLoreHints(ownerAgentId);
  const existingSummary = toExistingPlanEntries(existingEntries, folders);
  const { items: plan, truncated } = await planFilesBatchWithAI({
    agent,
    ownerProfile,
    catalog,
    folderOptions: folders.map((f) => ({ name: f.name, description: f.description })),
    existingEntries: existingSummary,
    chatExcerpts,
    contacts: contactHints,
    maxItems: params.maxItems ?? DEFAULT_MAX_ITEMS,
    userName: params.userName,
  });
  if (!plan.length) return { summary: { created: 0, skipped: 0, failed: 0, truncated }, appendedDrafts: [] };

  const loreById = new Map(catalog.map((c) => [c.id, c]));
  const total = plan.length;
  let done = 0;
  params.onProgress?.(0, total);

  type WorkerOut =
    | { kind: 'skip' }
    | { kind: 'add'; folderName: string; result: FilesEntryAddResult }
    | { kind: 'update'; target: XingyeFileEntry; result: FilesEntryUpdateResult };

  const settled = await runWithConcurrency<FilesBatchPlanItem, WorkerOut>(
    plan,
    ENTRY_CONCURRENCY,
    async (item) => {
      const selectedLore = selectLore(loreById, item.loreIds);
      const selectedChat = item.chatRefs.map((i) => chatExcerpts[i]).filter(Boolean);
      if (item.action === 'update') {
        const target = item.targetTitle
          ? resolveTargetEntry(existingEntries, { matchTitle: item.targetTitle })
          : null;
        if (!target) return { kind: 'skip' };
        const result = await generateFilesBatchUpdateEntryWithAI({
          agent,
          ownerProfile,
          focus: item.focus,
          selectedLore,
          selectedChat,
          target: { title: target.title, summary: target.summary, body: target.body },
          userName: params.userName,
        });
        return { kind: 'update', target, result };
      }
      const sameFolderExistingTitles = existingSummary
        .filter((e) => e.folderName === item.folderName)
        .map((e) => e.title);
      const result = await generateFilesBatchAddEntryWithAI({
        agent,
        ownerProfile,
        folderName: item.folderName,
        focus: item.focus,
        selectedLore,
        selectedChat,
        sameFolderExistingTitles,
        contacts: isRelationshipFolderName(item.folderName) ? contactHints : [],
        userName: params.userName,
      });
      return { kind: 'add', folderName: item.folderName, result };
    },
    () => {
      done += 1;
      params.onProgress?.(done, total);
    },
  );

  const summary: FilesBatchSummary = { created: 0, skipped: 0, failed: 0, truncated };
  const appendedDrafts: XingyePendingFileDraft[] = [];
  // 跨文件夹查重的运行态已知集：已有 entries + 本批已提案的 add 草稿——
  // 既拦"新草稿与别的夹里已有条目雷同"，也拦"本批两条 add 互为跨夹重复"。
  const knownForCross: CrossFolderDedupEntry[] = [...existingEntries];
  // 同夹标题去重的运行态键集（folderId\n归一标题）：镜像 init 路径 appendFileEntry 的同夹查重，
  // 拦"本批两条 add 同夹近同名"与"与待确认草稿同夹同名"。
  const sameFolderAddKeys = new Set<string>();
  const sameFolderKey = (folderId: string, title: string) => `${folderId}\n${normalizeTitleForDedup(title)}`;
  // 并入尚未确认的 pending add 草稿：existingEntries 只含已确认条目，否则重复点击「批量整理」会对
  // 同一主题反复提案、堆在待确认区。update 草稿走老条目，不参与新增散落判定。
  for (const pd of pendingDrafts) {
    if (pd.action !== 'add') continue;
    const fid = folders.length ? resolveFolderIdFromHint(folders, pd.folderHint ?? '') : '';
    if (!fid) continue;
    knownForCross.push({ id: pd.id, title: pd.title, body: pd.body, folderId: fid });
    sameFolderAddKeys.add(sameFolderKey(fid, pd.title));
  }
  for (const res of settled) {
    if (res.status === 'rejected') {
      summary.failed += 1;
      continue;
    }
    const v = res.value;
    if (v.kind === 'skip') {
      summary.skipped += 1;
      continue;
    }

    // add 草稿先过同夹标题查重 + 跨文件夹查重；命中就不再提案（update 走老条目，无新增散落问题）。
    let addFolderId = '';
    if (v.kind === 'add') {
      addFolderId = folders.length ? resolveFolderIdFromHint(folders, v.folderName) : '';
      if (addFolderId) {
        // 同夹查重（镜像 init 的 appendFileEntry）：与已确认条目的同夹相似标题，或本批/待确认草稿的同夹同名。
        const sameFolderDup =
          detectFilesDuplicate({ title: v.result.title, folderId: addFolderId }, existingEntries).kind !== 'unique' ||
          sameFolderAddKeys.has(sameFolderKey(addFolderId, v.result.title));
        if (sameFolderDup) {
          summary.skipped += 1;
          continue;
        }
        const cross = detectCrossFolderDuplicate(
          { title: v.result.title, body: v.result.body, folderId: addFolderId },
          knownForCross,
        );
        if (cross.kind === 'cross_dup') {
          summary.skipped += 1;
          continue;
        }
      }
    }

    try {
      const draft =
        v.kind === 'update'
          ? await appendFileDraft(ownerAgentId, {
              action: 'update',
              targetEntryId: v.target.id,
              matchTitle: v.target.title,
              patch: { bodyAppend: v.result.bodyAppend, summary: v.result.summary, tags: v.result.tags },
              source: 'xingye-files-batch',
            })
          : await appendFileDraft(ownerAgentId, {
              action: 'add',
              title: v.result.title,
              body: v.result.body,
              summary: v.result.summary,
              folderHint: v.folderName,
              tags: v.result.tags,
              source: 'xingye-files-batch',
            });
      appendedDrafts.push(draft);
      summary.created += 1;
      // add 成功后并入已知集，让本批后续条目也能对它同夹/跨夹去重。
      if (v.kind === 'add') {
        knownForCross.push({ id: draft.id, title: v.result.title, body: v.result.body, folderId: addFolderId });
        sameFolderAddKeys.add(sameFolderKey(addFolderId, v.result.title));
      }
    } catch {
      summary.failed += 1;
    }
  }
  return { summary, appendedDrafts };
}
