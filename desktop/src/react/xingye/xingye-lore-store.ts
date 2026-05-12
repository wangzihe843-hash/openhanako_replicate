import { useEffect, useState } from 'react';
import { getXingyePersistenceStorage } from './xingye-persistence';

export type XingyeLoreCategory =
  | 'background'
  | 'worldview'
  | 'relationship'
  | 'event'
  | 'location'
  | 'organization'
  | 'character'
  | 'rule';

export type XingyeLoreInsertionMode = 'always' | 'keyword' | 'manual';
export type XingyeLoreVisibility = 'canonical' | 'private' | 'draft';

export type XingyeLoreEntry = {
  id: string;
  agentId: string;
  title: string;
  content: string;
  category: XingyeLoreCategory;
  keywords: string[];
  enabled: boolean;
  priority: number;
  insertionMode: XingyeLoreInsertionMode;
  visibility: XingyeLoreVisibility;
  createdAt: string;
  updatedAt: string;
};

export type XingyeLoreEntryMap = Record<string, XingyeLoreEntry>;

export type XingyeLoreEntryInput = Partial<
  Pick<
    XingyeLoreEntry,
    'title' | 'content' | 'category' | 'keywords' | 'enabled' | 'priority' | 'insertionMode' | 'visibility'
  >
>;

export const XINGYE_LORE_ENTRIES_STORAGE_KEY = 'xingye.loreEntries';

export const XINGYE_LORE_CATEGORIES: readonly XingyeLoreCategory[] = [
  'background',
  'worldview',
  'relationship',
  'event',
  'location',
  'organization',
  'character',
  'rule',
];

/** UI 展示用中文名（与设定库下拉、卡片一致）。 */
export const XINGYE_LORE_CATEGORY_LABELS: Record<XingyeLoreCategory, string> = {
  background: '背景',
  worldview: '世界观',
  relationship: '关系',
  event: '事件',
  location: '地点',
  organization: '组织',
  character: '人物',
  rule: '规则',
};

const XINGYE_LORE_ENTRIES_CHANGED_EVENT = 'xingye-lore-entries-changed';
const LEGACY_LORE_CATEGORY: Record<string, XingyeLoreCategory> = {
  world: 'worldview',
  memory: 'background',
  other: 'rule',
};
const INSERTION_MODES: XingyeLoreInsertionMode[] = ['always', 'keyword', 'manual'];
const VISIBILITIES: XingyeLoreVisibility[] = ['canonical', 'private', 'draft'];

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

function normalizeKeywords(value: unknown): string[] {
  if (Array.isArray(value)) {
    return Array.from(new Set(value.map(normalizeOptionalString).filter((item): item is string => !!item)));
  }
  if (typeof value === 'string') {
    return Array.from(new Set(value.split(/[,\n，、]/).map(normalizeOptionalString).filter((item): item is string => !!item)));
  }
  return [];
}

function normalizeCategory(value: unknown): XingyeLoreCategory {
  if (typeof value !== 'string') return 'background';
  const raw = value.trim();
  const mapped = LEGACY_LORE_CATEGORY[raw];
  if (mapped) return mapped;
  return XINGYE_LORE_CATEGORIES.includes(raw as XingyeLoreCategory) ? (raw as XingyeLoreCategory) : 'background';
}

function normalizeInsertionMode(value: unknown): XingyeLoreInsertionMode {
  return typeof value === 'string' && INSERTION_MODES.includes(value as XingyeLoreInsertionMode)
    ? value as XingyeLoreInsertionMode
    : 'manual';
}

function normalizeVisibility(value: unknown): XingyeLoreVisibility {
  return typeof value === 'string' && VISIBILITIES.includes(value as XingyeLoreVisibility)
    ? value as XingyeLoreVisibility
    : 'canonical';
}

