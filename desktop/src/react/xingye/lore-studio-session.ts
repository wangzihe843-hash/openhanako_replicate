/**
 * 工坊会话的每-agent 持久化：transcript / phase / 草案方案 落到
 * {agentDir}/xingye/lore-studio/session.json（走现有 xingye-storage writeJson/readJson，
 * 自带 per-agent 锁与原子写）。打开工坊时按当前 agent 加载——**切 agent 各自记录不丢**。
 */
import { postXingyeStorage } from './xingye-storage-api';
import { createAgentXingyeStorageBackend } from './xingye-storage-backend';
import { hasServerConnection } from '../services/server-connection';
import { useStore } from '../stores';
import { XINGYE_LORE_CATEGORIES, type XingyeLoreCategory, type XingyeLoreInsertionMode } from './xingye-lore-store';
import {
  STUDIO_SESSION_RELATIVE_PATH,
  type StudioMessage,
  type StudioPhase,
  type StudioPlanLoreEntry,
  type StudioPlanProfileField,
  type StudioPlanTurn,
  type StudioSession,
} from './lore-studio-types';
import type { XingyeCorruptionTendency } from './xingye-profile-store';

const INSERTION_MODES: XingyeLoreInsertionMode[] = ['always', 'keyword', 'manual'];
const CORRUPTION_TENDENCIES: XingyeCorruptionTendency[] = ['none', 'latent', 'marked'];

const backend = createAgentXingyeStorageBackend(postXingyeStorage);

const PHASES: StudioPhase[] = ['intro', 'questioning', 'planning', 'done'];

export function emptyStudioSession(agentId: string): StudioSession {
  return {
    version: 1,
    agentId,
    backgroundStory: '',
    phase: 'intro',
    messages: [],
    draftPlan: null,
    updatedAt: new Date(0).toISOString(),
  };
}

function isValidMessage(value: unknown): value is StudioMessage {
  if (!value || typeof value !== 'object') return false;
  const m = value as Record<string, unknown>;
  if (typeof m.id !== 'string') return false;
  if (m.role === 'user') return typeof m.text === 'string';
  if (m.role === 'assistant') return !!m.turn && typeof m.turn === 'object';
  return false;
}

/**
 * 深校验持久化的 draftPlan：坏 / 半写坏的 session.json（type 仍为 'plan' 但 loreEntries 不是数组、
 * 或某条 keywords 不是数组）会在 PlanCard 渲染时 `.length`/`.map`/`keywords.join` 同步抛异常崩面板。
 * 这里把它收口成「loreEntries 一定是数组、每条 title/content 为字符串、keywords 一定是字符串数组」，
 * 与本文件对 messages / peerContext 的逐字段校验同档；无法识别则整体丢成 null。
 */
function normalizeDraftPlan(value: unknown): StudioPlanTurn | null {
  if (!value || typeof value !== 'object') return null;
  const d = value as Record<string, unknown>;
  if (d.type !== 'plan' || !Array.isArray(d.loreEntries)) return null;
  const loreEntries: StudioPlanLoreEntry[] = [];
  for (const raw of d.loreEntries) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as Record<string, unknown>;
    if (typeof e.title !== 'string' || typeof e.content !== 'string') continue;
    const entry: StudioPlanLoreEntry = {
      title: e.title,
      content: e.content,
      category: XINGYE_LORE_CATEGORIES.includes(e.category as XingyeLoreCategory)
        ? (e.category as XingyeLoreCategory)
        : 'background',
      insertionMode: INSERTION_MODES.includes(e.insertionMode as XingyeLoreInsertionMode)
        ? (e.insertionMode as XingyeLoreInsertionMode)
        : 'manual',
      keywords: Array.isArray(e.keywords) ? e.keywords.filter((k): k is string => typeof k === 'string') : [],
    };
    if (typeof e.tempId === 'string') entry.tempId = e.tempId;
    if (e.manualSuggested === true) entry.manualSuggested = true;
    if (typeof e.manualReason === 'string') entry.manualReason = e.manualReason;
    if (e.isUpdate === true) entry.isUpdate = true;
    loreEntries.push(entry);
  }
  const out: StudioPlanTurn = { type: 'plan', loreEntries };
  if (typeof d.summary === 'string') out.summary = d.summary;
  if (typeof d.notes === 'string') out.notes = d.notes;
  if (CORRUPTION_TENDENCIES.includes(d.corruptionTendency as XingyeCorruptionTendency)) {
    out.corruptionTendency = d.corruptionTendency as XingyeCorruptionTendency;
  }
  if (typeof d.corruptionSeed === 'number' && Number.isFinite(d.corruptionSeed)) out.corruptionSeed = d.corruptionSeed;
  if (Array.isArray(d.profilePatch)) {
    const patch = d.profilePatch.filter(
      (p): p is StudioPlanProfileField =>
        !!p &&
        typeof p === 'object' &&
        typeof (p as { field?: unknown }).field === 'string' &&
        typeof (p as { value?: unknown }).value === 'string',
    );
    if (patch.length) out.profilePatch = patch;
  }
  return out;
}

function normalizeSession(raw: unknown, agentId: string): StudioSession {
  const base = emptyStudioSession(agentId);
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Record<string, unknown>;
  const pc = r.peerContext as { sourceAgentId?: unknown; sourceName?: unknown } | null | undefined;
  return {
    version: 1,
    agentId,
    backgroundStory: typeof r.backgroundStory === 'string' ? r.backgroundStory : '',
    phase: PHASES.includes(r.phase as StudioPhase) ? (r.phase as StudioPhase) : 'intro',
    messages: Array.isArray(r.messages) ? (r.messages.filter(isValidMessage) as StudioMessage[]) : [],
    draftPlan: normalizeDraftPlan(r.draftPlan),
    peerContext:
      pc && typeof pc.sourceAgentId === 'string' && typeof pc.sourceName === 'string'
        ? { sourceAgentId: pc.sourceAgentId, sourceName: pc.sourceName }
        : undefined,
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : base.updatedAt,
  };
}

export async function loadStudioSession(agentId: string): Promise<StudioSession | null> {
  const id = typeof agentId === 'string' ? agentId.trim() : '';
  if (!id || !hasServerConnection(useStore.getState())) return null;
  // 注意：读失败（文件存在但损坏 / 传输错误）会**抛出**，刻意不吞成 null——否则调用方会把它当
  // 「从未初始化」起一个空会话，用户一编辑就 saveStudioSession 把磁盘上真实存在的 transcript/草案
  // 整表覆写掉（项目硬约束「读失败别吞成空再覆写」，参照 loadHistoryState）。只有**缺文件**时
  // backend.readJson 返回 null —— 那才是安全地起新会话。
  const raw = await backend.readJson<unknown>(id, STUDIO_SESSION_RELATIVE_PATH);
  if (raw == null) return null;
  return normalizeSession(raw, id);
}

export async function saveStudioSession(session: StudioSession): Promise<void> {
  const id = typeof session?.agentId === 'string' ? session.agentId.trim() : '';
  if (!id || !hasServerConnection(useStore.getState())) return;
  try {
    await backend.writeJson(id, STUDIO_SESSION_RELATIVE_PATH, {
      ...session,
      version: 1,
      agentId: id,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.warn('[lore-studio-session] save failed:', err);
  }
}
