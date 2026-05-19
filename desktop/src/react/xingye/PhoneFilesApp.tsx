import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Agent } from '../types';
import styles from './XingyeShell.module.css';
import { generateFilesDraftWithAI } from './xingye-files-ai';
import {
  appendFileEntry,
  confirmFileDraft,
  deleteFileEntry,
  discardFileDraft,
  ensureDefaultFileFolders,
  listFileDrafts,
  listFileEntries,
  listFileFolders,
  resolveFolderIdFromHint,
  updateFileEntry,
  type XingyePendingFileDraft,
  type XingyeFileEntry,
  type XingyeFileEntryDraft,
  type XingyeFileFolder,
} from './xingye-files-store';
import type { XingyeRoleProfile } from './xingye-profile-store';

export interface PhoneFilesAppProps {
  ownerAgent: Agent | null;
  ownerProfile?: XingyeRoleProfile | null;
  displayName: string;
  onBack: () => void;
}

type ComposeMode = { kind: 'create'; folderId: string } | { kind: 'edit'; entry: XingyeFileEntry };

type FolderTint = 'terracotta' | 'plum' | 'ochre' | 'sage' | 'slate';
type FolderIcon = 'globe' | 'users' | 'heart' | 'search' | 'draft';

/**
 * 5 个默认文件夹（ensureDefaultFileFolders 创建的）按名字硬编码 tint/icon。
 * 见 optimized/IMPLEMENTATION_NOTES.md 2.2 表。
 */
const DEFAULT_FOLDER_PRESETS: Record<string, { tint: FolderTint; icon: FolderIcon }> = {
  '世界观整理': { tint: 'terracotta', icon: 'globe' },
  '人际关系':   { tint: 'plum',       icon: 'users' },
  '关于 user':  { tint: 'ochre',      icon: 'heart' },
  '线索与发现': { tint: 'sage',       icon: 'search' },
  '待确认':     { tint: 'slate',      icon: 'draft' },
};

const TINT_CYCLE: FolderTint[] = ['terracotta', 'plum', 'ochre', 'sage', 'slate'];

function hashStringToIndex(str: string, mod: number): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h) % Math.max(1, mod);
}

function getFolderPresentation(folder: XingyeFileFolder): { tint: FolderTint; icon: FolderIcon } {
  const preset = DEFAULT_FOLDER_PRESETS[folder.name];
  if (preset) return preset;
  return {
    tint: TINT_CYCLE[hashStringToIndex(folder.id, TINT_CYCLE.length)],
    icon: 'globe',
  };
}

const ROW_ICON_TINT_CLASS: Record<FolderTint, string> = {
  terracotta: styles.xyFilesRowIconTerracotta,
  plum: styles.xyFilesRowIconPlum,
  ochre: styles.xyFilesRowIconOchre,
  sage: styles.xyFilesRowIconSage,
  slate: styles.xyFilesRowIconSlate,
};

const FOLDER_HEADER_TINT_CLASS: Record<FolderTint, string> = {
  terracotta: styles.xyFolderHeaderTerracotta,
  plum: styles.xyFolderHeaderPlum,
  ochre: styles.xyFolderHeaderOchre,
  sage: styles.xyFolderHeaderSage,
  slate: styles.xyFolderHeaderSlate,
};

const TINT_HEX: Record<FolderTint, string> = {
  terracotta: '#c46a44',
  plum: '#864d5e',
  ochre: '#b08828',
  sage: '#6b7a56',
  slate: '#4a5a6a',
};

function FolderGlyph({ kind, color }: { kind: FolderIcon; color: string }) {
  const common = {
    width: 22,
    height: 22,
    viewBox: '0 0 24 24',
    fill: 'none' as const,
    stroke: color,
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  if (kind === 'users') {
    return (
      <svg {...common}>
        <circle cx="9" cy="9" r="3.2" />
        <path d="M15 11a2.8 2.8 0 1 0 0-5.6" />
        <path d="M3 19c0-3.3 2.7-6 6-6s6 2.7 6 6" />
        <path d="M16 19c0-2 1.4-3.7 3.4-4.2" />
      </svg>
    );
  }
  if (kind === 'heart') {
    return (
      <svg {...common}>
        <path d="M12 19.2 4.6 12a4.4 4.4 0 0 1 6.2-6.2L12 7l1.2-1.2a4.4 4.4 0 0 1 6.2 6.2Z" />
      </svg>
    );
  }
  if (kind === 'search') {
    return (
      <svg {...common}>
        <circle cx="11" cy="11" r="6" />
        <path d="m20 20-4.5-4.5" />
      </svg>
    );
  }
  if (kind === 'draft') {
    return (
      <svg {...common}>
        <path d="M5 4h9l5 5v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z" />
        <path d="M14 4v5h5" />
        <path d="M8 14h7" />
        <path d="M8 17h5" strokeDasharray="2 2" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="8" />
      <path d="M4 12h16" />
      <path d="M12 4c2.5 2.5 4 5.4 4 8s-1.5 5.5-4 8c-2.5-2.5-4-5.4-4-8s1.5-5.5 4-8Z" />
    </svg>
  );
}

function DocGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M6 3h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
      <path d="M14 3v4h4" />
      <path d="M9 13h6M9 16h4" />
    </svg>
  );
}

