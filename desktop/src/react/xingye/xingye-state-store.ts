import { useEffect, useState } from 'react';
import type { XingyeRoleProfile } from './xingye-profile-store';

export type XingyeStateTargetType = 'user';

export type XingyeRelationshipStage =
  | 'enemy'
  | 'estranged'
  | 'stranger'
  | 'friend'
  | 'close_friend'
  | 'lover'
  | 'bond';

export type XingyeRelationshipState = {
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
  source?: 'initial' | 'manual' | 'ai_suggested' | 'accepted_ai_suggestion' | 'system';
  updatedAt: string;
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
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
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

  return clampRelationshipState({
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

export function getRelationshipState(
  agentId: string | null | undefined,
  storage: StorageLike | null = getLocalStorage(),
): XingyeRelationshipState | null {
  if (!agentId) return null;
  return loadRelationshipStates(storage)[agentId] ?? null;
}

export function ensureRelationshipState(
  agentId: string,
  profile?: Pick<XingyeRoleProfile, 'relationshipLabel'> | null,
  storage: StorageLike | null = getLocalStorage(),
): XingyeRelationshipState {
  const existing = getRelationshipState(agentId, storage);
  if (existing) return existing;

  const affection = deriveInitialAffectionFromLabel(profile?.relationshipLabel);
  return saveRelationshipState({
    agentId,
    targetType: 'user',
    targetId: USER_TARGET_ID,
    affection,
    trust: 0,
    loyalty: 0,
    jealousy: 0,
    corruption: 0,
    mood: '平静',
    relationshipKey: deriveRelationshipStage(affection),
    relationshipLabel: getRelationshipLabelFromStage(deriveRelationshipStage(affection)),
    stateSummary: '尚未刷新状态，当前仅根据角色关系标签初始化。',
    lastReason: profile?.relationshipLabel
      ? `根据关系标签「${profile.relationshipLabel}」初始化。`
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

export function updateRelationshipState(
  agentId: string,
  patch: XingyeRelationshipStatePatch,
  storage: StorageLike | null = getLocalStorage(),
): XingyeRelationshipState {
  const current = ensureRelationshipState(agentId, null, storage);
  return saveRelationshipState({
    ...current,
    affection: current.affection + asFiniteNumber(patch.affectionDelta),
    trust: current.trust + asFiniteNumber(patch.trustDelta),
    loyalty: current.loyalty + asFiniteNumber(patch.loyaltyDelta),
    jealousy: current.jealousy + asFiniteNumber(patch.jealousyDelta),
    corruption: current.corruption + asFiniteNumber(patch.corruptionDelta),
    mood: normalizeString(patch.mood, current.mood),
    stateSummary: normalizeString(patch.stateSummary, current.stateSummary ?? '') || current.stateSummary,
    lastReason: normalizeString(patch.reason, current.lastReason ?? '') || current.lastReason,
    source: 'accepted_ai_suggestion',
    updatedAt: new Date().toISOString(),
  }, storage);
}

export function resetRelationshipState(
  agentId: string,
  profile?: Pick<XingyeRoleProfile, 'relationshipLabel'> | null,
  storage: StorageLike | null = getLocalStorage(),
): XingyeRelationshipState {
  const states = loadRelationshipStates(storage);
  delete states[agentId];
  persistRelationshipStates(states, storage);
  notifyRelationshipStatesChanged();
  return ensureRelationshipState(agentId, profile, storage);
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
  profile?: Pick<XingyeRoleProfile, 'relationshipLabel'> | null,
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
    window.addEventListener(XINGYE_RELATIONSHIP_STATES_CHANGED_EVENT, handleChange);
    return () => window.removeEventListener(XINGYE_RELATIONSHIP_STATES_CHANGED_EVENT, handleChange);
  }, [agentId, profile?.relationshipLabel]);

  return state;
}
