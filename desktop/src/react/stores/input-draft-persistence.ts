/**
 * 输入框草稿持久化（前端侧）
 *
 * 内存 zustand 是运行时唯一权威，server 是落盘影子：
 * - hydrateInputDrafts()：启动/恢复归档后拉全量，只填内存中不存在的键
 * - initInputDraftPersistence()：注册 input-draft-sync 监听，把 setDraft/clearDraft
 *   变更按 key 独立 debounce 后 PUT 到 /api/input-drafts
 * - session 身份始终使用 sessionId；兼容入口收到 sessionPath 时由 server 边界解析
 * - 服务端是持久真相，hydrate 不覆盖 renderer 内已经更新过的草稿
 */
import type { JSONContent } from '@tiptap/core';
import { hanaFetch } from '../hooks/use-hana-fetch';
import { resolveServerConnection, type ServerConnection } from '../services/server-connection';
import { useStore } from './index';
import { sessionScopedKey } from './session-slice';
import { resolveWorkspaceUiSurface } from './workspace-ui-state-actions';
import { acknowledgeDraftMutation, captureDraftHydrationGuard, captureDraftMutation, registerDraftSyncListener } from './input-draft-sync';
import { HOME_DRAFT_KEY } from '../../../../shared/input-drafts.ts';

const PUSH_DEBOUNCE_MS = 500;
const pushTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pushQueues = new Map<string, { key: string; scope: string; promise: Promise<void> }>();
let hydrationVersion = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 内存 map 的键要么是 sessionId，要么是老数据兜底的 sessionPath（含路径分隔符），要么是 __home__ */
function isPathLikeKey(key: string): boolean {
  return key.includes('/') || key.includes('\\');
}

function draftScope(connection: ServerConnection | null, surface: string): string {
  return connection ? JSON.stringify([
    connection.connectionId, connection.serverId, connection.studioId,
    connection.userId, connection.baseUrl, surface,
  ]) : '';
}

function currentDraftScope(): string {
  return draftScope(resolveServerConnection(useStore.getState()), resolveWorkspaceUiSurface());
}

async function pushDraft(
  key: string,
  text: string,
  doc: JSONContent | null,
  connection: ServerConnection,
  surface: string,
  mutation: ReturnType<typeof captureDraftMutation>,
): Promise<void> {
  const body: Record<string, unknown> = {
    surface,
    text,
    ...(doc ? { doc } : {}),
  };
  if (key === HOME_DRAFT_KEY) body.scope = 'home';
  else if (isPathLikeKey(key)) body.sessionPath = key;
  else body.sessionId = key;
  try {
    await hanaFetch('/api/input-drafts', {
      method: 'PUT',
      connection,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    acknowledgeDraftMutation(mutation);
  } catch (err) {
    // 尽力而为的影子：失败不打断输入，下一次变更自然重试
    console.warn('[input-drafts] draft push failed:', err);
  }
}

function schedulePush(key: string, text: string, doc: JSONContent | null): void {
  const connection = resolveServerConnection(useStore.getState());
  if (!connection) return;
  const surface = resolveWorkspaceUiSurface();
  const scope = draftScope(connection, surface);
  const timerKey = JSON.stringify([scope, key]);
  const locatorSnapshot = useStore.getState();
  const mutation = captureDraftMutation(key);
  const existing = pushTimers.get(timerKey);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pushTimers.delete(timerKey);
    // Debouncing alone cannot stop an older in-flight PUT from overwriting a clear.
    const locators = currentDraftScope() === scope ? useStore.getState() : locatorSnapshot;
    const identity = sessionScopedKey(locators, key) || key;
    const previous = [...pushQueues.values()]
      .filter(entry => entry.scope === scope && (sessionScopedKey(locators, entry.key) || entry.key) === identity)
      .map(entry => entry.promise);
    const next = Promise.allSettled(previous).then(() => pushDraft(key, text, doc, connection, surface, mutation));
    pushQueues.set(timerKey, { key, scope, promise: next });
    const cleanup = () => {
      if (pushQueues.get(timerKey)?.promise === next) pushQueues.delete(timerKey);
    };
    void next.then(cleanup, cleanup);
  }, PUSH_DEBOUNCE_MS);
  pushTimers.set(timerKey, timer);
}

/** 拉全量草稿填充内存；内存已有的键以内存为准（用户可能已开始打字） */
export async function hydrateInputDrafts(): Promise<void> {
  const connection = resolveServerConnection(useStore.getState());
  if (!connection) return;
  const surface = resolveWorkspaceUiSurface();
  const scope = draftScope(connection, surface);
  const version = ++hydrationVersion;
  const hydration = captureDraftHydrationGuard();
  try {
    let data: unknown = null;
    try {
      const res = await hanaFetch(`/api/input-drafts?surface=${surface}`, { connection });
      data = await res.json().catch(() => null);
    } catch (err) {
      console.warn('[input-drafts] hydrate failed:', err);
    }
    if (version !== hydrationVersion || currentDraftScope() !== scope) return;
    const serverDrafts = isRecord(data) ? data : null;
    const pendingDrafts = hydration.pendingDrafts();
    if (!serverDrafts && !pendingDrafts.length) return;
    const current = useStore.getState();
    const drafts = { ...current.drafts };
    const draftDocs = { ...current.draftDocs };
    const existingKeys = new Set(Object.keys(drafts).map(key => sessionScopedKey(current, key) || key));
    const applyEntry = (key: string, entry: unknown, local = false) => {
      if ((!local && !hydration.canHydrate(key)) || !isRecord(entry) || typeof entry.text !== 'string' || !entry.text.trim()) return;
      if (existingKeys.has(key)) return;
      drafts[key] = entry.text;
      existingKeys.add(key);
      if (isRecord(entry.doc)) {
        draftDocs[key] = entry.doc as JSONContent;
      } else {
        delete draftDocs[key];
      }
    };
    // Archive removes runtime drafts, but an unconfirmed local write still owns
    // its text and rich document. Restore it before considering the server shadow.
    for (const entry of pendingDrafts) applyEntry(entry.key, entry, true);
    if (serverDrafts?.home) applyEntry(HOME_DRAFT_KEY, serverDrafts.home);
    for (const [sessionId, entry] of Object.entries(isRecord(serverDrafts?.sessions) ? serverDrafts.sessions : {})) {
      applyEntry(sessionId, entry);
    }
    useStore.setState({ drafts, draftDocs, ...(serverDrafts ? { draftsHydratedAt: Date.now() } : {}) });
  } finally {
    hydration.dispose();
  }
}

/** 注册草稿变更监听；在 app-init 早期调用一次 */
export function initInputDraftPersistence(): void {
  registerDraftSyncListener({
    scope: currentDraftScope,
    canonicalKey: key => sessionScopedKey(useStore.getState(), key) || key,
    onSet: (key, text, doc) => schedulePush(key, text, doc),
    onClear: (key) => schedulePush(key, '', null),
  });
}
