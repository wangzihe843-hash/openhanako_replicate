import { useEffect, useMemo, useState } from 'react';
import type { Agent } from '../types';
import { useStore } from '../stores';
import { hasServerConnection } from '../services/server-connection';
import { postXingyeStorage } from './xingye-storage-api';
import { createAgentXingyeStorageBackend } from './xingye-storage-backend';

import type { XingyeLoreEntry } from './xingye-lore-store';

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
  /** workspace 落盘引用（由 xingye-persistence / v2 layout 写入/加载） */
  avatarMediaPath?: string;
  chatBackgroundMediaPath?: string;
  allowAutoMoments?: boolean;
  allowProactiveDM?: boolean;
  /** 最近一次成功写入 OpenHanako identity/ishiki 的时间（ISO） */
  lastOpenHanakoSyncAt?: string;
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

/** Legacy localStorage map key — read-only, one-time migration when `profile.json` is missing. */
export const XINGYE_ROLE_PROFILES_LEGACY_STORAGE_KEY = 'xingye.roleProfiles';

/** @deprecated Use {@link XINGYE_ROLE_PROFILES_LEGACY_STORAGE_KEY}. Kept for older imports/tests. */
export const XINGYE_ROLE_PROFILES_STORAGE_KEY = XINGYE_ROLE_PROFILES_LEGACY_STORAGE_KEY;

export const XINGYE_PROFILE_JSON_RELATIVE_PATH = 'profile.json';

const profileBackend = createAgentXingyeStorageBackend(postXingyeStorage);

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

/** OpenHanako identity.md：单行叙事最大长度（超长截断，完整背景与 lore 留在 workspace）。 */
export const OPENHANAKO_SYNC_MAX_IDENTITY_FIELD = 240;
/** OpenHanako ishiki.md：列表项内文本最大长度。 */
export const OPENHANAKO_SYNC_MAX_ISHIKI_FIELD = 220;
const OPENHANAKO_SYNC_MAX_DISPLAY_NAME = 80;

