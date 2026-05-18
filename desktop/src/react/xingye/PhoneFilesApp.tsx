import { useCallback, useEffect, useMemo, useState } from 'react';
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

function excerptForList(body: string, max = 96): string {
  const collapsed = body.replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, Math.max(1, max - 1))}…`;
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${hh}:${mm}`;
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
      /**
       * 默认 folderId 用 hint 解析；folders 为空时给空串（UI 会显示需先初始化）。
       */
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
      /** confirm 路径里会 ensureDefaultFileFolders；reload 把刚被创建的 folders 拉回来。 */
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
      <div className={styles.phoneShell} aria-label="文件管理">
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

  return (
    <div className={styles.phoneShell} aria-label="文件管理">
      <div className={styles.phoneStatusBar}>
        <button type="button" className={styles.phoneBackButton} onClick={handleBack}>
          {backLabel}
        </button>
        <span>文件管理</span>
      </div>

      <div className={styles.phoneBody}>
        {listError ? (
          <p className={styles.phoneAppHint} role="alert">
            加载失败：{listError}
          </p>
        ) : null}
        {listLoading && folders.length === 0 && entries.length === 0 ? (
          <p className={styles.phoneAppHint}>加载中…</p>
        ) : null}

        {!inFolderDetail && pendingDrafts.length > 0 ? (
          <section
            className={styles.phoneAppCard}
            aria-label="待确认资料柜草稿"
            data-testid="phone-files-pending-drafts"
          >
            <h3 className={styles.phoneAppTitle}>待确认草稿 · 来自心跳巡检</h3>
            <p className={styles.phoneAppHint}>
              这些草稿由角色在巡检里提议，**还没**出现在任何文件夹里。可在下拉里改建议入的文件夹后点「确认生成」；丢弃不留痕。
            </p>
            {pendingDraftError ? (
              <p className={styles.phoneAppHint} role="alert">
                {pendingDraftError}
              </p>
            ) : null}
            <ul className={styles.phoneFilesEntryList} aria-label="待确认草稿列表">
              {pendingDrafts.map((d) => {
                const working = pendingDraftWorkingValue(d);
                const busy = pendingDraftBusyId === d.id;
                return (
                  <li key={d.id} data-testid={`phone-files-pending-draft-${d.id}`}>
                    <div
                      className={styles.phoneFilesEntryItem}
                      style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 8 }}
                    >
                      <input
                        type="text"
                        value={working.title}
                        onChange={(e) => handlePendingDraftFieldChange(d.id, { title: e.target.value })}
                        placeholder="标题"
                        aria-label="待确认资料柜草稿标题"
                        data-testid={`phone-files-pending-draft-title-${d.id}`}
                        disabled={busy}
                        style={{ font: 'inherit', background: 'transparent', border: '1px dashed rgba(0,0,0,0.2)', padding: '4px 6px' }}
                      />
                      <textarea
                        value={working.body}
                        onChange={(e) => handlePendingDraftFieldChange(d.id, { body: e.target.value })}
                        rows={4}
                        placeholder="正文"
                        aria-label="待确认资料柜草稿正文"
                        data-testid={`phone-files-pending-draft-body-${d.id}`}
                        disabled={busy}
                        style={{ width: '100%', font: 'inherit', background: 'transparent', border: '1px dashed rgba(0,0,0,0.2)', padding: '6px' }}
                      />
                      <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <span className={styles.phoneAppHint} style={{ margin: 0 }}>文件夹：</span>
                        {folders.length > 0 ? (
                          <select
                            className={styles.phoneInlineSelect}
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
                          <span className={styles.phoneAppHint} style={{ margin: 0 }}>
                            未初始化（确认时会自动建默认文件夹）
                          </span>
                        )}
                        {d.folderHint ? (
                          <span className={styles.phoneAppHint} style={{ margin: 0 }}>
                            建议：「{d.folderHint}」
                          </span>
                        ) : null}
                      </label>
                      {d.reason ? (
                        <p className={styles.phoneAppHint} style={{ margin: 0 }}>
                          理由：{d.reason}
                        </p>
                      ) : null}
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <button
                          type="button"
                          className={styles.phonePrimaryAction}
                          onClick={() => void handleConfirmPendingDraft(d)}
                          disabled={busy}
                          data-testid={`phone-files-pending-draft-confirm-${d.id}`}
                        >
                          {busy ? '处理中…' : '确认生成'}
                        </button>
                        <button
                          type="button"
                          className={styles.phoneModalGhostButton}
                          onClick={() => void handleDiscardPendingDraft(d)}
                          disabled={busy}
                          data-testid={`phone-files-pending-draft-discard-${d.id}`}
                        >
                          丢弃
                        </button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

        {!inFolderDetail ? (
          <section className={styles.phoneAppCard} aria-label="资料柜首页">
            <h3 className={styles.phoneAppTitle}>{ta} 的资料柜</h3>
            <p className={styles.phoneAppHint}>TA 的资料柜，按角色保存在本机星野目录。</p>

            {folders.length === 0 ? (
              <div data-testid="phone-files-empty">
                <p className={styles.phoneAppHint}>
                  还没有文件夹。点「初始化资料柜」生成默认分类（世界观整理 / 人际关系 / 关于 user / 线索与发现 / 待确认）。
                </p>
              </div>
            ) : (
              <ul className={styles.phoneFilesFolderList} aria-label="文件夹列表">
                {folders.map((folder) => {
                  const count = folderEntryCounts.get(folder.id) ?? 0;
                  return (
                    <li key={folder.id}>
                      <button
                        type="button"
                        className={styles.phoneFilesFolderItem}
                        onClick={() => {
                          setSelectedFolderId(folder.id);
                          setSelectedEntryId(null);
                        }}
                        data-testid={`phone-files-folder-${folder.id}`}
                      >
                        <span className={styles.phoneFilesFolderName}>{folder.name}</span>
                        <span className={styles.phoneFilesFolderMeta}>
                          {count > 0 ? `${count} 条` : '空'}
                        </span>
                        {folder.description ? (
                          <span className={styles.phoneFilesFolderHint}>{folder.description}</span>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}

            <div className={styles.phoneFilesHomeActions}>
              <button
                type="button"
                className={styles.phoneModalGhostButton}
                onClick={() => void handleInitFolders()}
                disabled={initBusy || listLoading}
                data-testid="phone-files-init-button"
              >
                {initBusy ? '初始化中…' : folders.length > 0 ? '已初始化资料柜' : '初始化资料柜'}
              </button>
              {folders.length > 0 ? (
                <button
                  type="button"
                  className={styles.phonePrimaryAction}
                  onClick={() => openCreateInFolder(folders[0].id)}
                  disabled={listLoading}
                  data-testid="phone-files-new-from-home"
                >
                  新建文件
                </button>
              ) : null}
            </div>
          </section>
        ) : null}

        {inFolderDetail && selectedFolder && !inEntryDetail ? (
          <section className={styles.phoneAppCard} aria-label={`${selectedFolder.name} 文件列表`}>
            <h3 className={styles.phoneAppTitle}>{selectedFolder.name}</h3>
            {selectedFolder.description ? (
              <p className={styles.phoneAppHint}>{selectedFolder.description}</p>
            ) : null}

            {folderEntries.length === 0 ? (
              <p className={styles.phoneAppHint} data-testid="phone-files-folder-empty">
                这个文件夹还没有文件。
              </p>
            ) : (
              <ul className={styles.phoneFilesEntryList} aria-label="文件列表">
                {folderEntries.map((entry) => (
                  <li key={entry.id}>
                    <button
                      type="button"
                      className={styles.phoneFilesEntryItem}
                      onClick={() => setSelectedEntryId(entry.id)}
                      data-testid={`phone-files-entry-${entry.id}`}
                    >
                      <span className={styles.phoneFilesEntryTitle}>{entry.title}</span>
                      {entry.body ? (
                        <span className={styles.phoneFilesEntryExcerpt}>{excerptForList(entry.body)}</span>
                      ) : null}
                      {entry.tags && entry.tags.length > 0 ? (
                        <span className={styles.phoneFilesEntryTags}>
                          {entry.tags.map((t) => `#${t}`).join(' ')}
                        </span>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className={styles.phoneFilesHomeActions}>
              <button
                type="button"
                className={styles.phonePrimaryAction}
                onClick={() => openCreateInFolder(selectedFolder.id)}
                data-testid="phone-files-new-in-folder"
              >
                新建文件
              </button>
            </div>
          </section>
        ) : null}

        {inEntryDetail && selectedEntry ? (
          <section className={styles.phoneAppCard} aria-label="文件详情">
            <h3 className={styles.phoneAppTitle}>{selectedEntry.title}</h3>
            <p className={styles.phoneAppHint}>
              {formatTimestamp(selectedEntry.updatedAt ?? selectedEntry.createdAt)}
              {selectedEntry.source ? ` · 来源：${selectedEntry.source}` : ''}
            </p>
            {selectedEntry.tags && selectedEntry.tags.length > 0 ? (
              <p className={styles.phoneFilesEntryTags}>
                {selectedEntry.tags.map((t) => `#${t}`).join(' ')}
              </p>
            ) : null}
            <div className={styles.phoneJournalDetailBodyScroll}>
              <pre className={styles.phoneJournalDetailBody}>{selectedEntry.body}</pre>
            </div>
            <div className={styles.phoneFilesHomeActions}>
              <button
                type="button"
                className={styles.phoneModalGhostButton}
                onClick={() => openEdit(selectedEntry)}
                data-testid="phone-files-edit-button"
              >
                编辑
              </button>
              <button
                type="button"
                className={styles.phoneModalGhostButton}
                onClick={() => void handleDeleteSelected()}
                disabled={deleteBusy}
                data-testid="phone-files-delete-button"
              >
                {deleteBusy ? '删除中…' : '删除这条文件'}
              </button>
            </div>
          </section>
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
              <label className={styles.phoneFormField}>
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
                className={styles.phoneModalGhostButton}
                onClick={() => void handleGenerateDraft()}
                disabled={aiBusy || saveBusy || !ownerAgent}
                data-testid="phone-files-ai-button"
              >
                {aiBusy ? '生成中…' : '让 TA 自己整理'}
              </button>
              {aiError ? (
                <p className={styles.phoneAppHint} role="alert">
                  {aiError}
                </p>
              ) : null}
              {aiFolderName && composeMode.kind === 'create' ? (
                (() => {
                  const targetFolder = folders.find((f) => f.id === composeMode.folderId);
                  if (!targetFolder || targetFolder.name === aiFolderName) return null;
                  return (
                    <p className={styles.phoneAppHint} data-testid="phone-files-ai-folder-mismatch">
                      TA 想把这条放进「{aiFolderName}」，但当前文件夹是「{targetFolder.name}」；保存后会落在当前文件夹。
                    </p>
                  );
                })()
              ) : null}
              <label className={styles.phoneFormField}>
                <span>标题</span>
                <input
                  value={draftTitle}
                  onChange={(event) => setDraftTitle(event.target.value)}
                  placeholder="给这条文件一个名字"
                  data-testid="phone-files-title-input"
                />
              </label>
              <label className={styles.phoneFormField}>
                <span>正文</span>
                <textarea
                  value={draftBody}
                  onChange={(event) => setDraftBody(event.target.value)}
                  rows={6}
                  placeholder="可以写设定 / 关系 / 线索 / 摘抄等内容…"
                  data-testid="phone-files-body-input"
                />
              </label>
              <label className={styles.phoneFormField}>
                <span>标签</span>
                <input
                  value={draftTags}
                  onChange={(event) => setDraftTags(event.target.value)}
                  placeholder="可选，用逗号分隔，如 设定, 关系"
                  data-testid="phone-files-tags-input"
                />
              </label>
              <label className={styles.phoneFormField}>
                <span>来源</span>
                <input
                  value={draftSource}
                  onChange={(event) => setDraftSource(event.target.value)}
                  placeholder="可选，如「2026-05-15 闲聊」"
                  data-testid="phone-files-source-input"
                />
              </label>
              {saveError ? (
                <p className={styles.phoneAppHint} role="alert">
                  {saveError}
                </p>
              ) : null}
            </div>
            <div className={styles.phoneModalActions}>
              <button
                type="button"
                className={styles.phoneModalGhostButton}
                onClick={closeCompose}
                disabled={saveBusy || aiBusy}
              >
                取消
              </button>
              <button
                type="button"
                className={styles.phonePrimaryAction}
                onClick={() => void handleSave()}
                disabled={saveBusy || aiBusy}
                data-testid="phone-files-save-button"
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
