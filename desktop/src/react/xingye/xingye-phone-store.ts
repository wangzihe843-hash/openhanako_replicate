import { useEffect, useState } from 'react';
import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import type { XingyeRoleProfileMap } from './xingye-profile-store';
import { getXingyePersistenceStorage } from './xingye-persistence';
import {
  generateVirtualContactsForRole as generateRuleVirtualContacts,
  shouldBlockFamilyContacts as shouldBlockFamilyContactsRule,
  shouldSkipFamilyContacts as shouldSkipFamilyContactsRule,
} from './xingye-contact-generator';
import { appendXingyeEventOnce } from './xingye-event-log';

export type XingyeContactTargetType =
  | 'user'
  | 'agent'
  | 'virtual_contact'
  | 'channel'
  | 'tag'
  | 'faction';

export type XingyeContactStatus = 'active' | 'deleted' | 'blocked';

export type XingyeContactSource =
  | 'manual'
  | 'mock'
  | 'generated'
  | 'phone_contacts'
  | 'phone_sms'
  | 'channel'
  | 'system'
  | 'ai_generated'
  | 'rule_fallback';

export type XingyeVirtualContactKind =
  | 'friend'
  | 'family'
  | 'coworker'
  | 'classmate'
  | 'mentor'
  | 'rival'
  | 'enemy'
  | 'client'
  | 'patient'
  | 'informant'
  | 'superior'
  | 'subordinate'
  | 'ex'
  | 'neighbor'
  | 'unknown';

export type XingyeVirtualContact = {
  ownerAgentId: string;
  id: string;
  displayName: string;
  kind: XingyeVirtualContactKind;
  shortBio?: string;
  remark?: string;
  impression?: string;
  relationshipHint?: string;
  tags?: string[];
  faction?: string;
  status?: XingyeContactStatus;
  avatarDataUrl?: string;
  linkedAgentId?: string;
  source?: XingyeContactSource;
  generatedReason?: string;
  createdAt: string;
  updatedAt: string;
};

export type XingyePhoneContactMeta = {
  ownerAgentId: string;
  targetType: XingyeContactTargetType;
  targetId: string;
  remark?: string;
  impression?: string;
  relationshipHint?: string;
  tags?: string[];
  faction?: string;
  status?: XingyeContactStatus;
  linkedAgentId?: string;
  /** AI 新增、待「新的朋友」确认的虚拟联系人等 */
  pendingNewFriend?: boolean;
  manualEditedFields?: string[];
  source?: XingyeContactSource;
  updatedAt: string;
};

export type XingyePhoneSmsMessage = {
  id: string;
  threadId: string;
  fromAgentId: string;
  toAgentId: string;
  content: string;
  source?: XingyeContactSource;
  createdAt: string;
};

export type XingyePhoneSmsThread = {
  id: string;
  ownerAgentId: string;
  targetType: XingyeContactTargetType;
  targetId: string;
  source?: XingyeContactSource;
  messages: XingyePhoneSmsMessage[];
  updatedAt: string;
};

/** persisted lifecycle for virtual-contact AI / rule generation (not contact incremental updates). */
export type XingyePhoneContactGenerationRunStatus = 'running' | 'success' | 'failed';

export type XingyePhoneContactGenerationState = {
  ownerAgentId: string;
  generatedAt: string;
  profileFingerprint: string;
  /** Stable hash of profile + roster inputs for auto-run dedupe. */
  inputHash?: string;
  mode?: XingyeContactGenerationMode;
  version: number;
  status?: XingyePhoneContactGenerationRunStatus;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
};

export type XingyeContactGenerationMode = 'rule' | 'ai';

export type XingyeContactUpdateMode =
  | 'initial_ai_generate'
  | 'incremental_update'
  | 'regenerate_all'
  | 'rollback_and_update';

export type XingyeContactSnapshot = {
  ownerAgentId: string;
  id: string;
  createdAt: string;
  reason: string;
  virtualContacts: XingyeVirtualContact[];
  contactMeta: Record<string, XingyePhoneContactMeta>;
  generationState?: XingyePhoneContactGenerationState;
};

export type XingyeContactAiUpdateState = {
  ownerAgentId: string;
  mode: XingyeContactUpdateMode;
  status: 'idle' | 'running' | 'success' | 'failed';
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  version: number;
};

export type XingyeAiGeneratedContact = {
  targetType: 'virtual_contact';
  displayName: string;
  kind: XingyeVirtualContactKind;
  shortBio?: string;
  remark?: string;
  impression?: string;
  relationshipHint?: string;
  tags?: string[];
  faction?: string;
  status?: XingyeContactStatus;
  generatedReason: string;
};

export type XingyeAiContactUpdate = {
  action: 'add' | 'update' | 'delete' | 'block' | 'restore';
  targetType: 'user' | 'agent' | 'virtual_contact';
  targetId?: string;
  matchName?: string;
  contact?: XingyeAiGeneratedContact;
  patch?: Partial<XingyePhoneContactMeta>;
  reason: string;
};

export type XingyePhoneAiGenerationStatus = 'idle' | 'running' | 'success' | 'failed';

export type XingyePhoneAiGenerationState = {
  ownerAgentId: string;
  kind: 'contacts_enrichment' | 'sms_history';
  status: XingyePhoneAiGenerationStatus;
  startedAt?: string;
  finishedAt?: string;
  profileFingerprint: string;
  error?: string;
  version: number;
};

export type XingyeGeneratedSmsHistoryState = {
  ownerAgentId: string;
  generatedAt: string;
  profileFingerprint: string;
  contactsIncluded: {
    targetType: XingyeContactTargetType;
    targetId: string;
  }[];
  version: number;
};

export type XingyePhoneContactView = {
  ownerAgentId: string;
  targetType: XingyeContactTargetType;
  targetId: string;
  displayName: string;
  originalName: string;
  remark: string;
  impression: string;
  kind?: XingyeVirtualContactKind;
  shortBio?: string;
  relationshipHint?: string;
  tags: string[];
  faction?: string;
  status: XingyeContactStatus;
  linkedAgentId?: string;
  generatedReason?: string;
  source?: XingyeContactSource;
  updatedAt?: string;
  avatarDataUrl?: string;
  agent?: Agent;
  virtualContact?: XingyeVirtualContact;
  pendingNewFriend?: boolean;
};

export const XINGYE_PHONE_CONTACTS_STORAGE_KEY = 'xingye.phoneContacts';
/**
 * SMS threads：localStorage 中单 key 存整张 map（JSON）。每条线程与通讯录一致的 composite key：
 * `ownerAgentId::targetType::targetId`（见 `threadKey`）。Workspace v2 按 owner 分片到
 * `agents/<sanitizedAgentId>/phone/sms-threads.json`，同一 map 中仅保留该 owner 的条目。
 */
export const XINGYE_PHONE_SMS_THREADS_STORAGE_KEY = 'xingye.phoneSmsThreads';
export const XINGYE_PHONE_VIRTUAL_CONTACTS_STORAGE_KEY = 'xingye.phoneVirtualContacts';
export const XINGYE_PHONE_CONTACT_GENERATION_STATE_STORAGE_KEY = 'xingye.phoneContactGenerationState';
export const XINGYE_PHONE_AI_GENERATION_STATE_STORAGE_KEY = 'xingye.phoneAiGenerationState';
export const XINGYE_PHONE_SMS_HISTORY_GENERATION_STATE_STORAGE_KEY = 'xingye.phoneSmsHistoryGenerationState';
export const XINGYE_PHONE_CONTACT_SNAPSHOTS_STORAGE_KEY = 'xingye.phoneContactSnapshots';
/** 每个 owner 在 localStorage 中最多保留的通讯录快照条数（仅打点，非多份完整联系人副本）。更早的会在加载或新建快照时丢弃。 */
export const XINGYE_PHONE_CONTACT_SNAPSHOT_MAX = 2;
export const XINGYE_PHONE_CONTACT_AI_UPDATE_STATE_STORAGE_KEY = 'xingye.phoneContactAiUpdateState';
/** 通讯录实际变更流水，供短信增量补全消费（不依赖 updatedAt 猜测）。 */
export const XINGYE_PHONE_CONTACT_CHANGE_LOG_STORAGE_KEY = 'xingye.phone.contactChangeLog';

export type XingyeContactChangeField =
  | 'remark'
  | 'impression'
  | 'relationshipHint'
  | 'tags'
  | 'faction'
  | 'status'
  | 'linkedAgentId';

export type XingyeContactChangeLogItem = {
  id: string;
  ownerAgentId: string;
  targetType: XingyeContactTargetType;
  targetId: string;
  action: 'add' | 'update' | 'delete' | 'block' | 'restore';
  changedFields: XingyeContactChangeField[];
  reason: string;
  source: 'contacts_incremental_update' | 'contacts_rollback_update' | 'manual_edit';
  createdAt: string;
  consumedBySmsAt?: string;
};

const MAX_CONTACT_CHANGE_LOG_ITEMS = 2000;

const XINGYE_PHONE_CHANGED_EVENT = 'xingye-phone-changed';

/** If a run stays `running` past this window (crash / tab killed), auto/manual may recover. */
const PHONE_CONTACT_GENERATION_STALE_MS = 10 * 60 * 1000;

const virtualContactAiGenerationChains = new Map<string, Promise<unknown>>();

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function getLocalStorage(): StorageLike | null {
  return getXingyePersistenceStorage();
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

function appendXingyePhoneEventBestEffort(
  agentId: string,
  input: Parameters<typeof appendXingyeEventOnce>[1],
  dedupeKey: string,
) {
  void appendXingyeEventOnce(agentId, input, dedupeKey).catch((error) => {
    console.warn('[xingye-phone-store] failed to append Xingye event:', error);
  });
}

/**
 * 通讯录与 SMS threads 共用的 storage map 键；须与 `contactKey`/`threadKey` 保持一致（防漂移请改此处一处）。
 */
export function phoneCompositeMapKey(
  ownerAgentId: string,
  targetType: XingyeContactTargetType,
  targetId: string,
): string {
  return `${ownerAgentId}::${targetType}::${targetId}`;
}

function contactKey(ownerAgentId: string, targetType: XingyeContactTargetType, targetId: string): string {
  return phoneCompositeMapKey(ownerAgentId, targetType, targetId);
}

function threadKey(ownerAgentId: string, targetType: XingyeContactTargetType, targetId: string): string {
  return phoneCompositeMapKey(ownerAgentId, targetType, targetId);
}

function notifyXingyePhoneChanged() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(XINGYE_PHONE_CHANGED_EVENT));
}

function normalizeContactMeta(value: unknown): XingyePhoneContactMeta | null {
  if (!isRecord(value)) return null;
  const ownerAgentId = normalizeOptionalString(value.ownerAgentId);
  const targetType = normalizeOptionalString(value.targetType) as XingyeContactTargetType | undefined;
  const targetId = normalizeOptionalString(value.targetId);
  if (!ownerAgentId || !targetType || !targetId) return null;

  return {
    ownerAgentId,
    targetType,
    targetId,
    remark: normalizeOptionalString(value.remark),
    impression: normalizeOptionalString(value.impression),
    relationshipHint: normalizeOptionalString(value.relationshipHint),
    tags: Array.isArray(value.tags) ? value.tags.map(normalizeOptionalString).filter((item): item is string => Boolean(item)) : [],
    faction: normalizeOptionalString(value.faction),
    status: (normalizeOptionalString(value.status) as XingyeContactStatus | undefined) ?? 'active',
    linkedAgentId: normalizeOptionalString(value.linkedAgentId),
    manualEditedFields: Array.isArray(value.manualEditedFields)
      ? value.manualEditedFields.map(normalizeOptionalString).filter((item): item is string => Boolean(item))
      : [],
    pendingNewFriend: typeof value.pendingNewFriend === 'boolean' ? value.pendingNewFriend : undefined,
    source: normalizeOptionalString(value.source) as XingyeContactSource | undefined,
    updatedAt: normalizeOptionalString(value.updatedAt) ?? new Date(0).toISOString(),
  };
}

function normalizeVirtualContact(value: unknown): XingyeVirtualContact | null {
  if (!isRecord(value)) return null;
  const ownerAgentId = normalizeOptionalString(value.ownerAgentId);
  const id = normalizeOptionalString(value.id);
  const displayName = normalizeOptionalString(value.displayName);
  const kind = normalizeOptionalString(value.kind) as XingyeVirtualContactKind | undefined;
  if (!ownerAgentId || !id || !displayName || !kind) return null;
  return {
    ownerAgentId,
    id,
    displayName,
    kind,
    shortBio: normalizeOptionalString(value.shortBio),
    remark: normalizeOptionalString(value.remark),
    impression: normalizeOptionalString(value.impression),
    relationshipHint: normalizeOptionalString(value.relationshipHint),
    tags: Array.isArray(value.tags) ? value.tags.map(normalizeOptionalString).filter((item): item is string => Boolean(item)) : [],
    faction: normalizeOptionalString(value.faction),
    status: (normalizeOptionalString(value.status) as XingyeContactStatus | undefined) ?? 'active',
    avatarDataUrl: normalizeOptionalString(value.avatarDataUrl),
    linkedAgentId: normalizeOptionalString(value.linkedAgentId),
    source: normalizeOptionalString(value.source) as XingyeContactSource | undefined,
    generatedReason: normalizeOptionalString(value.generatedReason),
    createdAt: normalizeOptionalString(value.createdAt) ?? new Date(0).toISOString(),
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
    source: normalizeOptionalString(value.source) as XingyeContactSource | undefined,
    createdAt: normalizeOptionalString(value.createdAt) ?? new Date(0).toISOString(),
  };
}