export function truncateForOpenHanakoSync(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1))}…`;
}

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

type SyncProfileInput = Pick<
  XingyeRoleProfile,
  | 'agentId'
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
  | 'avatarDataUrl'
  | 'chatBackgroundDataUrl'
  | 'allowAutoMoments'
  | 'allowProactiveDM'
  | 'updatedAt'
> | null | undefined;

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

  const avatarMediaPath = normalizeOptionalString(value.avatarMediaPath);
  if (avatarMediaPath) profile.avatarMediaPath = avatarMediaPath;
  const chatBackgroundMediaPath = normalizeOptionalString(value.chatBackgroundMediaPath);
  if (chatBackgroundMediaPath) profile.chatBackgroundMediaPath = chatBackgroundMediaPath;

  const lastOpenHanakoSyncAt = normalizeOptionalString(value.lastOpenHanakoSyncAt);
  if (lastOpenHanakoSyncAt) profile.lastOpenHanakoSyncAt = lastOpenHanakoSyncAt;

  if (typeof value.allowAutoMoments === 'boolean') {
    profile.allowAutoMoments = value.allowAutoMoments;
  }
  if (typeof value.allowProactiveDM === 'boolean') {
    profile.allowProactiveDM = value.allowProactiveDM;
  }

  return profile;
}

function legacyProfileMigrationEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean(
    (window as unknown as { __XINGYE_ALLOW_LEGACY_PROFILE_LOCAL_MIGRATE__?: boolean })
      .__XINGYE_ALLOW_LEGACY_PROFILE_LOCAL_MIGRATE__,
  );
}

function readLegacyRoleProfilesMap(): XingyeRoleProfileMap {
  if (!legacyProfileMigrationEnabled()) return {};
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(XINGYE_ROLE_PROFILES_LEGACY_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return {};
    const profiles: XingyeRoleProfileMap = {};
    for (const [id, value] of Object.entries(parsed)) {
      const normalized = normalizeProfile(value, id);
      if (normalized) profiles[normalized.agentId] = normalized;
    }
    return profiles;
  } catch {
    return {};
  }
}

function notifyXingyeRoleProfilesChanged(agentId: string) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(XINGYE_ROLE_PROFILES_CHANGED_EVENT, { detail: { agentId } }));
}

function requireServerForProfile(): void {
  if (!hasServerConnection(useStore.getState())) {
    throw new Error('未连接本地或远程服务器，无法读写 agent 目录下的人设文件。');
  }
}

/**
 * Reads `HANA_HOME/agents/{agentId}/xingye/profile.json`.
 * If missing, migrates at most once from legacy `localStorage` map `xingye.roleProfiles` for that agent, then writes `profile.json`.
 */
export async function readXingyeRoleProfile(agentId: string | null | undefined): Promise<XingyeRoleProfile | null> {
  const id = typeof agentId === 'string' ? agentId.trim() : '';
  if (!id) return null;
  if (!hasServerConnection(useStore.getState())) return null;

  try {
    const raw = await profileBackend.readJson<unknown>(id, XINGYE_PROFILE_JSON_RELATIVE_PATH);
    let normalized = raw != null ? normalizeProfile(raw, id) : null;
    if (normalized) return normalized;

    const legacy = readLegacyRoleProfilesMap()[id];
    const migrated = legacy ? normalizeProfile(legacy, id) : null;
    if (!migrated) return null;

    await profileBackend.writeJson(id, XINGYE_PROFILE_JSON_RELATIVE_PATH, migrated);
    notifyXingyeRoleProfilesChanged(id);
    return migrated;
  } catch (error) {
    console.warn('[xingye-profile-store] read profile failed:', error);
    return null;
  }
}

/**
 * Persists merged profile to `profile.json` for the agent via `/api/xingye/storage` (`writeJson`).
 */
export async function saveXingyeRoleProfile(
  agentId: string,
  patch: Partial<Omit<XingyeRoleProfile, 'agentId' | 'updatedAt'>>,
): Promise<XingyeRoleProfile> {
  const id = typeof agentId === 'string' ? agentId.trim() : '';
  if (!id) {
    throw new Error('保存人设需要有效的 agentId。');
  }
  requireServerForProfile();

  const existingRaw = await profileBackend.readJson<unknown>(id, XINGYE_PROFILE_JSON_RELATIVE_PATH);
  let previous = existingRaw != null ? normalizeProfile(existingRaw, id) : null;
  if (!previous) {
    const legacy = readLegacyRoleProfilesMap()[id];
    previous = legacy
      ? normalizeProfile(legacy, id)
      : { agentId: id, updatedAt: new Date(0).toISOString() };
  }
  if (!previous) {
    throw new Error('Unable to save Xingye role profile without agentId.');
  }

  const merged: Record<string, unknown> = { ...previous, ...patch, agentId: id, updatedAt: new Date().toISOString() };
  const next = normalizeProfile(merged, id);
  if (!next) {
    throw new Error('Unable to save Xingye role profile without agentId.');
  }

  try {
    await profileBackend.writeJson(id, XINGYE_PROFILE_JSON_RELATIVE_PATH, next);
  } catch (error) {
    console.warn('[xingye-profile-store] failed to save role profile:', error);
    throw error instanceof Error ? error : new Error(String(error));
  }

  notifyXingyeRoleProfilesChanged(id);
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

export function filterLoreEntriesForAgentSync(
  entries: XingyeLoreEntry[] | null | undefined,
): XingyeLoreEntry[] {
  if (!entries?.length) return [];
  return entries
    .filter((e) => e.enabled && e.insertionMode === 'always')
    .sort((a, b) => b.priority - a.priority || a.title.localeCompare(b.title));
}

export function buildOpenHanakoIdentity(
  agent: Pick<Agent, 'id' | 'name' | 'yuan'>,
  profile: SyncProfileInput,
): string {
  const display = getXingyeRoleProfileDisplay(agent, profile as XingyeRoleProfile | null | undefined);
  const displayName = truncateForOpenHanakoSync(display.displayName, OPENHANAKO_SYNC_MAX_DISPLAY_NAME);
  const relationship = resolveRelationship(display.relationshipLabel);
  const identitySummary = truncateForOpenHanakoSync(
    compactLine(display.identitySummary, DEFAULT_IDENTITY_SUMMARY),
    OPENHANAKO_SYNC_MAX_IDENTITY_FIELD,
  );
  const backgroundSummary = truncateForOpenHanakoSync(
    compactLine(display.backgroundSummary, DEFAULT_BACKGROUND_SUMMARY),
    OPENHANAKO_SYNC_MAX_IDENTITY_FIELD,
  );
  const shortBio = truncateForOpenHanakoSync(resolveRoleSummary(profile?.shortBio), OPENHANAKO_SYNC_MAX_IDENTITY_FIELD);

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
): string {
  const display = getXingyeRoleProfileDisplay(agent, profile as XingyeRoleProfile | null | undefined);
  const relationship = resolveRelationship(display.relationshipLabel);
  const speakingStyle = truncateForOpenHanakoSync(resolveSpeakingStyle(display.speakingStyle), OPENHANAKO_SYNC_MAX_ISHIKI_FIELD);
  const personalitySummary = truncateForOpenHanakoSync(
    compactLine(display.personalitySummary, DEFAULT_PERSONALITY_SUMMARY),
    OPENHANAKO_SYNC_MAX_ISHIKI_FIELD,
  );
  const behaviorLogic = truncateForOpenHanakoSync(
    compactLine(display.behaviorLogic, DEFAULT_BEHAVIOR_LOGIC),
    OPENHANAKO_SYNC_MAX_ISHIKI_FIELD,
  );
  const values = truncateForOpenHanakoSync(compactLine(display.values, DEFAULT_VALUES), OPENHANAKO_SYNC_MAX_ISHIKI_FIELD);
  const relationshipMode = truncateForOpenHanakoSync(
    compactLine(display.relationshipMode, DEFAULT_RELATIONSHIP_MODE),
    OPENHANAKO_SYNC_MAX_ISHIKI_FIELD,
  );
  const backgroundInfluence = truncateForOpenHanakoSync(
    compactLine(display.backgroundSummary, DEFAULT_BACKGROUND_SUMMARY),
    OPENHANAKO_SYNC_MAX_ISHIKI_FIELD,
  );
  const taboos = truncateForOpenHanakoSync(
    compactLine(display.taboos, '避免越过关系边界，避免把设定当作现实事实强行扩写。'),
    OPENHANAKO_SYNC_MAX_ISHIKI_FIELD,
  );
  const displayNameLine = truncateForOpenHanakoSync(display.displayName, OPENHANAKO_SYNC_MAX_DISPLAY_NAME);

  return [
    '# 人格与行动逻辑',
    '',
    `- 你是 ${displayNameLine}。`,
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
  _loreEntries?: XingyeLoreEntry[] | null,
): OpenHanakoAgentSyncPayload {
  void _loreEntries;
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
  const roleSummary = truncateForOpenHanakoSync(resolveRoleSummary(profile?.shortBio), OPENHANAKO_SYNC_MAX_ISHIKI_FIELD);
  const relationship = resolveRelationship(display.relationshipLabel);
  const speakingStyle = truncateForOpenHanakoSync(resolveSpeakingStyle(display.speakingStyle), OPENHANAKO_SYNC_MAX_ISHIKI_FIELD);
  const displayNameLine = truncateForOpenHanakoSync(display.displayName, OPENHANAKO_SYNC_MAX_DISPLAY_NAME);

  return {
    identity: buildOpenHanakoIdentity(agent, {
      ...(profile ?? {}),
      identitySummary: roleSummary,
      backgroundSummary: DEFAULT_BACKGROUND_SUMMARY,
    } as SyncProfileInput),
    ishiki: [
      '# 人格定义',
      '',
      '## 角色是谁',
      `- 你是 ${displayNameLine}，${roleSummary}`,
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

async function loadProfilesForAgentIds(agentIds: string[]): Promise<XingyeRoleProfileMap> {
  const unique = [...new Set(agentIds.map((x) => x.trim()).filter(Boolean))];
  const entries = await Promise.all(
    unique.map(async (id) => {
      const p = await readXingyeRoleProfile(id);
      return p ? ([id, p] as const) : null;
    }),
  );
  const map: XingyeRoleProfileMap = {};
  for (const e of entries) {
    if (e) map[e[0]] = e[1];
  }
  return map;
}

export function useXingyeRoleProfiles(): XingyeRoleProfileMap {
  const agents = useStore((s) => s.agents);
  const agentIds = useMemo(() => agents.map((a) => a.id), [agents]);
  const agentIdsKey = agentIds.join('\u0001');

  const [profiles, setProfiles] = useState<XingyeRoleProfileMap>({});

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const ids = useStore.getState().agents.map((a) => a.id);
      const next = await loadProfilesForAgentIds(ids);
      if (!cancelled) setProfiles(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [agentIdsKey]);

  useEffect(() => {
    const onChanged = () => {
      void (async () => {
        const ids = useStore.getState().agents.map((a) => a.id);
        setProfiles(await loadProfilesForAgentIds(ids));
      })();
    };
    if (typeof window === 'undefined') return undefined;
    window.addEventListener(XINGYE_ROLE_PROFILES_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(XINGYE_ROLE_PROFILES_CHANGED_EVENT, onChanged);
  }, []);

  return profiles;
}

export function useXingyeRoleProfile(agentId: string | null | undefined): XingyeRoleProfile | null {
  const trimmed = typeof agentId === 'string' ? agentId.trim() : '';
  const [profile, setProfile] = useState<XingyeRoleProfile | null>(null);

  useEffect(() => {
    if (!trimmed) {
      setProfile(null);
      return;
    }

    let cancelled = false;
    setProfile(null);

    void (async () => {
      const loaded = await readXingyeRoleProfile(trimmed);
      if (!cancelled) setProfile(loaded);
    })();

    return () => {
      cancelled = true;
    };
  }, [trimmed]);

  useEffect(() => {
    if (!trimmed) return undefined;

    const onChanged = (ev: Event) => {
      const detail = (ev as CustomEvent<{ agentId?: string }>).detail;
      if (detail?.agentId && detail.agentId !== trimmed) return;
      void (async () => {
        setProfile(await readXingyeRoleProfile(trimmed));
      })();
    };

    if (typeof window === 'undefined') return undefined;
    window.addEventListener(XINGYE_ROLE_PROFILES_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(XINGYE_ROLE_PROFILES_CHANGED_EVENT, onChanged);
  }, [trimmed]);

  return profile;
}
