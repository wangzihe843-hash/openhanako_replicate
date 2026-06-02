/**
 * desk-actions.ts — 工作台文件操作（纯函数，不依赖 DOM）
 *
 * 从 desk-shim.ts 提取，供 React 组件直接调用。
 */

import { useStore } from './index';
import { hanaFetch } from '../hooks/use-hana-fetch';
import { clearChat } from './agent-actions';
import type { DeskFile, DeskSearchResult } from '../types';
import type { WorkspaceDeskState } from './desk-slice';
import {
  hydratePersistedPreviewItems,
  loadPersistedWorkspaceUiState,
  schedulePersistCurrentWorkspaceUiState,
} from './workspace-ui-state-actions';
import { hasServerConnection } from '../services/server-connection';
// @ts-expect-error — shared JS module
import { mergeWorkspaceHistory, normalizeWorkspacePath, removeWorkspaceHistoryEntries } from '../../../../shared/workspace-history.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- store setState 回调及 IPC callback data */

const t = (key: string, vars?: Record<string, string | number>) => window.t?.(key, vars) ?? key;

let _deskLoadVersion = 0;
const _deskTreeLoadVersion = new Map<string, number>();

// ── 路径工具 ──

function normalizeFolder(value: string | null | undefined): string | null {
  return normalizeWorkspacePath(value);
}

function defaultDeskRoot(s: ReturnType<typeof useStore.getState>): string | undefined {
  return normalizeFolder(s.deskBasePath)
    || normalizeFolder(s.selectedFolder)
    || normalizeFolder(s.homeFolder)
    || undefined;
}

function selectedDeskAgentId(s: ReturnType<typeof useStore.getState>): string | null {
  return typeof s.selectedAgentId === 'string' && s.selectedAgentId.trim()
    ? s.selectedAgentId.trim()
    : null;
}

function addSelectedDeskAgentParam(params: URLSearchParams, s: ReturnType<typeof useStore.getState>): void {
  const agentId = selectedDeskAgentId(s);
  if (agentId) params.set('agentId', agentId);
}

function selectedDeskAgentBody(s: ReturnType<typeof useStore.getState>): { agentId?: string } {
  const agentId = selectedDeskAgentId(s);
  return agentId ? { agentId } : {};
}

function buildWorkspaceDeskState(s: ReturnType<typeof useStore.getState>): WorkspaceDeskState {
  const openTabs = [...(s.openTabs || [])];
  const activeTabId = s.activeTabId && openTabs.includes(s.activeTabId)
    ? s.activeTabId
    : (openTabs[0] || null);
  return {
    deskCurrentPath: '',
    deskFiles: [...(s.deskFiles || [])],
    deskTreeFilesByPath: { ...(s.deskTreeFilesByPath || {}) },
    deskExpandedPaths: [...(s.deskExpandedPaths || [])],
    deskSelectedPath: s.deskSelectedPath || '',
    deskJianContent: s.deskJianContent ?? null,
    cwdSkills: [...(s.cwdSkills || [])],
    cwdSkillsOpen: !!s.cwdSkillsOpen,
    jianDrawerOpen: !!s.jianDrawerOpen,
    rightWorkspaceTab: s.rightWorkspaceTab || 'workspace',
    jianView: s.jianView || 'desk',
    previewOpen: !!s.previewOpen,
    openTabs,
    activeTabId,
  };
}

function activePreviewTabId(openTabs: string[], activeTabId: string | null | undefined): string | null {
  return activeTabId && openTabs.includes(activeTabId)
    ? activeTabId
    : (openTabs[0] || null);
}

export function captureCurrentWorkspaceDeskState(root?: string | null): void {
  const s = useStore.getState();
  const key = normalizeFolder(root ?? s.deskBasePath);
  if (!key) return;
  s.setWorkspaceDeskState(key, buildWorkspaceDeskState(s));
  schedulePersistCurrentWorkspaceUiState(key);
}

