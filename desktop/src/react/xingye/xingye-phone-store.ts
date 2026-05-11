import { useEffect, useState } from 'react';
import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import type { XingyeRoleProfileMap } from './xingye-profile-store';
import {
  generateVirtualContactsForRole as generateRuleVirtualContacts,
  shouldBlockFamilyContacts as shouldBlockFamilyContactsRule,
  shouldSkipFamilyContacts as shouldSkipFamilyContactsRule,
} from './xingye-contact-generator';

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

export type XingyePhoneContactGenerationState = {
  ownerAgentId: string;
  generatedAt: string;
  profileFingerprint: string;
  mode?: XingyeContactGenerationMode;
  version: number;
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
};

export const XINGYE_PHONE_CONTACTS_STORAGE_KEY = 'xingye.phoneContacts';
export const XINGYE_PHONE_SMS_THREADS_STORAGE_KEY = 'xingye.phoneSmsThreads';
export const XINGYE_PHONE_VIRTUAL_CONTACTS_STORAGE_KEY = 'xingye.phoneVirtualContacts';
export const XINGYE_PHONE_CONTACT_GENERATION_STATE_STORAGE_KEY = 'xingye.phoneContactGenerationState';
export const XINGYE_PHONE_AI_GENERATION_STATE_STORAGE_KEY = 'xingye.phoneAiGenerationState';
export const XINGYE_PHONE_SMS_HISTORY_GENERATION_STATE_STORAGE_KEY = 'xingye.phoneSmsHistoryGenerationState';
export const XINGYE_PHONE_CONTACT_SNAPSHOTS_STORAGE_KEY = 'xingye.phoneContactSnapshots';
export const XINGYE_PHONE_CONTACT_AI_UPDATE_STATE_STORAGE_KEY = 'xingye.phoneContactAiUpdateState';

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

function contactKey(ownerAgentId: string, targetType: XingyeContactTargetType, targetId: string): string {
  return `${ownerAgentId}::${targetType}::${targetId}`;
}

function threadKey(ownerAgentId: string, targetType: XingyeContactTargetType, targetId: string): string {
  return `${ownerAgentId}::${targetType}::${targetId}`;
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
    source: normalizeOptionalString(value.source) as XingyePhoneSource | undefined,
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
      const profileFingerprint = normalizeOptionalString(value.profileFingerprint);
      const mode = normalizeOptionalString(value.mode) as XingyeContactGenerationMode | undefined;
      const version = typeof value.version === 'number' ? value.version : 1;
      if (!generatedAt || !profileFingerprint) continue;
      result[ownerAgentId] = { ownerAgentId, generatedAt, profileFingerprint, mode, version };
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
  targetType: XingyeContactTargetType,
  targetId: string,
  storage: StorageLike | null = getLocalStorage(),
): XingyePhoneContactMeta | null {
  if (!ownerAgentId || !targetId) return null;
  return loadContactMetaMap(storage)[contactKey(ownerAgentId, targetType, targetId)] ?? null;
}

