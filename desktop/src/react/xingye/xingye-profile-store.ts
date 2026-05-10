import { useEffect, useState } from 'react';
import type { Agent } from '../types';

export type XingyeRoleProfile = {
  agentId: string;
  displayName?: string;
  shortBio?: string;
  relationshipLabel?: string;
  speakingStyle?: string;
  identitySummary?: string;
  backgroundSummary?: string;
  personalitySummary?: string;
  behaviorLogic?: string;
  values?: string;
  taboos?: string;
  relationshipMode?: string;
  avatarDataUrl?: string;
  chatBackgroundDataUrl?: string;
  allowAutoMoments?: boolean;
  allowProactiveDM?: boolean;
  updatedAt: string;
};

export type XingyeRoleProfileMap = Record<string, XingyeRoleProfile>;

export type XingyeRoleProfileDisplay = {
  displayName: string;
  shortBio: string;
  relationshipLabel?: string;
  speakingStyle?: string;
  identitySummary?: string;
  backgroundSummary?: string;
  personalitySummary?: string;
  behaviorLogic?: string;
  values?: string;
  taboos?: string;
  relationshipMode?: string;
  avatarDataUrl?: string;
  chatBackgroundDataUrl?: string;
  allowAutoMoments: boolean;
  allowProactiveDM: boolean;
};

export const XINGYE_ROLE_PROFILES_STORAGE_KEY = 'xingye.roleProfiles';

const XINGYE_ROLE_PROFILES_CHANGED_EVENT = 'xingye-role-profiles-changed';
const DEEPSEEK_STYLE_FALLBACK = '理性、直接、克制，有判断力，解释清楚但不过度卖萌。';
const DEFAULT_ROLE_SUMMARY = '身份尚未完全确定，但应保持当前设定中的姓名、关系和语气一致。';
const DEFAULT_IDENTITY_SUMMARY = '身份尚未完全确定，但应保持当前设定中的姓名、关系和语气一致。';
const DEFAULT_BACKGROUND_SUMMARY = '背景尚未完全确定，但过往经历应与当前身份、关系和语气保持一致。';
const DEFAULT_PERSONALITY_SUMMARY = '稳定、自然，有温度，也能保持清楚判断。';
const DEFAULT_BEHAVIOR_LOGIC = '先理解用户语境，再给出具体、克制、可执行的回应。';
const DEFAULT_VALUES = '尊重事实、尊重边界，重视承诺和关系的一致性。';
const DEFAULT_RELATIONSHIP_MODE = '以当前关系设定为准，亲近但不越界。';
const SHORT_TEXT_THRESHOLD = 18;

const STRING_FIELDS = [
  'displayName',
  'shortBio',
  'relationshipLabel',
  'speakingStyle',
  'identitySummary',
  'backgroundSummary',
  'personalitySummary',
  'behaviorLogic',
  'values',
  'taboos',
  'relationshipMode',
  'avatarDataUrl',
  'chatBackgroundDataUrl',
] as const;

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;
type SyncProfileInput = Pick<
  XingyeRoleProfile,
  | 'displayName'
  | 'shortBio'
  | 'relationshipLabel'
  | 'speakingStyle'
  | 'identitySummary'
  | 'backgroundSummary'
  | 'personalitySummary'
  | 'behaviorLogic'
  | 'values'
  | 'taboos'
  | 'relationshipMode'
> | null | undefined;

function getLocalStorage(): StorageLike | null {
  if (typeof window === 'undefined') return null;

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeProfile(value: unknown, fallbackAgentId?: string): XingyeRoleProfile | null {
  if (!isRecord(value)) return null;

  const agentId = normalizeOptionalString(value.agentId) ?? fallbackAgentId;
  if (!agentId) return null;

  const profile: XingyeRoleProfile = {
    agentId,
    updatedAt: normalizeOptionalString(value.updatedAt) ?? new Date(0).toISOString(),
  };

  for (const field of STRING_FIELDS) {
    const normalized = normalizeOptionalString(value[field]);
    if (normalized) profile[field] = normalized;
  }

  if (typeof value.allowAutoMoments === 'boolean') {
    profile.allowAutoMoments = value.allowAutoMoments;
  }
  if (typeof value.allowProactiveDM === 'boolean') {
    profile.allowProactiveDM = value.allowProactiveDM;
  }

  return profile;
}

function notifyXingyeRoleProfilesChanged() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(XINGYE_ROLE_PROFILES_CHANGED_EVENT));
}

