/**
 * xingye-persistence.ts — 星野数据：localStorage 与 workspace（.xingye）之间的运行时桥
 *
 * - 无可用 workspace 或未连接 server：透传 window.localStorage。
 * - 有 workspace：内存镜像 + 防抖写入 .xingye/（layout v2：按 agent 分域 manifest.json + agents/...）。
 */

import { useStore } from '../stores';
import { hasServerConnection } from '../services/server-connection';
// @ts-expect-error — shared JS module
import { normalizeWorkspacePath } from '../../../../shared/workspace-history.js';
import { postXingyeStorage } from './xingye-storage-api';
import type { XingyeWorkspaceManifestV2 } from './xingye-workspace-v2';
import {
  loadWorkspaceV2IntoMemoryMap,
  persistMemoryMapToWorkspaceV2,
  readWorkspaceManifestV2,
} from './xingye-workspace-v2';

export const XINGYE_WORKSPACE_STORAGE_STATE_KEY = 'xingye.workspaceStorage.v1';

/** 与各 store 中常量一致（避免循环 import） */
export const XINGYE_KNOWN_STORAGE_KEYS: readonly string[] = [
  'xingye.roleProfiles',
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

const KEY_TO_RELATIVE: Record<string, string> = {
  'xingye.roleProfiles': 'v1/data/role-profiles.json',
  'xingye.phoneContacts': 'v1/data/phone-contacts.json',
  'xingye.phoneSmsThreads': 'v1/data/phone-sms-threads.json',
  'xingye.phoneVirtualContacts': 'v1/data/phone-virtual-contacts.json',
  'xingye.phoneContactGenerationState': 'v1/data/phone-contact-generation-state.json',
  'xingye.phoneAiGenerationState': 'v1/data/phone-ai-generation-state.json',
  'xingye.phoneSmsHistoryGenerationState': 'v1/data/phone-sms-history-generation-state.json',
  'xingye.phoneContactSnapshots': 'v1/data/phone-contact-snapshots.json',
  'xingye.phoneContactAiUpdateState': 'v1/data/phone-contact-ai-update-state.json',
  'xingye.phone.contactChangeLog': 'v1/data/phone-contact-change-log.json',
  'xingye.moments': 'v1/data/moments.json',
  'xingye.loreEntries': 'v1/data/lore-entries.json',
  'xingye.relationshipStates': 'v1/data/relationship-states.json',
  'xingye.memoryCandidates': 'v1/data/memory-candidates.json',
};

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

interface WorkspaceMigrationState {
  workspaces: Record<string, { migratedAt: string; version: number }>;
}

function workspaceStateKey(ws: string): string {
  return normalizeWorkspacePath(ws) || ws;
}

function readMigrationState(): WorkspaceMigrationState {
  try {
    const raw = window.localStorage.getItem(XINGYE_WORKSPACE_STORAGE_STATE_KEY);
    if (!raw) return { workspaces: {} };
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || !('workspaces' in parsed)) return { workspaces: {} };
    const w = (parsed as WorkspaceMigrationState).workspaces;
    return { workspaces: typeof w === 'object' && w ? w : {} };
  } catch {
    return { workspaces: {} };
  }
}

function isWorkspaceMigrated(ws: string): boolean {
  return !!readMigrationState().workspaces[workspaceStateKey(ws)];
}

function markWorkspaceMigrated(ws: string): void {
  const next = readMigrationState();
  next.workspaces[workspaceStateKey(ws)] = { migratedAt: new Date().toISOString(), version: 1 };
  window.localStorage.setItem(XINGYE_WORKSPACE_STORAGE_STATE_KEY, JSON.stringify(next));
}

async function hydrateRoleProfilesFromDisk(memory: Map<string, string>): Promise<void> {
  const raw = memory.get('xingye.roleProfiles');
  if (!raw) return;
  let map: Record<string, Record<string, unknown>>;
  try {
    map = JSON.parse(raw) as Record<string, Record<string, unknown>>;
  } catch {
    return;
  }
  let changed = false;
  for (const [, prof] of Object.entries(map)) {
    if (!prof || typeof prof !== 'object') continue;
    const avatarPath = prof.avatarMediaPath;
    if (typeof avatarPath === 'string' && !prof.avatarDataUrl) {
      try {
        const r = await postXingyeStorage({ action: 'read', relativePath: avatarPath, binary: true });
        if (r?.encoding === 'base64' && r?.content) {
          const ext = (avatarPath.split('.').pop() || 'png').toLowerCase();
          const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
          prof.avatarDataUrl = `data:${mime};base64,${r.content}`;
          changed = true;
        }
      } catch { /* ignore */ }
    }
    const bgPath = prof.chatBackgroundMediaPath;
    if (typeof bgPath === 'string' && !prof.chatBackgroundDataUrl) {
      try {
        const r = await postXingyeStorage({ action: 'read', relativePath: bgPath, binary: true });
        if (r?.encoding === 'base64' && r?.content) {
          const ext = (bgPath.split('.').pop() || 'webp').toLowerCase();
          const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
          prof.chatBackgroundDataUrl = `data:${mime};base64,${r.content}`;
          changed = true;
        }
      } catch { /* ignore */ }
    }
  }
  if (changed) {
    memory.set('xingye.roleProfiles', JSON.stringify(map));
  }
}

let nextFlushManifestPatch:
  | Partial<Pick<XingyeWorkspaceManifestV2, 'migratedFromLocalStorageAt' | 'migratedFromLayoutV1At' | 'createdAt'>>
  | undefined;