export async function activateWorkspaceDesk(root: string | null | undefined, options: {
  reload?: boolean;
} = {}): Promise<void> {
  // Any workspace activation owns the visible desk state. Invalidate older file
  // loads even when the caller delays the reload until after another step
  // such as persisting workspace history.
  _deskLoadVersion += 1;

  const normalized = normalizeFolder(root);
  const s = useStore.getState();
  const currentRoot = normalizeFolder(s.deskBasePath);

  if (currentRoot) {
    captureCurrentWorkspaceDeskState(currentRoot);
  }

  if (!normalized) {
    useStore.setState({
      deskBasePath: '',
      deskCurrentPath: '',
      deskFiles: [],
      deskTreeFilesByPath: {},
      deskExpandedPaths: [],
      deskDirtyTreePaths: [],
      deskSelectedPath: '',
      deskJianContent: null,
      cwdSkills: [],
      cwdSkillsOpen: false,
      jianDrawerOpen: false,
      rightWorkspaceTab: 'workspace',
      jianView: 'desk',
      previewOpen: false,
      openTabs: [],
      activeTabId: null,
    });
    updateDeskContextBtn();
    return;
  }

  const latest = useStore.getState();
  const saved = latest.workspaceDeskStateByRoot?.[normalized] || null;
  const savedOpenTabs = saved?.openTabs || [];

  useStore.setState({
    deskBasePath: normalized,
    deskCurrentPath: '',
    deskFiles: [],
    deskTreeFilesByPath: saved?.deskTreeFilesByPath || {},
    deskExpandedPaths: saved?.deskExpandedPaths || [],
    deskDirtyTreePaths: [],
    deskSelectedPath: saved?.deskSelectedPath || '',
    deskJianContent: null,
    cwdSkills: saved?.cwdSkills || [],
    cwdSkillsOpen: saved?.cwdSkillsOpen || false,
    jianDrawerOpen: saved?.jianDrawerOpen ?? false,
    rightWorkspaceTab: saved?.rightWorkspaceTab || 'workspace',
    jianView: saved?.jianView || 'desk',
    previewOpen: saved?.previewOpen ?? false,
    openTabs: savedOpenTabs,
    activeTabId: activePreviewTabId(savedOpenTabs, saved?.activeTabId),
  });
  updateDeskContextBtn();

  if (!saved) {
    const persisted = await loadPersistedWorkspaceUiState(normalized);
    const restoredPreviewItems = await hydratePersistedPreviewItems(normalized, persisted);
    const restoredPreviewItemsById = new Map(restoredPreviewItems.map(item => [item.id, item]));
    const restoredOpenTabs = persisted?.openTabs?.filter(id => restoredPreviewItemsById.has(id)) || [];
    const restoredActiveTabId = activePreviewTabId(restoredOpenTabs, persisted?.activeTabId);
    if (persisted && normalizeFolder(useStore.getState().deskBasePath) === normalized) {
      useStore.setState((state: any) => ({
        deskCurrentPath: '',
        deskExpandedPaths: persisted.deskExpandedPaths || [],
        deskSelectedPath: persisted.deskSelectedPath || '',
        rightWorkspaceTab: persisted.rightWorkspaceTab || 'workspace',
        jianView: persisted.jianView || 'desk',
        jianDrawerOpen: persisted.jianDrawerOpen ?? false,
        previewOpen: !!persisted.previewOpen,
        openTabs: restoredOpenTabs,
        activeTabId: restoredActiveTabId,
        ...(restoredPreviewItems.length > 0
          ? {
              previewItems: [
                ...state.previewItems.filter((item: any) => !restoredPreviewItemsById.has(item.id)),
                ...restoredPreviewItems,
              ],
            }
          : {}),
      }));
    }
  }

  if (options.reload === false) return;
  await loadDeskFiles('', normalized);
  const expandedPaths = useStore.getState().deskExpandedPaths || [];
  for (const subdir of expandedPaths) {
    await loadDeskTreeFiles(subdir, { force: true, overrideDir: normalized });
  }
}

export function deskFullPath(name: string): string | null {
  const s = useStore.getState();
  if (!s.deskBasePath) return null;
  return s.deskBasePath + '/' + name;
}

export function deskCurrentDir(): string | null {
  const s = useStore.getState();
  if (!s.deskBasePath) return null;
  return s.deskBasePath;
}

// ── 文件操作 ──

