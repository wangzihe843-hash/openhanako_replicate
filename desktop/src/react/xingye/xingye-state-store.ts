import { useEffect, useState } from 'react';
import { saveXingyeRoleProfile, type XingyeRoleProfile } from './xingye-profile-store';
import { getXingyePersistenceStorage } from './xingye-persistence';
import { scaleRelationshipDeltas } from './xingye-state-curve';
import { listLoreEntries } from './xingye-lore-store';
import {
  deriveInitialLoyaltyFromAffection,
  deriveInitialTrustFromAffection,
  resolveInitialCorruption,
} from './xingye-state-init';

/**
 * 初始化播种时会读取的 profile 字段子集：relationshipLabel 推好感；其余自由文本段
 * 供「黑化值」关键词兜底扫描；corruptionTendency 是 LLM / 用户给的显式档位；corruptionSeed 是
 * 用户在详情页确认过的精确黑化起点（最高优先，见 resolveInitialCorruption）。
 * 全部可选——调用方（panel）通常传完整 display profile，缺字段时优雅降级。
 */
export type RelationshipInitProfile = Partial<Pick<
  XingyeRoleProfile,
  | 'relationshipLabel'
  | 'shortBio'
  | 'identitySummary'
  | 'backgroundSummary'
  | 'personalitySummary'
  | 'behaviorLogic'
  | 'values'
  | 'taboos'
  | 'relationshipMode'
  | 'corruptionTendency'
  | 'corruptionSeed'
>>;

export type XingyeStateTargetType = 'user';

export type XingyeRelationshipStage =
  | 'enemy'
  | 'estranged'
  | 'stranger'
  | 'friend'
  | 'close_friend'
  | 'lover'
  | 'bond';

export type XingyeRelationshipStateSource =
  | 'initial'
  | 'manual'
  | 'ai_suggested'
  | 'accepted_ai_suggestion'
  | 'system';

export type XingyeRelationshipStateHistoryItem = {
  agentId: string;
  targetType: 'user';
  targetId: '__user__';
  affection: number;
  trust: number;
  loyalty: number;
  jealousy: number;
  corruption: number;
  mood: string;
  relationshipKey: XingyeRelationshipStage;
  relationshipLabel: string;
  stateSummary?: string;
  lastReason?: string;
  source?: XingyeRelationshipStateSource;
  updatedAt: string;
};

export type XingyeRelationshipState = XingyeRelationshipStateHistoryItem & {
  previousStates?: XingyeRelationshipStateHistoryItem[];
};

export type XingyeRelationshipStatePatch = {
  affectionDelta?: number;
  trustDelta?: number;
  loyaltyDelta?: number;
  jealousyDelta?: number;
  corruptionDelta?: number;
  mood?: string;
  stateSummary?: string;
  reason?: string;
};

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type RelationshipStateMap = Record<string, XingyeRelationshipState>;

export const XINGYE_RELATIONSHIP_STATES_STORAGE_KEY = 'xingye.relationshipStates';

const XINGYE_RELATIONSHIP_STATES_CHANGED_EVENT = 'xingye-relationship-states-changed';
const USER_TARGET_ID = '__user__';
const MAX_PREVIOUS_STATES = 8;

const STAGE_LABELS: Record<XingyeRelationshipStage, string> = {
  enemy: '水火不容',
  estranged: '心有芥蒂',
  stranger: '萍水相逢',
  friend: '君子之交',
  close_friend: '知己相照',
  lover: '情愫暗生',
  bond: '朝夕相许',
};

const INITIAL_LABEL_RULES: Array<{ affection: number; words: string[] }> = [
  { affection: -80, words: ['仇敌', '水火不容', '敌人'] },
  { affection: -40, words: ['疏离', '心有芥蒂', '关系不好'] },
  { affection: 0, words: ['陌生人', '萍水相逢'] },
  { affection: 30, words: ['朋友', '君子之交'] },
  { affection: 60, words: ['挚友', '知己'] },
  { affection: 90, words: ['恋人', '情侣', '情愫暗生'] },
  { affection: 130, words: ['深度羁绊', '朝夕相许'] },
];

