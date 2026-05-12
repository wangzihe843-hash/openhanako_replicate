/**
 * xingye-persistence.ts — 星野数据：localStorage 与 workspace（.xingye）之间的运行时桥
 *
 * - 无可用 workspace 或未连接 server：透传 window.localStorage。
 * - 有 workspace：首次迁移后内存镜像 + 防抖写入 .xingye/v1/data/*.json；roleProfiles 大图落 v1/media/。
 */

import { useStore } from '../stores';
import { hanaFetch } from '../hooks/use-hana-fetch';
import { hasServerConnection } from '../services/server-connection';
// @ts-expect-error — shared JS module
import { normalizeWorkspacePath } from '../../../../shared/workspace-history.js';

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
};

const MANIFEST_RELATIVE = 'v1/manifest.json';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

type MigrationFile = { relativePath: string; content: string; encoding?: 'utf8' | 'base64' };

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

function workspaceIdFromRoot(root: string): string {
  const s = workspaceStateKey(root);
  let h = 0;
  for (let i = 0; i < s.length; i += 1) {
    h = ((h << 5) - h) + s.charCodeAt(i);
    h |= 0;
  }
  return `w${Math.abs(h).toString(16)}`;
}

async function xingyeStoragePost(body: Record<string, unknown>): Promise<any> {
  const agentId = useStore.getState().currentAgentId;
  const res = await hanaFetch('/api/xingye/storage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, agentId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || res.statusText);
  return data;
}

function parseDataUrl(dataUrl: string): { mime: string; base64: string } | null {
  const m = /^data:([^;,]+);base64,(.*)$/is.exec(dataUrl);
  if (!m) return null;
  return { mime: m[1].trim(), base64: m[2].trim().replace(/\s/g, '') };
}

function extFromMime(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes('png')) return 'png';
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('webp')) return 'webp';
  if (m.includes('gif')) return 'gif';
  return 'bin';
}

function safeAgentMediaDir(agentId: string): string {
  return agentId.replace(/[^a-zA-Z0-9-_]/g, '_').slice(0, 120) || 'agent';
}

/**
 * 从内存中的 roleProfiles JSON 字符串生成落盘用的瘦身 JSON + 待上传二进制文件列表。
 * 内存中的 map 仍保留完整 data URL（由 hydrate 或当前编辑会话维护）。
 */
function buildRoleProfileDiskPayload(jsonStr: string): { diskJson: string; binaries: MigrationFile[] } {
  const binaries: MigrationFile[] = [];
  try {
    const map = JSON.parse(jsonStr) as Record<string, Record<string, unknown>>;
    if (!map || typeof map !== 'object') return { diskJson: jsonStr, binaries: [] };
    const out: Record<string, Record<string, unknown>> = {};
    for (const [agentId, prof] of Object.entries(map)) {
      if (!prof || typeof prof !== 'object') continue;
      const copy = { ...prof };
      const avatarUrl = copy.avatarDataUrl;
      if (typeof avatarUrl === 'string' && avatarUrl.startsWith('data:')) {
        const parsed = parseDataUrl(avatarUrl);
        if (parsed) {
          const ext = extFromMime(parsed.mime);
          const rel = `v1/media/${safeAgentMediaDir(agentId)}/avatar.${ext}`;
          binaries.push({ relativePath: rel, content: parsed.base64, encoding: 'base64' });
          copy.avatarMediaPath = rel;
          delete copy.avatarDataUrl;
        }
      }
      const bgUrl = copy.chatBackgroundDataUrl;
      if (typeof bgUrl === 'string' && bgUrl.startsWith('data:')) {
        const parsed = parseDataUrl(bgUrl);
        if (parsed) {
          const ext = extFromMime(parsed.mime);
          const rel = `v1/media/${safeAgentMediaDir(agentId)}/chat-background.${ext}`;
          binaries.push({ relativePath: rel, content: parsed.base64, encoding: 'base64' });
          copy.chatBackgroundMediaPath = rel;
          delete copy.chatBackgroundDataUrl;
        }
      }
      out[agentId] = copy;
    }
    return { diskJson: JSON.stringify(out), binaries };
  } catch {
    return { diskJson: jsonStr, binaries: [] };
  }
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
        const r = await xingyeStoragePost({ action: 'read', relativePath: avatarPath, binary: true });
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
        const r = await xingyeStoragePost({ action: 'read', relativePath: bgPath, binary: true });
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

async function writeFiles(files: MigrationFile[]): Promise<void> {
  for (const f of files) {
    await xingyeStoragePost({
      action: 'write',
      relativePath: f.relativePath,
      content: f.content,
      encoding: f.encoding === 'base64' ? 'base64' : 'utf8',
    });
  }
}

async function writeManifest(workspaceRoot: string): Promise<void> {
  const manifest = {
    schemaVersion: 1,
    workspaceRoot: workspaceStateKey(workspaceRoot),
    workspaceId: workspaceIdFromRoot(workspaceRoot),
    createdAt: new Date().toISOString(),
    migratedFromLocalStorageAt: new Date().toISOString(),
  };
  await writeFiles([{ relativePath: MANIFEST_RELATIVE, content: JSON.stringify(manifest, null, 2) }]);
}

async function persistMemoryToWorkspace(memory: Map<string, string>): Promise<void> {
  const files: MigrationFile[] = [];
  for (const key of XINGYE_KNOWN_STORAGE_KEYS) {
    const rel = KEY_TO_RELATIVE[key];
    if (!rel) continue;
    const value = memory.get(key);
    if (value === undefined) continue;
    if (key === 'xingye.roleProfiles') {
      const { diskJson, binaries } = buildRoleProfileDiskPayload(value);
      files.push({ relativePath: rel, content: diskJson, encoding: 'utf8' });
      files.push(...binaries);
    } else {
      files.push({ relativePath: rel, content: value, encoding: 'utf8' });
    }
  }
  await writeFiles(files);
}

async function loadWorkspaceIntoMemory(ws: string, memory: Map<string, string>): Promise<void> {
  void ws;
  for (const key of XINGYE_KNOWN_STORAGE_KEYS) {
    const rel = KEY_TO_RELATIVE[key];
    if (!rel) continue;
    try {
      const data = await xingyeStoragePost({ action: 'read', relativePath: rel });
      if (data?.content != null && typeof data.content === 'string') {
        memory.set(key, data.content);
      }
    } catch {
      /* skip missing */
    }
  }
  await hydrateRoleProfilesFromDisk(memory);
}

let mode: 'passthrough' | 'workspace' = 'passthrough';
const memory = new Map<string, string>();
let activeWorkspace: string | null = null;
let refreshVersion = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_DEBOUNCE_MS = 450;

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
  try {
    await persistMemoryToWorkspace(memory);
  } catch (err) {
    console.warn('[xingye-persistence] flush failed:', err);
  }
}

/** 测试或排障：强制把内存写回 workspace */
export async function flushXingyePersistenceNow(): Promise<void> {
  await flushNow();
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
      await persistMemoryToWorkspace(memory);
      await writeManifest(normalized);
      markWorkspaceMigrated(normalized);
    } else {
      await loadWorkspaceIntoMemory(normalized, memory);
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
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

export async function xingyeStorageClient(body: Record<string, unknown>): Promise<any> {
  return xingyeStoragePost(body);
}