export async function loadDeskFiles(subdir?: string, overrideDir?: string | null): Promise<void> {
  const s = useStore.getState();
  if (!hasServerConnection(s)) return;
  if (subdir !== undefined) s.setDeskCurrentPath('');
  const myVersion = ++_deskLoadVersion;
  try {
    const params = new URLSearchParams();
    // overrideDir 是显式调用契约：string 表示指定根目录，null 表示不复用旧 deskBasePath。
    // undefined 才走 store 中已有 deskBasePath，避免普通刷新丢失当前根目录。
    const dir = overrideDir !== undefined
      ? (overrideDir || undefined)
      : defaultDeskRoot(s);
    if (dir) params.set('dir', dir);
    addSelectedDeskAgentParam(params, s);
    const curPath = '';
    if (curPath) params.set('subdir', curPath);
    const qs = params.toString() ? `?${params}` : '';
    const res = await hanaFetch(`/api/desk/files${qs}`);
    const data = await res.json();
    if (myVersion !== _deskLoadVersion) return;
    if (data.error) throw new Error(String(data.error));
    const st = useStore.getState();
    st.setDeskFiles(data.files || []);
    st.setDeskTreeFiles('', data.files || []);
    st.setDeskSelectedPath('');
    if (data.basePath) st.setDeskBasePath(data.basePath);
    loadJianContent();
    updateDeskContextBtn();
  } catch (err) {
    console.error('[jian-desk] load failed:', err);
    if (myVersion !== _deskLoadVersion) return;
    const st = useStore.getState();
    st.setDeskFiles([]);
    st.setDeskCurrentPath('');
    st.setDeskTreeFiles('', []);
    st.setDeskJianContent(null);
    updateDeskContextBtn();
  }
}

function deskTreeLoadKey(root: string | undefined, subdir: string): string {
  return `${root || ''}\n${subdir}`;
}

function normalizeSubdir(value: string | null | undefined): string {
  return (value || '').replace(/^\/+|\/+$/g, '');
}

function childSubdir(parent: string, name: string): string {
  const normalized = normalizeSubdir(parent);
  return normalized ? `${normalized}/${name}` : name;
}

function ancestorSubdirs(pathValue: string): string[] {
  const normalized = normalizeSubdir(pathValue);
  if (!normalized) return [];
  const parts = normalized.split('/').filter(Boolean);
  const result: string[] = [];
  for (let i = 1; i <= parts.length; i++) {
    result.push(parts.slice(0, i).join('/'));
  }
  return result;
}

function normalizeWorkspaceComparePath(value: string | null | undefined): string {
  return (normalizeFolder(value) || '').replace(/\\/g, '/').replace(/\/+$/g, '');
}