export function loadXingyeRoleProfiles(storage: StorageLike | null = getLocalStorage()): XingyeRoleProfileMap {
  if (!storage) return {};

  try {
    const raw = storage.getItem(XINGYE_ROLE_PROFILES_STORAGE_KEY);
    if (!raw) return {};

    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return {};

    const profiles: XingyeRoleProfileMap = {};
    for (const [agentId, value] of Object.entries(parsed)) {
      const normalized = normalizeProfile(value, agentId);
      if (normalized) profiles[normalized.agentId] = normalized;
    }

    return profiles;
  } catch (error) {
    console.warn('[xingye-profile-store] failed to load role profiles:', error);
    return {};
  }
}

export function getXingyeRoleProfile(
  agentId: string | null | undefined,
  storage: StorageLike | null = getLocalStorage(),
): XingyeRoleProfile | null {
  if (!agentId) return null;
  return loadXingyeRoleProfiles(storage)[agentId] ?? null;
}

export function saveXingyeRoleProfile(
  agentId: string,
  patch: Partial<Omit<XingyeRoleProfile, 'agentId' | 'updatedAt'>>,
  storage: StorageLike | null = getLocalStorage(),
): XingyeRoleProfile {
  const profiles = loadXingyeRoleProfiles(storage);
  const previous = profiles[agentId] ?? { agentId, updatedAt: new Date(0).toISOString() };
  const next = normalizeProfile({
    ...previous,
    ...patch,
    agentId,
    updatedAt: new Date().toISOString(),
  }, agentId);

  if (!next) {
    throw new Error('Unable to save Xingye role profile without agentId.');
  }

  profiles[agentId] = next;

  try {
    storage?.setItem(XINGYE_ROLE_PROFILES_STORAGE_KEY, JSON.stringify(profiles));
  } catch (error) {
    console.warn('[xingye-profile-store] failed to save role profile:', error);
  }

  notifyXingyeRoleProfilesChanged();
  return next;
}

export function getXingyeRoleProfileDisplay(
  agent: Pick<Agent, 'id' | 'name' | 'yuan'>,
  profile: XingyeRoleProfile | null | undefined,
): XingyeRoleProfileDisplay {
  return {
    displayName: profile?.displayName || agent.name,
    shortBio: profile?.shortBio || '尚未填写角色简介。',
    relationshipLabel: profile?.relationshipLabel,
    speakingStyle: profile?.speakingStyle,
    identitySummary: profile?.identitySummary,
    backgroundSummary: profile?.backgroundSummary,
    personalitySummary: profile?.personalitySummary,
    behaviorLogic: profile?.behaviorLogic,
    values: profile?.values,
    taboos: profile?.taboos,
    relationshipMode: profile?.relationshipMode,
    avatarDataUrl: profile?.avatarDataUrl,
    chatBackgroundDataUrl: profile?.chatBackgroundDataUrl,
    allowAutoMoments: profile?.allowAutoMoments ?? false,
    allowProactiveDM: profile?.allowProactiveDM ?? false,
  };
}

export type OpenHanakoAgentSyncPayload = {
  identity: string;
  ishiki: string;
};

function isPlaceholderLikeText(value: string | undefined): boolean {
  if (!value) return true;
  const compact = value.replace(/\s+/g, '').toLowerCase();
  return !compact || /^test[_-]?\d*$/.test(compact) || compact === '测试' || compact === '測試';
}

function isThinPersonaField(value: string | undefined): boolean {
  const normalized = normalizeOptionalString(value);
  return !normalized || normalized.length < SHORT_TEXT_THRESHOLD || isPlaceholderLikeText(normalized);
}

function asSentence(value: string): string {
  return /[。！？.!?]$/.test(value) ? value : `${value}。`;
}

