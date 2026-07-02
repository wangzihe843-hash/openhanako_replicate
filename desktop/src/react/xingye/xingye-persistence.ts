/**
 * Xingye business persistence bridge.
 *
 * Official business data is stored per agent under:
 *   HANA_HOME/agents/{agentId}/xingye/
 *
 * Callers must explicitly refresh with an OpenHanako agent id (typically the
 * Xingye shell selected agent). There is no fallback to currentAgentId or
 * workspace paths. When not in agent mode, getXingyePersistenceStorage() is
 * null (no silent localStorage writes), except tests may set
 * `window.__XINGYE_PERSISTENCE_DEV_LOCAL__ = true` to use localStorage.
 * Unscoped legacy localStorage → agent file migration is disabled unless
 * `window.__XINGYE_ALLOW_LEGACY_LOCAL_MIGRATE__ = true`.
 */

import { useStore } from '../stores';
import { hasServerConnection } from '../services/server-connection';
import { postXingyeStorage } from './xingye-storage-api';

export const XINGYE_WORKSPACE_STORAGE_STATE_KEY = 'xingye.workspaceStorage.v1';

export const XINGYE_KNOWN_STORAGE_KEYS: readonly string[] = [
  'xingye.phoneContacts',
  'xingye.phoneSmsThreads',
  'xingye.phoneVirtualContacts',
  'xingye.phoneContactGenerationState',
  'xingye.phoneAiGenerationState',
  'xingye.phoneSmsHistoryGenerationState',
  'xingye.phoneContactSnapshots',
  'xingye.phoneContactAiUpdateState',
  'xingye.phone.contactChangeLog',
  'xingye.moments',
  'xingye.loreEntries',
  'xingye.relationshipStates',
  'xingye.memoryCandidates',
] as const;

const KEY_TO_AGENT_RELATIVE: Record<string, string> = {
  'xingye.phoneContacts': 'phone/contacts.json',
  'xingye.phoneSmsThreads': 'phone/sms-threads.json',
  'xingye.phoneVirtualContacts': 'phone/virtual-contacts.json',
  'xingye.phoneContactGenerationState': 'phone/contact-generation-state.json',
  'xingye.phoneAiGenerationState': 'phone/ai-generation-state.json',
  'xingye.phoneSmsHistoryGenerationState': 'phone/sms-history-generation-state.json',
  'xingye.phoneContactSnapshots': 'phone/snapshots/index.json',
  'xingye.phoneContactAiUpdateState': 'phone/contact-ai-update-state.json',
  'xingye.phone.contactChangeLog': 'phone/contact-change-log.json',
  'xingye.moments': 'moments/posts.json',
  'xingye.loreEntries': 'lore/entries.json',
  'xingye.relationshipStates': 'relationship-state.json',
  'xingye.memoryCandidates': 'memory-candidates.json',
};

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export type XingyePersistenceMode = 'disabled' | 'agent' | 'error';

/**
 * 「生成类」入口在持久化未绑定到目标角色时抛出的专用错误。
 *
 * 调用方（如行程初始化 / 手动整理）可 `instanceof` 判定为「瞬时绑定竞态」而非真失败，
 * 跳过本次并在重绑完成（'xingye-persistence-changed'）后重试，而不是弹错误条。
 */
export class XingyePersistenceBindingError extends Error {
  readonly code = 'xingye_persistence_binding_mismatch';
  readonly expectedAgentId: string;
  readonly actualAgentId: string | null;
  constructor(expectedAgentId: string, actualAgentId: string | null) {
    super(
      `星野持久化未绑定到当前角色（期望「${expectedAgentId}」，实际「${actualAgentId ?? '未绑定'}」）：` +
        '已跳过本次生成以防跨角色串读，待角色数据加载完成后会自动重试。',
    );
    this.name = 'XingyePersistenceBindingError';
    this.expectedAgentId = expectedAgentId;
    this.actualAgentId = actualAgentId;
  }
}