function getLocalStorage(): StorageLike | null {
  return getXingyePersistenceStorage();
}

function notifyRelationshipStatesChanged() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(XINGYE_RELATIONSHIP_STATES_CHANGED_EVENT));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asFiniteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function normalizeString(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function isValidDate(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function normalizeState(value: unknown, fallbackAgentId?: string): XingyeRelationshipState | null {
  if (!isRecord(value)) return null;
  const agentId = normalizeString(value.agentId, fallbackAgentId ?? '');
  if (!agentId) return null;

  const state = clampRelationshipState({
    agentId,
    targetType: 'user',
    targetId: USER_TARGET_ID,
    affection: asFiniteNumber(value.affection),
    trust: asFiniteNumber(value.trust),
    loyalty: asFiniteNumber(value.loyalty),
    jealousy: asFiniteNumber(value.jealousy),
    corruption: asFiniteNumber(value.corruption),
    mood: normalizeString(value.mood, '平静'),
    relationshipKey: deriveRelationshipStage(asFiniteNumber(value.affection)),
    relationshipLabel: normalizeString(value.relationshipLabel),
    stateSummary: normalizeString(value.stateSummary) || undefined,
    lastReason: normalizeString(value.lastReason) || undefined,
    source: normalizeString(value.source) as XingyeRelationshipState['source'],
    updatedAt: isValidDate(normalizeString(value.updatedAt))
      ? normalizeString(value.updatedAt)
      : new Date().toISOString(),
  });
  const previousStates = Array.isArray(value.previousStates)
    ? value.previousStates
      .map((item) => normalizeHistoryItem(item, agentId))
      .filter((item): item is XingyeRelationshipStateHistoryItem => !!item)
      .slice(0, MAX_PREVIOUS_STATES)
    : undefined;
  return previousStates?.length ? { ...state, previousStates } : state;
}

function normalizeHistoryItem(value: unknown, fallbackAgentId?: string): XingyeRelationshipStateHistoryItem | null {
  const normalized = normalizeState(value, fallbackAgentId);
  if (!normalized) return null;
  return toRelationshipStateHistoryItem(normalized);
}

function loadRelationshipStates(storage: StorageLike | null = getLocalStorage()): RelationshipStateMap {
  if (!storage) return {};
  try {
    const raw = storage.getItem(XINGYE_RELATIONSHIP_STATES_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return {};

    const states: RelationshipStateMap = {};
    for (const [agentId, value] of Object.entries(parsed)) {
      const normalized = normalizeState(value, agentId);
      if (normalized) states[normalized.agentId] = normalized;
    }
    return states;
  } catch (error) {
    console.warn('[xingye-state-store] failed to load relationship states:', error);
    return {};
  }
}

function persistRelationshipStates(states: RelationshipStateMap, storage: StorageLike | null) {
  storage?.setItem(XINGYE_RELATIONSHIP_STATES_STORAGE_KEY, JSON.stringify(states));
}

export function deriveRelationshipStage(affection: number): XingyeRelationshipStage {
  if (affection <= -60) return 'enemy';
  if (affection <= -20) return 'estranged';
  if (affection <= 19) return 'stranger';
  if (affection <= 49) return 'friend';
  if (affection <= 79) return 'close_friend';
  if (affection <= 119) return 'lover';
  return 'bond';
}

export function getRelationshipLabelFromStage(stage: XingyeRelationshipStage): string {
  return STAGE_LABELS[stage] ?? STAGE_LABELS.stranger;
}

export function deriveInitialAffectionFromLabel(label: string | null | undefined): number {
  const normalized = (label ?? '').trim();
  if (!normalized) return 0;
  for (const rule of INITIAL_LABEL_RULES) {
    if (rule.words.some((word) => normalized.includes(word))) return rule.affection;
  }
  return 0;
}

export function clampRelationshipState(state: XingyeRelationshipState): XingyeRelationshipState {
  const affection = clampNumber(state.affection, -100, 150);
  const relationshipKey = deriveRelationshipStage(affection);
  return {
    ...state,
    targetType: 'user',
    targetId: USER_TARGET_ID,
    affection,
    trust: clampNumber(state.trust, -100, 100),
    loyalty: clampNumber(state.loyalty, -100, 100),
    jealousy: clampNumber(state.jealousy, 0, 100),
    corruption: clampNumber(state.corruption, 0, 100),
    mood: state.mood?.trim() || '平静',
    relationshipKey,
    relationshipLabel: getRelationshipLabelFromStage(relationshipKey),
    updatedAt: isValidDate(state.updatedAt) ? state.updatedAt : new Date().toISOString(),
  };
}

function toRelationshipStateHistoryItem(state: XingyeRelationshipState): XingyeRelationshipStateHistoryItem {
  const { previousStates: _previousStates, ...historyItem } = state;
  return historyItem;
}

export function getRelationshipState(
  agentId: string | null | undefined,
  storage: StorageLike | null = getLocalStorage(),
): XingyeRelationshipState | null {
  if (!agentId) return null;
  return loadRelationshipStates(storage)[agentId] ?? null;
}

/**
 * 拼出供「黑化值」关键词兜底扫描的文本：profile 自由文本摘要 + 启用的 canonical **background** lore 正文。
 *
 * lore 部分**刻意只扫 `background` 分类**：黑化是「这个角色本人」的底色，背景 lore 写的正是 TA
 * 自己的来历。而 `relationship / character / event` 等分类描述的是「世界与他人」——某个第三方
 * NPC「占有欲极强、爱吃醋」会让 latent/marked 词表误命中，把别人的黑化算到主角头上。profile
 * 字段是对角色本人的结构化描述、不存在串味问题，照旧全扫。
 *
 * lore 读取是同步的（localStorage 后端）；读不到（离线 / 测试）就只用 profile，安全降级。
 */
function buildCorruptionScanText(
  profile: RelationshipInitProfile | null | undefined,
  agentId: string,
  storage: StorageLike | null,
): string {
  const profileParts = [
    profile?.shortBio,
    profile?.identitySummary,
    profile?.backgroundSummary,
    profile?.personalitySummary,
    profile?.behaviorLogic,
    profile?.values,
    profile?.taboos,
    profile?.relationshipMode,
  ].filter((part): part is string => typeof part === 'string' && part.trim().length > 0);

  let loreParts: string[] = [];
  try {
    loreParts = listLoreEntries(agentId, storage)
      .filter((entry) => entry.enabled && entry.visibility === 'canonical' && entry.category === 'background')
      .map((entry) => `${entry.title} ${entry.content}`);
  } catch (error) {
    console.warn('[xingye-state-store] lore scan for corruption seed failed:', error);
    loreParts = [];
  }

  return [...profileParts, ...loreParts].join('\n');
}

export function ensureRelationshipState(
  agentId: string,
  profile?: RelationshipInitProfile | null,
  storage: StorageLike | null = getLocalStorage(),
): XingyeRelationshipState {
  const existing = getRelationshipState(agentId, storage);
  if (existing) return existing;

  // 分治播种（详见 xingye-state-init）：好感从标签推；信任/忠诚机械跟好感走；
  // 醋意是当下情绪态、初始化不播种（保持 0）；黑化只能从设定信号来——三级优先：用户确认过的
  // 精确值 corruptionSeed ＞ LLM 档位 corruptionTendency 基线 ＞ 关键词扫 profile + background
  // lore 兜底（不扫关系/人物类，避免第三方关键词误判），且必须在初始化设基线（曲线让黑化几乎只进难退）。
  const affection = deriveInitialAffectionFromLabel(profile?.relationshipLabel);
  const corruption = resolveInitialCorruption(
    profile?.corruptionSeed,
    profile?.corruptionTendency,
    buildCorruptionScanText(profile, agentId, storage),
  );
  return saveRelationshipState({
    agentId,
    targetType: 'user',
    targetId: USER_TARGET_ID,
    affection,
    trust: deriveInitialTrustFromAffection(affection),
    loyalty: deriveInitialLoyaltyFromAffection(affection),
    jealousy: 0,
    corruption,
    mood: '平静',
    relationshipKey: deriveRelationshipStage(affection),
    relationshipLabel: getRelationshipLabelFromStage(deriveRelationshipStage(affection)),
    stateSummary: '尚未刷新状态，当前仅根据角色设定初始化。',
    lastReason: profile?.relationshipLabel
      ? `根据关系标签「${profile.relationshipLabel}」与角色设定初始化。`
      : '未命中关系标签，使用默认初始状态。',
    source: 'initial',
    updatedAt: new Date().toISOString(),
  }, storage);
}

export function saveRelationshipState(
  state: XingyeRelationshipState,
  storage: StorageLike | null = getLocalStorage(),
): XingyeRelationshipState {
  const next = clampRelationshipState({
    ...state,
    updatedAt: state.updatedAt || new Date().toISOString(),
  });
  const states = loadRelationshipStates(storage);
  states[next.agentId] = next;
  persistRelationshipStates(states, storage);
  notifyRelationshipStatesChanged();
  return next;
}

/**
 * 把当前关系阶段标签同步回详情页 profile.json。
 *
 * 触发场景：updateRelationshipState（接受 AI 建议 / 心跳巡检草稿落地）或
 * resetRelationshipState 之后，关系阶段（基于 affection 推导出的 relationshipLabel）
 * 与上一份不同 ── 让详情页和主对话 system prompt 都能立刻看到新关系。
 *
 * fire-and-forget：失败只 warn，不抛错给上层（saveRelationshipState 同步返回，
 * 不应被一次详情页落盘失败拖累）。saveXingyeRoleProfile 自带 requireServerForProfile
 * 检查，离线环境会自动跳过。
 */
function syncRelationshipLabelToProfile(agentId: string, relationshipLabel: string): void {
  if (!agentId || !relationshipLabel) return;
  void saveXingyeRoleProfile(agentId, { relationshipLabel }).catch((error) => {
    console.warn('[xingye-state-store] failed to sync relationshipLabel to profile:', error);
  });
}

export function updateRelationshipState(
  agentId: string,
  patch: XingyeRelationshipStatePatch,
  storage: StorageLike | null = getLocalStorage(),
): XingyeRelationshipState {
  const current = ensureRelationshipState(agentId, null, storage);
  const previousStates = [
    toRelationshipStateHistoryItem(current),
    ...(current.previousStates ?? []),
  ].slice(0, MAX_PREVIOUS_STATES);
  // patch 里的 5 个 delta 是 LLM 给的「原始情绪冲量」；按当前关系阶段 / 方向 / 数值
  // 重塑成实际 delta（早期好感涨得快、深关系大背叛跌得狠、信任慢涨快跌、忠诚黏、
  // 醋意绑忠诚、黑化几乎只进难退）。绝对上下限仍由下方 clampRelationshipState 收口。
  const scaled = scaleRelationshipDeltas(current, patch);
  const next = saveRelationshipState({
    ...current,
    affection: current.affection + scaled.affectionDelta,
    trust: current.trust + scaled.trustDelta,
    loyalty: current.loyalty + scaled.loyaltyDelta,
    jealousy: current.jealousy + scaled.jealousyDelta,
    corruption: current.corruption + scaled.corruptionDelta,
    mood: normalizeString(patch.mood, current.mood),
    stateSummary: normalizeString(patch.stateSummary, current.stateSummary ?? '') || current.stateSummary,
    lastReason: normalizeString(patch.reason, current.lastReason ?? '') || current.lastReason,
    source: 'accepted_ai_suggestion',
    previousStates,
    updatedAt: new Date().toISOString(),
  }, storage);
  if (next.relationshipLabel !== current.relationshipLabel) {
    syncRelationshipLabelToProfile(agentId, next.relationshipLabel);
  }
  return next;
}

export function resetRelationshipState(
  agentId: string,
  profile?: RelationshipInitProfile | null,
  storage: StorageLike | null = getLocalStorage(),
): XingyeRelationshipState {
  const previous = getRelationshipState(agentId, storage);
  const states = loadRelationshipStates(storage);
  delete states[agentId];
  persistRelationshipStates(states, storage);
  notifyRelationshipStatesChanged();
  const next = ensureRelationshipState(agentId, profile, storage);
  if (previous && next.relationshipLabel !== previous.relationshipLabel) {
    syncRelationshipLabelToProfile(agentId, next.relationshipLabel);
  }
  return next;
}

/**
 * 按当前设定预览「黑化起点」会被算成多少（精确值 ＞ 档位 ＞ 关键词扫 profile+background lore），
 * 不写库。供详情页「重置黑化起点」在确认前展示目标值，也被 resetCorruptionToSeed 内部复用。
 */
export function computeInitialCorruption(
  agentId: string,
  profile?: RelationshipInitProfile | null,
  storage: StorageLike | null = getLocalStorage(),
): number {
  return resolveInitialCorruption(
    profile?.corruptionSeed,
    profile?.corruptionTendency,
    buildCorruptionScanText(profile, agentId, storage),
  );
}

/**
 * 只重置「黑化起点」：把当前关系 state 的 corruption 重新按设定算一遍写回，其余数值
 * （好感 / 信任 / 忠诚 / 醋意 / 心情）与 previousStates 历史都保留。黑化是一次性懒播种——改了
 * corruptionSeed / corruptionTendency 后老角色不会自动重播，这是详情页「重置黑化起点」显式补一刀
 * 的入口。算出来与当前相等就原样返回、不抖历史。
 */
export function resetCorruptionToSeed(
  agentId: string,
  profile?: RelationshipInitProfile | null,
  storage: StorageLike | null = getLocalStorage(),
): XingyeRelationshipState {
  const current = ensureRelationshipState(agentId, profile, storage);
  const seed = computeInitialCorruption(agentId, profile, storage);
  if (seed === current.corruption) return current;
  const previousStates = [
    toRelationshipStateHistoryItem(current),
    ...(current.previousStates ?? []),
  ].slice(0, MAX_PREVIOUS_STATES);
  return saveRelationshipState({
    ...current,
    corruption: seed,
    lastReason: `手动重置黑化起点至设定值 ${seed}。`,
    source: 'manual',
    previousStates,
    updatedAt: new Date().toISOString(),
  }, storage);
}

export function getStateDisplayBadges(state: XingyeRelationshipState): Array<{ label: string; value: string }> {
  return [
    { label: '关系', value: state.relationshipLabel },
    { label: '心情', value: state.mood },
    { label: '好感度', value: String(state.affection) },
    { label: '信任', value: String(state.trust) },
    { label: '忠诚', value: String(state.loyalty) },
  ];
}

export function useRelationshipState(
  agentId: string | null | undefined,
  profile?: RelationshipInitProfile | null,
) {
  const [state, setState] = useState<XingyeRelationshipState | null>(() => (
    agentId ? ensureRelationshipState(agentId, profile) : null
  ));

  useEffect(() => {
    if (!agentId) {
      setState(null);
      return undefined;
    }

    setState(ensureRelationshipState(agentId, profile));
    const handleChange = () => setState(getRelationshipState(agentId));
    const onPersistence = () => handleChange();
    window.addEventListener(XINGYE_RELATIONSHIP_STATES_CHANGED_EVENT, handleChange);
    window.addEventListener('xingye-persistence-changed', onPersistence);
    return () => {
      window.removeEventListener(XINGYE_RELATIONSHIP_STATES_CHANGED_EVENT, handleChange);
      window.removeEventListener('xingye-persistence-changed', onPersistence);
    };
  }, [agentId, profile?.relationshipLabel]);

  return state;
}