function workspaceCompareKey(value: string): string {
  return (/^[A-Za-z]:\//.test(value) || value.startsWith('//'))
    ? value.toLowerCase()
    : value;
}

function relativeSubdirForWorkspacePath(root: string | null | undefined, targetPath: string | null | undefined): string | null {
  const normalizedRoot = normalizeWorkspaceComparePath(root);
  const normalizedTarget = normalizeWorkspaceComparePath(targetPath);
  if (!normalizedRoot || !normalizedTarget) return null;
  const rootKey = workspaceCompareKey(normalizedRoot);
  const targetKey = workspaceCompareKey(normalizedTarget);
  if (targetKey === rootKey) return '';
  const prefixKey = rootKey.endsWith('/') ? rootKey : `${rootKey}/`;
  if (!targetKey.startsWith(prefixKey)) return null;
  const prefixLength = normalizedRoot.endsWith('/') ? normalizedRoot.length : normalizedRoot.length + 1;
  return normalizeSubdir(normalizedTarget.slice(prefixLength));
}

function replaceSubdirPrefix(value: string, oldPrefix: string, newPrefix: string): string {
  if (value === oldPrefix) return newPrefix;
  if (value.startsWith(`${oldPrefix}/`)) return `${newPrefix}${value.slice(oldPrefix.length)}`;
  return value;
}

function removeSubdirPrefix(value: string, prefix: string): boolean {
  return value === prefix || value.startsWith(`${prefix}/`);
}

function isPlainFileName(value: string): boolean {
  return !!value && !value.includes('/') && !value.includes('\\') && value !== '.' && value !== '..';
}

function uniqueNameForSubdir(subdir: string, baseName: string): string {
  const s = useStore.getState();
  const normalizedSubdir = normalizeSubdir(subdir);
  const files = s.deskTreeFilesByPath?.[normalizedSubdir]
    || (!normalizedSubdir ? s.deskFiles : []);
  const existing = new Set((files || []).map((f: { name: string }) => f.name));
  if (!existing.has(baseName)) return baseName;

  const dotIndex = baseName.lastIndexOf('.');
  const hasExtension = dotIndex > 0;
  const stem = hasExtension ? baseName.slice(0, dotIndex) : baseName;
  const ext = hasExtension ? baseName.slice(dotIndex) : '';
  let index = 2;
  while (existing.has(`${stem} ${index}${ext}`)) index += 1;
  return `${stem} ${index}${ext}`;
}

function joinDeskPath(basePath: string, subdir: string, name: string): string {
  const separator = basePath.includes('\\') && !basePath.includes('/') ? '\\' : '/';
  const base = basePath.replace(/[\\/]+$/g, '');
  const parts = normalizeSubdir(subdir).split('/').filter(Boolean);
  return [base, ...parts, name].join(separator);
}

export async function loadDeskTreeFiles(subdir = '', options: { force?: boolean; overrideDir?: string | null } = {}): Promise<void> {
  const s = useStore.getState();
  if (!hasServerConnection(s)) return;
  const dir = options.overrideDir !== undefined
    ? (options.overrideDir || undefined)
    : defaultDeskRoot(s);
  const normalizedSubdir = normalizeSubdir(subdir);
  const cached = s.deskTreeFilesByPath?.[normalizedSubdir];
  if (cached && !options.force) return;

  const key = deskTreeLoadKey(dir, normalizedSubdir);
  const myVersion = (_deskTreeLoadVersion.get(key) || 0) + 1;
  _deskTreeLoadVersion.set(key, myVersion);

  try {
    const params = new URLSearchParams();
    if (dir) params.set('dir', dir);
    if (normalizedSubdir) params.set('subdir', normalizedSubdir);
    addSelectedDeskAgentParam(params, s);
    const qs = params.toString() ? `?${params}` : '';
    const res = await hanaFetch(`/api/desk/files${qs}`);
    const data = await res.json();
    if (_deskTreeLoadVersion.get(key) !== myVersion) return;
    if (data.error) throw new Error(String(data.error));
    const st = useStore.getState();
    if (data.basePath) st.setDeskBasePath(data.basePath);
    st.setDeskTreeFiles(normalizedSubdir, data.files || []);
    if (!normalizedSubdir) st.setDeskFiles(data.files || []);
  } catch (err) {
    console.error('[desk-tree] load failed:', err);
    if (_deskTreeLoadVersion.get(key) !== myVersion) return;
    useStore.getState().setDeskTreeFiles(normalizedSubdir, []);
  }
}

export async function searchDeskFiles(query: string): Promise<DeskSearchResult[]> {
  const s = useStore.getState();
  if (!hasServerConnection(s)) return [];
  const trimmed = query.trim();
  if (!trimmed) return [];
  try {
    const params = new URLSearchParams();
    const dir = defaultDeskRoot(s);
    if (dir) params.set('dir', dir);
    addSelectedDeskAgentParam(params, s);
    params.set('q', trimmed);
    const res = await hanaFetch(`/api/desk/search-files?${params}`);
    const data = await res.json();
    if (data.error) throw new Error(String(data.error));
    return Array.isArray(data.results) ? data.results : [];
  } catch (err) {
    console.error('[desk] search failed:', err);
    return [];
  }
}

export async function jumpToDeskSearchResult(result: DeskSearchResult): Promise<void> {
  const target = normalizeSubdir(result.relativePath);
  if (!target) return;
  const parent = normalizeSubdir(result.parentSubdir);
  const foldersToExpand = result.isDir
    ? ancestorSubdirs(target)
    : ancestorSubdirs(parent);
  useStore.setState((s: any) => ({
    deskExpandedPaths: Array.from(new Set([...(s.deskExpandedPaths || []), ...foldersToExpand])),
    deskSelectedPath: target,
  }));
  schedulePersistCurrentWorkspaceUiState();
  for (const subdir of foldersToExpand) {
    await loadDeskTreeFiles(subdir);
  }
  useStore.getState().setDeskSelectedPath(target);
}

export async function revealDeskDirectory(directoryPath: string): Promise<boolean> {
  const s = useStore.getState();
  if (!hasServerConnection(s)) return false;
  const root = normalizeFolder(s.deskBasePath) || defaultDeskRoot(s);
  const target = relativeSubdirForWorkspacePath(root, directoryPath);
  if (target == null) return false;

  const foldersToExpand = ancestorSubdirs(target);
  useStore.setState((state: any) => ({
    deskCurrentPath: '',
    rightWorkspaceTab: 'workspace',
    deskExpandedPaths: Array.from(new Set([...(state.deskExpandedPaths || []), ...foldersToExpand])),
    deskSelectedPath: target,
  }));
  schedulePersistCurrentWorkspaceUiState(root);

  await loadDeskTreeFiles('', { force: true, overrideDir: root });
  for (const subdir of foldersToExpand) {
    await loadDeskTreeFiles(subdir, { force: true, overrideDir: root });
  }

  useStore.setState((state: any) => ({
    deskCurrentPath: '',
    rightWorkspaceTab: 'workspace',
    deskExpandedPaths: Array.from(new Set([...(state.deskExpandedPaths || []), ...foldersToExpand])),
    deskSelectedPath: target,
  }));
  schedulePersistCurrentWorkspaceUiState(root);
  return true;
}

export async function loadJianContent(): Promise<void> {
  const s = useStore.getState();
  if (!hasServerConnection(s)) return;
  try {
    const params = new URLSearchParams();
    if (s.deskBasePath) params.set('dir', s.deskBasePath);
    addSelectedDeskAgentParam(params, s);
    const qs = params.toString() ? `?${params}` : '';
    const res = await hanaFetch(`/api/desk/jian${qs}`);
    const data = await res.json();
    useStore.getState().setDeskJianContent(data.content || null);
  } catch (err) {
    console.error('[jian] load jian.md failed:', err);
    useStore.getState().setDeskJianContent(null);
  }
}

export async function saveJianContent(content?: string): Promise<void> {
  const s = useStore.getState();
  if (!hasServerConnection(s)) return;
  const text = content ?? s.deskJianContent ?? '';
  try {
    await hanaFetch('/api/desk/jian', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...selectedDeskAgentBody(s), dir: s.deskBasePath || undefined, subdir: '', content: text }),
    });
    useStore.getState().setDeskJianContent(text || null);
    const st2 = useStore.getState();
    const params = new URLSearchParams();
    if (st2.deskBasePath) params.set('dir', st2.deskBasePath);
    addSelectedDeskAgentParam(params, st2);
    const qs = params.toString() ? `?${params}` : '';
    const res2 = await hanaFetch(`/api/desk/files${qs}`);
    const data2 = await res2.json();
    const st = useStore.getState();
    st.setDeskFiles(data2.files || []);
    st.setDeskTreeFiles('', data2.files || []);
  } catch (err) {
    console.error('[jian] save jian.md failed:', err);
  }
}