let mode: XingyePersistenceMode = 'disabled';
const memory = new Map<string, string>();
let activeAgentId: string | null = null;
let refreshVersion = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_DEBOUNCE_MS = 450;
const FLUSH_RETRY_MS = 5_000;
let flushPending = false;
let memoryRevision = 0;
let lastAgentFlushError: string | null = null;
let lastRefreshError: string | null = null;

function parseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function devLocalStorageFallbackEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean((window as unknown as { __XINGYE_PERSISTENCE_DEV_LOCAL__?: boolean }).__XINGYE_PERSISTENCE_DEV_LOCAL__);
}

function emitPersistenceChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('xingye-persistence-changed'));
}

function isScopedPayloadEmpty(key: string, agentId: string, value: unknown): boolean {
  const scoped = pickAgentScopedData(key, agentId, value);
  if (scoped == null) return true;
  if (Array.isArray(scoped)) return scoped.length === 0;
  if (isRecord(scoped)) return Object.keys(scoped).length === 0;
  return false;
}

function ownsAgentScope(value: unknown, agentId: string): boolean {
  if (!isRecord(value)) return true;
  const owner =
    value.ownerAgentId ??
    value.agentId ??
    value.authorAgentId ??
    value.sourceAgentId ??
    value.characterAgentId;
  return typeof owner !== 'string' || owner === agentId;
}

function pickAgentScopedData(key: string, agentId: string, value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.filter((item) => ownsAgentScope(item, agentId));
  }

  if (!isRecord(value)) return value;

  const entries = Object.entries(value).filter(([, item]) => ownsAgentScope(item, agentId));
  return Object.fromEntries(entries);
}

function wrapAgentScopedData(key: string, agentId: string, value: unknown): unknown {
  if (value == null) return null;

  if (key === 'xingye.loreEntries' && Array.isArray(value)) {
    return Object.fromEntries(
      value
        .filter((entry) => isRecord(entry))
        .map((entry, index) => [String(entry.id ?? entry.key ?? index), entry]),
    );
  }

  return value;
}

async function readAgentFile(agentId: string, key: string): Promise<string | null> {
  const relativePath = KEY_TO_AGENT_RELATIVE[key];
  if (!relativePath) return null;
  const result = await postXingyeStorage({ action: 'readJson', agentId, relativePath });
  const data = result?.data ?? null;
  const wrapped = wrapAgentScopedData(key, agentId, data);
  return wrapped == null ? null : JSON.stringify(wrapped);
}

async function writeAgentFile(agentId: string, key: string, raw: string): Promise<void> {
  const relativePath = KEY_TO_AGENT_RELATIVE[key];
  if (!relativePath) return;
  const parsed = parseJson(raw);
  const data = pickAgentScopedData(key, agentId, parsed);
  await postXingyeStorage({ action: 'writeJson', agentId, relativePath, data });
}

/**
 * When agent-scope JSON is missing, read legacy global localStorage once,
 * scope to this agent, write to agent files, then re-read from API.
 * Does not migrate unrelated agents' rows into this agent (pickAgentScopedData).
 */
async function tryMigrateFromLocalStorageOnce(agentId: string, key: string): Promise<string | null> {
  if (typeof window === 'undefined' || devLocalStorageFallbackEnabled()) return null;
  /** Formal UI must not pull unscoped legacy keys into arbitrary agent dirs (cross-agent / hanako pollution). */
  if (!(window as unknown as { __XINGYE_ALLOW_LEGACY_LOCAL_MIGRATE__?: boolean }).__XINGYE_ALLOW_LEGACY_LOCAL_MIGRATE__) {
    return null;
  }
  try {
    const legacy = window.localStorage.getItem(key);
    if (!legacy) return null;
    const parsed = parseJson(legacy);
    if (parsed == null) return null;
    if (isScopedPayloadEmpty(key, agentId, parsed)) return null;
    await writeAgentFile(agentId, key, legacy);
    return await readAgentFile(agentId, key);
  } catch {
    return null;
  }
}

/**
 * Read an agent's scoped files into a FRESH local Map (does not touch the
 * module-global `memory`). The caller commits it atomically only after a
 * version check, so concurrent refreshes can't interleave their partial reads
 * into the shared map and the UI never sees a mixed-agent transient state.
 */
