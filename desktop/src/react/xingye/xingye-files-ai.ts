import { hanaFetch } from '../hooks/use-hana-fetch';
import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import { peekDeskHeartbeatUiOutcome } from './xingye-desk-heartbeat-memory';
import {
  FILES_DRAFT_EXISTING_ENTRIES_PROMPT_LIMIT,
  buildFilesDraftPrompt,
  type FilesDraftExistingEntry,
  type FilesDraftFolderHint,
} from './xingye-files-prompts';
import {
  applyCategoryBoostOrder,
  buildXingyeLoreRuntimeQueryText,
  collectXingyeLoreRuntimeContext,
  formatXingyeLoreRuntimeContextBlock,
} from './xingye-lore-runtime-context';
import { XINGYE_LORE_CATEGORY_LABELS, listLoreEntries, type XingyeLoreCategory } from './xingye-lore-store';
import { buildContactLoreHints } from './xingye-contact-lore-link';
import { classifyXingyeFilesFolder } from './xingye-files-folder-taxonomy';
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

export type XingyeFilesAiDraft = {
  folderName: string;
  title: string;
  body: string;
  summary?: string;
  tags?: string[];
};

export function truncateChars(text: string, max: number): string {
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

export async function buildStableLoreBlock(
  agentId: string,
  boostCategories: ReadonlyArray<XingyeLoreCategory> = [],
): Promise<string> {
  const fromFile = await readLoreMemoryMarkdown(agentId);
  // markdown 形态是自由文本、无分类维度，无法提权——只能原样截断；提权仅作用于 always 条目回退路径。
  if (fromFile && fromFile.trim()) return truncateChars(fromFile, 3200);
  return buildStableLoreFromAlwaysEntries(agentId, 2800, boostCategories).trim();
}

/**
 * 把目标文件夹名映射到要提权的 lore 分类：
 * - 「人际关系 / 关于 user / 人脉 / 人物 / 联系人」等记人夹 → relationship；「世界观/设定/规则」→ worldview。
 * - 猜不出（自定义夹）返回 []（不提权、安全降级）。仅在已知 targetFolder 时调用。
 *
 * 复用 `classifyXingyeFilesFolder` 作为「这个夹放什么」的单一口径——避免本函数与 taxonomy 各维护一套
 * 关键词集而漂移（曾漏掉「联系人/人物/人脉」，导致这类记人夹拿不到通讯录注入）。粒度差异（people≠aboutUser）
 * 在 taxonomy 内体现内容分工，这里只关心提权分类，故 people 与 aboutUser 都归 relationship。
 */
export function folderBoostCategories(folder: FilesDraftFolderHint | null): XingyeLoreCategory[] {
  const kind = classifyXingyeFilesFolder(folder?.name ?? '');
  if (kind === 'people' || kind === 'aboutUser') return ['relationship'];
  if (kind === 'worldview') return ['worldview'];
  return [];
}

export function formatRelationshipBlock(agentId: string): string {
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

export function profilePartsForQuery(profile: XingyeRoleProfile | null | undefined): string[] {
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

export function normalizeOptional(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return truncateChars(text, max);
}

export function normalizeTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const t = item.trim();
    if (!t) continue;
    out.push(t.slice(0, 24));
    if (out.length >= 8) break;
  }
  return out.length ? out : undefined;
}

export function normalizeFilesDraftResult(raw: unknown): XingyeFilesAiDraft | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const folderName = typeof record.folderName === 'string' ? record.folderName.trim() : '';
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  const body = typeof record.body === 'string' ? record.body.trim() : '';
  if (!folderName || !title || !body) return null;
  return {
    folderName: truncateChars(folderName, 80),
    title: truncateChars(title, 160),
    body: truncateChars(body, 2000),
    summary: normalizeOptional(record.summary, 240),
    tags: normalizeTags(record.tags),
  };
}

/**
 * 调 `POST /api/xingye/phone-generate`（kind: files_draft）。
 * 与 schedule / journal / divination 一致。不写入资料柜，返回的草稿由调用方填到编辑框。
 *
 * 任意上下文（profile/lore/recent chat/heartbeat/relationship）缺失都会优雅降级为「（无）」，
 * prompt 仍可用；模型若无法整理则返回 null，由调用方处理。
 */