function normalizePriority(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 100;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function createId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `lore-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeLoreEntry(value: unknown, fallbackId?: string): XingyeLoreEntry | null {
  if (!isRecord(value)) return null;

  const id = normalizeOptionalString(value.id) ?? fallbackId ?? createId();
  const agentId = normalizeOptionalString(value.agentId);
  const title = normalizeOptionalString(value.title);
  const content = normalizeOptionalString(value.content);
  if (!id || !agentId || !title || !content) return null;

  const createdAt = normalizeOptionalString(value.createdAt) ?? new Date(0).toISOString();
  const updatedAt = normalizeOptionalString(value.updatedAt) ?? createdAt;
  return {
    id,
    agentId,
    title,
    content,
    category: normalizeCategory(value.category),
    keywords: normalizeKeywords(value.keywords),
    enabled: typeof value.enabled === 'boolean' ? value.enabled : true,
    priority: normalizePriority(value.priority),
    insertionMode: normalizeInsertionMode(value.insertionMode),
    visibility: normalizeVisibility(value.visibility),
    createdAt,
    updatedAt,
  };
}

function loadLoreEntryMap(storage: StorageLike | null = getLocalStorage()): XingyeLoreEntryMap {
  if (!storage) return {};

  try {
    const raw = storage.getItem(XINGYE_LORE_ENTRIES_STORAGE_KEY);
    if (!raw) return {};

    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return {};

    const entries: XingyeLoreEntryMap = {};
    for (const [id, value] of Object.entries(parsed)) {
      const normalized = normalizeLoreEntry(value, id);
      if (normalized) entries[normalized.id] = normalized;
    }
    return entries;
  } catch (error) {
    console.warn('[xingye-lore-store] failed to load lore entries:', error);
    return {};
  }
}

function saveLoreEntryMap(entries: XingyeLoreEntryMap, storage: StorageLike | null = getLocalStorage()) {
  try {
    storage?.setItem(XINGYE_LORE_ENTRIES_STORAGE_KEY, JSON.stringify(entries));
  } catch (error) {
    console.warn('[xingye-lore-store] failed to save lore entries:', error);
  }
}

function notifyLoreEntriesChanged() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(XINGYE_LORE_ENTRIES_CHANGED_EVENT));
}

export function listLoreEntries(agentId: string | null | undefined, storage: StorageLike | null = getLocalStorage()): XingyeLoreEntry[] {
  if (!agentId) return [];
  return Object.values(loadLoreEntryMap(storage))
    .filter((entry) => entry.agentId === agentId)
    .sort((a, b) => b.priority - a.priority || b.updatedAt.localeCompare(a.updatedAt));
}

export function createLoreEntry(
  agentId: string,
  input: XingyeLoreEntryInput,
  storage: StorageLike | null = getLocalStorage(),
): XingyeLoreEntry {
  const now = new Date().toISOString();
  const entry = normalizeLoreEntry({
    id: createId(),
    agentId,
    title: input.title ?? '未命名设定',
    content: input.content ?? '待补充设定内容。',
    category: input.category ?? 'background',
    keywords: input.keywords ?? [],
    enabled: input.enabled ?? true,
    priority: input.priority ?? 50,
    insertionMode: input.insertionMode ?? 'manual',
    visibility: input.visibility ?? 'canonical',
    createdAt: now,
    updatedAt: now,
  });
  if (!entry) throw new Error('Unable to create Xingye lore entry without agentId, title, or content.');

  const entries = loadLoreEntryMap(storage);
  entries[entry.id] = entry;
  saveLoreEntryMap(entries, storage);
  notifyLoreEntriesChanged();
  return entry;
}

export function updateLoreEntry(
  id: string,
  patch: XingyeLoreEntryInput,
  storage: StorageLike | null = getLocalStorage(),
): XingyeLoreEntry | null {
  const entries = loadLoreEntryMap(storage);
  const previous = entries[id];
  if (!previous) return null;

  const next = normalizeLoreEntry({
    ...previous,
    ...patch,
    id: previous.id,
    agentId: previous.agentId,
    createdAt: previous.createdAt,
    updatedAt: new Date().toISOString(),
  });
  if (!next) return null;

  entries[id] = next;
  saveLoreEntryMap(entries, storage);
  notifyLoreEntriesChanged();
  return next;
}

export function deleteLoreEntry(id: string, storage: StorageLike | null = getLocalStorage()): boolean {
  const entries = loadLoreEntryMap(storage);
  if (!entries[id]) return false;
  delete entries[id];
  saveLoreEntryMap(entries, storage);
  notifyLoreEntriesChanged();
  return true;
}

export function toggleLoreEntry(id: string, storage: StorageLike | null = getLocalStorage()): XingyeLoreEntry | null {
  const entry = loadLoreEntryMap(storage)[id];
  if (!entry) return null;
  return updateLoreEntry(id, { enabled: !entry.enabled }, storage);
}

export function useXingyeLoreEntries(agentId: string | null | undefined): XingyeLoreEntry[] {
  const [entries, setEntries] = useState<XingyeLoreEntry[]>(() => listLoreEntries(agentId));

  useEffect(() => {
    const refresh = () => setEntries(listLoreEntries(agentId));
    refresh();
    if (typeof window === 'undefined') return undefined;

    const refreshFromStorage = (event: StorageEvent) => {
      if (event.key === XINGYE_LORE_ENTRIES_STORAGE_KEY) refresh();
    };

    const onPersistence = () => refresh();
    window.addEventListener(XINGYE_LORE_ENTRIES_CHANGED_EVENT, refresh);
    window.addEventListener('storage', refreshFromStorage);
    window.addEventListener('xingye-persistence-changed', onPersistence);
    return () => {
      window.removeEventListener(XINGYE_LORE_ENTRIES_CHANGED_EVENT, refresh);
      window.removeEventListener('storage', refreshFromStorage);
      window.removeEventListener('xingye-persistence-changed', onPersistence);
    };
  }, [agentId]);

  return entries;
}