function trimSentenceEnding(value: string): string {
  return value.replace(/[。！？.!?]+$/g, '');
}

function compactLine(value: string | undefined, fallback: string): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized || isPlaceholderLikeText(normalized)) return fallback;
  return normalized;
}

function resolveRoleSummary(shortBio: string | undefined): string {
  const normalized = normalizeOptionalString(shortBio);
  if (!normalized || isPlaceholderLikeText(normalized)) return DEFAULT_ROLE_SUMMARY;
  return normalized.length < SHORT_TEXT_THRESHOLD
    ? `${asSentence(normalized)}保持稳定、自然的角色状态，表达清楚且有判断力。`
    : normalized;
}

function resolveSpeakingStyle(speakingStyle: string | undefined): string {
  const normalized = normalizeOptionalString(speakingStyle);
  if (!normalized) return DEEPSEEK_STYLE_FALLBACK;

  const compact = normalized.replace(/\s+/g, '').toLowerCase();
  if (compact.includes('deepseek') && /原本|原来|默认|本来|原风格/.test(compact)) {
    return DEEPSEEK_STYLE_FALLBACK;
  }

  return isThinPersonaField(normalized) ? `${asSentence(trimSentenceEnding(normalized))}表达清楚、稳定，不刻意夸张。` : normalized;
}

function resolveRelationship(relationshipLabel: string | undefined): string {
  return compactLine(relationshipLabel, '朋友');
}

function relationshipSentence(relationship: string): string {
  const trimmed = trimSentenceEnding(relationship);
  if (/关系$/.test(trimmed)) return `与用户是${trimmed}。`;
  return `与用户是${trimmed}关系。`;
}