export async function generateFilesDraftWithAI(params: {
  agent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  /** 当前正在新建文件的目标文件夹（首页快捷入口可不传，模型从 folderOptions 选）。 */
  targetFolder?: FilesDraftFolderHint | null;
  /** 当前角色已有的所有资料文件夹（可空数组）。 */
  folderOptions?: FilesDraftFolderHint[];
  /**
   * 当前角色已归档的 entries 摘要（按时间倒序）。喂给 prompt 让模型在生成前
   * 看一眼已有条目，避免再写一份几乎同名的新 entry——典型 case：「师父说过的几句话」
   * 已经存在，模型应该在 body 里追加新段落（让用户后续合并），而不是生成「师父说的几句话」。
   * 调用方通常用 PhoneFilesApp 里的 `entries` state 映射后传入；缺省视为暂无条目。
   */
  existingEntries?: FilesDraftExistingEntry[];
  userIntent?: string;
  userName?: string;
  timeoutMs?: number;
}): Promise<XingyeFilesAiDraft> {
  const { agent, ownerProfile } = params;
  const timeoutMs = params.timeoutMs ?? 90_000;
  const userIntent = params.userIntent?.trim() ?? '';
  const userName = await resolveXingyeSpeakerUserName(params.userName);
  const agentName = ownerProfile?.displayName?.trim() || agent.name || '当前角色';
  const folderOptions = Array.isArray(params.folderOptions) ? params.folderOptions : [];
  const targetFolder = params.targetFolder ?? null;

  // 按目标文件夹给对应分类的 lore 提权（人际关系夹→relationship、世界观夹→worldview）；
  // 文件夹未知或猜不出分类时为空数组 = 不提权。两条取 lore 路径都带上它。
  const loreBoostCategories = folderBoostCategories(targetFolder);

  // 关系类文件夹（folderBoostCategories 命中 relationship）才注入通讯录候选池；世界观 / 线索等保持干净。
  // 无目标文件夹（首页快捷入口）时模型会自己从 folderOptions 里挑——只要候选里有关系类夹，就也注入，
  // 否则模型挑了「人际关系」却没通讯录可参考（见 PhoneFilesApp 的 targetFolder=null 路径）。
  const includeContacts = targetFolder
    ? loreBoostCategories.includes('relationship')
    : folderOptions.some((f) => folderBoostCategories(f).includes('relationship'));
  const virtualContacts = includeContacts ? buildContactLoreHints(agent.id) : [];

  const stableLoreBlock = await buildStableLoreBlock(agent.id, loreBoostCategories);

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

  const queryText = buildXingyeLoreRuntimeQueryText([
    ...profilePartsForQuery(ownerProfile ?? null),
    userName,
    agentName,
    userIntent,
    targetFolder?.name ?? '',
    targetFolder?.description ?? '',
    folderOptions.map((f) => f.name).join(' '),
    typeof recentContext.summaryText === 'string' ? recentContext.summaryText : '',
    relationshipBlock,
    stableLoreBlock.slice(0, 2000),
    heartbeatLine ?? '',
    // 把候选联系人的名字折进 queryText，让关系/人物类 lore 在冷启动也能被 keyword 命中
    // （与 mail-ai 同款手法）；includeContacts=false 时为空字符串，无副作用。
    virtualContacts.map((c) => c.displayName).join(' '),
  ]);

  let keywordLoreBlock = '';
  try {
    const keywordCtx = collectXingyeLoreRuntimeContext(agent.id, {
      purpose: 'generic',
      queryText,
      maxChars: 2000,
      includeAlways: false,
      includeKeyword: true,
      priorityBoostCategories: loreBoostCategories,
    });
    keywordLoreBlock = formatXingyeLoreRuntimeContextBlock(keywordCtx);
  } catch {
    keywordLoreBlock = '';
  }

  const prompt = buildFilesDraftPrompt({
    agent,
    userName,
    profile: ownerProfile,
    userIntent,
    targetFolder,
    folderOptions,
    existingEntries: Array.isArray(params.existingEntries)
      ? params.existingEntries.slice(0, FILES_DRAFT_EXISTING_ENTRIES_PROMPT_LIMIT)
      : [],
    recentSceneBlock,
    stableLoreBlock,
    keywordLoreBlock,
    relationshipBlock,
    heartbeatBlock,
    virtualContacts,
  });

  const response = await hanaFetch('/api/xingye/phone-generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeout: timeoutMs,
    body: JSON.stringify({
      kind: 'files_draft',
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

  const normalized = normalizeFilesDraftResult(data?.result);
  if (!normalized) {
    throw new Error('模型返回无效：缺少 folderName/title/body 或 JSON 解析失败');
  }
  return normalized;
}
