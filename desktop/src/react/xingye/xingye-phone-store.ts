import { useEffect, useState } from 'react';
import type { Agent } from '../types';
import type { XingyeRoleProfileMap } from './xingye-profile-store';

export type XingyePhoneSource =
  | 'manual'
  | 'mock'
  | 'generated'
  | 'phone_sms'
  | 'phone_contacts';

export type XingyePhoneContactMeta = {
  ownerAgentId: string;
  targetAgentId: string;
  remark?: string;
  impression?: string;
  relationshipHint?: string;
  source?: XingyePhoneSource;
  updatedAt: string;
};

export type XingyePhoneSmsMessage = {
  id: string;
  threadId: string;
  fromAgentId: string;
  toAgentId: string;
  content: string;
  source?: XingyePhoneSource;
  createdAt: string;
};

export type XingyePhoneSmsThread = {
  id: string;
  ownerAgentId: string;
  targetAgentId: string;
  source?: XingyePhoneSource;
  messages: XingyePhoneSmsMessage[];
  updatedAt: string;
};

export type XingyePhoneContactView = {
  ownerAgentId: string;
  targetAgentId: string;
  targetName: string;
  targetDisplayName: string;
  remark: string;
  impression: string;
  relationshipHint?: string;
  source?: XingyePhoneSource;
  updatedAt?: string;
  agent: Agent;
};

export const XINGYE_PHONE_CONTACTS_STORAGE_KEY = 'xingye.phoneContacts';
export const XINGYE_PHONE_SMS_THREADS_STORAGE_KEY = 'xingye.phoneSmsThreads';

const XINGYE_PHONE_CHANGED_EVENT = 'xingye-phone-changed';

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

function createId(prefix: string): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function contactKey(ownerAgentId: string, targetAgentId: string): string {
  return `${ownerAgentId}::${targetAgentId}`;
}

function threadKey(ownerAgentId: string, targetAgentId: string): string {
  return `${ownerAgentId}::${targetAgentId}`;
}

function notifyXingyePhoneChanged() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(XINGYE_PHONE_CHANGED_EVENT));
}

function normalizeContactMeta(value: unknown): XingyePhoneContactMeta | null {
  if (!isRecord(value)) return null;
  const ownerAgentId = normalizeOptionalString(value.ownerAgentId);
  const targetAgentId = normalizeOptionalString(value.targetAgentId);
  if (!ownerAgentId || !targetAgentId) return null;

  return {
    ownerAgentId,
    targetAgentId,
    remark: normalizeOptionalString(value.remark),
    impression: normalizeOptionalString(value.impression),
    relationshipHint: normalizeOptionalString(value.relationshipHint),
    source: normalizeOptionalString(value.source) as XingyePhoneSource | undefined,
    updatedAt: normalizeOptionalString(value.updatedAt) ?? new Date(0).toISOString(),
  };
}

function normalizeSmsMessage(value: unknown): XingyePhoneSmsMessage | null {
  if (!isRecord(value)) return null;
  const id = normalizeOptionalString(value.id);
  const threadId = normalizeOptionalString(value.threadId);
  const fromAgentId = normalizeOptionalString(value.fromAgentId);
  const toAgentId = normalizeOptionalString(value.toAgentId);
  const content = normalizeOptionalString(value.content);
  if (!id || !threadId || !fromAgentId || !toAgentId || !content) return null;

  return {
    id,
    threadId,
    fromAgentId,
    toAgentId,
    content,
    source: normalizeOptionalString(value.source) as XingyePhoneSource | undefined,
    createdAt: normalizeOptionalString(value.createdAt) ?? new Date(0).toISOString(),
  };
}

function normalizeSmsThread(value: unknown): XingyePhoneSmsThread | null {
  if (!isRecord(value)) return null;
  const id = normalizeOptionalString(value.id);
  const ownerAgentId = normalizeOptionalString(value.ownerAgentId);
  const targetAgentId = normalizeOptionalString(value.targetAgentId);
  if (!id || !ownerAgentId || !targetAgentId) return null;

  const messages = Array.isArray(value.messages)
    ? value.messages
      .map(normalizeSmsMessage)
      .filter((item): item is XingyePhoneSmsMessage => Boolean(item))
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    : [];

  return {
    id,
    ownerAgentId,
    targetAgentId,
    source: normalizeOptionalString(value.source) as XingyePhoneSource | undefined,
    messages,
    updatedAt: normalizeOptionalString(value.updatedAt) ?? new Date(0).toISOString(),
  };
}

function loadContactMetaMap(storage: StorageLike | null = getLocalStorage()): Record<string, XingyePhoneContactMeta> {
  if (!storage) return {};
  try {
    const raw = storage.getItem(XINGYE_PHONE_CONTACTS_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return {};
    const result: Record<string, XingyePhoneContactMeta> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const item = normalizeContactMeta(value);
      if (item) result[key] = item;
    }
    return result;
  } catch (error) {
    console.warn('[xingye-phone-store] failed to load contacts:', error);
    return {};
  }
}

function saveContactMetaMap(next: Record<string, XingyePhoneContactMeta>, storage: StorageLike | null = getLocalStorage()) {
  storage?.setItem(XINGYE_PHONE_CONTACTS_STORAGE_KEY, JSON.stringify(next));
  notifyXingyePhoneChanged();
}