async function loadAgentScopedMemory(agentId: string): Promise<Map<string, string>> {
  const next = new Map<string, string>();
  for (const key of XINGYE_KNOWN_STORAGE_KEYS) {
    let raw = await readAgentFile(agentId, key);
    if (raw == null) {
      raw = await tryMigrateFromLocalStorageOnce(agentId, key);
    }
    if (raw != null) next.set(key, raw);
  }
  return next;
}

function scheduleFlush(delayMs = FLUSH_DEBOUNCE_MS): void {
  if (mode !== 'agent') return;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushNow();
  }, delayMs);
}

async function flushNow(): Promise<boolean> {
  if (mode !== 'agent' || !activeAgentId || !flushPending) return true;
  const revision = memoryRevision;
  lastAgentFlushError = null;
  try {
    for (const [key, raw] of memory.entries()) {
      await writeAgentFile(activeAgentId, key, raw);
    }
    if (revision === memoryRevision) {
      flushPending = false;
    } else {
      scheduleFlush();
    }
    return true;
  } catch (err) {
    flushPending = true;
    lastAgentFlushError = err instanceof Error ? err.message : String(err);
    console.warn('[xingye-persistence] agent flush failed:', err);
    scheduleFlush(FLUSH_RETRY_MS);
    return false;
  }
}

export async function flushXingyePersistenceNow(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await flushNow();
}

async function flushPendingBeforeTransition(myVersion: number): Promise<boolean> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!flushPending) return true;
  const flushed = await flushNow();
  if (myVersion !== refreshVersion) return false;
  return flushed;
}

export function getXingyePersistenceDiagnostics(): {
  mode: XingyePersistenceMode;
  activeAgentId: string | null;
  lastRefreshError: string | null;
  lastAgentFlushError: string | null;
  /** @deprecated misleading name; same as activeAgentId */
  activeWorkspace: string | null;
  /** @deprecated use lastRefreshError / lastAgentFlushError */
  lastWorkspaceFlushError: string | null;
} {
  return {
    mode,
    activeAgentId,
    lastRefreshError,
    lastAgentFlushError,
    activeWorkspace: activeAgentId,
    lastWorkspaceFlushError: lastRefreshError ?? lastAgentFlushError,
  };
}

/**
 * 跨角色串读守卫：断言星野持久化「当前已绑定到 agentId」。
 *
 * 背景：XingyeShell 用 `void refreshXingyeAgentPersistence(selectedXingyeAgentId)`
 * 异步重绑持久化；绑定完成前 getXingyePersistenceStorage() 仍指向上一个角色的 in-memory
 * 数据。手机各 app 的「生成类」入口按各自 ownerAgent 立即读 ambient lore / 关系状态 /
 * 最近上下文——切角色瞬间若抢跑，会读到「上一个角色」的数据（lore 还有 entry.agentId
 * 过滤兜底成空，但关系状态 / 最近上下文没有这层过滤，会真的串到别人）。
 *
 * 只在「确实绑定到了另一个角色」(mode==='agent' 且 activeAgentId 是别的 id) 时抛
 * {@link XingyePersistenceBindingError}——这才是 ambient 会串读他人数据的情形。
 * mode 非 'agent'（未绑定 / 断连 / 出错时 storage 为 null，ambient 读到的是空、不会串到他人）
 * 本就安全，不拦截，也避免误伤「持久化未绑定」的单元测试与首次绑定前的正常空读。
 * devLocal（仅测试）走全局 localStorage、不做 agent 绑定，直接跳过校验。
 */
export function assertXingyePersistenceBoundTo(agentId: string): void {
  const id = typeof agentId === 'string' ? agentId.trim() : '';
  if (!id) return;
  if (devLocalStorageFallbackEnabled()) return;
  if (mode === 'agent' && activeAgentId && activeAgentId !== id) {
    throw new XingyePersistenceBindingError(id, activeAgentId);
  }
}