function excerptForList(body: string, max = 96): string {
  const collapsed = body.replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, Math.max(1, max - 1))}…`;
}

function tagsToInputValue(tags: string[] | undefined): string {
  return Array.isArray(tags) ? tags.join(', ') : '';
}

function parseTagsInput(value: string): string[] | undefined {
  const out = value
    .split(/[,，;；\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  return out.length ? out : undefined;
}

/**
 * 「X 分钟前 / X 小时前 / X 天前 / X 月 X 日」相对时间，匹配设计稿 right-aligned mono 字号 11 的尺寸。
 */
function relativeTime(iso: string | undefined): string {
  if (!iso) return '';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return '';
  const diffMs = Date.now() - ts;
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const days = Math.floor(hr / 24);
  if (days < 30) return `${days} 天前`;
  const d = new Date(ts);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

/**
 * 资料柜详情页 meta：「修改于 X · 来源：Y · N 行」。
 * 行数从 body 里按 \n 计算（与设计稿一致，最少 1 行）。
 */
function bodyLineCount(body: string): number {
  if (!body) return 0;
  return body.split(/\r?\n/).length;
}

/**
 * 把 body 按 \n\n 切段渲染成 <p>；以 `> ` 开头的行包成 <blockquote>。
 */
function renderPaperBody(body: string): ReactNode {
  const text = body ?? '';
  if (!text.trim()) {
    return <p style={{ color: 'var(--xy-ink-mute)' }}>（空白）</p>;
  }
  const blocks = text.split(/\n{2,}/);
  return blocks.map((block, idx) => {
    const trimmed = block.trim();
    if (trimmed.startsWith('> ')) {
      const quoteText = trimmed.replace(/^> /, '').replace(/\n> /g, '\n');
      return (
        <blockquote key={idx} className={styles.xyDetailPaperQuote}>
          {quoteText}
        </blockquote>
      );
    }
    return (
      <p key={idx}>
        {block.split('\n').map((line, lineIdx, arr) => (
          <span key={lineIdx}>
            {line}
            {lineIdx < arr.length - 1 ? <br /> : null}
          </span>
        ))}
      </p>
    );
  });
}

export function PhoneFilesApp({ ownerAgent, ownerProfile, displayName, onBack }: PhoneFilesAppProps) {
  const ownerAgentId = ownerAgent?.id ?? '';

  const [folders, setFolders] = useState<XingyeFileFolder[]>([]);
  const [entries, setEntries] = useState<XingyeFileEntry[]>([]);
  const [pendingDrafts, setPendingDrafts] = useState<XingyePendingFileDraft[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);

  const [composeMode, setComposeMode] = useState<ComposeMode | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftBody, setDraftBody] = useState('');
  const [draftTags, setDraftTags] = useState('');
  const [draftSource, setDraftSource] = useState('');
  const [draftIntent, setDraftIntent] = useState('');
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [initBusy, setInitBusy] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiFolderName, setAiFolderName] = useState<string | null>(null);
  /**
   * 「待确认草稿」行内编辑缓冲。Key = draft.id。
   * folderId 可由用户改（下拉选 folder）；title/body 也能编辑。
   */
  const [pendingDraftEdits, setPendingDraftEdits] = useState<
    Record<string, { title: string; body: string; folderId: string }>
  >({});
  const [pendingDraftBusyId, setPendingDraftBusyId] = useState<string | null>(null);
  const [pendingDraftError, setPendingDraftError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!ownerAgentId) {
      setFolders([]);
      setEntries([]);
      setPendingDrafts([]);
      setPendingDraftEdits({});
      return;
    }
    setListLoading(true);
    setListError(null);
    try {
      const [f, e, drafts] = await Promise.all([
        listFileFolders(ownerAgentId),
        listFileEntries(ownerAgentId),
        listFileDrafts(ownerAgentId),
      ]);
      setFolders(f);
      setEntries(e);
      setPendingDrafts(drafts);
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
    } finally {
      setListLoading(false);
    }
  }, [ownerAgentId]);

  const pendingDraftWorkingValue = useCallback(
    (d: XingyePendingFileDraft) => {
      const edit = pendingDraftEdits[d.id];
      if (edit) return edit;
      const resolvedFolderId = folders.length > 0
        ? resolveFolderIdFromHint(folders, d.folderHint)
        : '';
      return {
        title: d.title,
        body: d.body,
        folderId: resolvedFolderId,
      };
    },
    [pendingDraftEdits, folders],
  );

  const handlePendingDraftFieldChange = (
    draftId: string,
    patch: Partial<{ title: string; body: string; folderId: string }>,
  ) => {
    setPendingDraftEdits((prev) => {
      const d = pendingDrafts.find((entry) => entry.id === draftId);
      if (!d) return prev;
      const base = prev[draftId] ?? {
        title: d.title,
        body: d.body,
        folderId: folders.length > 0 ? resolveFolderIdFromHint(folders, d.folderHint) : '',
      };
      return { ...prev, [draftId]: { ...base, ...patch } };
    });
  };

  const handleConfirmPendingDraft = async (d: XingyePendingFileDraft) => {
    if (!ownerAgentId) return;
    setPendingDraftBusyId(d.id);
    setPendingDraftError(null);
    try {
      const working = pendingDraftWorkingValue(d);
      const entry = await confirmFileDraft(ownerAgentId, d.id, {
        folderId: working.folderId || undefined,
        title: working.title,
        body: working.body,
      });
      setEntries((prev) => [entry, ...prev.filter((p) => p.id !== entry.id)]);
      setPendingDrafts((prev) => prev.filter((p) => p.id !== d.id));
      setPendingDraftEdits((prev) => {
        if (!(d.id in prev)) return prev;
        const { [d.id]: _omitted, ...rest } = prev;
        return rest;
      });
      if (folders.length === 0) {
        await reload();
      }
    } catch (err) {
      setPendingDraftError(err instanceof Error ? err.message : String(err));
    } finally {
      setPendingDraftBusyId(null);
    }
  };

  const handleDiscardPendingDraft = async (d: XingyePendingFileDraft) => {
    if (!ownerAgentId) return;
    if (!window.confirm('确定丢弃这条待确认资料柜草稿？此操作不可恢复，但角色可在下次巡检里重新提议。')) {
      return;
    }
    setPendingDraftBusyId(d.id);
    setPendingDraftError(null);
    try {
      const ok = await discardFileDraft(ownerAgentId, d.id);
      if (ok) {
        setPendingDrafts((prev) => prev.filter((p) => p.id !== d.id));
        setPendingDraftEdits((prev) => {
          if (!(d.id in prev)) return prev;
          const { [d.id]: _omitted, ...rest } = prev;
          return rest;
        });
      } else {
        await reload();
      }
    } catch (err) {
      setPendingDraftError(err instanceof Error ? err.message : String(err));
    } finally {
      setPendingDraftBusyId(null);
    }
  };

  useEffect(() => {
    setSelectedFolderId(null);
    setSelectedEntryId(null);
    setComposeMode(null);
    setSaveError(null);
    setListError(null);
  }, [ownerAgentId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const selectedFolder = useMemo(
    () => (selectedFolderId ? folders.find((f) => f.id === selectedFolderId) ?? null : null),
    [folders, selectedFolderId],
  );

  const selectedEntry = useMemo(
    () => (selectedEntryId ? entries.find((e) => e.id === selectedEntryId) ?? null : null),
    [entries, selectedEntryId],
  );

  const folderEntries = useMemo(() => {
    if (!selectedFolderId) return [] as XingyeFileEntry[];
    return entries.filter((e) => e.folderId === selectedFolderId);
  }, [entries, selectedFolderId]);

  const folderEntryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of entries) {
      counts.set(entry.folderId, (counts.get(entry.folderId) ?? 0) + 1);
    }
    return counts;
  }, [entries]);

  /**
   * 每个 folder 上「· N 草稿」的红字角标。
   * 用 folderHint 解析回 folderId，统计落在每个 folder 上的草稿数。
   */
  const folderPendingCounts = useMemo(() => {
    const counts = new Map<string, number>();
    if (folders.length === 0) return counts;
    for (const draft of pendingDrafts) {
      const fid = resolveFolderIdFromHint(folders, draft.folderHint);
      counts.set(fid, (counts.get(fid) ?? 0) + 1);
    }
    return counts;
  }, [pendingDrafts, folders]);

  const recentEntries = useMemo(() => entries.slice(0, 3), [entries]);

  const ta = displayName || ownerAgent?.name || 'TA';

  const openCreateInFolder = (folderId: string) => {
    setComposeMode({ kind: 'create', folderId });
    setDraftTitle('');
    setDraftBody('');
    setDraftTags('');
    setDraftSource('');
    setDraftIntent('');
    setSaveError(null);
    setAiError(null);
    setAiFolderName(null);
  };

  const openEdit = (entry: XingyeFileEntry) => {
    setComposeMode({ kind: 'edit', entry });
    setDraftTitle(entry.title);
    setDraftBody(entry.body);
    setDraftTags(tagsToInputValue(entry.tags));
    setDraftSource(entry.source ?? '');
    setDraftIntent('');
    setSaveError(null);
    setAiError(null);
    setAiFolderName(null);
  };

  const closeCompose = () => {
    setComposeMode(null);
    setSaveError(null);
    setAiError(null);
    setAiFolderName(null);
  };

  const handleGenerateDraft = async () => {
    if (!ownerAgent || !composeMode) return;
    const targetFolderId =
      composeMode.kind === 'create' ? composeMode.folderId : composeMode.entry.folderId;
    const targetFolder = folders.find((f) => f.id === targetFolderId);
    setAiBusy(true);
    setAiError(null);
    try {
      const result = await generateFilesDraftWithAI({
        agent: ownerAgent,
        ownerProfile: ownerProfile ?? null,
        targetFolder: targetFolder
          ? { id: targetFolder.id, name: targetFolder.name, description: targetFolder.description }
          : null,
        folderOptions: folders.map((f) => ({
          id: f.id,
          name: f.name,
          description: f.description,
        })),
        userIntent: draftIntent.trim(),
      });
      setDraftTitle(result.title);
      setDraftBody(result.body);
      if (result.tags && result.tags.length > 0) {
        setDraftTags(result.tags.join(', '));
      }
      setAiFolderName(result.folderName);
    } catch (err) {
      setAiError(err instanceof Error ? err.message : String(err));
    } finally {
      setAiBusy(false);
    }
  };

  const handleInitFolders = async () => {
    if (!ownerAgentId || initBusy) return;
    setInitBusy(true);
    setListError(null);
    try {
      const created = await ensureDefaultFileFolders(ownerAgentId);
      setFolders(created);
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
    } finally {
      setInitBusy(false);
    }
  };

  const handleSave = async () => {
    if (!ownerAgentId || !composeMode) return;
    const title = draftTitle.trim();
    if (!title) {
      setSaveError('标题不能为空。');
      return;
    }
    setSaveBusy(true);
    setSaveError(null);
    try {
      if (composeMode.kind === 'create') {
        const draft: XingyeFileEntryDraft = {
          folderId: composeMode.folderId,
          title,
          body: draftBody,
          tags: parseTagsInput(draftTags),
          source: draftSource.trim() || undefined,
        };
        const row = await appendFileEntry(ownerAgentId, draft);
        setEntries((prev) => [row, ...prev.filter((p) => p.id !== row.id)]);
        setSelectedEntryId(row.id);
      } else {
        const updated = await updateFileEntry(ownerAgentId, composeMode.entry.id, {
          folderId: composeMode.entry.folderId,
          title,
          body: draftBody,
          tags: parseTagsInput(draftTags),
          source: draftSource.trim() || undefined,
        });
        if (updated) {
          setEntries((prev) => {
            const next = prev.filter((p) => p.id !== updated.id);
            next.unshift(updated);
            return next;
          });
          setSelectedEntryId(updated.id);
        } else {
          await reload();
        }
      }
      setComposeMode(null);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaveBusy(false);
    }
  };

  const handleDeleteSelected = async () => {
    if (!selectedEntry || !ownerAgentId) return;
    if (!window.confirm('确定删除这条文件？此操作不可恢复。')) return;
    setDeleteBusy(true);
    try {
      const ok = await deleteFileEntry(ownerAgentId, selectedEntry.id);
      if (ok) {
        setEntries((prev) => prev.filter((e) => e.id !== selectedEntry.id));
        setSelectedEntryId(null);
      } else {
        await reload();
      }
    } finally {
      setDeleteBusy(false);
    }
  };

  if (!ownerAgentId) {
    return (
      <div className={`${styles.phoneShell} ${styles.xyPalette}`} aria-label="文件管理">
        <div className={styles.phoneStatusBar}>
          <button type="button" className={styles.phoneBackButton} onClick={onBack}>
            返回首页
          </button>
          <span>文件管理</span>
        </div>
        <div className={styles.phoneBody}>
          <section className={styles.phoneAppCard}>
            <h3 className={styles.phoneAppTitle}>文件管理不可用</h3>
            <p className={styles.phoneAppHint}>
              未选择角色 / 小手机不可用。资料柜写入当前角色在 HANA_HOME 下的星野目录，不能使用隐式回退。
            </p>
            <p className={styles.phoneAppHint}>请返回星野角色页，选择有效角色后再打开文件管理。</p>
          </section>
        </div>
      </div>
    );
  }

  const inFolderDetail = Boolean(selectedFolder);
  const inEntryDetail = Boolean(selectedEntry);

  const handleBack = () => {
    if (inEntryDetail) {
      setSelectedEntryId(null);
      return;
    }
    if (inFolderDetail) {
      setSelectedFolderId(null);
      return;
    }
    onBack();
  };

  const backLabel = inEntryDetail ? '返回文件列表' : inFolderDetail ? '返回文件夹列表' : '返回首页';

  const totalEntries = entries.length;

  return (
    <div className={`${styles.phoneShell} ${styles.xyPalette}`} aria-label="文件管理">
      <div className={styles.phoneStatusBar}>
        <button type="button" className={styles.phoneBackButton} onClick={handleBack}>
          {backLabel}
        </button>
        <span>文件管理</span>
      </div>

      <div className={styles.xyBody}>
        {listError ? (
          <p className={styles.phoneAppHint} role="alert" style={{ padding: '8px 18px' }}>
            加载失败：{listError}
          </p>
        ) : null}
        {listLoading && folders.length === 0 && entries.length === 0 ? (
          <p className={styles.phoneAppHint} style={{ padding: '8px 18px' }}>加载中…</p>
        ) : null}

        {/* 资料柜首页 */}
        {!inFolderDetail && !inEntryDetail ? (
          <div className={styles.xyScroll}>
            <header className={styles.xyFilesHero}>
              <div>
                <p className={styles.xyFilesKicker}>CABINET</p>
                <h2 className={styles.xyFilesTitle}>{ta} 的资料柜</h2>
              </div>
              <span className={styles.xyFilesMeta}>
                {totalEntries} 条 · {folders.length} 文件夹
              </span>
            </header>

            <div className={styles.xyBreadcrumb}>
              <span>本机</span>
              <span className={styles.xyBcSep}>›</span>
              <span>{ta}</span>
              <span className={styles.xyBcSep}>›</span>
              <b>资料柜</b>
            </div>

            {pendingDrafts.length > 0 ? (
              <section
                className={styles.xyDraftSection}
                aria-label="待确认资料柜草稿"
                data-testid="phone-files-pending-drafts"
              >
                <p className={styles.xyDraftHeader}>待确认草稿 · 来自心跳巡检</p>
                {pendingDraftError ? (
                  <p className={styles.xyDraftError} role="alert">{pendingDraftError}</p>
                ) : null}
                {pendingDrafts.map((d) => {
                  const working = pendingDraftWorkingValue(d);
                  const busy = pendingDraftBusyId === d.id;
                  return (
                    <div
                      key={d.id}
                      className={styles.xyDraftCard}
                      data-testid={`phone-files-pending-draft-${d.id}`}
                    >
                      <input
                        type="text"
                        className={styles.xyDraftInput}
                        value={working.title}
                        onChange={(e) => handlePendingDraftFieldChange(d.id, { title: e.target.value })}
                        placeholder="标题"
                        aria-label="待确认资料柜草稿标题"
                        data-testid={`phone-files-pending-draft-title-${d.id}`}
                        disabled={busy}
                      />
                      <textarea
                        className={styles.xyDraftTextarea}
                        value={working.body}
                        onChange={(e) => handlePendingDraftFieldChange(d.id, { body: e.target.value })}
                        rows={4}
                        placeholder="正文"
                        aria-label="待确认资料柜草稿正文"
                        data-testid={`phone-files-pending-draft-body-${d.id}`}
                        disabled={busy}
                      />
                      <div className={styles.xyDraftRow}>
                        <span className={styles.xyDraftHint}>文件夹：</span>
                        {folders.length > 0 ? (
                          <select
                            className={styles.xyDraftSelect}
                            value={working.folderId}
                            onChange={(e) => handlePendingDraftFieldChange(d.id, { folderId: e.target.value })}
                            disabled={busy}
                            aria-label="待确认资料柜草稿文件夹"
                            data-testid={`phone-files-pending-draft-folder-${d.id}`}
                          >
                            {folders.map((folder) => (
                              <option key={folder.id} value={folder.id}>
                                {folder.name}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className={styles.xyDraftHint}>
                            未初始化（确认时会自动建默认文件夹）
                          </span>
                        )}
                        {d.folderHint ? (
                          <span className={styles.xyDraftHint}>
                            建议：「{d.folderHint}」
                          </span>
                        ) : null}
                      </div>
                      {d.reason ? (
                        <p className={styles.xyDraftReason}>理由：{d.reason}</p>
                      ) : null}
                      <div className={styles.xyDraftActions}>
                        <button
                          type="button"
                          className={styles.xyDraftConfirm}
                          onClick={() => void handleConfirmPendingDraft(d)}
                          disabled={busy}
                          data-testid={`phone-files-pending-draft-confirm-${d.id}`}
                        >
                          {busy ? '处理中…' : '确认生成'}
                        </button>
                        <button
                          type="button"
                          className={styles.xyDraftDiscard}
                          onClick={() => void handleDiscardPendingDraft(d)}
                          disabled={busy}
                          data-testid={`phone-files-pending-draft-discard-${d.id}`}
                        >
                          丢弃
                        </button>
                      </div>
                    </div>
                  );
                })}
              </section>
            ) : null}

            {folders.length === 0 ? (
              <div className={styles.xyFilesEmpty} data-testid="phone-files-empty">
                <p>还没有文件夹。点「初始化资料柜」生成默认分类</p>
                <p style={{ marginTop: 4, fontSize: 12 }}>
                  （世界观整理 / 人际关系 / 关于 user / 线索与发现 / 待确认）
                </p>
                <button
                  type="button"
                  className={styles.xyEditorPrimary}
                  onClick={() => void handleInitFolders()}
                  disabled={initBusy || listLoading}
                  data-testid="phone-files-init-button"
                >
                  {initBusy ? '初始化中…' : '初始化资料柜'}
                </button>
              </div>
            ) : (
              <>
                <div className={styles.xyFilesColHead}>
                  <span className={styles.xyFilesColName}>名称</span>
                  <span className={styles.xyFilesColCount}>条数</span>
                  <span className={styles.xyFilesColTime}>修改</span>
                </div>
                <div className={styles.xyFilesList} aria-label="文件夹列表">
                  {folders.map((folder) => {
                    const count = folderEntryCounts.get(folder.id) ?? 0;
                    const draftCount = folderPendingCounts.get(folder.id) ?? 0;
                    const pres = getFolderPresentation(folder);
                    const rowCls = `${styles.xyFilesRow}${draftCount > 0 ? ` ${styles.xyFilesRowPending}` : ''}`;
                    return (
                      <button
                        key={folder.id}
                        type="button"
                        className={rowCls}
                        onClick={() => {
                          setSelectedFolderId(folder.id);
                          setSelectedEntryId(null);
                        }}
                        data-testid={`phone-files-folder-${folder.id}`}
                      >
                        <span className={`${styles.xyFilesRowIcon} ${ROW_ICON_TINT_CLASS[pres.tint]}`}>
                          <FolderGlyph kind={pres.icon} color={TINT_HEX[pres.tint]} />
                        </span>
                        <span className={styles.xyFilesRowMain}>
                          <span className={styles.xyFilesRowName}>
                            {folder.name}
                            {draftCount > 0 ? (
                              <em className={styles.xyFilesRowDraftBadge}> · {draftCount} 草稿</em>
                            ) : null}
                          </span>
                          {folder.description ? (
                            <span className={styles.xyFilesRowDesc}>{folder.description}</span>
                          ) : null}
                        </span>
                        <span className={styles.xyFilesRowCount}>{count > 0 ? count : '—'}</span>
                        <span className={styles.xyFilesRowTime}>{relativeTime(folder.updatedAt)}</span>
                      </button>
                    );
                  })}
                </div>

                {recentEntries.length > 0 ? (
                  <>
                    <p className={styles.xyFilesSectionLabel}>最近文件</p>
                    <div className={styles.xyFilesList}>
                      {recentEntries.map((entry) => {
                        const folderName = folders.find((f) => f.id === entry.folderId)?.name ?? '—';
                        return (
                          <button
                            key={entry.id}
                            type="button"
                            className={styles.xyFilesRow}
                            onClick={() => setSelectedEntryId(entry.id)}
                          >
                            <span className={`${styles.xyFilesRowIcon} ${styles.xyFilesRowIconDoc}`}>
                              <DocGlyph />
                            </span>
                            <span className={styles.xyFilesRowMain}>
                              <span className={styles.xyFilesRowName}>{entry.title}</span>
                              <span className={styles.xyFilesRowDesc}>
                                {folderName} · {bodyLineCount(entry.body)} 行
                              </span>
                            </span>
                            <span className={styles.xyFilesRowCount}>—</span>
                            <span className={styles.xyFilesRowTime}>
                              {relativeTime(entry.updatedAt ?? entry.createdAt)}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </>
                ) : null}

                <button
                  type="button"
                  className={styles.xyFab}
                  onClick={() => openCreateInFolder(folders[0].id)}
                  data-testid="phone-files-new-from-home"
                  aria-label="新建文件"
                >
                  ＋ 新建文件
                </button>
              </>
            )}
          </div>
        ) : null}

        {/* 文件夹内容 */}
        {inFolderDetail && selectedFolder && !inEntryDetail ? (
          <div className={styles.xyScroll}>
            {(() => {
              const pres = getFolderPresentation(selectedFolder);
              return (
                <header
                  className={`${styles.xyFolderHeader} ${FOLDER_HEADER_TINT_CLASS[pres.tint]}`}
                  aria-label={`${selectedFolder.name} 文件夹`}
                >
                  <span className={styles.xyFolderHeaderGlyph}>
                    <FolderGlyph kind={pres.icon} color={TINT_HEX[pres.tint]} />
                  </span>
                  <div className={styles.xyFolderHeaderMain}>
                    <h2 className={styles.xyFolderHeaderName}>{selectedFolder.name}</h2>
                    <p className={styles.xyFolderHeaderDesc}>
                      {selectedFolder.description ?? 'TA 的资料柜分类'} · {folderEntries.length} 条
                    </p>
                  </div>
                </header>
              );
            })()}

            {folderEntries.length === 0 ? (
              <p
                className={styles.xyFilesEmpty}
                data-testid="phone-files-folder-empty"
              >
                这个文件夹还没有文件。
              </p>
            ) : (
              <div className={styles.xyNoteList}>
                {folderEntries.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    className={styles.xyNoteCard}
                    onClick={() => setSelectedEntryId(entry.id)}
                    data-testid={`phone-files-entry-${entry.id}`}
                  >
                    <h3 className={styles.xyNoteCardTitle}>{entry.title}</h3>
                    {entry.body ? (
                      <p className={styles.xyNoteCardBody}>{excerptForList(entry.body)}</p>
                    ) : null}
                    <div className={styles.xyNoteCardFoot}>
                      {entry.tags && entry.tags.length > 0
                        ? entry.tags.map((t) => (
                            <span key={t} className={`${styles.xyChip} ${styles.xyChipTintSage}`}>
                              #{t}
                            </span>
                          ))
                        : null}
                      <span className={styles.xyNoteSpacer} />
                      <span className={styles.xyNoteTime}>
                        {relativeTime(entry.updatedAt ?? entry.createdAt)}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            )}

            <button
              type="button"
              className={styles.xyFab}
              onClick={() => openCreateInFolder(selectedFolder.id)}
              data-testid="phone-files-new-in-folder"
              aria-label="新建文件"
            >
              ＋ 新建文件
            </button>
          </div>
        ) : null}

        {/* 文件详情 */}
        {inEntryDetail && selectedEntry ? (
          <div className={styles.xyScroll}>
            <article className={styles.xyDetailPaper} aria-label="文件详情">
              <p className={styles.xyDetailPaperPath}>
                资料柜 › {folders.find((f) => f.id === selectedEntry.folderId)?.name ?? '—'}
              </p>
              <h1 className={styles.xyDetailPaperTitle}>{selectedEntry.title}</h1>
              <p className={styles.xyDetailPaperMeta}>
                修改于 {relativeTime(selectedEntry.updatedAt ?? selectedEntry.createdAt)}
                {selectedEntry.source ? ` · 来源：${selectedEntry.source}` : ''}
                {' · '}{bodyLineCount(selectedEntry.body)} 行
              </p>
              {selectedEntry.tags && selectedEntry.tags.length > 0 ? (
                <div className={styles.xyDetailPaperTags}>
                  {selectedEntry.tags.map((t) => (
                    <span key={t} className={`${styles.xyChip} ${styles.xyChipTintSage}`}>
                      #{t}
                    </span>
                  ))}
                </div>
              ) : null}
              <hr className={styles.xyDetailPaperRule} />
              <div className={styles.xyDetailPaperBody}>{renderPaperBody(selectedEntry.body)}</div>
              <hr className={styles.xyDetailPaperRule} />
              <div className={styles.xyDetailPaperFoot}>
                <button
                  type="button"
                  className={styles.xyBtnGhost}
                  onClick={() => openEdit(selectedEntry)}
                  data-testid="phone-files-edit-button"
                >
                  编辑
                </button>
                <button
                  type="button"
                  className={`${styles.xyBtnGhost} ${styles.xyBtnGhostDanger}`}
                  onClick={() => void handleDeleteSelected()}
                  disabled={deleteBusy}
                  data-testid="phone-files-delete-button"
                >
                  {deleteBusy ? '删除中…' : '删除'}
                </button>
              </div>
            </article>
          </div>
        ) : null}
      </div>

      {composeMode ? (
        <div
          className={styles.phoneModalOverlay}
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeCompose();
          }}
        >
          <div
            className={styles.phoneModalSheet}
            role="dialog"
            aria-modal="true"
            aria-labelledby="phone-files-compose-title"
          >
            <h3 id="phone-files-compose-title" className={styles.phoneModalTitle}>
              {composeMode.kind === 'create' ? '新建文件' : '编辑文件'}
            </h3>
            <div className={styles.phoneModalBody}>
              <label className={styles.xyEditorField}>
                <span>整理意图</span>
                <textarea
                  value={draftIntent}
                  onChange={(event) => setDraftIntent(event.target.value)}
                  rows={2}
                  placeholder="可选：想让 TA 整理什么方向的资料"
                  data-testid="phone-files-intent-input"
                />
              </label>
              <button
                type="button"
                className={styles.xyBtnGhost}
                onClick={() => void handleGenerateDraft()}
                disabled={aiBusy || saveBusy || !ownerAgent}
                data-testid="phone-files-ai-button"
                style={{ flex: '0 0 auto', alignSelf: 'flex-start' }}
              >
                {aiBusy ? '生成中…' : '让 TA 自己整理'}
              </button>
              {aiError ? (
                <p className={styles.xyEditorError} role="alert">{aiError}</p>
              ) : null}
              {aiFolderName && composeMode.kind === 'create' ? (
                (() => {
                  const targetFolder = folders.find((f) => f.id === composeMode.folderId);
                  if (!targetFolder || targetFolder.name === aiFolderName) return null;
                  return (
                    <p className={styles.xyDraftHint} data-testid="phone-files-ai-folder-mismatch">
                      TA 想把这条放进「{aiFolderName}」，但当前文件夹是「{targetFolder.name}」；保存后会落在当前文件夹。
                    </p>
                  );
                })()
              ) : null}
              <label className={styles.xyEditorField}>
                <span>标题</span>
                <input
                  value={draftTitle}
                  onChange={(event) => setDraftTitle(event.target.value)}
                  placeholder="给这条文件一个名字"
                  data-testid="phone-files-title-input"
                />
              </label>
              <label className={styles.xyEditorField}>
                <span>正文</span>
                <textarea
                  value={draftBody}
                  onChange={(event) => setDraftBody(event.target.value)}
                  rows={6}
                  placeholder="可以写设定 / 关系 / 线索 / 摘抄等内容…"
                  data-testid="phone-files-body-input"
                />
              </label>
              <label className={styles.xyEditorField}>
                <span>标签</span>
                <input
                  value={draftTags}
                  onChange={(event) => setDraftTags(event.target.value)}
                  placeholder="可选，用逗号分隔，如 设定, 关系"
                  data-testid="phone-files-tags-input"
                />
              </label>
              <label className={styles.xyEditorField}>
                <span>来源</span>
                <input
                  value={draftSource}
                  onChange={(event) => setDraftSource(event.target.value)}
                  placeholder="可选，如「2026-05-15 闲聊」"
                  data-testid="phone-files-source-input"
                />
              </label>
              {saveError ? (
                <p className={styles.xyEditorError} role="alert">{saveError}</p>
              ) : null}
            </div>
            <div className={styles.phoneModalActions}>
              <button
                type="button"
                className={styles.xyBtnGhost}
                onClick={closeCompose}
                disabled={saveBusy || aiBusy}
                style={{ flex: '0 0 auto' }}
              >
                取消
              </button>
              <button
                type="button"
                className={styles.xyEditorPrimary}
                onClick={() => void handleSave()}
                disabled={saveBusy || aiBusy}
                data-testid="phone-files-save-button"
                style={{ flex: '0 0 auto', padding: '10px 18px' }}
              >
                {saveBusy ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