export async function deskUploadFiles(paths: string[]): Promise<void> {
  const s = useStore.getState();
  try {
    const res = await hanaFetch('/api/desk/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...selectedDeskAgentBody(s), action: 'upload', dir: s.deskBasePath || undefined, subdir: '', paths }),
    });
    const data = await res.json();
    if (data.files) {
      const st = useStore.getState();
      st.setDeskFiles(data.files);
      st.setDeskTreeFiles('', data.files);
    }
  } catch (err) {
    console.error('[jian-desk] upload failed:', err);
  }
}

export async function deskUploadFilesToSubdir(paths: string[], subdir: string): Promise<void> {
  const s = useStore.getState();
  const normalizedSubdir = subdir.replace(/^\/+|\/+$/g, '');
  try {
    const res = await hanaFetch('/api/desk/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...selectedDeskAgentBody(s), action: 'upload', dir: s.deskBasePath || undefined, subdir: normalizedSubdir, paths }),
    });
    const data = await res.json();
    if (data.files) {
      const st = useStore.getState();
      st.setDeskTreeFiles(normalizedSubdir, data.files);
      if (!normalizedSubdir) st.setDeskFiles(data.files);
    }
  } catch (err) {
    console.error('[jian-desk] upload to tree failed:', err);
  }
}

function applyFilesForSubdir(subdir: string, files: DeskFile[]): void {
  const normalizedSubdir = normalizeSubdir(subdir);
  const st = useStore.getState();
  st.setDeskTreeFiles(normalizedSubdir, files);
  if (!normalizedSubdir) st.setDeskFiles(files);
}

export async function deskCreateFileInSubdir(subdir: string, name: string, text: string): Promise<boolean> {
  const s = useStore.getState();
  const normalizedSubdir = normalizeSubdir(subdir);
  const trimmed = name.trim();
  if (!isPlainFileName(trimmed)) return false;
  try {
    const res = await hanaFetch('/api/desk/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...selectedDeskAgentBody(s),
        action: 'create',
        dir: s.deskBasePath || undefined,
        subdir: normalizedSubdir,
        name: trimmed,
        content: text,
      }),
    });
    const data = await res.json();
    if (data.error) { console.error('[desk] create file error:', data.error); return false; }
    if (data.files) applyFilesForSubdir(normalizedSubdir, data.files);
    return true;
  } catch (err) {
    console.error('[jian-desk] create failed:', err);
    return false;
  }
}

export async function deskCreateFile(text: string): Promise<void> {
  const d = new Date();
  const ts = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const locale = window.i18n?.locale || 'zh';
  const prefix = locale.startsWith('zh') ? '备注' : locale.startsWith('ja') ? 'メモ' : locale.startsWith('ko') ? '메모' : 'note';
  const name = uniqueNameForSubdir('', `${ts}-${prefix}.md`);
  await deskCreateFileInSubdir('', name, text);
}