function normalizeSmsThread(value: unknown): XingyePhoneSmsThread | null {
  if (!isRecord(value)) return null;
  const id = normalizeOptionalString(value.id);
  const ownerAgentId = normalizeOptionalString(value.ownerAgentId);
  const legacyTargetAgentId = normalizeOptionalString(value.targetAgentId);
  const targetType = (normalizeOptionalString(value.targetType) as XingyeContactTargetType | undefined)
    ?? (legacyTargetAgentId ? 'agent' : undefined);
  const targetId = normalizeOptionalString(value.targetId) ?? legacyTargetAgentId;
  if (!id || !ownerAgentId || !targetType || !targetId) return null;

  const messages = Array.isArray(value.messages)
    ? value.messages
      .map(normalizeSmsMessage)
      .filter((item): item is XingyePhoneSmsMessage => Boolean(item))
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    : [];

  return {
    id,
    ownerAgentId,
    targetType,
    targetId,
    source: normalizeOptionalString(value.source) as XingyeContactSource | undefined,
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

function loadVirtualContactMap(storage: StorageLike | null = getLocalStorage()): Record<string, XingyeVirtualContact> {
  if (!storage) return {};
  try {
    const raw = storage.getItem(XINGYE_PHONE_VIRTUAL_CONTACTS_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return {};
    const result: Record<string, XingyeVirtualContact> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const item = normalizeVirtualContact(value);
      if (item) result[key] = item;
    }
    return result;
  } catch (error) {
    console.warn('[xingye-phone-store] failed to load virtual contacts:', error);
    return {};
  }
}

function saveVirtualContactMap(next: Record<string, XingyeVirtualContact>, storage: StorageLike | null = getLocalStorage()) {
  storage?.setItem(XINGYE_PHONE_VIRTUAL_CONTACTS_STORAGE_KEY, JSON.stringify(next));
  notifyXingyePhoneChanged();
}

function loadGenerationStateMap(storage: StorageLike | null = getLocalStorage()): Record<string, XingyePhoneContactGenerationState> {
  if (!storage) return {};
  try {
    const raw = storage.getItem(XINGYE_PHONE_CONTACT_GENERATION_STATE_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return {};
    const result: Record<string, XingyePhoneContactGenerationState> = {};
    for (const [ownerAgentId, value] of Object.entries(parsed)) {
      if (!isRecord(value)) continue;
      const generatedAt = normalizeOptionalString(value.generatedAt);
      const startedAt = normalizeOptionalString(value.startedAt);
      const finishedAt = normalizeOptionalString(value.finishedAt);
      const profileFingerprint = normalizeOptionalString(value.profileFingerprint);
      const inputHash = normalizeOptionalString(value.inputHash);
      const mode = normalizeOptionalString(value.mode) as XingyeContactGenerationMode | undefined;
      const version = typeof value.version === 'number' ? value.version : 1;
      const statusRaw = normalizeOptionalString(value.status);
      const error = normalizeOptionalString(value.error);
      const allowed = new Set<string>(['running', 'success', 'failed']);
      const status = statusRaw && allowed.has(statusRaw) ? (statusRaw as XingyePhoneContactGenerationRunStatus) : undefined;
      if (!profileFingerprint) continue;
      const effectiveGeneratedAt = generatedAt || startedAt;
      if (!effectiveGeneratedAt) continue;
      /** Legacy rows had no `status`; treat as completed so auto-run does not loop forever. */
      const resolvedStatus: XingyePhoneContactGenerationRunStatus = status ?? 'success';
      result[ownerAgentId] = {
        ownerAgentId,
        generatedAt: effectiveGeneratedAt,
        profileFingerprint,
        inputHash,
        mode,
        version,
        status: resolvedStatus,
        startedAt,
        finishedAt,
        error,
      };
    }
    return result;
  } catch {
    return {};
  }
}

function saveGenerationStateMap(next: Record<string, XingyePhoneContactGenerationState>, storage: StorageLike | null = getLocalStorage()) {
  storage?.setItem(XINGYE_PHONE_CONTACT_GENERATION_STATE_STORAGE_KEY, JSON.stringify(next));
  notifyXingyePhoneChanged();
}

export function getPhoneContactGenerationState(
  ownerAgentId: string,
  storage: StorageLike | null = getLocalStorage(),
): XingyePhoneContactGenerationState | null {
  return loadGenerationStateMap(storage)[ownerAgentId] ?? null;
}

export function setPhoneContactGenerationState(
  ownerAgentId: string,
  state: XingyePhoneContactGenerationState,
  storage: StorageLike | null = getLocalStorage(),
) {
  const map = loadGenerationStateMap(storage);
  map[ownerAgentId] = state;
  saveGenerationStateMap(map, storage);
}

export function computePhoneContactGenerationInputHash(profileFingerprint: string, sortedAgentIds: string[]): string {
  return `${profileFingerprint}||${sortedAgentIds.join(',')}`;
}

export function isStalePhoneContactGenerationRunning(state: XingyePhoneContactGenerationState | null): boolean {
  if (!state || state.status !== 'running') return false;
  const t = state.startedAt ?? state.generatedAt;
  if (!t) return true;
  return Date.now() - new Date(t).getTime() > PHONE_CONTACT_GENERATION_STALE_MS;
}

/**
 * Auto-run guard for PhoneContactsApp: do not depend on unstable object deps; use fingerprint + inputHash.
 * - Active non-stale `running` → skip (persisted lock).
 * - `failed` → skip (user must use manual AI 按钮).
 * - Terminal success/rule with same fingerprint + inputHash → skip.
 */
export function shouldAutoSkipVirtualContactGeneration(
  ownerAgentId: string,
  profileFingerprint: string,
  inputHash: string,
  storage: StorageLike | null = getLocalStorage(),
): boolean {
  if (!ownerAgentId) return true;
  const s = getPhoneContactGenerationState(ownerAgentId, storage);
  if (!s) return false;
  if (s.status === 'running' && !isStalePhoneContactGenerationRunning(s)) return true;
  if (s.status === 'failed') return true;
  if (s.profileFingerprint !== profileFingerprint) return false;
  if (s.inputHash && s.inputHash !== inputHash) return false;
  if (s.status === 'success') return true;
  return false;
}

/** Serialize virtual-contact AI/rule generation per owner (no parallel runs in one JS context). */
export function withVirtualContactAiGenerationLock<T>(ownerAgentId: string, fn: () => Promise<T>): Promise<T> {
  if (!ownerAgentId.trim()) {
    return Promise.reject(new Error('withVirtualContactAiGenerationLock: ownerAgentId required'));
  }
  const previous = virtualContactAiGenerationChains.get(ownerAgentId) ?? Promise.resolve();
  const run = previous.then(
    () => undefined,
    () => undefined,
  ).then(() => fn());
  virtualContactAiGenerationChains.set(ownerAgentId, run);
  return run.finally(() => {
    if (virtualContactAiGenerationChains.get(ownerAgentId) === run) {
      virtualContactAiGenerationChains.delete(ownerAgentId);
    }
  }) as Promise<T>;
}

/** @internal vitest */
export function resetVirtualContactAiGenerationLockForTests(): void {
  virtualContactAiGenerationChains.clear();
}

function saveContactMetaMap(next: Record<string, XingyePhoneContactMeta>, storage: StorageLike | null = getLocalStorage()) {
  storage?.setItem(XINGYE_PHONE_CONTACTS_STORAGE_KEY, JSON.stringify(next));
  notifyXingyePhoneChanged();
}

function tagsEqual(a: string[] | undefined, b: string[] | undefined): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

function diffContactMetaForChangeLog(
  previous: XingyePhoneContactMeta | null,
  next: XingyePhoneContactMeta,
): XingyeContactChangeField[] {
  const keys: XingyeContactChangeField[] = [
    'remark',
    'impression',
    'relationshipHint',
    'tags',
    'faction',
    'status',
    'linkedAgentId',
  ];
  const out: XingyeContactChangeField[] = [];
  for (const k of keys) {
    if (k === 'tags') {
      if (!tagsEqual(previous?.tags, next.tags)) out.push(k);
      continue;
    }
    const pa = normalizeOptionalString(previous?.[k] as string | undefined);
    const pb = normalizeOptionalString(next[k] as string | undefined);
    if (pa !== pb) out.push(k);
  }
  return out;
}

function inferManualContactChangeAction(
  previous: XingyePhoneContactMeta | null,
  next: XingyePhoneContactMeta,
  changedFields: XingyeContactChangeField[],
): XingyeContactChangeLogItem['action'] {
  if (
    changedFields.length === 1
    && changedFields[0] === 'status'
    && previous?.status !== next.status
  ) {
    if (next.status === 'blocked') return 'block';
    if (next.status === 'deleted') return 'delete';
    if (next.status === 'active') return 'restore';
  }
  return 'update';
}

function normalizeChangeLogItem(value: unknown): XingyeContactChangeLogItem | null {
  if (!isRecord(value)) return null;
  const id = normalizeOptionalString(value.id);
  const ownerAgentId = normalizeOptionalString(value.ownerAgentId);
  const targetType = normalizeOptionalString(value.targetType) as XingyeContactTargetType | undefined;
  const targetId = normalizeOptionalString(value.targetId);
  const action = normalizeOptionalString(value.action);
  const reason = typeof value.reason === 'string' ? value.reason : '';
  const source = normalizeOptionalString(value.source);
  const createdAt = normalizeOptionalString(value.createdAt) ?? new Date(0).toISOString();
  const consumedBySmsAt = normalizeOptionalString(value.consumedBySmsAt);
  const allowedActions = new Set(['add', 'update', 'delete', 'block', 'restore']);
  const allowedSources = new Set(['contacts_incremental_update', 'contacts_rollback_update', 'manual_edit']);
  if (!id || !ownerAgentId || !targetType || !targetId || !action || !allowedActions.has(action)) return null;
  if (!source || !allowedSources.has(source)) return null;
  const changedFieldsRaw = Array.isArray(value.changedFields) ? value.changedFields : [];
  const allowedFields = new Set<XingyeContactChangeField>([
    'remark',
    'impression',
    'relationshipHint',
    'tags',
    'faction',
    'status',
    'linkedAgentId',
  ]);
  const changedFields = changedFieldsRaw
    .map(item => (typeof item === 'string' ? item.trim() : ''))
    .filter((item): item is XingyeContactChangeField => allowedFields.has(item as XingyeContactChangeField));
  return {
    id,
    ownerAgentId,
    targetType,
    targetId,
    action: action as XingyeContactChangeLogItem['action'],
    changedFields,
    reason,
    source: source as XingyeContactChangeLogItem['source'],
    createdAt,
    consumedBySmsAt,
  };
}

function loadContactChangeLog(storage: StorageLike | null = getLocalStorage()): XingyeContactChangeLogItem[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(XINGYE_PHONE_CONTACT_CHANGE_LOG_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeChangeLogItem).filter((item): item is XingyeContactChangeLogItem => !!item);
  } catch {
    return [];
  }
}

function persistContactChangeLog(items: XingyeContactChangeLogItem[], storage: StorageLike | null) {
  const s = storage ?? getLocalStorage();
  const trimmed = items.length > MAX_CONTACT_CHANGE_LOG_ITEMS ? items.slice(-MAX_CONTACT_CHANGE_LOG_ITEMS) : items;
  s?.setItem(XINGYE_PHONE_CONTACT_CHANGE_LOG_STORAGE_KEY, JSON.stringify(trimmed));
  notifyXingyePhoneChanged();
}

export function appendContactChangeLogItem(
  item: Omit<XingyeContactChangeLogItem, 'id' | 'createdAt'> & { id?: string; createdAt?: string },
  storage: StorageLike | null = getLocalStorage(),
): XingyeContactChangeLogItem {
  const full: XingyeContactChangeLogItem = {
    ...item,
    id: item.id ?? createId('cc-log'),
    createdAt: item.createdAt ?? new Date().toISOString(),
  };
  const items = loadContactChangeLog(storage);
  items.push(full);
  persistContactChangeLog(items, storage);
  appendXingyePhoneEventBestEffort(full.ownerAgentId, {
    type: 'phone.contact_changed',
    source: 'xingye-phone-store',
    subjectId: full.targetId,
    createdAt: full.createdAt,
    payload: {
      contactId: full.targetId,
      targetType: full.targetType,
      changedFields: full.changedFields,
      changeLogId: full.id,
      reason: full.reason,
      source: full.source,
      action: full.action,
      createdAt: full.createdAt,
    },
  }, `phone.contact_changed:${full.ownerAgentId}:${full.id}`);
  return full;
}

export function getUnconsumedContactChangesForSms(
  ownerAgentId: string,
  storage: StorageLike | null = getLocalStorage(),
): XingyeContactChangeLogItem[] {
  if (!ownerAgentId) return [];
  return loadContactChangeLog(storage).filter(
    item => item.ownerAgentId === ownerAgentId && !item.consumedBySmsAt && item.targetType !== 'user',
  );
}

export function markContactChangesConsumedBySms(
  ownerAgentId: string,
  changeIds: string[],
  storage: StorageLike | null = getLocalStorage(),
) {
  if (!ownerAgentId || !changeIds.length) return;
  const idSet = new Set(changeIds);
  const now = new Date().toISOString();
  const items = loadContactChangeLog(storage).map(item => {
    if (item.ownerAgentId === ownerAgentId && idSet.has(item.id)) {
      return { ...item, consumedBySmsAt: now };
    }
    return item;
  });
  persistContactChangeLog(items, storage);
}

function changedFieldsFromMetaSnapshot(meta: XingyePhoneContactMeta | null): XingyeContactChangeField[] {
  if (!meta) return [];
  const keys: XingyeContactChangeField[] = [
    'remark',
    'impression',
    'relationshipHint',
    'tags',
    'faction',
    'status',
    'linkedAgentId',
  ];
  return keys.filter((k) => {
    if (k === 'tags') return (meta.tags?.length ?? 0) > 0;
    return normalizeOptionalString(meta[k] as string | undefined) !== undefined;
  });
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
  targetType: XingyeContactTargetType,
  targetId: string,
  storage: StorageLike | null = getLocalStorage(),
): XingyePhoneContactMeta | null {
  if (!ownerAgentId || !targetId) return null;
  return loadContactMetaMap(storage)[contactKey(ownerAgentId, targetType, targetId)] ?? null;
}

function resolveUserContactTargetId(ownerAgentId: string, storage: StorageLike | null): string {
  const map = loadContactMetaMap(storage);
  const canonical = map[contactKey(ownerAgentId, 'user', '__user__')];
  if (canonical?.targetId) return canonical.targetId;
  const existing = Object.values(map).find(meta => meta.ownerAgentId === ownerAgentId && meta.targetType === 'user');
  return existing?.targetId ?? '__user__';
}

export function savePhoneContactMeta(
  ownerAgentId: string,
  targetType: XingyeContactTargetType,
  targetId: string,
  patch: Partial<Omit<XingyePhoneContactMeta, 'ownerAgentId' | 'targetType' | 'targetId' | 'updatedAt'>>,
  storage: StorageLike | null = getLocalStorage(),
  options?: { markManualFields?: boolean; skipContactChangeLog?: boolean },
): XingyePhoneContactMeta {
  if (!normalizeOptionalString(ownerAgentId)) {
    console.warn('[xingye-phone-store] savePhoneContactMeta: empty ownerAgentId, not persisted');
    return {
      ownerAgentId: ownerAgentId || '',
      targetType,
      targetId,
      remark: normalizeOptionalString(patch.remark),
      impression: normalizeOptionalString(patch.impression),
      relationshipHint: normalizeOptionalString(patch.relationshipHint),
      tags: patch.tags ?? [],
      faction: normalizeOptionalString(patch.faction),
      status: patch.status ?? 'active',
      linkedAgentId: normalizeOptionalString(patch.linkedAgentId),
      pendingNewFriend: patch.pendingNewFriend,
      manualEditedFields: [],
      source: patch.source ?? 'phone_contacts',
      updatedAt: new Date().toISOString(),
    };
  }
  const map = loadContactMetaMap(storage);
  const key = contactKey(ownerAgentId, targetType, targetId);
  const previous = map[key];
  const nextManualFields = new Set(previous?.manualEditedFields ?? []);
  if (options?.markManualFields !== false) {
    if (patch.remark !== undefined) nextManualFields.add('remark');
    if (patch.impression !== undefined) nextManualFields.add('impression');
    if (patch.relationshipHint !== undefined) nextManualFields.add('relationshipHint');
    if (patch.tags !== undefined) nextManualFields.add('tags');
    if (patch.faction !== undefined) nextManualFields.add('faction');
    if (patch.status !== undefined) nextManualFields.add('status');
  }
  const next: XingyePhoneContactMeta = {
    ownerAgentId,
    targetType,
    targetId,
    remark: normalizeOptionalString(patch.remark) ?? previous?.remark,
    impression: normalizeOptionalString(patch.impression) ?? previous?.impression,
    relationshipHint: normalizeOptionalString(patch.relationshipHint) ?? previous?.relationshipHint,
    tags: patch.tags ?? previous?.tags ?? [],
    faction: normalizeOptionalString(patch.faction) ?? previous?.faction,
    status: patch.status ?? previous?.status ?? 'active',
    linkedAgentId: normalizeOptionalString(patch.linkedAgentId) ?? previous?.linkedAgentId,
    pendingNewFriend: ('pendingNewFriend' in patch && patch.pendingNewFriend !== undefined)
      ? patch.pendingNewFriend
      : previous?.pendingNewFriend,
    manualEditedFields: [...nextManualFields],
    source: patch.source ?? previous?.source ?? 'phone_contacts',
    updatedAt: new Date().toISOString(),
  };
  map[key] = next;
  saveContactMetaMap(map, storage);
  if (options?.skipContactChangeLog !== true && options?.markManualFields !== false) {
    const changedFields = diffContactMetaForChangeLog(previous ?? null, next);
    if (changedFields.length > 0) {
      appendContactChangeLogItem({
        ownerAgentId,
        targetType,
        targetId,
        action: inferManualContactChangeAction(previous ?? null, next, changedFields),
        changedFields,
        reason: '用户在小手机通讯录中编辑',
        source: 'manual_edit',
      }, storage);
    }
  }
  return next;
}

export function preserveManualContactFields(
  existingMeta: XingyePhoneContactMeta | null,
  aiPatch: Partial<XingyePhoneContactMeta>,
): Partial<XingyePhoneContactMeta> {
  if (!existingMeta) return aiPatch;
  const manualFields = new Set(existingMeta.manualEditedFields ?? []);
  return {
    ...aiPatch,
    remark: manualFields.has('remark') ? existingMeta.remark : aiPatch.remark,
    impression: manualFields.has('impression') ? existingMeta.impression : aiPatch.impression,
    relationshipHint: manualFields.has('relationshipHint') ? existingMeta.relationshipHint : aiPatch.relationshipHint,
    tags: manualFields.has('tags') ? existingMeta.tags : aiPatch.tags,
    faction: manualFields.has('faction') ? existingMeta.faction : aiPatch.faction,
    status: manualFields.has('status') ? existingMeta.status : aiPatch.status,
    linkedAgentId: manualFields.has('linkedAgentId') ? existingMeta.linkedAgentId : aiPatch.linkedAgentId,
  };
}

const GENERATION_INSTRUCTION_PHRASES = [
  '增加一个',
  '新增一个',
  '添加一个',
  '生成一个',
  '补充一个',
  '强化',
  '体现',
  '用于',
  '根据设定',
  '根据资料',
  '符合',
  '作为角色',
  '角色设定',
  '戏剧张力',
  '功能',
  '模块',
  '可拉黑',
  '对立角色',
  '任务列表',
  '开发说明',
  '生成说明',
  'AI任务',
  '联系人列表',
];

export function looksLikeGenerationInstruction(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return GENERATION_INSTRUCTION_PHRASES.some(phrase => t.includes(phrase));
}

function truncateGraphemes(value: string, maxUnits: number): string {
  const chars = [...value];
  if (chars.length <= maxUnits) return value;
  return chars.slice(0, maxUnits).join('');
}

export type XingyeVisibleContactField =
  | 'displayName'
  | 'shortBio'
  | 'remark'
  | 'impression'
  | 'relationshipHint';

export function sanitizeVisibleContactText(
  value: string | undefined,
  _field: XingyeVisibleContactField,
): { clean?: string; spillToReason?: string } {
  if (value === undefined) return {};
  const trimmed = value.trim();
  if (!trimmed) return {};
  if (looksLikeGenerationInstruction(trimmed)) {
    return { spillToReason: trimmed };
  }
  return { clean: trimmed };
}

/** 与下方 XINGYE_DEFAULT_CONTACT_* 导出保持一致（不可在导出前引用那些常量，避免 TDZ）。 */
const CANONICAL_TAGS_LIST: string[] = ['亲近的人', '需要观察', '不可靠', '同伴', '危险'];
const CANONICAL_FACTIONS_LIST: string[] = ['自己人', '中立', '对立', '未知'];

function normalizeContactStatusValue(value: unknown): XingyeContactStatus {
  const s = typeof value === 'string' ? value.trim() : '';
  if (s === 'blocked' || s === 'deleted' || s === 'active') return s;
  return 'active';
}

/** 儿童向 / 全年龄日常等：拉黑可能极不合适，仅强制保留「已删除」类断联。 */
export function profileLikelyForbidsBlocked(
  profile: XingyeRoleProfile | null | undefined,
  agent: Agent | null | undefined,
): boolean {
  const t = [
    agent?.name,
    agent?.yuan,
    profile?.displayName,
    profile?.shortBio,
    profile?.identitySummary,
    profile?.backgroundSummary,
    profile?.personalitySummary,
  ].filter(Boolean).join(' ');
  if (!t.trim()) return false;
  const soft = /(幼儿园|小学低年级|子供向|全年龄|治愈系日常|轻松日常|校园甜文|萌系日常)/.test(t);
  const hard = /(黑|债|跟踪|骚扰|勒索|威胁|间谍|黑帮|杀手|边境|战|走私|卧底)/.test(t);
  return soft && !hard;
}

function tagSynonymToCanonical(tag: string): string | null {
  const t = tag.trim();
  if (!t) return null;
  if (CANONICAL_TAGS_LIST.includes(t)) return t;
  if (/危险|威胁|敌对|勒索/.test(t)) return '危险';
  if (/亲近|家人|信任|可靠/.test(t)) return '亲近的人';
  if (/同伴|搭档|队友|同事/.test(t)) return '同伴';
  if (/观察|留意|谨慎|线人|灰色/.test(t)) return '需要观察';
  if (/不可靠|不可信|滑头|两面/.test(t)) return '不可靠';
  return null;
}

/** 将模型返回的 tags 映射到固定词表，去掉无效项。 */
export function canonicalizeContactTags(tags: string[] | undefined): string[] {
  const out: string[] = [];
  for (const raw of tags ?? []) {
    const c = tagSynonymToCanonical(typeof raw === 'string' ? raw : '');
    if (c && !out.includes(c)) out.push(c);
  }
  return out.slice(0, 3);
}

function normalizeUserContactTags(tags: string[] | undefined): string[] {
  const out: string[] = [];
  for (const raw of tags ?? []) {
    const tag = typeof raw === 'string' ? raw.trim() : '';
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out.slice(0, 3);
}

function factionSynonymToCanonical(f: string): string | null {
  const t = f.trim();
  if (!t) return null;
  if (CANONICAL_FACTIONS_LIST.includes(t)) return t;
  if (/自己|己方|可信|家人|搭档/.test(t)) return '自己人';
  if (/对立|敌|反派|勒索|威胁/.test(t)) return '对立';
  if (/中立|路人|普通|灰色/.test(t)) return '中立';
  if (/未知|不明|不确定|匿名/.test(t)) return '未知';
  return null;
}

export function canonicalizeFaction(faction: string | undefined): string | undefined {
  if (!faction?.trim()) return undefined;
  return factionSynonymToCanonical(faction) ?? undefined;
}

export function inferTagsForContact(contact: Pick<XingyeAiGeneratedContact, 'kind' | 'status' | 'faction' | 'shortBio'>): string[] {
  const k = contact.kind;
  const bio = (contact.shortBio ?? '').trim();
  const fc = contact.faction ?? '';
  const tags: string[] = [];
  const push = (t: string) => {
    if (CANONICAL_TAGS_LIST.includes(t) && !tags.includes(t)) tags.push(t);
  };
  if (k === 'enemy' || k === 'rival') {
    push('危险');
    push('不可靠');
  } else if (k === 'informant') {
    push('需要观察');
    push('不可靠');
  } else if (k === 'friend' || k === 'family') {
    push('亲近的人');
    if (bio.length > 8) push('同伴');
  } else if (k === 'coworker' || k === 'superior' || k === 'subordinate') {
    push('同伴');
    push('需要观察');
  } else if (k === 'patient' || k === 'client') {
    push('需要观察');
    if (k === 'patient') push('同伴');
  } else if (k === 'ex') {
    push('需要观察');
    push('亲近的人');
  } else if (k === 'neighbor' || k === 'classmate') {
    push('同伴');
  } else if (k === 'mentor') {
    push('同伴');
    push('需要观察');
  } else {
    push('需要观察');
    push('同伴');
  }
  if (fc === '对立' && !tags.includes('危险')) push('危险');
  if (contact.status === 'blocked' && !tags.includes('危险')) push('危险');
  return tags.slice(0, 3);
}

export function inferFactionForContact(
  contact: Pick<XingyeAiGeneratedContact, 'kind' | 'tags' | 'status' | 'shortBio'>,
): string {
  const k = contact.kind;
  const tagStr = (contact.tags ?? []).join('');
  if (k === 'enemy' || k === 'rival' || tagStr.includes('危险')) return '对立';
  if (k === 'friend' || k === 'family' || tagStr.includes('亲近的人')) return '自己人';
  if (k === 'informant' || k === 'unknown') return '中立';
  if (k === 'patient' || k === 'neighbor' || k === 'classmate' || k === 'client') return '中立';
  if (k === 'coworker' || k === 'superior' || k === 'subordinate' || k === 'mentor') return '自己人';
  if (k === 'ex') return '中立';
  return '中立';
}

function scoreForBlocked(contact: XingyeAiGeneratedContact): number {
  let s = 0;
  const kinds: XingyeVirtualContactKind[] = ['enemy', 'rival', 'informant', 'unknown'];
  if (kinds.includes(contact.kind)) s += 6;
  if ((contact.tags ?? []).includes('危险')) s += 5;
  if ((contact.tags ?? []).includes('不可靠')) s += 3;
  if (contact.faction === '对立') s += 4;
  if (contact.kind === 'ex') s += 2;
  return s;
}

function scoreForDeleted(contact: XingyeAiGeneratedContact): number {
  let s = 0;
  if (contact.kind === 'ex') s += 8;
  if (contact.kind === 'patient' || contact.kind === 'client') s += 5;
  if (contact.kind === 'coworker' || contact.kind === 'subordinate') s += 3;
  if (contact.kind === 'neighbor' || contact.kind === 'classmate') s += 2;
  if (contact.kind === 'unknown') s += 4;
  if ((contact.tags ?? []).includes('需要观察') && contact.faction === '中立') s += 1;
  return s;
}

/**
 * 仅「重新生成全部」：若本批仍无任何 blocked/deleted，则最多把 **一条** active 改为 blocked 或 deleted（二者择一，与初次生成分离）。
 */
function ensureMinimumNonActiveContactsForRegenerate(
  contacts: XingyeAiGeneratedContact[],
  profileAllowsNoBlocked?: boolean,
): void {
  if (contacts.length === 0) return;

  const st = (c: XingyeAiGeneratedContact) => normalizeContactStatusValue(c.status);
  const hasNonActive = contacts.some(c => st(c) === 'blocked' || st(c) === 'deleted');
  if (hasNonActive) return;

  const pickBestActive = (scorer: (c: XingyeAiGeneratedContact) => number): number => {
    let best = -1;
    let bestScore = -1;
    contacts.forEach((c, i) => {
      if (st(c) !== 'active') return;
      const s = scorer(c);
      if (s > bestScore) {
        bestScore = s;
        best = i;
      }
    });
    return best;
  };

  const firstActive = (): number => contacts.findIndex(c => st(c) === 'active');

  if (profileAllowsNoBlocked) {
    const i = pickBestActive(scoreForDeleted);
    const idx = i >= 0 ? i : firstActive();
    if (idx >= 0) contacts[idx].status = 'deleted';
    return;
  }

  const bi = pickBestActive(scoreForBlocked);
  const di = pickBestActive(scoreForDeleted);
  const bs = bi >= 0 ? scoreForBlocked(contacts[bi]) : -1;
  const ds = di >= 0 ? scoreForDeleted(contacts[di]) : -1;

  if (bi < 0 && di < 0) {
    const idx = firstActive();
    if (idx >= 0) contacts[idx].status = 'deleted';
    return;
  }

  if (bi === di) {
    const idx = bi;
    contacts[idx].status = bs >= ds ? 'blocked' : 'deleted';
    return;
  }

  if (bs >= ds && bi >= 0) {
    contacts[bi].status = 'blocked';
    return;
  }
  if (di >= 0) {
    contacts[di].status = 'deleted';
    return;
  }
  if (bi >= 0) contacts[bi].status = 'blocked';
}

/** 与 `ensureContactDistribution` 第二参数配合：仅 regenerate 会触发非 active 保底。 */
export type XingyeContactDistributionContext = {
  intent: 'initial' | 'regenerate';
  profileAllowsNoBlocked?: boolean;
};

/** 避免阵营几乎全是「未知」。 */
function ensureFactionVariety(contacts: XingyeAiGeneratedContact[]): void {
  if (contacts.length < 3) return;
  const unknownIdx = contacts
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => (canonicalizeFaction(c.faction) ?? '未知') === '未知');
  const ratio = unknownIdx.length / contacts.length;
  if (ratio <= 0.45) return;
  unknownIdx.forEach(({ c, i }, n) => {
    if (n % 2 === 1) return;
    const k = c.kind;
    if (k === 'enemy' || k === 'rival') c.faction = '对立';
    else if (k === 'friend' || k === 'family') c.faction = '自己人';
    else c.faction = '中立';
  });
}

/** 避免所有联系人都只有「需要观察」。 */
function ensureTagDiversity(contacts: XingyeAiGeneratedContact[]): void {
  if (contacts.length < 2) return;
  const allOnlyObserve = contacts.every(c => {
    const t = canonicalizeContactTags(c.tags);
    return t.length === 1 && t[0] === '需要观察';
  });
  if (!allOnlyObserve) return;
  contacts.forEach((c, i) => {
    const alt: XingyeVirtualContactKind[] = ['friend', 'coworker', 'patient', 'enemy', 'ex', 'neighbor'];
    const pseudoKind = alt[i % alt.length];
    c.tags = inferTagsForContact({ ...c, kind: pseudoKind });
    if (c.tags.length < 2) c.tags = [i % 2 === 0 ? '同伴' : '亲近的人', '需要观察'].filter((t, j, a) => a.indexOf(t) === j).slice(0, 2);
  });
}

/**
 * 对一批即将写入的 AI 虚拟联系人做词表与阵营规范化。
 * - `initial`：不修改模型给出的 status（与「AI 生成联系人」prompt 一致，不本地硬凑 blocked/deleted）。
 * - `regenerate`：在规范化后调用保底，若仍无任何拉黑/已删除则**至多改一条** active 为 blocked 或 deleted（见 `ensureMinimumNonActiveContactsForRegenerate`）。
 */
export function ensureContactDistribution(
  contacts: XingyeAiGeneratedContact[],
  ctx?: XingyeContactDistributionContext,
): XingyeAiGeneratedContact[] {
  if (!contacts.length) return contacts;
  const out = contacts.map(c => ({ ...c, targetType: 'virtual_contact' as const }));
  for (const c of out) {
    c.status = normalizeContactStatusValue(c.status);
    let tags = canonicalizeContactTags(c.tags);
    if (!tags.length) tags = inferTagsForContact(c);
    c.tags = tags.slice(0, 3);
    c.faction = canonicalizeFaction(c.faction) ?? inferFactionForContact(c);
    if (!c.relationshipHint?.trim() && c.status === 'blocked') c.relationshipHint = '已拉黑';
    if (!c.relationshipHint?.trim() && c.status === 'deleted') c.relationshipHint = '已断联';
  }
  ensureFactionVariety(out);
  ensureTagDiversity(out);
  if (ctx?.intent === 'regenerate') {
    ensureMinimumNonActiveContactsForRegenerate(out, ctx.profileAllowsNoBlocked);
  }
  return out;
}

/** 增量更新后：为仍缺 tags/faction 的虚拟联系人补全（不覆盖 manual）。 */
export function reconcileVirtualContactInferenceFields(
  ownerAgentId: string,
  agents: Agent[],
  profiles: XingyeRoleProfileMap,
  storage: StorageLike | null = getLocalStorage(),
) {
  const views = getPhoneContacts(ownerAgentId, agents, profiles, { includeDeleted: true }, storage)
    .filter(v => v.targetType === 'virtual_contact');
  for (const v of views) {
    const meta = getPhoneContactMeta(ownerAgentId, 'virtual_contact', v.targetId, storage);
    const manual = new Set(meta?.manualEditedFields ?? []);
    const shape: XingyeAiGeneratedContact = {
      targetType: 'virtual_contact',
      displayName: v.displayName,
      kind: v.kind ?? 'unknown',
      shortBio: v.shortBio,
      tags: v.tags,
      faction: v.faction,
      status: v.status,
      generatedReason: v.generatedReason ?? '',
    };
    let tags = canonicalizeContactTags(v.tags);
    if (!tags.length && !manual.has('tags')) tags = inferTagsForContact(shape);
    let faction = canonicalizeFaction(v.faction) ?? (manual.has('faction') ? v.faction : inferFactionForContact({ ...shape, tags }));
    if (!faction) faction = inferFactionForContact({ ...shape, tags });
    const patch: Partial<XingyePhoneContactMeta> = {};
    if (!manual.has('tags') && tags.length && JSON.stringify(tags) !== JSON.stringify(v.tags ?? [])) patch.tags = tags;
    if (!manual.has('faction') && faction && faction !== v.faction) patch.faction = faction;
    if (Object.keys(patch).length) {
      savePhoneContactMeta(ownerAgentId, 'virtual_contact', v.targetId, { ...patch, source: 'ai_generated' }, storage, { markManualFields: false });
    }
    if (!manual.has('tags') || !manual.has('faction')) {
      const vc = v.virtualContact;
      if (vc) {
        const nextVc: XingyeVirtualContact = {
          ...vc,
          tags: manual.has('tags') ? vc.tags : (tags.length ? tags : vc.tags),
          faction: manual.has('faction') ? vc.faction : (faction ?? vc.faction),
          updatedAt: new Date().toISOString(),
        };
        if (nextVc.tags?.length !== vc.tags?.length || nextVc.faction !== vc.faction) {
          saveVirtualContact(ownerAgentId, nextVc, storage);
        }
      }
    }
  }
}

export function normalizeAiGeneratedContact(contact: XingyeAiGeneratedContact): XingyeAiGeneratedContact {
  const reasons: string[] = [];
  if (contact.generatedReason?.trim()) reasons.push(contact.generatedReason.trim());

  const mergeSpill = (spill?: string) => {
    if (spill) reasons.push(`[模型误入可见字段] ${spill}`);
  };

  const takeVisible = (raw: string | undefined, field: XingyeVisibleContactField, maxLen: number) => {
    const { clean, spillToReason } = sanitizeVisibleContactText(raw, field);
    mergeSpill(spillToReason);
    if (!clean) return undefined;
    return truncateGraphemes(clean, maxLen);
  };

  let displayName = takeVisible(contact.displayName, 'displayName', 12) ?? '';
  if (!displayName) displayName = '未命名联系人';

  const shortBio = takeVisible(contact.shortBio, 'shortBio', 40);
  const remark = takeVisible(contact.remark, 'remark', 12);
  let impression = takeVisible(contact.impression, 'impression', 60);
  const relationshipHint = takeVisible(contact.relationshipHint, 'relationshipHint', 24);

  if (!impression?.trim() && !shortBio?.trim()) {
    impression = '还没有形成明确印象。';
  }

  const rawGenerated = contact.generatedReason?.trim();
  if (rawGenerated && impression?.trim() && impression.trim() === rawGenerated) {
    impression = shortBio?.trim()
      ? truncateGraphemes(shortBio.trim(), 60)
      : '还没有形成明确印象。';
    reasons.push('[impression 与生成依据重复，已改写]');
  }

  let tags = canonicalizeContactTags((contact.tags ?? []).map(tag => String(tag).trim()).filter(Boolean));
  const inferBase: Pick<XingyeAiGeneratedContact, 'kind' | 'status' | 'faction' | 'shortBio'> = {
    kind: contact.kind,
    status: normalizeContactStatusValue(contact.status),
    faction: contact.faction,
    shortBio: contact.shortBio ?? shortBio,
  };
  if (!tags.length) tags = inferTagsForContact(inferBase);

  let faction = canonicalizeFaction(
    contact.faction?.trim() ? truncateGraphemes(contact.faction.trim(), 20) : undefined,
  ) ?? inferFactionForContact({
    kind: contact.kind,
    tags,
    status: normalizeContactStatusValue(contact.status),
    shortBio: contact.shortBio ?? shortBio,
  });

  const status = normalizeContactStatusValue(contact.status);

  const generatedReason = reasons.filter(Boolean).join('；') || 'AI 生成';

  return {
    ...contact,
    displayName,
    shortBio,
    remark,
    impression,
    relationshipHint,
    tags: tags.slice(0, 3),
    faction,
    status,
    generatedReason,
  };
}

export function normalizeAiContactUpdate(update: XingyeAiContactUpdate): XingyeAiContactUpdate {
  const next: XingyeAiContactUpdate = { ...update };
  if (next.contact) {
    next.contact = normalizeAiGeneratedContact(next.contact);
  }
  if (next.patch) {
    const patch = { ...next.patch };
    const spillBits: string[] = [];
    (['remark', 'impression', 'relationshipHint'] as const).forEach((key) => {
      const raw = patch[key];
      if (typeof raw !== 'string') return;
      const { clean, spillToReason } = sanitizeVisibleContactText(raw, key);
      if (spillToReason) spillBits.push(`${key}: ${spillToReason}`);
      if (clean) patch[key] = truncateGraphemes(clean, key === 'impression' ? 60 : 12);
      else delete patch[key];
    });
    if (Array.isArray(patch.tags)) {
      let t = next.targetType === 'user'
        ? normalizeUserContactTags(patch.tags)
        : canonicalizeContactTags(patch.tags);
      if (!t.length && next.contact) t = inferTagsForContact(next.contact);
      patch.tags = t;
    }
    if (typeof patch.faction === 'string') {
      const trimmed = patch.faction.trim();
      if (!trimmed) {
        delete patch.faction;
      } else {
        const f = canonicalizeFaction(trimmed);
        patch.faction = f ?? inferFactionForContact({
          kind: next.contact?.kind ?? 'unknown',
          tags: patch.tags ?? next.contact?.tags,
          status: (patch.status as XingyeContactStatus | undefined) ?? next.contact?.status ?? 'active',
          shortBio: next.contact?.shortBio,
        });
      }
    }
    if (patch.status !== undefined) {
      patch.status = normalizeContactStatusValue(patch.status);
    }
    if (spillBits.length) {
      const extra = `[误入 patch 的说明] ${spillBits.join('；')}`;
      next.reason = next.reason?.trim() ? `${next.reason.trim()}；${extra}` : extra;
    }
    next.patch = patch;
  }
  return next;
}

export function sanitizeEnrichmentSuggestionFields(suggestion: {
  remark?: string;
  impression?: string;
  relationshipHint?: string;
}): typeof suggestion {
  const out = { ...suggestion };
  (['remark', 'impression', 'relationshipHint'] as const).forEach((key) => {
    const raw = out[key];
    if (typeof raw !== 'string') return;
    const { clean, spillToReason } = sanitizeVisibleContactText(raw, key);
    if (spillToReason) delete out[key];
    else if (clean) out[key] = truncateGraphemes(clean, key === 'impression' ? 60 : 12);
    else delete out[key];
  });
  return out;
}

export function getPhoneContactListTitle(contact: XingyePhoneContactView): string {
  const remark = contact.remark?.trim();
  if (remark) return remark;
  return contact.displayName?.trim() || '联系人';
}

export function getPhoneContactListSubtitle(contact: XingyePhoneContactView): string {
  const impression = contact.impression?.trim();
  if (impression && !looksLikeGenerationInstruction(impression)) return impression;
  const bio = contact.shortBio?.trim();
  if (bio && !looksLikeGenerationInstruction(bio)) return bio;
  if (impression) return impression;
  if (bio) return bio;
  if (contact.targetType === 'virtual_contact') return '虚拟联系人';
  return `${contact.targetType} · ${contact.status}`;
}

export function getPhoneContactListMeta(contact: XingyePhoneContactView): string {
  return `${contact.targetType} · ${contact.status}`;
}

export function markContactFieldManual(
  ownerAgentId: string,
  targetType: XingyeContactTargetType,
  targetId: string,
  field: 'remark' | 'impression' | 'relationshipHint' | 'tags' | 'faction' | 'status' | 'linkedAgentId',
  storage: StorageLike | null = getLocalStorage(),
) {
  const map = loadContactMetaMap(storage);
  const key = contactKey(ownerAgentId, targetType, targetId);
  const previous = map[key];
  const nextManualFields = new Set(previous?.manualEditedFields ?? []);
  nextManualFields.add(field);
  map[key] = {
    ownerAgentId,
    targetType,
    targetId,
    remark: previous?.remark,
    impression: previous?.impression,
    relationshipHint: previous?.relationshipHint,
    tags: previous?.tags ?? [],
    faction: previous?.faction,
    status: previous?.status ?? 'active',
    linkedAgentId: previous?.linkedAgentId,
    pendingNewFriend: previous?.pendingNewFriend,
    manualEditedFields: [...nextManualFields],
    source: previous?.source ?? 'manual',
    updatedAt: new Date().toISOString(),
  };
  saveContactMetaMap(map, storage);
}

export function blockPhoneContact(ownerAgentId: string, targetType: XingyeContactTargetType, targetId: string) {
  return savePhoneContactMeta(ownerAgentId, targetType, targetId, { status: 'blocked', source: 'manual' }, undefined, { markManualFields: true });
}

export function deletePhoneContact(ownerAgentId: string, targetType: XingyeContactTargetType, targetId: string) {
  return savePhoneContactMeta(ownerAgentId, targetType, targetId, { status: 'deleted', source: 'manual' }, undefined, { markManualFields: true });
}

export function restorePhoneContact(ownerAgentId: string, targetType: XingyeContactTargetType, targetId: string) {
  return savePhoneContactMeta(ownerAgentId, targetType, targetId, { status: 'active', source: 'manual' }, undefined, { markManualFields: true });
}

/** 取消拉黑，与 restorePhoneContact 相同：将 status 置为 active。 */
export function unblockPhoneContact(ownerAgentId: string, targetType: XingyeContactTargetType, targetId: string) {
  return restorePhoneContact(ownerAgentId, targetType, targetId);
}

/** 保证当前 owner 下存在 user 元数据（__user__ / 「你」），且 v1 不允许 user 处于 blocked/deleted。不覆盖已有 remark/impression/tags/faction。 */
export function ensureDefaultUserContact(ownerAgentId: string, storage: StorageLike | null = getLocalStorage()) {
  if (!ownerAgentId) return;
  const meta = getPhoneContactMeta(ownerAgentId, 'user', '__user__', storage);
  if (!meta) {
    savePhoneContactMeta(
      ownerAgentId,
      'user',
      '__user__',
      {
        remark: '你',
        impression: '还没有形成明确印象。',
        tags: [],
        status: 'active',
        source: 'system',
      },
      storage,
      { markManualFields: false },
    );
    return;
  }
  if (meta.status === 'blocked' || meta.status === 'deleted') {
    savePhoneContactMeta(
      ownerAgentId,
      'user',
      '__user__',
      { status: 'active', source: meta.source ?? 'system' },
      storage,
      { markManualFields: false },
    );
  }
}

export function getDefaultUserContact(ownerAgentId: string, storage: StorageLike | null = getLocalStorage()): XingyePhoneContactView {
  ensureDefaultUserContact(ownerAgentId, storage);
  const meta = getPhoneContactMeta(ownerAgentId, 'user', '__user__', storage);
  return {
    ownerAgentId,
    targetType: 'user',
    targetId: '__user__',
    displayName: '你',
    originalName: '你',
    remark: meta?.remark ?? '你',
    impression: meta?.impression ?? '还没有形成明确印象。',
    relationshipHint: meta?.relationshipHint,
    tags: meta?.tags ?? [],
    faction: meta?.faction,
    status: meta?.status ?? 'active',
    linkedAgentId: meta?.linkedAgentId,
    source: meta?.source ?? 'system',
    updatedAt: meta?.updatedAt,
    pendingNewFriend: meta?.pendingNewFriend,
  };
}

export function getVirtualContacts(ownerAgentId: string, storage: StorageLike | null = getLocalStorage()): XingyeVirtualContact[] {
  return Object.values(loadVirtualContactMap(storage))
    .filter(item => item.ownerAgentId === ownerAgentId)
    .sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh-Hans-CN'));
}

export function saveVirtualContact(ownerAgentId: string, contact: XingyeVirtualContact, storage: StorageLike | null = getLocalStorage()): XingyeVirtualContact {
  const map = loadVirtualContactMap(storage);
  const now = new Date().toISOString();
  const next: XingyeVirtualContact = {
    ...contact,
    ownerAgentId,
    id: contact.id || createId('vc'),
    updatedAt: now,
    createdAt: contact.createdAt || now,
  };
  map[`${ownerAgentId}::${next.id}`] = next;
  saveVirtualContactMap(map, storage);
  return next;
}

function loadContactSnapshotsMap(storage: StorageLike | null = getLocalStorage()): Record<string, XingyeContactSnapshot[]> {
  if (!storage) return {};
  try {
    const raw = storage.getItem(XINGYE_PHONE_CONTACT_SNAPSHOTS_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return {};
    const map: Record<string, XingyeContactSnapshot[]> = {};
    let mutated = false;
    for (const [ownerAgentId, value] of Object.entries(parsed)) {
      if (!Array.isArray(value)) continue;
      let arr = value.filter((snapshot): snapshot is XingyeContactSnapshot => (
        isRecord(snapshot)
        && typeof snapshot.id === 'string'
        && typeof snapshot.createdAt === 'string'
        && typeof snapshot.reason === 'string'
        && Array.isArray(snapshot.virtualContacts)
        && isRecord(snapshot.contactMeta)
      )) as XingyeContactSnapshot[];
      if (arr.length > XINGYE_PHONE_CONTACT_SNAPSHOT_MAX) {
        arr = arr.slice(-XINGYE_PHONE_CONTACT_SNAPSHOT_MAX);
        mutated = true;
      }
      map[ownerAgentId] = arr;
    }
    if (mutated && storage) {
      saveContactSnapshotsMap(map, storage);
    }
    return map;
  } catch {
    return {};
  }
}

function saveContactSnapshotsMap(next: Record<string, XingyeContactSnapshot[]>, storage: StorageLike | null = getLocalStorage()) {
  storage?.setItem(XINGYE_PHONE_CONTACT_SNAPSHOTS_STORAGE_KEY, JSON.stringify(next));
  notifyXingyePhoneChanged();
}

export function getPhoneContactSnapshots(ownerAgentId: string, storage: StorageLike | null = getLocalStorage()): XingyeContactSnapshot[] {
  return loadContactSnapshotsMap(storage)[ownerAgentId] ?? [];
}

export function getLatestPhoneContactSnapshot(ownerAgentId: string, storage: StorageLike | null = getLocalStorage()): XingyeContactSnapshot | null {
  const snapshots = getPhoneContactSnapshots(ownerAgentId, storage);
  return snapshots.length ? snapshots[snapshots.length - 1] : null;
}

export function createPhoneContactSnapshot(ownerAgentId: string, reason: string, storage: StorageLike | null = getLocalStorage()): XingyeContactSnapshot {
  const snapshotsMap = loadContactSnapshotsMap(storage);
  const virtualContacts = getVirtualContacts(ownerAgentId, storage);
  const contactMeta = loadContactMetaMap(storage);
  const filteredMeta = Object.fromEntries(Object.entries(contactMeta).filter(([key]) => key.startsWith(`${ownerAgentId}::`)));
  const generationState = getPhoneContactGenerationState(ownerAgentId, storage) ?? undefined;
  const snapshot: XingyeContactSnapshot = {
    ownerAgentId,
    id: createId('contact-snapshot'),
    createdAt: new Date().toISOString(),
    reason,
    virtualContacts,
    contactMeta: filteredMeta,
    generationState,
  };
  const list = [...(snapshotsMap[ownerAgentId] ?? []), snapshot].slice(-XINGYE_PHONE_CONTACT_SNAPSHOT_MAX);
  snapshotsMap[ownerAgentId] = list;
  saveContactSnapshotsMap(snapshotsMap, storage);
  return snapshot;
}

export function restorePhoneContactSnapshot(ownerAgentId: string, snapshotId: string, storage: StorageLike | null = getLocalStorage()): boolean {
  const snapshots = getPhoneContactSnapshots(ownerAgentId, storage);
  const snapshot = snapshots.find(item => item.id === snapshotId);
  if (!snapshot) return false;
  const virtualMap = loadVirtualContactMap(storage);
  for (const key of Object.keys(virtualMap)) {
    if (key.startsWith(`${ownerAgentId}::`)) delete virtualMap[key];
  }
  for (const contact of snapshot.virtualContacts) {
    virtualMap[`${ownerAgentId}::${contact.id}`] = contact;
  }
  saveVirtualContactMap(virtualMap, storage);

  const contactMap = loadContactMetaMap(storage);
  for (const key of Object.keys(contactMap)) {
    if (key.startsWith(`${ownerAgentId}::`)) delete contactMap[key];
  }
  for (const [key, value] of Object.entries(snapshot.contactMeta)) {
    contactMap[key] = value;
  }
  saveContactMetaMap(contactMap, storage);
  if (snapshot.generationState) setPhoneContactGenerationState(ownerAgentId, snapshot.generationState, storage);
  ensureDefaultUserContact(ownerAgentId, storage);
  return true;
}

function loadContactAiUpdateStateMap(storage: StorageLike | null = getLocalStorage()): Record<string, XingyeContactAiUpdateState> {
  if (!storage) return {};
  try {
    const raw = storage.getItem(XINGYE_PHONE_CONTACT_AI_UPDATE_STATE_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return {};
    const map: Record<string, XingyeContactAiUpdateState> = {};
    for (const [ownerAgentId, value] of Object.entries(parsed)) {
      if (!isRecord(value)) continue;
      const mode = normalizeOptionalString(value.mode) as XingyeContactUpdateMode | undefined;
      const status = normalizeOptionalString(value.status) as XingyeContactAiUpdateState['status'] | undefined;
      if (!mode || !status) continue;
      map[ownerAgentId] = {
        ownerAgentId,
        mode,
        status,
        startedAt: normalizeOptionalString(value.startedAt),
        finishedAt: normalizeOptionalString(value.finishedAt),
        error: normalizeOptionalString(value.error),
        version: typeof value.version === 'number' ? value.version : 1,
      };
    }
    return map;
  } catch {
    return {};
  }
}

function saveContactAiUpdateStateMap(next: Record<string, XingyeContactAiUpdateState>, storage: StorageLike | null = getLocalStorage()) {
  storage?.setItem(XINGYE_PHONE_CONTACT_AI_UPDATE_STATE_STORAGE_KEY, JSON.stringify(next));
  notifyXingyePhoneChanged();
}

export function saveContactAiUpdateState(ownerAgentId: string, state: XingyeContactAiUpdateState, storage: StorageLike | null = getLocalStorage()) {
  const map = loadContactAiUpdateStateMap(storage);
  map[ownerAgentId] = state;
  saveContactAiUpdateStateMap(map, storage);
}

export function getContactAiUpdateState(ownerAgentId: string, storage: StorageLike | null = getLocalStorage()): XingyeContactAiUpdateState | null {
  return loadContactAiUpdateStateMap(storage)[ownerAgentId] ?? null;
}

function getProfileFingerprint(agent: Agent, profile: XingyeRoleProfile | null | undefined): string {
  return [
    agent.id,
    agent.name,
    agent.yuan,
    profile?.displayName ?? '',
    profile?.shortBio ?? '',
    profile?.relationshipLabel ?? '',
    profile?.speakingStyle ?? '',
    profile?.identitySummary ?? '',
    profile?.backgroundSummary ?? '',
    profile?.personalitySummary ?? '',
  ].join('|');
}

export function shouldSkipFamilyContacts(profileText: string): boolean {
  return shouldSkipFamilyContactsRule(profileText);
}

export function shouldBlockFamilyContacts(profileText: string): boolean {
  return shouldBlockFamilyContactsRule(profileText);
}

export function generateVirtualContactsForRole(
  ownerAgentId: string,
  agent: Agent,
  profile: XingyeRoleProfile | null | undefined,
  agents: Agent[],
  _profiles: XingyeRoleProfileMap,
  mode: XingyeContactGenerationMode = 'rule',
): XingyeVirtualContact[] {
  if (mode === 'ai') return [];
  return generateRuleVirtualContacts({ ownerAgentId, agent, profile, agents });
}

export function ensureGeneratedVirtualContacts(
  ownerAgentId: string,
  agent: Agent | null,
  profile: XingyeRoleProfile | null | undefined,
  agents: Agent[],
  profiles: XingyeRoleProfileMap,
  storage: StorageLike | null = getLocalStorage(),
): XingyeVirtualContact[] {
  if (!ownerAgentId || !agent) return [];
  const genState = getPhoneContactGenerationState(ownerAgentId, storage);
  if (genState?.status === 'running' && !isStalePhoneContactGenerationRunning(genState)) {
    return getVirtualContacts(ownerAgentId, storage);
  }
  const existing = getVirtualContacts(ownerAgentId, storage);
  const stateMap = loadGenerationStateMap(storage);
  const fingerprint = getProfileFingerprint(agent, profile);
  const sortedIds = agents.map(a => a.id).sort();
  const inputHash = computePhoneContactGenerationInputHash(fingerprint, sortedIds);
  const state = stateMap[ownerAgentId];
  if (existing.length > 0 && state) return existing;

  const generated = generateVirtualContactsForRole(ownerAgentId, agent, profile, agents, profiles, 'rule');
  const map = loadVirtualContactMap(storage);
  for (const item of generated) {
    map[`${ownerAgentId}::${item.id}`] = item;
    const existingMeta = getPhoneContactMeta(ownerAgentId, 'virtual_contact', item.id, storage);
    if (!existingMeta) {
      savePhoneContactMeta(ownerAgentId, 'virtual_contact', item.id, {
        source: 'generated',
        status: item.status ?? 'active',
        linkedAgentId: item.linkedAgentId,
      }, storage);
    }
  }
  saveVirtualContactMap(map, storage);
  const now = new Date().toISOString();
  stateMap[ownerAgentId] = {
    ownerAgentId,
    generatedAt: now,
    profileFingerprint: fingerprint,
    inputHash,
    mode: 'rule',
    version: 1,
    status: 'success',
    finishedAt: now,
  };
  saveGenerationStateMap(stateMap, storage);
  return generated;
}

/**
 * 把联系人显示名归一化为 dedupe 用的稳定键。
 *
 * 规则：
 * - trim
 * - 全角 → 半角（含全角空格 \u3000）
 * - lowercase
 * - 合并连续空白
 * - 去掉常见装饰符号 / 引号 / 标点 / 括号（首尾整体清理）
 *
 * 仅用于内部去重比对；不会用于显示。
 */
export function normalizeContactNameForDedupe(value: string | null | undefined): string {
  if (typeof value !== 'string') return '';
  let s = value.trim();
  if (!s) return '';
  s = s.replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  s = s.replace(/\u3000/g, ' ');
  s = s.toLowerCase();
  s = s.replace(/\s+/g, ' ');
  const edgeJunk = /^[\s\-_·•●．。、!！?？:：;；'"`*【】\[\](){}<>《》「」『』~～#@&^|/\\.,，]+|[\s\-_·•●．。、!！?？:：;；'"`*【】\[\](){}<>《》「」『』~～#@&^|/\\.,，]+$/g;
  s = s.replace(edgeJunk, '');
  return s.trim();
}

/**
 * 计算联系人的去重 key：
 * 1. user 不参与 virtual_contact 去重，返回 ''
 * 2. 有 linkedAgentId → `agent:${linkedAgentId}`
 * 3. 否则用 normalized displayName
 * 4. displayName 不存在时用 normalized remark
 * 5. 不使用随机 id 当 dedupe key
 */
export function getContactDedupeKey(contact: {
  targetType?: string | null;
  linkedAgentId?: string | null;
  displayName?: string | null;
  remark?: string | null;
}): string {
  if (contact.targetType === 'user') return '';
  const linked = typeof contact.linkedAgentId === 'string' ? contact.linkedAgentId.trim() : '';
  if (linked) return `agent:${linked}`;
  const name = normalizeContactNameForDedupe(contact.displayName ?? '');
  if (name) return `name:${name}`;
  const remark = normalizeContactNameForDedupe(contact.remark ?? '');
  if (remark) return `remark:${remark}`;
  return '';
}

const PLACEHOLDER_DISPLAY_NAMES = new Set<string>([
  '未命名联系人',
  '未命名',
  '未知联系人',
  '联系人',
  'unnamed contact',
  'unknown',
]);

/** 仅丢弃 displayName 为空 / 占位 / 全符号 / 与 normalizeAiGeneratedContact 给出的兜底相同等明显模板项。 */
function isPlaceholderContactName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return true;
  if (PLACEHOLDER_DISPLAY_NAMES.has(trimmed.toLowerCase())) return true;
  const normalized = normalizeContactNameForDedupe(trimmed);
  if (!normalized) return true;
  if (PLACEHOLDER_DISPLAY_NAMES.has(normalized)) return true;
  return false;
}

export function findVirtualContactByName(ownerAgentId: string, displayName: string, storage: StorageLike | null = getLocalStorage()): XingyeVirtualContact | null {
  const normalized = normalizeContactNameForDedupe(displayName);
  if (!normalized) return null;
  const contacts = getVirtualContacts(ownerAgentId, storage);
  return contacts.find(item => normalizeContactNameForDedupe(item.displayName) === normalized) ?? null;
}

/**
 * AI 生成联系人保存时的同名匹配（旧名 `findVirtualContactForBatchAiMerge`）。
 *
 * 关键修复：不再只匹配 active —— 任何状态的同名联系人（active / blocked / deleted）
 * 都视为同一个人，避免「黑名单/已删除联系人被重复生成」。
 * 状态如何合并由 `mergeStatusForAiGeneratedVirtual` 决定（blocked/deleted 默认保留）。
 */
function findVirtualContactForBatchAiMerge(
  ownerAgentId: string,
  displayName: string,
  storage: StorageLike | null,
): XingyeVirtualContact | null {
  const normalized = normalizeContactNameForDedupe(displayName);
  if (!normalized) return null;
  const matches = getVirtualContacts(ownerAgentId, storage)
    .filter(item => normalizeContactNameForDedupe(item.displayName) === normalized);
  if (!matches.length) return null;
  const statusRank = (c: XingyeVirtualContact): number => {
    const meta = getPhoneContactMeta(ownerAgentId, 'virtual_contact', c.id, storage);
    const s = meta?.status ?? c.status ?? 'active';
    if (s === 'active') return 3;
    if (s === 'blocked') return 2;
    return 1;
  };
  return [...matches].sort((a, b) => {
    const d = statusRank(b) - statusRank(a);
    if (d !== 0) return d;
    return a.id.localeCompare(b.id);
  })[0];
}

/** 「重新生成全部」：同名时合并到 active 优先，否则 blocked/deleted 也可被 AI 刷新（避免整表留在已删除）。 */
function findVirtualContactForRegenerateMerge(
  ownerAgentId: string,
  displayName: string,
  storage: StorageLike | null,
): XingyeVirtualContact | null {
  return findVirtualContactForBatchAiMerge(ownerAgentId, displayName, storage);
}

function resolveVirtualContactIdByStrictMatchName(
  ownerAgentId: string,
  agents: Agent[],
  profiles: XingyeRoleProfileMap,
  matchName: string,
  storage: StorageLike | null,
): string | undefined {
  const needle = matchName.trim().toLowerCase();
  if (!needle) return undefined;
  const views = getPhoneContacts(ownerAgentId, agents, profiles, { includeDeleted: true }, storage)
    .filter(v => v.targetType === 'virtual_contact');
  const byDisplay = views.filter(v => v.displayName.trim().toLowerCase() === needle);
  if (byDisplay.length === 1) return byDisplay[0].targetId;
  const byRemark = views.filter(v => (v.remark ?? '').trim().toLowerCase() === needle);
  if (byRemark.length === 1) return byRemark[0].targetId;
  return undefined;
}

function resolveAgentIdByStrictName(agents: Agent[], profiles: XingyeRoleProfileMap, matchName: string): string | undefined {
  const needle = matchName.trim().toLowerCase();
  if (!needle) return undefined;
  const matches = agents.filter((a) => {
    const display = (profiles[a.id]?.displayName || a.name).trim().toLowerCase();
    const name = a.name.trim().toLowerCase();
    return display === needle || name === needle;
  });
  return matches.length === 1 ? matches[0].id : undefined;
}

function mergeStatusForAiGeneratedVirtual(params: {
  existingMeta: XingyePhoneContactMeta | null;
  existed: XingyeVirtualContact | null;
  inputStatus: XingyeContactStatus;
  /** 重新生成全部：允许用 AI 的 status 覆盖原 blocked/deleted（除非用户曾手动锁定 status）。 */
  refreshStatusFromAi?: boolean;
}): XingyeContactStatus {
  const { existingMeta, existed, inputStatus, refreshStatusFromAi } = params;
  const manual = new Set(existingMeta?.manualEditedFields ?? []);
  if (manual.has('status')) {
    return (existingMeta?.status ?? existed?.status ?? 'active') as XingyeContactStatus;
  }
  const prev = (existingMeta?.status ?? existed?.status ?? 'active') as XingyeContactStatus;
  if (refreshStatusFromAi) return inputStatus;
  if (prev === 'blocked' || prev === 'deleted') return prev;
  return inputStatus;
}

function syncVirtualContactEntityWithStoredMeta(
  ownerAgentId: string,
  virtualId: string,
  storage: StorageLike | null,
) {
  const vc = getVirtualContacts(ownerAgentId, storage).find(c => c.id === virtualId);
  if (!vc) return;
  const meta = getPhoneContactMeta(ownerAgentId, 'virtual_contact', virtualId, storage);
  if (!meta) return;
  const next: XingyeVirtualContact = {
    ...vc,
    status: meta.status ?? vc.status ?? 'active',
    tags: meta.tags?.length ? meta.tags : vc.tags,
    faction: meta.faction ?? vc.faction,
    remark: meta.remark ?? vc.remark,
    impression: meta.impression ?? vc.impression,
    relationshipHint: meta.relationshipHint ?? vc.relationshipHint,
    linkedAgentId: meta.linkedAgentId ?? vc.linkedAgentId,
    updatedAt: new Date().toISOString(),
  };
  if (
    next.status === vc.status
    && JSON.stringify(next.tags ?? []) === JSON.stringify(vc.tags ?? [])
    && next.faction === vc.faction
    && next.remark === vc.remark
    && next.impression === vc.impression
    && next.relationshipHint === vc.relationshipHint
    && next.linkedAgentId === vc.linkedAgentId
  ) {
    return;
  }
  saveVirtualContact(ownerAgentId, next, storage);
}

export type ApplyAiGeneratedContactsResult = {
  /** 实际写入存储的虚拟联系人（含新建与合并后的更新） */
  saved: XingyeVirtualContact[];
  /** 真正新建的虚拟联系人条数（去重后） */
  createdCount: number;
  /** 与已有联系人合并/更新的条数（同名归并，不新增 id） */
  mergedCount: number;
  /** 被丢弃的条数（空名 / 模板占位 / 同名 blocked-deleted 在 never 模式下被跳过等） */
  skippedCount: number;
};

/**
 * 合并 AI 一次返回里两条同名候选的有价值字段。
 * 不会覆盖已有非空字段；不会改变 displayName / kind。
 */
function mergeBatchAiCandidate(base: XingyeAiGeneratedContact, extra: XingyeAiGeneratedContact): XingyeAiGeneratedContact {
  const mergedTags = canonicalizeContactTags([
    ...(base.tags ?? []),
    ...(extra.tags ?? []),
  ]);
  return {
    ...base,
    impression: base.impression?.trim() ? base.impression : extra.impression,
    relationshipHint: base.relationshipHint?.trim() ? base.relationshipHint : extra.relationshipHint,
    shortBio: base.shortBio?.trim() ? base.shortBio : extra.shortBio,
    remark: base.remark?.trim() ? base.remark : extra.remark,
    faction: base.faction?.trim() ? base.faction : extra.faction,
    tags: mergedTags.length ? mergedTags : (base.tags ?? extra.tags ?? []),
  };
}

/**
 * 写入 AI 生成的虚拟联系人。所有去重在此处发生：
 *
 * 1. 丢弃空名 / 模板占位（"未命名联系人" / 全符号 等）。
 * 2. 本批同名合并：同 dedupe key 的多条只保留一条，可合并 tags / faction / impression 等有价值字段。
 *    包括同名 blocked / deleted —— 模型若一次返回两个同名 blocked 也只写一份。
 * 3. 与已有联系人按 dedupe key 比对：
 *    - mode === 'never'（增量 add）：若已存在同名联系人，丢弃（不新增、不修改），交给「更新联系人」流程；
 *    - mode === 'prefer-active-only'（首次 AI 生成）：合并 patch 到已有联系人；
 *      status 默认保持原 blocked/deleted（除非 manual 已锁定 → 同样保留 manual）；
 *    - mode === 'regenerate'（重新生成全部）：合并 patch 到已有；status 允许 AI 刷新但仍 honor manual 锁定。
 * 4. 真正新建联系人时才分配 id；合并时复用已有 id。
 */
export function applyAiGeneratedContacts(
  ownerAgentId: string,
  contacts: XingyeAiGeneratedContact[],
  options?: {
    preserveLinkedAgent?: boolean;
    storage?: StorageLike | null;
    virtualSource?: XingyeContactSource;
    metaSource?: XingyeContactSource;
    /** 默认合并同名（任意状态）；增量 add 传 never；重新生成全部传 regenerate。 */
    mergeMatchingDisplayName?: 'prefer-active-only' | 'never' | 'regenerate';
  },
): ApplyAiGeneratedContactsResult {
  const storage = options?.storage ?? getLocalStorage();
  const virtualSource = options?.virtualSource ?? 'ai_generated';
  const metaSource = options?.metaSource ?? virtualSource;
  const mergeMode = options?.mergeMatchingDisplayName ?? 'prefer-active-only';
  const output: XingyeVirtualContact[] = [];
  let createdCount = 0;
  let mergedCount = 0;
  let skippedCount = 0;

  const batchByKey = new Map<string, XingyeAiGeneratedContact>();
  for (const raw of contacts) {
    const input = normalizeAiGeneratedContact(raw);
    if (!input.displayName?.trim() || isPlaceholderContactName(input.displayName)) {
      skippedCount += 1;
      continue;
    }
    const key = getContactDedupeKey({
      targetType: 'virtual_contact',
      displayName: input.displayName,
      remark: input.remark,
    });
    if (!key) {
      skippedCount += 1;
      continue;
    }
    const existed = batchByKey.get(key);
    if (existed) {
      batchByKey.set(key, mergeBatchAiCandidate(existed, input));
      skippedCount += 1;
      continue;
    }
    batchByKey.set(key, input);
  }

  for (const input of batchByKey.values()) {
    const existed = findVirtualContactForBatchAiMerge(ownerAgentId, input.displayName, storage)
      ?? (input.remark ? findVirtualContactForBatchAiMerge(ownerAgentId, input.remark, storage) : null);

    if (existed && mergeMode === 'never') {
      skippedCount += 1;
      continue;
    }

    const existingMeta = existed ? getPhoneContactMeta(ownerAgentId, 'virtual_contact', existed.id, storage) : null;
    const mergedStatus = mergeStatusForAiGeneratedVirtual({
      existingMeta,
      existed,
      inputStatus: normalizeContactStatusValue(input.status),
      refreshStatusFromAi: mergeMode === 'regenerate',
    });
    const aiMetaPatch: Partial<XingyePhoneContactMeta> = {
      remark: input.remark,
      impression: input.impression,
      relationshipHint: input.relationshipHint,
      tags: input.tags,
      faction: input.faction,
      status: mergedStatus,
      linkedAgentId: existingMeta?.linkedAgentId ?? existed?.linkedAgentId,
      source: metaSource,
    };
    if (!existed && metaSource === 'ai_generated') {
      aiMetaPatch.pendingNewFriend = true;
    }
    const patch = preserveManualContactFields(existingMeta, aiMetaPatch);
    const finalStatus = (patch.status ?? mergedStatus) as XingyeContactStatus;
    const saved = saveVirtualContact(ownerAgentId, {
      ownerAgentId,
      id: existed?.id ?? '',
      displayName: existed?.displayName ?? input.displayName.trim(),
      kind: input.kind ?? existed?.kind ?? 'unknown',
      shortBio: input.shortBio ?? existed?.shortBio,
      remark: patch.remark ?? input.remark ?? existed?.remark,
      impression: patch.impression ?? input.impression ?? existed?.impression,
      relationshipHint: patch.relationshipHint ?? input.relationshipHint ?? existed?.relationshipHint,
      tags: (patch.tags?.length ? patch.tags : undefined) ?? input.tags ?? existed?.tags ?? [],
      faction: patch.faction ?? input.faction ?? existed?.faction,
      status: finalStatus,
      linkedAgentId: patch.linkedAgentId ?? existingMeta?.linkedAgentId ?? existed?.linkedAgentId,
      source: virtualSource,
      generatedReason: input.generatedReason,
      createdAt: existed?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, storage);
    savePhoneContactMeta(ownerAgentId, 'virtual_contact', saved.id, patch, storage, { markManualFields: false });
    output.push(saved);
    if (existed) mergedCount += 1;
    else createdCount += 1;
  }
  ensureDefaultUserContact(ownerAgentId, storage);
  return { saved: output, createdCount, mergedCount, skippedCount };
}

export function applyAiContactUpdates(
  ownerAgentId: string,
  updates: XingyeAiContactUpdate[],
  options?: {
    storage?: StorageLike | null;
    /** 传入后可对 matchName 做唯一性解析，避免误匹配。 */
    agents?: Agent[];
    profiles?: XingyeRoleProfileMap;
    /** 设置时才写入 contact change log（与 AI 增量/回滚后更新配套）。 */
    contactChangeSource?: 'contacts_incremental_update' | 'contacts_rollback_update';
  },
) {
  const storage = options?.storage ?? getLocalStorage();
  const agents = options?.agents ?? [];
  const profiles = options?.profiles ?? {};
  const canResolveNames = agents.length > 0;
  const contactChangeSource = options?.contactChangeSource;

  const preVirtual = getVirtualContacts(ownerAgentId, storage).length;
  const preBlockedVc = getContactsByStatus(ownerAgentId, 'blocked', agents, profiles, storage)
    .filter(c => c.targetType === 'virtual_contact').length;
  const preDeletedVc = getContactsByStatus(ownerAgentId, 'deleted', agents, profiles, storage)
    .filter(c => c.targetType === 'virtual_contact').length;

  const counts = { add: 0, update: 0, delete: 0, block: 0, restore: 0, skip: 0 };

  for (const raw of updates) {
    const update = normalizeAiContactUpdate(raw);
    if (update.action === 'add' && update.contact) {
      const result = applyAiGeneratedContacts(ownerAgentId, [{
        ...update.contact,
        targetType: 'virtual_contact',
      }], { storage, mergeMatchingDisplayName: 'never' });
      if (result.createdCount > 0) {
        counts.add += 1;
        if (contactChangeSource) {
          const want = update.contact.displayName.trim().toLowerCase();
          const savedVc = result.saved.filter(s => s.displayName.trim().toLowerCase() === want).at(-1)
            ?? result.saved[result.saved.length - 1];
          const metaAfter = getPhoneContactMeta(ownerAgentId, 'virtual_contact', savedVc.id, storage);
          const changedFields = changedFieldsFromMetaSnapshot(metaAfter);
          appendContactChangeLogItem({
            ownerAgentId,
            targetType: 'virtual_contact',
            targetId: savedVc.id,
            action: 'add',
            changedFields: changedFields.length ? changedFields : ['status'],
            reason: update.reason,
            source: contactChangeSource,
          }, storage);
        }
      }
      else counts.skip += 1;
      continue;
    }

    let resolvedTargetId = typeof update.targetId === 'string' ? update.targetId.trim() : '';
    if (!resolvedTargetId && update.matchName?.trim()) {
      if (update.targetType === 'virtual_contact') {
        resolvedTargetId = canResolveNames
          ? (resolveVirtualContactIdByStrictMatchName(ownerAgentId, agents, profiles, update.matchName, storage) ?? '')
          : (findVirtualContactByName(ownerAgentId, update.matchName, storage)?.id ?? '');
      } else if (update.targetType === 'agent') {
        resolvedTargetId = canResolveNames
          ? (resolveAgentIdByStrictName(agents, profiles, update.matchName) ?? '')
          : '';
      }
    }

    if (update.targetType === 'user') {
      resolvedTargetId = resolveUserContactTargetId(ownerAgentId, storage);
    }

    if (!resolvedTargetId) {
      counts.skip += 1;
      continue;
    }

    if (update.targetType === 'user' && (update.action === 'delete' || update.action === 'block')) {
      counts.skip += 1;
      continue;
    }

    /** AI 增量：仅 virtual_contact 可 block/delete/restore；agent 须用户在小手机内手动。 */
    if (update.targetType === 'agent' && (update.action === 'delete' || update.action === 'block' || update.action === 'restore')) {
      counts.skip += 1;
      continue;
    }

    if (update.action === 'delete') {
      const metaBefore = getPhoneContactMeta(ownerAgentId, update.targetType, resolvedTargetId, storage);
      savePhoneContactMeta(ownerAgentId, update.targetType, resolvedTargetId, { status: 'deleted', source: 'ai_generated' }, storage, { markManualFields: false });
      if (update.targetType === 'virtual_contact') syncVirtualContactEntityWithStoredMeta(ownerAgentId, resolvedTargetId, storage);
      counts.delete += 1;
      if (contactChangeSource) {
        const metaAfter = getPhoneContactMeta(ownerAgentId, update.targetType, resolvedTargetId, storage);
        if (metaAfter) {
          const changedFields = diffContactMetaForChangeLog(metaBefore, metaAfter);
          if (changedFields.length) {
            appendContactChangeLogItem({
              ownerAgentId,
              targetType: update.targetType,
              targetId: resolvedTargetId,
              action: 'delete',
              changedFields,
              reason: update.reason,
              source: contactChangeSource,
            }, storage);
          }
        }
      }
      continue;
    }
    if (update.action === 'block') {
      const metaBefore = getPhoneContactMeta(ownerAgentId, update.targetType, resolvedTargetId, storage);
      savePhoneContactMeta(ownerAgentId, update.targetType, resolvedTargetId, { status: 'blocked', source: 'ai_generated' }, storage, { markManualFields: false });
      if (update.targetType === 'virtual_contact') syncVirtualContactEntityWithStoredMeta(ownerAgentId, resolvedTargetId, storage);
      counts.block += 1;
      if (contactChangeSource) {
        const metaAfter = getPhoneContactMeta(ownerAgentId, update.targetType, resolvedTargetId, storage);
        if (metaAfter) {
          const changedFields = diffContactMetaForChangeLog(metaBefore, metaAfter);
          if (changedFields.length) {
            appendContactChangeLogItem({
              ownerAgentId,
              targetType: update.targetType,
              targetId: resolvedTargetId,
              action: 'block',
              changedFields,
              reason: update.reason,
              source: contactChangeSource,
            }, storage);
          }
        }
      }
      continue;
    }
    if (update.action === 'restore') {
      const metaBefore = getPhoneContactMeta(ownerAgentId, update.targetType, resolvedTargetId, storage);
      savePhoneContactMeta(ownerAgentId, update.targetType, resolvedTargetId, { status: 'active', source: 'ai_generated' }, storage, { markManualFields: false });
      if (update.targetType === 'virtual_contact') syncVirtualContactEntityWithStoredMeta(ownerAgentId, resolvedTargetId, storage);
      counts.restore += 1;
      if (contactChangeSource) {
        const metaAfter = getPhoneContactMeta(ownerAgentId, update.targetType, resolvedTargetId, storage);
        if (metaAfter) {
          const changedFields = diffContactMetaForChangeLog(metaBefore, metaAfter);
          if (changedFields.length) {
            appendContactChangeLogItem({
              ownerAgentId,
              targetType: update.targetType,
              targetId: resolvedTargetId,
              action: 'restore',
              changedFields,
              reason: update.reason,
              source: contactChangeSource,
            }, storage);
          }
        }
      }
      continue;
    }
    if (update.action === 'update') {
      const existingMeta = getPhoneContactMeta(ownerAgentId, update.targetType, resolvedTargetId, storage);
      const aiPayload: Partial<XingyePhoneContactMeta> = {
        ...(update.patch ?? {}),
        source: 'ai_generated',
      };
      if (update.targetType === 'user') {
        delete aiPayload.status;
        delete aiPayload.faction;
        delete aiPayload.linkedAgentId;
        delete aiPayload.pendingNewFriend;
      }
      if (update.targetType === 'agent') {
        delete aiPayload.status;
      }
      const patch = preserveManualContactFields(existingMeta, aiPayload);
      savePhoneContactMeta(ownerAgentId, update.targetType, resolvedTargetId, patch, storage, { markManualFields: false });
      if (update.targetType === 'virtual_contact') syncVirtualContactEntityWithStoredMeta(ownerAgentId, resolvedTargetId, storage);
      counts.update += 1;
      if (contactChangeSource) {
        const afterMeta = getPhoneContactMeta(ownerAgentId, update.targetType, resolvedTargetId, storage);
        if (afterMeta) {
          const changedFields = diffContactMetaForChangeLog(existingMeta, afterMeta);
          if (changedFields.length) {
            appendContactChangeLogItem({
              ownerAgentId,
              targetType: update.targetType,
              targetId: resolvedTargetId,
              action: 'update',
              changedFields,
              reason: update.reason,
              source: contactChangeSource,
            }, storage);
          }
        }
      }
    }
  }

  ensureDefaultUserContact(ownerAgentId, storage);

  const postVirtual = getVirtualContacts(ownerAgentId, storage).length;
  const postBlockedVc = getContactsByStatus(ownerAgentId, 'blocked', agents, profiles, storage)
    .filter(c => c.targetType === 'virtual_contact').length;
  const postDeletedVc = getContactsByStatus(ownerAgentId, 'deleted', agents, profiles, storage)
    .filter(c => c.targetType === 'virtual_contact').length;

  if (typeof console !== 'undefined' && console.info) {
    console.info('[xingye-phone] applyAiContactUpdates', {
      ownerAgentId,
      updatesIn: updates.length,
      counts,
      virtualContacts: { before: preVirtual, after: postVirtual },
      virtualBlocked: { before: preBlockedVc, after: postBlockedVc },
      virtualDeleted: { before: preDeletedVc, after: postDeletedVc },
    });
  }
}

/**
 * 「重新生成全部」专用：清空当前 owner 的 virtual_contact 实体与对应 meta；不动 user / agent meta。
 *
 * 通过 `preserveManuallyEdited: true` 调用时，保留任何 meta 上有 `manualEditedFields` 的虚拟联系人
 * （含手动 blocked / deleted、手动改过 remark 等），让 regenerate 不丢失用户手动维护过的条目。
 */
export function clearAllVirtualContactsForOwner(
  ownerAgentId: string,
  storage: StorageLike | null = getLocalStorage(),
  options?: { preserveManuallyEdited?: boolean },
) {
  if (!ownerAgentId) return;
  const preserveManual = options?.preserveManuallyEdited ?? false;
  const virtualMap = loadVirtualContactMap(storage);
  const metaMap = loadContactMetaMap(storage);
  const virtualPrefix = `${ownerAgentId}::`;
  const metaPrefix = `${ownerAgentId}::virtual_contact::`;

  const preservedVirtualIds = new Set<string>();
  if (preserveManual) {
    for (const [key, meta] of Object.entries(metaMap)) {
      if (!key.startsWith(metaPrefix)) continue;
      if ((meta.manualEditedFields?.length ?? 0) > 0 || meta.source === 'manual') {
        preservedVirtualIds.add(meta.targetId);
      }
    }
  }

  let virtualMutated = false;
  for (const key of Object.keys(virtualMap)) {
    if (!key.startsWith(virtualPrefix)) continue;
    const contact = virtualMap[key];
    if (preservedVirtualIds.has(contact.id)) continue;
    delete virtualMap[key];
    virtualMutated = true;
  }
  if (virtualMutated) saveVirtualContactMap(virtualMap, storage);

  let metaMutated = false;
  for (const key of Object.keys(metaMap)) {
    if (!key.startsWith(metaPrefix)) continue;
    if (preservedVirtualIds.has(metaMap[key].targetId)) continue;
    delete metaMap[key];
    metaMutated = true;
  }
  if (metaMutated) saveContactMetaMap(metaMap, storage);
}

export function rollbackAndUpdateVirtualContactsWithAI(
  ownerAgentId: string,
  updates: XingyeAiContactUpdate[],
  snapshotId?: string,
  storage: StorageLike | null = getLocalStorage(),
  agents: Agent[] = [],
  profiles: XingyeRoleProfileMap = {},
): boolean {
  const snapshot = snapshotId
    ? getPhoneContactSnapshots(ownerAgentId, storage).find(item => item.id === snapshotId) ?? null
    : getLatestPhoneContactSnapshot(ownerAgentId, storage);
  if (!snapshot) return false;
  const restored = restorePhoneContactSnapshot(ownerAgentId, snapshot.id, storage);
  if (!restored) return false;
  applyAiContactUpdates(ownerAgentId, updates, {
    storage,
    agents,
    profiles,
    contactChangeSource: 'contacts_rollback_update',
  });
  return true;
}

export function linkVirtualContactToAgent(ownerAgentId: string, virtualContactId: string, linkedAgentId: string) {
  const map = loadVirtualContactMap();
  const key = `${ownerAgentId}::${virtualContactId}`;
  const contact = map[key];
  if (!contact) return null;
  const prevLinked = normalizeOptionalString(contact.linkedAgentId) ?? '';
  const nextLinked = linkedAgentId.trim();
  const updated = { ...contact, linkedAgentId: nextLinked, updatedAt: new Date().toISOString() };
  map[key] = updated;
  saveVirtualContactMap(map);
  savePhoneContactMeta(ownerAgentId, 'virtual_contact', virtualContactId, { linkedAgentId: nextLinked, source: 'manual' }, undefined, { markManualFields: false });
  markContactFieldManual(ownerAgentId, 'virtual_contact', virtualContactId, 'linkedAgentId');
  if (prevLinked !== nextLinked) {
    appendContactChangeLogItem({
      ownerAgentId,
      targetType: 'virtual_contact',
      targetId: virtualContactId,
      action: 'update',
      changedFields: ['linkedAgentId'],
      reason: '用户关联虚拟联系人到真实角色',
      source: 'manual_edit',
    });
  }
  return updated;
}

export function unlinkVirtualContactFromAgent(ownerAgentId: string, virtualContactId: string) {
  const map = loadVirtualContactMap();
  const key = `${ownerAgentId}::${virtualContactId}`;
  const contact = map[key];
  if (!contact) return null;
  const prevLinked = normalizeOptionalString(contact.linkedAgentId) ?? '';
  const updated = { ...contact, linkedAgentId: undefined, updatedAt: new Date().toISOString() };
  map[key] = updated;
  saveVirtualContactMap(map);
  savePhoneContactMeta(ownerAgentId, 'virtual_contact', virtualContactId, { linkedAgentId: '', source: 'manual' }, undefined, { markManualFields: false });
  markContactFieldManual(ownerAgentId, 'virtual_contact', virtualContactId, 'linkedAgentId');
  if (prevLinked) {
    appendContactChangeLogItem({
      ownerAgentId,
      targetType: 'virtual_contact',
      targetId: virtualContactId,
      action: 'update',
      changedFields: ['linkedAgentId'],
      reason: '用户取消虚拟联系人与真实角色的关联',
      source: 'manual_edit',
    });
  }
  return updated;
}

export function resolveContactDisplayName(
  ownerAgentId: string,
  targetType: XingyeContactTargetType,
  targetId: string,
  agents: Agent[],
  profiles: XingyeRoleProfileMap,
): string {
  const meta = getPhoneContactMeta(ownerAgentId, targetType, targetId);
  if (meta?.remark) return meta.remark;
  if (targetType === 'user') return '你';
  if (targetType === 'virtual_contact') {
    return getVirtualContacts(ownerAgentId).find(item => item.id === targetId)?.displayName ?? '虚拟联系人';
  }
  const agent = agents.find(item => item.id === targetId);
  if (!agent) return targetId;
  return profiles[agent.id]?.displayName || agent.name;
}

export function resolveContactAvatar(
  ownerAgentId: string,
  targetType: XingyeContactTargetType,
  targetId: string,
  agents: Agent[],
  _profiles: XingyeRoleProfileMap,
): string | null {
  if (targetType === 'user') return null;
  if (targetType === 'virtual_contact') {
    const vc = getVirtualContacts(ownerAgentId).find(item => item.id === targetId);
    if (vc?.avatarDataUrl) return vc.avatarDataUrl;
    if (vc?.linkedAgentId) {
      const agent = agents.find(item => item.id === vc.linkedAgentId);
      return agent ? null : null;
    }
    return null;
  }
  return null;
}

export function getPhoneProfileFingerprint(agent: Agent | null, profile: XingyeRoleProfile | null | undefined): string {
  if (!agent) return '';
  return [
    agent.id,
    agent.name,
    agent.yuan,
    profile?.displayName ?? '',
    profile?.shortBio ?? '',
    profile?.relationshipLabel ?? '',
    profile?.speakingStyle ?? '',
    profile?.identitySummary ?? '',
    profile?.backgroundSummary ?? '',
    profile?.personalitySummary ?? '',
  ].join('|');
}

function loadAiGenerationStateMap(storage: StorageLike | null = getLocalStorage()): Record<string, XingyePhoneAiGenerationState> {
  if (!storage) return {};
  try {
    const raw = storage.getItem(XINGYE_PHONE_AI_GENERATION_STATE_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return {};
    const map: Record<string, XingyePhoneAiGenerationState> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!isRecord(value)) continue;
      const ownerAgentId = normalizeOptionalString(value.ownerAgentId);
      const kind = normalizeOptionalString(value.kind) as XingyePhoneAiGenerationState['kind'] | undefined;
      const status = normalizeOptionalString(value.status) as XingyePhoneAiGenerationStatus | undefined;
      const profileFingerprint = normalizeOptionalString(value.profileFingerprint);
      if (!ownerAgentId || !kind || !status || !profileFingerprint) continue;
      map[key] = {
        ownerAgentId,
        kind,
        status,
        profileFingerprint,
        startedAt: normalizeOptionalString(value.startedAt),
        finishedAt: normalizeOptionalString(value.finishedAt),
        error: normalizeOptionalString(value.error),
        version: typeof value.version === 'number' ? value.version : 1,
      };
    }
    return map;
  } catch {
    return {};
  }
}

function saveAiGenerationStateMap(next: Record<string, XingyePhoneAiGenerationState>, storage: StorageLike | null = getLocalStorage()) {
  storage?.setItem(XINGYE_PHONE_AI_GENERATION_STATE_STORAGE_KEY, JSON.stringify(next));
  notifyXingyePhoneChanged();
}

export function getPhoneAiGenerationState(
  ownerAgentId: string,
  kind: XingyePhoneAiGenerationState['kind'],
  storage: StorageLike | null = getLocalStorage(),
): XingyePhoneAiGenerationState | null {
  return loadAiGenerationStateMap(storage)[`${ownerAgentId}::${kind}`] ?? null;
}

export function setPhoneAiGenerationState(
  ownerAgentId: string,
  kind: XingyePhoneAiGenerationState['kind'],
  state: Partial<XingyePhoneAiGenerationState>,
  storage: StorageLike | null = getLocalStorage(),
) {
  const map = loadAiGenerationStateMap(storage);
  const key = `${ownerAgentId}::${kind}`;
  const previous = map[key];
  map[key] = {
    ownerAgentId,
    kind,
    status: state.status ?? previous?.status ?? 'idle',
    profileFingerprint: state.profileFingerprint ?? previous?.profileFingerprint ?? '',
    startedAt: state.startedAt ?? previous?.startedAt,
    finishedAt: state.finishedAt ?? previous?.finishedAt,
    error: state.error ?? previous?.error,
    version: state.version ?? previous?.version ?? 1,
  };
  saveAiGenerationStateMap(map, storage);
  return map[key];
}

function loadSmsHistoryGenerationStateMap(storage: StorageLike | null = getLocalStorage()): Record<string, XingyeGeneratedSmsHistoryState> {
  if (!storage) return {};
  try {
    const raw = storage.getItem(XINGYE_PHONE_SMS_HISTORY_GENERATION_STATE_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return {};
    const map: Record<string, XingyeGeneratedSmsHistoryState> = {};
    for (const [ownerAgentId, value] of Object.entries(parsed)) {
      if (!isRecord(value)) continue;
      const generatedAt = normalizeOptionalString(value.generatedAt);
      const profileFingerprint = normalizeOptionalString(value.profileFingerprint);
      if (!generatedAt || !profileFingerprint) continue;
      map[ownerAgentId] = {
        ownerAgentId,
        generatedAt,
        profileFingerprint,
        contactsIncluded: Array.isArray(value.contactsIncluded)
          ? value.contactsIncluded.filter((item): item is XingyeGeneratedSmsHistoryState['contactsIncluded'][number] => (
            isRecord(item)
            && typeof item.targetType === 'string'
            && typeof item.targetId === 'string'
          ))
          : [],
        version: typeof value.version === 'number' ? value.version : 1,
      };
    }
    return map;
  } catch {
    return {};
  }
}

function saveSmsHistoryGenerationStateMap(next: Record<string, XingyeGeneratedSmsHistoryState>, storage: StorageLike | null = getLocalStorage()) {
  storage?.setItem(XINGYE_PHONE_SMS_HISTORY_GENERATION_STATE_STORAGE_KEY, JSON.stringify(next));
  notifyXingyePhoneChanged();
}

export function getSmsHistoryGenerationState(ownerAgentId: string, storage: StorageLike | null = getLocalStorage()): XingyeGeneratedSmsHistoryState | null {
  return loadSmsHistoryGenerationStateMap(storage)[ownerAgentId] ?? null;
}

export function setSmsHistoryGenerationState(
  ownerAgentId: string,
  state: XingyeGeneratedSmsHistoryState,
  storage: StorageLike | null = getLocalStorage(),
) {
  const map = loadSmsHistoryGenerationStateMap(storage);
  map[ownerAgentId] = state;
  saveSmsHistoryGenerationStateMap(map, storage);
}

export function clearSmsHistoryGenerationState(
  ownerAgentId: string,
  storage: StorageLike | null = getLocalStorage(),
) {
  const map = loadSmsHistoryGenerationStateMap(storage);
  if (!(ownerAgentId in map)) return;
  delete map[ownerAgentId];
  saveSmsHistoryGenerationStateMap(map, storage);
}

export function getPhoneContacts(
  ownerAgentId: string,
  agents: Agent[],
  profiles: XingyeRoleProfileMap,
  options?: { includeDeleted?: boolean },
  storage: StorageLike | null = getLocalStorage(),
): XingyePhoneContactView[] {
  if (!ownerAgentId) return [];
  const includeDeleted = options?.includeDeleted ?? false;
  const views: XingyePhoneContactView[] = [];
  views.push(getDefaultUserContact(ownerAgentId, storage));
  const virtualContacts = getVirtualContacts(ownerAgentId, storage);
  for (const vc of virtualContacts) {
    const meta = getPhoneContactMeta(ownerAgentId, 'virtual_contact', vc.id, storage);
    views.push({
      ownerAgentId,
      targetType: 'virtual_contact',
      targetId: vc.id,
      displayName: vc.displayName,
      originalName: vc.displayName,
      remark: meta?.remark ?? vc.remark ?? vc.displayName,
      impression: meta?.impression ?? vc.impression ?? '还没有形成明确印象。',
      kind: vc.kind,
      shortBio: vc.shortBio,
      relationshipHint: meta?.relationshipHint ?? vc.relationshipHint,
      tags: meta?.tags ?? vc.tags ?? [],
      faction: meta?.faction ?? vc.faction,
      status: meta?.status ?? vc.status ?? 'active',
      linkedAgentId: meta?.linkedAgentId ?? vc.linkedAgentId,
      generatedReason: vc.generatedReason,
      source: meta?.source ?? vc.source,
      updatedAt: meta?.updatedAt ?? vc.updatedAt,
      avatarDataUrl: vc.avatarDataUrl,
      virtualContact: vc,
      pendingNewFriend: meta?.pendingNewFriend,
    });
  }

  for (const agent of agents) {
    if (agent.id === ownerAgentId) continue;
    const meta = getPhoneContactMeta(ownerAgentId, 'agent', agent.id, storage);
    const displayName = profiles[agent.id]?.displayName || agent.name;
    views.push({
      ownerAgentId,
      targetType: 'agent',
      targetId: agent.id,
      displayName,
      originalName: agent.name,
      remark: meta?.remark ?? displayName,
      impression: meta?.impression ?? '还没有形成明确印象。',
      relationshipHint: meta?.relationshipHint,
      tags: meta?.tags ?? [],
      faction: meta?.faction,
      status: meta?.status ?? 'active',
      linkedAgentId: meta?.linkedAgentId,
      source: meta?.source,
      updatedAt: meta?.updatedAt,
      agent,
      pendingNewFriend: meta?.pendingNewFriend,
    });
  }

  return views
    .filter(item => includeDeleted || item.targetType === 'user' || item.status !== 'deleted')
    .sort((a, b) => a.remark.localeCompare(b.remark, 'zh-Hans-CN'));
}

export const XINGYE_DEFAULT_CONTACT_TAGS = ['亲近的人', '需要观察', '不可靠', '同伴', '危险'] as const;
export const XINGYE_DEFAULT_CONTACT_FACTIONS = ['自己人', '中立', '对立', '未知'] as const;

export function getContactsByStatus(
  ownerAgentId: string,
  status: XingyeContactStatus,
  agents: Agent[],
  profiles: XingyeRoleProfileMap,
  storage: StorageLike | null = getLocalStorage(),
): XingyePhoneContactView[] {
  return getPhoneContacts(ownerAgentId, agents, profiles, { includeDeleted: true }, storage)
    .filter(item => item.status === status);
}

export function getBlockedContacts(
  ownerAgentId: string,
  agents: Agent[],
  profiles: XingyeRoleProfileMap,
  storage?: StorageLike | null,
): XingyePhoneContactView[] {
  return getContactsByStatus(ownerAgentId, 'blocked', agents, profiles, storage)
    .filter(item => item.targetType !== 'user');
}

export function getDeletedContacts(
  ownerAgentId: string,
  agents: Agent[],
  profiles: XingyeRoleProfileMap,
  storage?: StorageLike | null,
): XingyePhoneContactView[] {
  return getContactsByStatus(ownerAgentId, 'deleted', agents, profiles, storage)
    .filter(item => item.targetType !== 'user');
}

/** 标签/阵营统计与浏览：含 active 与 blocked，不含已删除（已删除仅在「已删除」页集中展示）。 */
export function getPhoneContactsForTaggingAndFactions(
  ownerAgentId: string,
  agents: Agent[],
  profiles: XingyeRoleProfileMap,
  storage?: StorageLike | null,
): XingyePhoneContactView[] {
  return getPhoneContacts(ownerAgentId, agents, profiles, { includeDeleted: true }, storage)
    .filter(item => item.status !== 'deleted');
}

export function getContactsByTag(
  ownerAgentId: string,
  tag: string,
  agents: Agent[],
  profiles: XingyeRoleProfileMap,
  storage?: StorageLike | null,
): XingyePhoneContactView[] {
  const needle = tag.trim();
  if (!needle) return [];
  return getPhoneContactsForTaggingAndFactions(ownerAgentId, agents, profiles, storage)
    .filter(item => (item.tags ?? []).includes(needle));
}

export function getContactsByFaction(
  ownerAgentId: string,
  faction: string,
  agents: Agent[],
  profiles: XingyeRoleProfileMap,
  storage?: StorageLike | null,
): XingyePhoneContactView[] {
  const needle = faction.trim();
  if (!needle) return [];
  const all = getPhoneContactsForTaggingAndFactions(ownerAgentId, agents, profiles, storage);
  if (needle === '未知') {
    return all.filter(item => !item.faction?.trim() || item.faction === '未知');
  }
  return all.filter(item => (item.faction?.trim() ?? '') === needle);
}

export function getDefaultContactTags(
  ownerAgentId: string,
  agents: Agent[],
  profiles: XingyeRoleProfileMap,
  storage?: StorageLike | null,
): { tag: string; count: number }[] {
  return XINGYE_DEFAULT_CONTACT_TAGS.map(tag => ({
    tag,
    count: getContactsByTag(ownerAgentId, tag, agents, profiles, storage).length,
  }));
}

export function getDefaultContactFactions(
  ownerAgentId: string,
  agents: Agent[],
  profiles: XingyeRoleProfileMap,
  storage?: StorageLike | null,
): { faction: string; count: number }[] {
  return XINGYE_DEFAULT_CONTACT_FACTIONS.map(faction => ({
    faction,
    count: getContactsByFaction(ownerAgentId, faction, agents, profiles, storage).length,
  }));
}

/** AI 新增、尚未在「新的朋友」里标记已读的联系人（含虚拟与真实 agent）。不含 user。 */
export function getPendingNewContacts(
  ownerAgentId: string,
  agents: Agent[],
  profiles: XingyeRoleProfileMap,
  storage?: StorageLike | null,
): XingyePhoneContactView[] {
  return getPhoneContacts(ownerAgentId, agents, profiles, { includeDeleted: true }, storage)
    .filter(item => item.targetType !== 'user' && item.pendingNewFriend && item.status === 'active');
}

export function clearPendingNewFriend(
  ownerAgentId: string,
  targetType: XingyeContactTargetType,
  targetId: string,
  storage?: StorageLike | null,
) {
  return savePhoneContactMeta(ownerAgentId, targetType, targetId, { pendingNewFriend: false }, storage, { markManualFields: false });
}

export function getSmsThreads(
  ownerAgentId: string,
  targetTypeOrStorage?: XingyeContactTargetType | StorageLike | null,
  storageArg?: StorageLike | null,
): XingyePhoneSmsThread[] {
  if (!ownerAgentId) return [];
  const targetType = typeof targetTypeOrStorage === 'string' ? targetTypeOrStorage : undefined;
  const storage = typeof targetTypeOrStorage === 'string'
    ? (storageArg ?? getLocalStorage())
    : (storageArg ?? targetTypeOrStorage ?? getLocalStorage());
  return Object.values(loadSmsThreadMap(storage))
    .filter(thread => thread.ownerAgentId === ownerAgentId && (!targetType || thread.targetType === targetType))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export function getSmsThread(
  ownerAgentId: string,
  targetType: XingyeContactTargetType,
  targetId: string,
  storage: StorageLike | null = getLocalStorage(),
): XingyePhoneSmsThread | null {
  if (!ownerAgentId || !targetId) return null;
  return loadSmsThreadMap(storage)[threadKey(ownerAgentId, targetType, targetId)] ?? null;
}

type AddSmsMessageInput = {
  ownerAgentId: string;
  targetType: XingyeContactTargetType;
  targetId: string;
  content: string;
  direction: 'incoming' | 'outgoing';
  source?: XingyeContactSource;
  createdAt?: string;
  /**
   * 可选确定性 message id。心跳草稿 confirm 路径传 `from-draft-${draftId}` 以
   * 实现幂等：retry 时同 id 的消息已存在则跳过。普通调用留空，自动生成。
   */
  messageId?: string;
};

function normalizeCreatedAt(value: string | undefined): string {
  if (!value) return new Date().toISOString();
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? new Date().toISOString() : new Date(parsed).toISOString();
}

export function addSmsMessage(
  input: AddSmsMessageInput,
  storage: StorageLike | null = getLocalStorage(),
): XingyePhoneSmsThread | null {
  const normalizedContent = input.content.trim();
  if (!input.ownerAgentId || !input.targetId || !normalizedContent) return null;

  const map = loadSmsThreadMap(storage);
  const key = threadKey(input.ownerAgentId, input.targetType, input.targetId);
  const previous = map[key];

  /**
   * 幂等：若调用方提供 messageId 且 thread 里已有同 id 消息（confirm retry 场景），
   * 直接返回现状不重复 append。同 id 但内容不同的场景视为开发者错误，不处理。
   */
  if (input.messageId && previous?.messages.some((m) => m.id === input.messageId)) {
    return previous;
  }

  const threadId = previous?.id ?? createId('sms-thread');
  const remoteId = input.targetType === 'agent' ? input.targetId : `${input.targetType}:${input.targetId}`;
  const createdAt = normalizeCreatedAt(input.createdAt);
  const message: XingyePhoneSmsMessage = {
    id: input.messageId ?? createId('sms-message'),
    threadId,
    fromAgentId: input.direction === 'outgoing' ? input.ownerAgentId : remoteId,
    toAgentId: input.direction === 'outgoing' ? remoteId : input.ownerAgentId,
    content: normalizedContent,
    source: input.source ?? 'mock',
    createdAt,
  };

  const nextMessages = [...(previous?.messages ?? []), message]
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const nextUpdatedAt = nextMessages[nextMessages.length - 1]?.createdAt ?? createdAt;
  const next: XingyePhoneSmsThread = {
    id: threadId,
    ownerAgentId: input.ownerAgentId,
    targetType: input.targetType,
    targetId: input.targetId,
    source: previous?.source ?? 'phone_sms',
    messages: nextMessages,
    updatedAt: nextUpdatedAt,
  };
  map[key] = next;
  saveSmsThreadMap(map, storage);
  appendXingyePhoneEventBestEffort(input.ownerAgentId, {
    type: 'phone.sms_appended',
    source: 'xingye-phone-store',
    subjectId: threadId,
    createdAt,
    payload: {
      threadId,
      contactId: input.targetId,
      targetType: input.targetType,
      messageId: message.id,
      direction: input.direction,
      createdAt,
      sentAt: createdAt,
      from: message.fromAgentId,
      to: message.toAgentId,
      source: message.source,
    },
  }, `phone.sms_appended:${input.ownerAgentId}:${message.id}`);
  return next;
}

export function addMockSmsMessage(
  ownerAgentId: string,
  targetType: XingyeContactTargetType,
  targetId: string,
  content: string,
  direction: 'incoming' | 'outgoing',
  storage: StorageLike | null = getLocalStorage(),
): XingyePhoneSmsThread | null {
  return addSmsMessage({
    ownerAgentId,
    targetType,
    targetId,
    content,
    direction,
    source: 'mock',
  }, storage);
}

export function clearAiSmsHistory(
  ownerAgentId: string,
  storage: StorageLike | null = getLocalStorage(),
) {
  if (!ownerAgentId) return;
  const map = loadSmsThreadMap(storage);
  let changed = false;
  for (const [key, thread] of Object.entries(map)) {
    if (thread.ownerAgentId !== ownerAgentId) continue;
    const kept = thread.messages.filter(message => message.source !== 'ai_generated');
    if (kept.length === thread.messages.length) continue;
    changed = true;
    if (kept.length === 0) {
      delete map[key];
      continue;
    }
    const sorted = [...kept].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    map[key] = {
      ...thread,
      messages: sorted,
      updatedAt: sorted[sorted.length - 1]?.createdAt ?? thread.updatedAt,
    };
  }
  if (changed) saveSmsThreadMap(map, storage);
  clearSmsHistoryGenerationState(ownerAgentId, storage);
  setPhoneAiGenerationState(ownerAgentId, 'sms_history', {
    status: 'idle',
    error: undefined,
    finishedAt: undefined,
  }, storage);
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
        || event.key === XINGYE_PHONE_VIRTUAL_CONTACTS_STORAGE_KEY
        || event.key === XINGYE_PHONE_CONTACT_GENERATION_STATE_STORAGE_KEY
        || event.key === XINGYE_PHONE_AI_GENERATION_STATE_STORAGE_KEY
        || event.key === XINGYE_PHONE_SMS_HISTORY_GENERATION_STATE_STORAGE_KEY
        || event.key === XINGYE_PHONE_CONTACT_SNAPSHOTS_STORAGE_KEY
        || event.key === XINGYE_PHONE_CONTACT_AI_UPDATE_STATE_STORAGE_KEY
        || event.key === XINGYE_PHONE_CONTACT_CHANGE_LOG_STORAGE_KEY
      ) {
        onChanged();
      }
    };
    const onPersistence = () => onChanged();
    window.addEventListener(XINGYE_PHONE_CHANGED_EVENT, onChanged);
    window.addEventListener('storage', onStorage);
    window.addEventListener('xingye-persistence-changed', onPersistence);
    return () => {
      window.removeEventListener(XINGYE_PHONE_CHANGED_EVENT, onChanged);
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('xingye-persistence-changed', onPersistence);
    };
  }, []);
  return version;
}