async function loadWorkspaceIntoMemory(ws: string, memory: Map<string, string>): Promise<void> {
  void ws;
  const v2 = await readWorkspaceManifestV2();
  if (v2) {
    await loadWorkspaceV2IntoMemoryMap(memory);
    await hydrateRoleProfilesFromDisk(memory);
    return;
  }

  let hadV1Data = false;
  for (const key of XINGYE_KNOWN_STORAGE_KEYS) {
    const rel = KEY_TO_RELATIVE[key];
    if (!rel) continue;
    try {
      const data = await postXingyeStorage({ action: 'read', relativePath: rel });
      if (data?.content != null && typeof data.content === 'string') {
        memory.set(key, data.content);
        hadV1Data = true;
      }
    } catch {
      /* skip missing */
    }
  }
  await hydrateRoleProfilesFromDisk(memory);
  if (hadV1Data) {
    nextFlushManifestPatch = {
      ...nextFlushManifestPatch,
      migratedFromLayoutV1At: new Date().toISOString(),
    };
  }
}

let mode: 'passthrough' | 'workspace' = 'passthrough';
const memory = new Map<string, string>();
let activeWorkspace: string | null = null;
let refreshVersion = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_DEBOUNCE_MS = 450;
let lastWorkspaceFlushError: string | null = null;

function scheduleFlush(): void {
  if (mode !== 'workspace') return;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushNow();
  }, FLUSH_DEBOUNCE_MS);
}

async function flushNow(): Promise<void> {
  if (mode !== 'workspace' || !activeWorkspace) return;
  lastWorkspaceFlushError = null;
  try {
    const patch = nextFlushManifestPatch;
    nextFlushManifestPatch = undefined;
    await persistMemoryMapToWorkspaceV2(memory, workspaceStateKey(activeWorkspace), patch);
  } catch (err) {
    lastWorkspaceFlushError = err instanceof Error ? err.message : String(err);
    console.warn('[xingye-persistence] flush failed:', err);
  }
}

/** 测试或排障：强制把内存写回 workspace */
export async function flushXingyePersistenceNow(): Promise<void> {
  await flushNow();
}

export function getXingyePersistenceDiagnostics(): {
  mode: 'passthrough' | 'workspace';
  activeWorkspace: string | null;
  lastWorkspaceFlushError: string | null;
} {
  return { mode, activeWorkspace, lastWorkspaceFlushError };
}

export function getXingyePersistenceStorage(): StorageLike | null {
  if (typeof window === 'undefined') return null;

  if (mode === 'passthrough') {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  }

  return {
    getItem(key: string) {
      if (memory.has(key)) return memory.get(key) ?? null;
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    setItem(key: string, value: string) {
      memory.set(key, value);
      scheduleFlush();
    },
    removeItem(key: string) {
      memory.delete(key);
      scheduleFlush();
      try {
        window.localStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * 在 desk / workspace 变化后调用：迁移（若需要）、加载 .xingye 数据到内存。
 */
export async function refreshXingyeWorkspacePersistence(): Promise<void> {
  const myVersion = ++refreshVersion;
  if (!hasServerConnection(useStore.getState())) {
    mode = 'passthrough';
    memory.clear();
    activeWorkspace = null;
    return;
  }

  const s = useStore.getState();
  const rawWs = s.deskBasePath || s.selectedFolder || s.homeFolder;
  const ws = typeof rawWs === 'string' ? rawWs.trim() : '';
  if (!ws) {
    mode = 'passthrough';
    memory.clear();
    activeWorkspace = null;
    return;
  }

  const normalized = normalizeWorkspacePath(ws) || ws;
  if (activeWorkspace === normalized && mode === 'workspace') {
    return;
  }

  memory.clear();
  activeWorkspace = normalized;

  try {
    if (!isWorkspaceMigrated(normalized)) {
      for (const key of XINGYE_KNOWN_STORAGE_KEYS) {
        try {
          const v = window.localStorage.getItem(key);
          if (v != null) memory.set(key, v);
        } catch { /* ignore */ }
      }
      nextFlushManifestPatch = {
        ...nextFlushManifestPatch,
        migratedFromLocalStorageAt: new Date().toISOString(),
      };
      await persistMemoryMapToWorkspaceV2(memory, workspaceStateKey(normalized), nextFlushManifestPatch);
      nextFlushManifestPatch = undefined;
      markWorkspaceMigrated(normalized);
    } else {
      await loadWorkspaceIntoMemory(normalized, memory);
      if (nextFlushManifestPatch?.migratedFromLayoutV1At) {
        const patch = nextFlushManifestPatch;
        nextFlushManifestPatch = undefined;
        await persistMemoryMapToWorkspaceV2(memory, workspaceStateKey(normalized), patch);
      }
    }
    if (myVersion !== refreshVersion) return;
    mode = 'workspace';
    window.dispatchEvent(new CustomEvent('xingye-persistence-changed'));
  } catch (err) {
    console.warn('[xingye-persistence] refresh failed, falling back to localStorage:', err);
    if (myVersion !== refreshVersion) return;
    mode = 'passthrough';
    memory.clear();
    activeWorkspace = null;
  }
}

/** 单元测试：重置为透传 localStorage */
export function resetXingyePersistenceForTests(): void {
  mode = 'passthrough';
  memory.clear();
  activeWorkspace = null;
  nextFlushManifestPatch = undefined;
  lastWorkspaceFlushError = null;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

export async function xingyeStorageClient(body: Record<string, unknown>): Promise<any> {
  return postXingyeStorage(body);
}