export function getXingyePersistenceStorage(): StorageLike | null {
  if (typeof window === 'undefined') return null;

  if (devLocalStorageFallbackEnabled()) {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  }

  if (mode !== 'agent' || !activeAgentId) {
    return null;
  }

  return {
    getItem(key: string) {
      return memory.has(key) ? memory.get(key) ?? null : null;
    },
    setItem(key: string, value: string) {
      memory.set(key, value);
      memoryRevision += 1;
      flushPending = true;
      scheduleFlush();
    },
    removeItem(key: string) {
      memory.delete(key);
      memoryRevision += 1;
      flushPending = true;
      scheduleFlush();
    },
  };
}

/**
 * Load agent-scoped Xingye files into memory. Requires a non-empty agent id string.
 * Pass null/undefined/'' to enter disabled state (no storage, no localStorage writes).
 */
export async function refreshXingyeAgentPersistence(agentId: string | null | undefined): Promise<void> {
  const myVersion = ++refreshVersion;
  const id = typeof agentId === 'string' ? agentId.trim() : '';

  lastRefreshError = null;

  if (!id) {
    // 进入 disabled 前先落盘上一个 agent 的 debounced 待写（此刻 mode 仍 'agent'、activeAgentId 仍指向它）。
    // 否则 memory.clear() 后定时器再 fire 时 flushNow 因 mode!=='agent' 早退，上一个 agent 的待写被静默丢弃。
    if (!(await flushPendingBeforeTransition(myVersion))) return;
    mode = 'disabled';
    memory.clear();
    memoryRevision += 1;
    flushPending = false;
    activeAgentId = null;
    emitPersistenceChanged();
    return;
  }

  if (!hasServerConnection(useStore.getState())) {
    // 同上：断连进入 disabled 前，先把上一个 agent 的待写落盘，避免丢失。
    if (!(await flushPendingBeforeTransition(myVersion))) return;
    mode = 'disabled';
    memory.clear();
    memoryRevision += 1;
    flushPending = false;
    activeAgentId = null;
    emitPersistenceChanged();
    return;
  }

  if (activeAgentId === id && mode === 'agent') {
    return;
  }

  // Persist any debounced pending edit to the CURRENT agent BEFORE switching,
  // while activeAgentId/memory still point at it, and cancel the timer so it
  // cannot fire mid-load. Otherwise a flush during loadAgentScopedMemory would
  // serialize the NEW agent's rows but scope them to the OLD activeAgentId:
  // pickAgentScopedData filters owner-tagged rows to empty and overwrites the
  // OLD agent's file with {} (silent per-character data wipe), while owner-less
  // rows leak into the wrong agent's file.
  if (!(await flushPendingBeforeTransition(myVersion))) return;

  try {
    const loaded = await loadAgentScopedMemory(id);
    // A newer refresh superseded us during the load — don't clobber its memory.
    if (myVersion !== refreshVersion) return;
    memory.clear();
    for (const [key, raw] of loaded) memory.set(key, raw);
    memoryRevision += 1;
    flushPending = false;
    activeAgentId = id;
    mode = 'agent';
    lastRefreshError = null;
    emitPersistenceChanged();
  } catch (err) {
    lastRefreshError = err instanceof Error ? err.message : String(err);
    console.warn('[xingye-persistence] refresh failed:', err);
    if (myVersion !== refreshVersion) return;
    mode = 'error';
    memory.clear();
    memoryRevision += 1;
    flushPending = false;
    activeAgentId = null;
    emitPersistenceChanged();
  }
}

/** @deprecated Use {@link refreshXingyeAgentPersistence}; call with explicit agent id only. */
export async function refreshXingyeWorkspacePersistence(agentId?: string | null): Promise<void> {
  if (arguments.length === 0) {
    console.warn('[xingye-persistence] refreshXingyeWorkspacePersistence() invoked with no agent id — no-op (will not switch active agent).');
    return;
  }
  return refreshXingyeAgentPersistence(agentId);
}

export function resetXingyePersistenceForTests(): void {
  mode = 'disabled';
  memory.clear();
  memoryRevision = 0;
  flushPending = false;
  activeAgentId = null;
  lastAgentFlushError = null;
  lastRefreshError = null;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

export async function xingyeStorageClient(body: Record<string, unknown>): Promise<any> {
  return postXingyeStorage(body);
}