function uniqueLines(lines: string[]): string[] {
  const seen = new Set<string>();
  return lines.filter((line) => {
    const normalized = line.trim();
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

export function buildOpenHanakoIdentity(
  agent: Pick<Agent, 'id' | 'name' | 'yuan'>,
  profile: SyncProfileInput,
  _loreEntries?: Array<{ content?: string }>,
): string {
  const display = getXingyeRoleProfileDisplay(agent, profile as XingyeRoleProfile | null | undefined);
  const displayName = display.displayName;
  const relationship = resolveRelationship(display.relationshipLabel);
  const identitySummary = compactLine(display.identitySummary, DEFAULT_IDENTITY_SUMMARY);
  const backgroundSummary = compactLine(display.backgroundSummary, DEFAULT_BACKGROUND_SUMMARY);
  const shortBio = resolveRoleSummary(profile?.shortBio);

  return [
    `# ${displayName}`,
    '',
    ...uniqueLines([
      asSentence(identitySummary),
      relationshipSentence(relationship),
      asSentence(backgroundSummary),
      asSentence(shortBio),
    ]),
  ].join('\n');
}

export function buildOpenHanakoIshiki(
  agent: Pick<Agent, 'id' | 'name' | 'yuan'>,
  profile: SyncProfileInput,
  _loreEntries?: Array<{ content?: string }>,
): string {
  const display = getXingyeRoleProfileDisplay(agent, profile as XingyeRoleProfile | null | undefined);
  const relationship = resolveRelationship(display.relationshipLabel);
  const speakingStyle = resolveSpeakingStyle(display.speakingStyle);
  const personalitySummary = compactLine(display.personalitySummary, DEFAULT_PERSONALITY_SUMMARY);
  const behaviorLogic = compactLine(display.behaviorLogic, DEFAULT_BEHAVIOR_LOGIC);
  const values = compactLine(display.values, DEFAULT_VALUES);
  const relationshipMode = compactLine(display.relationshipMode, DEFAULT_RELATIONSHIP_MODE);
  const backgroundInfluence = compactLine(display.backgroundSummary, DEFAULT_BACKGROUND_SUMMARY);
  const taboos = compactLine(display.taboos, '避免越过关系边界，避免把设定当作现实事实强行扩写。');

  return [
    '# 人格与行动逻辑',
    '',
    `- 你是 ${display.displayName}。`,
    `- 你与用户的关系是：${relationship}。`,
    `- 你的性格基础：${personalitySummary}`,
    `- 你的说话风格：${speakingStyle}`,
    `- 你的行事逻辑：${behaviorLogic}`,
    `- 你的价值观：${values}`,
    `- 你的关系模式：${relationshipMode}`,
    `- 你的关系边界：${taboos}`,
    `- 这些经历会影响你当前的反应：${backgroundInfluence}`,
    '- 你需要保持稳定人设，不要每次对话都像新角色。',
    '- 你不会把完整背景故事反复讲给用户听，除非上下文需要。',
    '- 你不编造没有依据的现实经历或外部事实。',
    '- 不要频繁声明“我是 AI”或跳出角色，除非用户明确问到。',
  ].join('\n');
}

export function buildOpenHanakoAgentSyncPayload(
  agent: Pick<Agent, 'id' | 'name' | 'yuan'>,
  profile: SyncProfileInput,
): OpenHanakoAgentSyncPayload {
  if (
    profile?.identitySummary ||
    profile?.backgroundSummary ||
    profile?.personalitySummary ||
    profile?.behaviorLogic ||
    profile?.values ||
    profile?.taboos ||
    profile?.relationshipMode
  ) {
    return {
      identity: buildOpenHanakoIdentity(agent, profile),
      ishiki: buildOpenHanakoIshiki(agent, profile),
    };
  }

  const display = getXingyeRoleProfileDisplay(agent, profile as XingyeRoleProfile | null | undefined);
  const roleSummary = resolveRoleSummary(profile?.shortBio);
  const relationship = resolveRelationship(display.relationshipLabel);
  const speakingStyle = resolveSpeakingStyle(display.speakingStyle);

  return {
    identity: buildOpenHanakoIdentity(agent, {
      ...profile,
      identitySummary: roleSummary,
      backgroundSummary: DEFAULT_BACKGROUND_SUMMARY,
    }),
    ishiki: [
      '# 人格定义',
      '',
      '## 角色是谁',
      `- 你是 ${display.displayName}，${roleSummary}`,
      '',
      '## 与用户关系',
      `- 你与用户的关系是：${relationship}。`,
      '- 你关心用户的状态和偏好，但不擅自替用户做决定。',
      '',
      '## 说话风格',
      `- ${speakingStyle}`,
      '- 语气自然，有温度但不过分撒娇；可以表达判断，也要说明理由。',
      '',
      '## 互动方式',
      '- 主动理解用户的真实意图，必要时提出简短澄清。',
      '- 回答要具体、可执行，避免空泛安慰或机械复读。',
      '- 当用户只是在聊天时，可以轻松一点；当用户在处理问题时，优先清楚、直接地帮忙。',
      '',
      '## 稳定人设要求',
      '- 始终保持同一个角色身份、关系设定和语气习惯，不因为单次对话随意改写人设。',
      '- 表达上保持连续性，不随意改变身份、经历或关系边界。',
      '',
      '## 边界',
      '- 你不编造没有依据的现实经历或外部事实。',
      '- 不频繁跳出角色解释来源，除非用户明确问到。',
      '',
    ].join('\n'),
  };
}

export function useXingyeRoleProfiles(): XingyeRoleProfileMap {
  const [profiles, setProfiles] = useState<XingyeRoleProfileMap>(() => loadXingyeRoleProfiles());

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    const refresh = () => setProfiles(loadXingyeRoleProfiles());
    const refreshFromStorage = (event: StorageEvent) => {
      if (event.key === XINGYE_ROLE_PROFILES_STORAGE_KEY) refresh();
    };

    window.addEventListener(XINGYE_ROLE_PROFILES_CHANGED_EVENT, refresh);
    window.addEventListener('storage', refreshFromStorage);
    return () => {
      window.removeEventListener(XINGYE_ROLE_PROFILES_CHANGED_EVENT, refresh);
      window.removeEventListener('storage', refreshFromStorage);
    };
  }, []);

  return profiles;
}

export function useXingyeRoleProfile(agentId: string | null | undefined): XingyeRoleProfile | null {
  const profiles = useXingyeRoleProfiles();
  return agentId ? profiles[agentId] ?? null : null;
}