function loadSmsThreadMap(storage: StorageLike | null = getLocalStorage()): Record<string, XingyePhoneSmsThread> {
  if (!storage) return {};
  try {
    const raw = storage.getItem(XINGYE_PHONE_SMS_THREADS_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return {};
    const result: Record<string, XingyePhoneSmsThread> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const item = normalizeSmsThread(value);
      if (item) result[key] = item;
    }
    return result;
  } catch (error) {
    console.warn('[xingye-phone-store] failed to load sms threads:', error);
    return {};
  }
}

function saveSmsThreadMap(next: Record<string, XingyePhoneSmsThread>, storage: StorageLike | null = getLocalStorage()) {
  storage?.setItem(XINGYE_PHONE_SMS_THREADS_STORAGE_KEY, JSON.stringify(next));
  notifyXingyePhoneChanged();
}

export function getPhoneContactMeta(
  ownerAgentId: string,
  targetAgentId: string,
  storage: StorageLike | null = getLocalStorage(),
): XingyePhoneContactMeta | null {
  if (!ownerAgentId || !targetAgentId) return null;
  return loadContactMetaMap(storage)[contactKey(ownerAgentId, targetAgentId)] ?? null;
}

export function savePhoneContactMeta(
  ownerAgentId: string,
  targetAgentId: string,
  patch: Partial<Omit<XingyePhoneContactMeta, 'ownerAgentId' | 'targetAgentId' | 'updatedAt'>>,
  storage: StorageLike | null = getLocalStorage(),
): XingyePhoneContactMeta {
  const map = loadContactMetaMap(storage);
  const key = contactKey(ownerAgentId, targetAgentId);
  const previous = map[key];
  const next: XingyePhoneContactMeta = {
    ownerAgentId,
    targetAgentId,
    remark: normalizeOptionalString(patch.remark) ?? previous?.remark,
    impression: normalizeOptionalString(patch.impression) ?? previous?.impression,
    relationshipHint: normalizeOptionalString(patch.relationshipHint) ?? previous?.relationshipHint,
    source: patch.source ?? previous?.source ?? 'phone_contacts',
    updatedAt: new Date().toISOString(),
  };
  map[key] = next;
  saveContactMetaMap(map, storage);
  return next;
}

export function getPhoneContacts(
  ownerAgentId: string,
  agents: Agent[],
  profiles: XingyeRoleProfileMap,
  storage: StorageLike | null = getLocalStorage(),
): XingyePhoneContactView[] {
  if (!ownerAgentId) return [];
  return agents
    .filter(agent => agent.id !== ownerAgentId)
    .map((agent) => {
      const meta = getPhoneContactMeta(ownerAgentId, agent.id, storage);
      const displayName = profiles[agent.id]?.displayName || agent.name;
      return {
        ownerAgentId,
        targetAgentId: agent.id,
        targetName: agent.name,
        targetDisplayName: displayName,
        remark: meta?.remark ?? displayName,
        impression: meta?.impression ?? '还没有形成明确印象。',
        relationshipHint: meta?.relationshipHint,
        source: meta?.source,
        updatedAt: meta?.updatedAt,
        agent,
      };
    })
    .sort((a, b) => a.remark.localeCompare(b.remark, 'zh-Hans-CN'));
}

export function getSmsThreads(
  ownerAgentId: string,
  storage: StorageLike | null = getLocalStorage(),
): XingyePhoneSmsThread[] {
  if (!ownerAgentId) return [];
  return Object.values(loadSmsThreadMap(storage))
    .filter(thread => thread.ownerAgentId === ownerAgentId)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export function getSmsThread(
  ownerAgentId: string,
  targetAgentId: string,
  storage: StorageLike | null = getLocalStorage(),
): XingyePhoneSmsThread | null {
  if (!ownerAgentId || !targetAgentId) return null;
  return loadSmsThreadMap(storage)[threadKey(ownerAgentId, targetAgentId)] ?? null;
}

export function addMockSmsMessage(
  ownerAgentId: string,
  targetAgentId: string,
  content: string,
  direction: 'incoming' | 'outgoing',
  storage: StorageLike | null = getLocalStorage(),
): XingyePhoneSmsThread | null {
  const normalizedContent = content.trim();
  if (!ownerAgentId || !targetAgentId || !normalizedContent) return null;

  const map = loadSmsThreadMap(storage);
  const key = threadKey(ownerAgentId, targetAgentId);
  const previous = map[key];
  const threadId = previous?.id ?? createId('sms-thread');
  const message: XingyePhoneSmsMessage = {
    id: createId('sms-message'),
    threadId,
    fromAgentId: direction === 'outgoing' ? ownerAgentId : targetAgentId,
    toAgentId: direction === 'outgoing' ? targetAgentId : ownerAgentId,
    content: normalizedContent,
    source: 'mock',
    createdAt: new Date().toISOString(),
  };

  const next: XingyePhoneSmsThread = {
    id: threadId,
    ownerAgentId,
    targetAgentId,
    source: previous?.source ?? 'phone_sms',
    messages: [...(previous?.messages ?? []), message],
    updatedAt: message.createdAt,
  };
  map[key] = next;
  saveSmsThreadMap(map, storage);
  return next;
}

export function useXingyePhoneStorageVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onChanged = () => setVersion(prev => prev + 1);
    const onStorage = (event: StorageEvent) => {
      if (
        event.key === XINGYE_PHONE_CONTACTS_STORAGE_KEY
        || event.key === XINGYE_PHONE_SMS_THREADS_STORAGE_KEY
      ) {
        onChanged();
      }
    };
    window.addEventListener(XINGYE_PHONE_CHANGED_EVENT, onChanged);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(XINGYE_PHONE_CHANGED_EVENT, onChanged);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  return version;
}
