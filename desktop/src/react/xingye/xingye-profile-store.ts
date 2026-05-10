import { useEffect, useState } from 'react';
import type { Agent } from '../types';

export type XingyeRoleProfile = {
  agentId: string;
  displayName?: string;
  shortBio?: string;
  relationshipLabel?: string;
  speakingStyle?: string;
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
  avatarDataUrl?: string;
  chatBackgroundDataUrl?: string;
  allowAutoMoments: boolean;
  allowProactiveDM: boolean;
};

export const XINGYE_ROLE_PROFILES_STORAGE_KEY = 'xingye.roleProfiles';

const XINGYE_ROLE_PROFILES_CHANGED_EVENT = 'xingye-role-profiles-changed';

const STRING_FIELDS = [
  'displayName',
  'shortBio',
  'relationshipLabel',
  'speakingStyle',
  'avatarDataUrl',
  'chatBackgroundDataUrl',
] as const;

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

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
    shortBio: profile?.shortBio || `OpenHanako Agent: ${agent.yuan || agent.id}`,
    relationshipLabel: profile?.relationshipLabel,
    speakingStyle: profile?.speakingStyle,
    avatarDataUrl: profile?.avatarDataUrl,
    chatBackgroundDataUrl: profile?.chatBackgroundDataUrl,
    allowAutoMoments: profile?.allowAutoMoments ?? false,
    allowProactiveDM: profile?.allowProactiveDM ?? false,
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