export async function deskMoveFiles(names: string[], destFolder: string): Promise<void> {
  const s = useStore.getState();
  try {
    const res = await hanaFetch('/api/desk/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...selectedDeskAgentBody(s), action: 'move', dir: s.deskBasePath || undefined, subdir: '', names, destFolder }),
    });
    const data = await res.json();
    if (data.files) {
      const st = useStore.getState();
      st.setDeskFiles(data.files);
      st.setDeskTreeFiles('', data.files);
    }
  } catch (err) {
    console.error('[jian-desk] move failed:', err);
  }
}

export interface DeskTreeMoveItem {
  sourceSubdir: string;
  name: string;
  isDirectory?: boolean;
}

function applyRenamedDirectoryCache(oldSubdir: string, newSubdir: string): void {
  useStore.setState((s: any) => {
    const nextTree: Record<string, DeskFile[]> = {};
    for (const [key, files] of Object.entries(s.deskTreeFilesByPath || {})) {
      const nextKey = replaceSubdirPrefix(key, oldSubdir, newSubdir);
      nextTree[nextKey] = files as DeskFile[];
    }
    return {
      deskTreeFilesByPath: nextTree,
      deskExpandedPaths: (s.deskExpandedPaths || []).map((path: string) => replaceSubdirPrefix(path, oldSubdir, newSubdir)),
      deskSelectedPath: replaceSubdirPrefix(s.deskSelectedPath || '', oldSubdir, newSubdir),
      deskCurrentPath: '',
    };
  });
  schedulePersistCurrentWorkspaceUiState();
}

function pruneRemovedDirectoryCache(removedSubdirs: string[]): void {
  if (removedSubdirs.length === 0) return;
  useStore.setState((s: any) => {
    const nextTree: Record<string, DeskFile[]> = {};
    for (const [key, files] of Object.entries(s.deskTreeFilesByPath || {})) {
      if (removedSubdirs.some(prefix => removeSubdirPrefix(key, prefix))) continue;
      nextTree[key] = files as DeskFile[];
    }
    return {
      deskTreeFilesByPath: nextTree,
      deskExpandedPaths: (s.deskExpandedPaths || []).filter((path: string) => !removedSubdirs.some(prefix => removeSubdirPrefix(path, prefix))),
      deskSelectedPath: removedSubdirs.some(prefix => removeSubdirPrefix(s.deskSelectedPath || '', prefix)) ? '' : s.deskSelectedPath,
    };
  });
  schedulePersistCurrentWorkspaceUiState();
}

export async function deskMoveTreeFiles(items: DeskTreeMoveItem[], destSubdir: string): Promise<void> {
  const s = useStore.getState();
  if (items.length === 0) return;
  const normalizedDest = destSubdir.replace(/^\/+|\/+$/g, '');
  try {
    const res = await hanaFetch('/api/desk/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...selectedDeskAgentBody(s),
        action: 'movePaths',
        dir: s.deskBasePath || undefined,
        items: items.map(item => ({
          sourceSubdir: item.sourceSubdir.replace(/^\/+|\/+$/g, ''),
          name: item.name,
          isDirectory: !!item.isDirectory,
        })),
        destSubdir: normalizedDest,
        currentSubdir: '',
      }),
    });
    const data = await res.json();
    const st = useStore.getState();
    if (data.filesByPath && typeof data.filesByPath === 'object') {
      for (const [subdir, files] of Object.entries(data.filesByPath)) {
        st.setDeskTreeFiles(subdir, files as DeskFile[]);
        if (normalizeSubdir(subdir) === '') st.setDeskFiles(files as DeskFile[]);
      }
    }
    if (data.files && !data.filesByPath) {
      st.setDeskFiles(data.files);
      st.setDeskTreeFiles('', data.files);
    }
  } catch (err) {
    console.error('[jian-desk] tree move failed:', err);
  }
}