export function savePhoneContactMeta(
  ownerAgentId: string,
  targetType: XingyeContactTargetType,
  targetId: string,
  patch: Partial<Omit<XingyePhoneContactMeta, 'ownerAgentId' | 'targetType' | 'targetId' | 'updatedAt'>>,
  storage: StorageLike | null = getLocalStorage(),
  options?: { markManualFields?: boolean },
): XingyePhoneContactMeta {
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
    manualEditedFields: [...nextManualFields],
    source: patch.source ?? previous?.source ?? 'phone_contacts',
    updatedAt: new Date().toISOString(),
  };
  map[key] = next;
  saveContactMetaMap(map, storage);
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

  const tags = (contact.tags ?? []).map(tag => tag.trim()).filter(Boolean).slice(0, 12);
  const faction = contact.faction?.trim() ? truncateGraphemes(contact.faction.trim(), 20) : undefined;

  const generatedReason = reasons.filter(Boolean).join('；') || 'AI 生成';

  return {
    ...contact,
    displayName,
    shortBio,
    remark,
    impression,
    relationshipHint,
    tags,
    faction,
    status: contact.status ?? 'active',
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

export function getDefaultUserContact(ownerAgentId: string, storage: StorageLike | null = getLocalStorage()): XingyePhoneContactView {
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
    for (const [ownerAgentId, value] of Object.entries(parsed)) {
      if (!Array.isArray(value)) continue;
      map[ownerAgentId] = value.filter((snapshot): snapshot is XingyeContactSnapshot => (
        isRecord(snapshot)
        && typeof snapshot.id === 'string'
        && typeof snapshot.createdAt === 'string'
        && typeof snapshot.reason === 'string'
        && Array.isArray(snapshot.virtualContacts)
        && isRecord(snapshot.contactMeta)
      )) as XingyeContactSnapshot[];
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
  const list = [...(snapshotsMap[ownerAgentId] ?? []), snapshot].slice(-12);
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
  const existing = getVirtualContacts(ownerAgentId, storage);
  const stateMap = loadGenerationStateMap(storage);
  const fingerprint = getProfileFingerprint(agent, profile);
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
  stateMap[ownerAgentId] = {
    ownerAgentId,
    generatedAt: new Date().toISOString(),
    profileFingerprint: fingerprint,
    mode: 'rule',
    version: 1,
  };
  saveGenerationStateMap(stateMap, storage);
  return generated;
}

function findVirtualContactByName(ownerAgentId: string, displayName: string, storage: StorageLike | null = getLocalStorage()): XingyeVirtualContact | null {
  const normalized = displayName.trim().toLowerCase();
  if (!normalized) return null;
  const contacts = getVirtualContacts(ownerAgentId, storage);
  return contacts.find(item => item.displayName.trim().toLowerCase() === normalized) ?? null;
}

export function applyAiGeneratedContacts(
  ownerAgentId: string,
  contacts: XingyeAiGeneratedContact[],
  options?: {
    preserveLinkedAgent?: boolean;
    storage?: StorageLike | null;
    virtualSource?: XingyeContactSource;
    metaSource?: XingyeContactSource;
  },
): XingyeVirtualContact[] {
  const storage = options?.storage ?? getLocalStorage();
  const virtualSource = options?.virtualSource ?? 'ai_generated';
  const metaSource = options?.metaSource ?? virtualSource;
  const output: XingyeVirtualContact[] = [];
  for (const raw of contacts) {
    const input = normalizeAiGeneratedContact(raw);
    if (!input.displayName?.trim()) continue;
    const existed = findVirtualContactByName(ownerAgentId, input.displayName, storage);
    const saved = saveVirtualContact(ownerAgentId, {
      ownerAgentId,
      id: existed?.id ?? '',
      displayName: input.displayName.trim(),
      kind: input.kind ?? 'unknown',
      shortBio: input.shortBio,
      relationshipHint: input.relationshipHint,
      tags: input.tags ?? [],
      faction: input.faction,
      status: input.status ?? 'active',
      linkedAgentId: existed?.linkedAgentId,
      source: virtualSource,
      generatedReason: input.generatedReason,
      createdAt: existed?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, storage);
    const existingMeta = getPhoneContactMeta(ownerAgentId, 'virtual_contact', saved.id, storage);
    const patch = preserveManualContactFields(existingMeta, {
      remark: input.remark,
      impression: input.impression,
      relationshipHint: input.relationshipHint,
      tags: input.tags,
      faction: input.faction,
      status: input.status,
      linkedAgentId: existingMeta?.linkedAgentId,
      source: metaSource,
    });
    savePhoneContactMeta(ownerAgentId, 'virtual_contact', saved.id, patch, storage, { markManualFields: false });
    output.push(saved);
  }
  return output;
}

export function applyAiContactUpdates(
  ownerAgentId: string,
  updates: XingyeAiContactUpdate[],
  options?: { storage?: StorageLike | null },
) {
  const storage = options?.storage ?? getLocalStorage();
  for (const raw of updates) {
    const update = normalizeAiContactUpdate(raw);
    if (update.action === 'add' && update.contact) {
      applyAiGeneratedContacts(ownerAgentId, [{
        ...update.contact,
        targetType: 'virtual_contact',
      }], { storage });
      continue;
    }
    let resolvedTargetId = update.targetId;
    if (!resolvedTargetId && update.matchName && update.targetType === 'virtual_contact') {
      resolvedTargetId = findVirtualContactByName(ownerAgentId, update.matchName, storage)?.id;
    }
    if (!resolvedTargetId) continue;
    if (update.targetType === 'user' && (update.action === 'delete' || update.action === 'block')) continue;
    if (update.action === 'delete') {
      savePhoneContactMeta(ownerAgentId, update.targetType, resolvedTargetId, { status: 'deleted', source: 'ai_generated' }, storage, { markManualFields: false });
      continue;
    }
    if (update.action === 'block') {
      savePhoneContactMeta(ownerAgentId, update.targetType, resolvedTargetId, { status: 'blocked', source: 'ai_generated' }, storage, { markManualFields: false });
      continue;
    }
    if (update.action === 'restore') {
      savePhoneContactMeta(ownerAgentId, update.targetType, resolvedTargetId, { status: 'active', source: 'ai_generated' }, storage, { markManualFields: false });
      continue;
    }
    if (update.action === 'update') {
      const existingMeta = getPhoneContactMeta(ownerAgentId, update.targetType, resolvedTargetId, storage);
      const patch = preserveManualContactFields(existingMeta, {
        ...update.patch,
        source: 'ai_generated',
      });
      savePhoneContactMeta(ownerAgentId, update.targetType, resolvedTargetId, patch, storage, { markManualFields: false });
    }
  }
}

export function regenerateAllVirtualContactsWithAI(
  ownerAgentId: string,
  options?: { preserveLinkedAgent?: boolean; storage?: StorageLike | null },
) {
  const storage = options?.storage ?? getLocalStorage();
  const preserveLinkedAgent = options?.preserveLinkedAgent ?? true;
  const virtualMap = loadVirtualContactMap(storage);
  const metaMap = loadContactMetaMap(storage);
  for (const [key, value] of Object.entries(virtualMap)) {
    if (!key.startsWith(`${ownerAgentId}::`)) continue;
    if (preserveLinkedAgent && value.linkedAgentId) continue;
    delete virtualMap[key];
  }
  for (const key of Object.keys(metaMap)) {
    if (!key.startsWith(`${ownerAgentId}::virtual_contact::`)) continue;
    const targetId = key.split('::')[2];
    const linked = metaMap[key]?.linkedAgentId;
    if (preserveLinkedAgent && linked) continue;
    delete metaMap[key];
    if (targetId) {
      for (const [vKey, vValue] of Object.entries(virtualMap)) {
        if (vKey === `${ownerAgentId}::${targetId}` && (!preserveLinkedAgent || !vValue.linkedAgentId)) delete virtualMap[vKey];
      }
    }
  }
  saveVirtualContactMap(virtualMap, storage);
  saveContactMetaMap(metaMap, storage);
}

export function rollbackAndUpdateVirtualContactsWithAI(
  ownerAgentId: string,
  updates: XingyeAiContactUpdate[],
  snapshotId?: string,
  storage: StorageLike | null = getLocalStorage(),
): boolean {
  const snapshot = snapshotId
    ? getPhoneContactSnapshots(ownerAgentId, storage).find(item => item.id === snapshotId) ?? null
    : getLatestPhoneContactSnapshot(ownerAgentId, storage);
  if (!snapshot) return false;
  const restored = restorePhoneContactSnapshot(ownerAgentId, snapshot.id, storage);
  if (!restored) return false;
  applyAiContactUpdates(ownerAgentId, updates, { storage });
  return true;
}

export function linkVirtualContactToAgent(ownerAgentId: string, virtualContactId: string, linkedAgentId: string) {
  const map = loadVirtualContactMap();
  const key = `${ownerAgentId}::${virtualContactId}`;
  const contact = map[key];
  if (!contact) return null;
  const updated = { ...contact, linkedAgentId, updatedAt: new Date().toISOString() };
  map[key] = updated;
  saveVirtualContactMap(map);
  savePhoneContactMeta(ownerAgentId, 'virtual_contact', virtualContactId, { linkedAgentId, source: 'manual' }, undefined, { markManualFields: false });
  markContactFieldManual(ownerAgentId, 'virtual_contact', virtualContactId, 'linkedAgentId');
  return updated;
}

export function unlinkVirtualContactFromAgent(ownerAgentId: string, virtualContactId: string) {
  const map = loadVirtualContactMap();
  const key = `${ownerAgentId}::${virtualContactId}`;
  const contact = map[key];
  if (!contact) return null;
  const updated = { ...contact, linkedAgentId: undefined, updatedAt: new Date().toISOString() };
  map[key] = updated;
  saveVirtualContactMap(map);
  savePhoneContactMeta(ownerAgentId, 'virtual_contact', virtualContactId, { linkedAgentId: '', source: 'manual' }, undefined, { markManualFields: false });
  markContactFieldManual(ownerAgentId, 'virtual_contact', virtualContactId, 'linkedAgentId');
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
    });
  }

  return views
    .filter(item => includeDeleted || item.status !== 'deleted')
    .sort((a, b) => a.remark.localeCompare(b.remark, 'zh-Hans-CN'));
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
  const threadId = previous?.id ?? createId('sms-thread');
  const remoteId = input.targetType === 'agent' ? input.targetId : `${input.targetType}:${input.targetId}`;
  const createdAt = normalizeCreatedAt(input.createdAt);
  const message: XingyePhoneSmsMessage = {
    id: createId('sms-message'),
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