export async function deskRenameTreeItem(sourceSubdir: string, oldName: string, newName: string, isDirectory = false): Promise<boolean> {
  const s = useStore.getState();
  const normalizedSource = normalizeSubdir(sourceSubdir);
  const trimmed = newName.trim();
  if (!isPlainFileName(oldName) || !isPlainFileName(trimmed)) return false;
  if (oldName === trimmed) return true;
  try {
    const res = await hanaFetch('/api/desk/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...selectedDeskAgentBody(s),
        action: 'rename',
        dir: s.deskBasePath || undefined,
        subdir: normalizedSource,
        oldName,
        newName: trimmed,
      }),
    });
    const data = await res.json();
    if (data.error) { console.error('[desk] tree rename error:', data.error); return false; }
    if (isDirectory) {
      applyRenamedDirectoryCache(childSubdir(normalizedSource, oldName), childSubdir(normalizedSource, trimmed));
    }
    if (data.files) {
      const st = useStore.getState();
      st.setDeskTreeFiles(normalizedSource, data.files);
      if (!normalizedSource) st.setDeskFiles(data.files);
    }
    return true;
  } catch (err) {
    console.error('[desk] tree rename failed:', err);
    return false;
  }
}

export async function deskTrashTreeItems(items: DeskTreeMoveItem[]): Promise<boolean> {
  const s = useStore.getState();
  const trashItem = window.platform?.trashItem;
  if (!trashItem) {
    console.error('[desk] system trash is not available');
    return false;
  }
  if (!s.deskBasePath || items.length === 0) return false;

  const affectedParents = new Set<string>();
  const removedDirs: string[] = [];
  const paths = items.map(item => ({
    ...item,
    sourceSubdir: normalizeSubdir(item.sourceSubdir),
    path: joinDeskPath(s.deskBasePath, item.sourceSubdir, item.name),
  }));

  let trashedCount = 0;
  try {
    for (const item of paths) {
      if (!isPlainFileName(item.name)) break;
      const ok = await trashItem(item.path);
      if (!ok) break;
      trashedCount += 1;
      affectedParents.add(item.sourceSubdir);
      if (item.isDirectory) removedDirs.push(childSubdir(item.sourceSubdir, item.name));
    }
  } catch (err) {
    console.error('[desk] tree trash failed:', err);
  } finally {
    pruneRemovedDirectoryCache(removedDirs);
    for (const parent of affectedParents) {
      await loadDeskTreeFiles(parent, { force: true });
    }
  }
  return trashedCount === paths.length;
}

export async function deskRemoveFile(name: string): Promise<void> {
  const s = useStore.getState();
  try {
    const res = await hanaFetch('/api/desk/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...selectedDeskAgentBody(s), action: 'remove', dir: s.deskBasePath || undefined, subdir: '', name }),
    });
    const data = await res.json();
    if (data.files) {
      const st = useStore.getState();
      st.setDeskFiles(data.files);
      st.setDeskTreeFiles('', data.files);
    }
  } catch (err) {
    console.error('[jian-desk] remove failed:', err);
  }
}

/**
 * deskMkdir — 新建文件夹，并返回新文件夹名（供调用者触发 rename）。
 */
export async function deskMkdir(): Promise<string | null> {
  const name = uniqueNameForSubdir('', t('desk.newFolder'));
  return await deskMkdirInSubdir('', name) ? name : null;
}

export async function deskMkdirInSubdir(subdir: string, name: string): Promise<boolean> {
  const s = useStore.getState();
  const normalizedSubdir = normalizeSubdir(subdir);
  const trimmed = name.trim();
  if (!isPlainFileName(trimmed)) return false;
  try {
    const res = await hanaFetch('/api/desk/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...selectedDeskAgentBody(s),
        action: 'mkdir',
        dir: s.deskBasePath || undefined,
        subdir: normalizedSubdir,
        name: trimmed,
      }),
    });
    const data = await res.json();
    if (data.error) { console.error('[desk] mkdir error:', data.error); return false; }
    if (data.files) applyFilesForSubdir(normalizedSubdir, data.files);
    return true;
  } catch (err) {
    console.error('[desk] mkdir failed:', err);
    return false;
  }
}

export async function deskRenameFile(oldName: string, newName: string): Promise<boolean> {
  const s = useStore.getState();
  try {
    const res = await hanaFetch('/api/desk/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...selectedDeskAgentBody(s), action: 'rename', dir: s.deskBasePath || undefined, subdir: '', oldName, newName }),
    });
    const data = await res.json();
    if (data.error) { console.error('[desk] rename error:', data.error); return false; }
    if (data.files) {
      const st = useStore.getState();
      st.setDeskFiles(data.files);
      st.setDeskTreeFiles('', data.files);
    }
    return true;
  } catch (err) { console.error('[desk] rename failed:', err); return false; }
}

// ── 状态工具 ──

export function toggleMemory(): void {
  useStore.setState((s: any) => ({ memoryEnabled: !s.memoryEnabled }));
}

export async function applyFolder(folder: string): Promise<void> {
  const normalized = normalizeFolder(folder);
  if (!normalized) return;
  useStore.setState((s: any) => ({
    selectedFolder: normalized,
    cwdHistory: mergeWorkspaceHistory(s.cwdHistory, [normalized]),
    workspaceFolders: (s.workspaceFolders || []).filter((p: string) => normalizeFolder(p) !== normalized),
  }));
  void activateWorkspaceDesk(normalized, { reload: false });
  const s = useStore.getState();
  if (!s.pendingNewSession) {
    useStore.setState({ currentSessionPath: null, pendingNewSession: true });
    clearChat();
    useStore.getState().requestInputFocus();
  }
  await persistWorkspaceHistory(normalized);
  await loadDeskFiles('', normalized);
}

async function persistWorkspaceHistory(folder: string): Promise<void> {
  const s = useStore.getState();
  if (!hasServerConnection(s)) return;
  try {
    const res = await hanaFetch('/api/config/workspaces/recent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: folder }),
    });
    const data = await res.json();
    if (data.error) throw new Error(String(data.error));
    if (Array.isArray(data.cwd_history)) {
      useStore.setState({ cwdHistory: mergeWorkspaceHistory(data.cwd_history, []) });
    }
  } catch (err) {
    console.error('[workspace] persist history failed:', err);
  }
}

export async function removeRecentWorkspace(folder: string): Promise<void> {
  const normalized = normalizeFolder(folder);
  if (!normalized) return;
  useStore.setState((s: any) => ({
    cwdHistory: removeWorkspaceHistoryEntries(s.cwdHistory, [normalized]),
  }));
  const s = useStore.getState();
  if (!hasServerConnection(s)) return;
  try {
    const res = await hanaFetch('/api/config/workspaces/recent', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: normalized }),
    });
    const data = await res.json();
    if (data.error) throw new Error(String(data.error));
    if (Array.isArray(data.cwd_history)) {
      useStore.setState({ cwdHistory: mergeWorkspaceHistory(data.cwd_history, []) });
    }
  } catch (err) {
    console.error('[workspace] remove recent history failed:', err);
  }
}

export async function clearRecentWorkspaces(): Promise<void> {
  useStore.setState({ cwdHistory: [] });
  const s = useStore.getState();
  if (!hasServerConnection(s)) return;
  try {
    const res = await hanaFetch('/api/config/workspaces/recent/all', {
      method: 'DELETE',
    });
    const data = await res.json();
    if (data.error) throw new Error(String(data.error));
    if (Array.isArray(data.cwd_history)) {
      useStore.setState({ cwdHistory: mergeWorkspaceHistory(data.cwd_history, []) });
    }
  } catch (err) {
    console.error('[workspace] clear recent history failed:', err);
  }
}

export function addWorkspaceFolder(folder: string): void {
  const normalized = normalizeFolder(folder);
  if (!normalized) return;
  useStore.setState((s: any) => {
    const primary = normalizeFolder(s.selectedFolder) || normalizeFolder(s.homeFolder);
    if (normalized === primary) return {};
    if ((s.workspaceFolders || []).includes(normalized)) return {};
    return { workspaceFolders: [...(s.workspaceFolders || []), normalized] };
  });
}

export function removeWorkspaceFolder(folder: string): void {
  const normalized = normalizeFolder(folder);
  if (!normalized) return;
  useStore.setState((s: any) => ({
    workspaceFolders: (s.workspaceFolders || []).filter((p: string) => p !== normalized),
  }));
}

export function updateDeskContextBtn(): void {
  const s = useStore.getState();
  const available = !!s.deskBasePath && s.deskFiles.length > 0;
  if (!available && s.deskContextAttached) {
    s.setDeskContextAttached(false);
  }
}

export function toggleJianSidebar(forceOpen?: boolean): void {
  const s = useStore.getState();
  const newOpen = forceOpen !== undefined ? forceOpen : !s.jianOpen;
  s.setJianOpen(newOpen);
  localStorage.setItem('hana-jian', newOpen ? 'open' : 'closed');
  if (forceOpen === undefined) s.setJianAutoCollapsed(false);
}

export function initJian(): void {
  const legacy = localStorage.getItem('hana-jian');
  const savedJian = legacy ?? localStorage.getItem('hana-jian-chat');
  if (savedJian !== null && legacy === null) {
    localStorage.setItem('hana-jian', savedJian);
  }
  if (savedJian !== null) useStore.getState().setJianOpen(savedJian !== 'closed');
  const s = useStore.getState();
  void activateWorkspaceDesk(s.selectedFolder || s.homeFolder || null);
}
