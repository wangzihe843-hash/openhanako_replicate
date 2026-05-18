import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Agent } from '../types';
import styles from './XingyeShell.module.css';
import {
  appendAppEntry,
  deleteAppEntry,
  listAppEntries,
  updateAppEntry,
  type AppEntry,
} from './xingye-app-entry-store';
import {
  confirmShoppingDraft,
  discardShoppingDraft,
  listShoppingDrafts,
  type ShoppingDraftPlatformStyle,
  type ShoppingDraftStatus,
  type XingyePendingShoppingDraft,
} from './xingye-shopping-drafts';
import type { XingyeRoleProfile } from './xingye-profile-store';
import { generateShoppingDraftWithAI } from './xingye-shopping-ai';

export interface PhoneShoppingAppProps {
  ownerAgent: Agent | null;
  ownerProfile?: XingyeRoleProfile | null;
  displayName: string;
  onBack: () => void;
}

export type ShoppingEntryStatus =
  | 'wanted'
  | 'ordered'
  | 'received'
  | 'hesitating'
  | 'returned'
  | 'favorite';

export type ShoppingEntryMetadata = {
  status: ShoppingEntryStatus;
  platformStyle?: 'amazon' | 'taobao' | 'xianyu' | 'generic';
  itemName: string;
  category?: string;
  reason?: string;
  imaginedPrice?: string;
  tags?: string[];
};

type ShoppingEntry = AppEntry & {
  appId: 'shopping';
  metadata: ShoppingEntryMetadata;
};

type ShoppingDraft = {
  itemName: string;
  status: ShoppingEntryStatus;
  platformStyle: NonNullable<ShoppingEntryMetadata['platformStyle']>;
  category: string;
  imaginedPrice: string;
  reason: string;
  tagsText: string;
  content: string;
};

const SHOPPING_APP_ID = 'shopping';

const STATUS_LABELS: Record<ShoppingEntryStatus, string> = {
  wanted: '想买',
  hesitating: '犹豫',
  ordered: '已下单',
  received: '已收到',
  favorite: '已收藏',
  returned: '已退掉',
};

const FILTERS: Array<{ value: 'all' | ShoppingEntryStatus; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'wanted', label: '想买' },
  { value: 'hesitating', label: '犹豫' },
  { value: 'ordered', label: '已下单' },
  { value: 'received', label: '已收到' },
  { value: 'favorite', label: '已收藏' },
  { value: 'returned', label: '已退掉' },
];

const PLATFORM_STYLE_LABELS: Record<NonNullable<ShoppingEntryMetadata['platformStyle']>, string> = {
  generic: '普通记录',
  amazon: '清单感',
  taobao: '订单感',
  xianyu: '闲置感',
};

function emptyDraft(): ShoppingDraft {
  return {
    itemName: '',
    status: 'wanted',
    platformStyle: 'generic',
    category: '',
    imaginedPrice: '',
    reason: '',
    tagsText: '',
    content: '',
  };
}

function isShoppingStatus(value: unknown): value is ShoppingEntryStatus {
  return (
    value === 'wanted' ||
    value === 'ordered' ||
    value === 'received' ||
    value === 'hesitating' ||
    value === 'returned' ||
    value === 'favorite'
  );
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((tag) => (typeof tag === 'string' ? tag.trim() : ''))
    .filter(Boolean)
    .slice(0, 8);
}

function normalizeShoppingEntry(entry: AppEntry): ShoppingEntry {
  const meta = entry.metadata ?? {};
  const itemName = typeof meta.itemName === 'string' && meta.itemName.trim() ? meta.itemName.trim() : entry.title;
  const platformStyle =
    meta.platformStyle === 'amazon' ||
    meta.platformStyle === 'taobao' ||
    meta.platformStyle === 'xianyu' ||
    meta.platformStyle === 'generic'
      ? meta.platformStyle
      : 'generic';
  return {
    ...entry,
    appId: 'shopping',
    metadata: {
      status: isShoppingStatus(meta.status) ? meta.status : 'wanted',
      platformStyle,
      itemName,
      category: typeof meta.category === 'string' && meta.category.trim() ? meta.category.trim() : undefined,
      reason: typeof meta.reason === 'string' && meta.reason.trim() ? meta.reason.trim() : undefined,
      imaginedPrice:
        typeof meta.imaginedPrice === 'string' && meta.imaginedPrice.trim()
          ? meta.imaginedPrice.trim()
          : undefined,
      tags: normalizeTags(meta.tags),
    },
  };
}

function draftFromEntry(entry: ShoppingEntry): ShoppingDraft {
  return {
    itemName: entry.metadata.itemName || entry.title,
    status: entry.metadata.status,
    platformStyle: entry.metadata.platformStyle ?? 'generic',
    category: entry.metadata.category ?? '',
    imaginedPrice: entry.metadata.imaginedPrice ?? '',
    reason: entry.metadata.reason ?? '',
    tagsText: (entry.metadata.tags ?? []).join(', '),
    content: entry.content,
  };
}

function buildInputFromDraft(draft: ShoppingDraft) {
  const itemName = draft.itemName.trim();
  const tags = draft.tagsText
    .split(/[,，]/)
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 8);
  const metadata: ShoppingEntryMetadata = {
    status: draft.status,
    platformStyle: draft.platformStyle,
    itemName,
  };
  const category = draft.category.trim();
  const imaginedPrice = draft.imaginedPrice.trim();
  const reason = draft.reason.trim();
  if (category) metadata.category = category;
  if (imaginedPrice) metadata.imaginedPrice = imaginedPrice;
  if (reason) metadata.reason = reason;
  if (tags.length > 0) metadata.tags = tags;
  return {
    title: itemName,
    content: draft.content.trim(),
    source: 'manual',
    metadata,
  };
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function excerpt(text: string, max = 58): string {
  const one = text.replace(/\s+/g, ' ').trim();
  if (!one) return '没有备注。';
  if (one.length <= max) return one;
  return `${one.slice(0, Math.max(1, max - 1))}…`;
}

export function PhoneShoppingApp({ ownerAgent, ownerProfile, displayName, onBack }: PhoneShoppingAppProps) {
  const ownerAgentId = ownerAgent?.id ?? '';
  const [entries, setEntries] = useState<ShoppingEntry[]>([]);
  const [pendingDrafts, setPendingDrafts] = useState<XingyePendingShoppingDraft[]>([]);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | ShoppingEntryStatus>('all');
  const [composeOpen, setComposeOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ShoppingDraft>(() => emptyDraft());
  const [userIntent, setUserIntent] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  /**
   * 「待确认草稿」行内编辑缓冲。Key = draft.id。
   * 用户在小手机里改了字、还没按「确认生成」前先在内存里保留改动；
   * 离开页面再回来时回退到 drafts.jsonl 的最新内容（草稿本身已落盘，不会丢）。
   */
  const [draftEdits, setDraftEdits] = useState<
    Record<string, {
      itemName: string;
      status: ShoppingDraftStatus;
      content: string;
      category: string;
      imaginedPrice: string;
    }>
  >({});
  const [draftBusyId, setDraftBusyId] = useState<string | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);

  const reloadEntries = useCallback(async () => {
    if (!ownerAgentId) {
      setEntries([]);
      setPendingDrafts([]);
      setDraftEdits({});
      return;
    }
    setLoading(true);
    setListError(null);
    try {
      const [rows, drafts] = await Promise.all([
        listAppEntries(ownerAgentId, SHOPPING_APP_ID),
        listShoppingDrafts(ownerAgentId),
      ]);
      setEntries(rows.map(normalizeShoppingEntry).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)));
      setPendingDrafts(drafts);
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [ownerAgentId]);

  const draftWorkingValue = useCallback(
    (d: XingyePendingShoppingDraft) => {
      const edit = draftEdits[d.id];
      if (edit) return edit;
      return {
        itemName: d.itemName,
        status: d.status,
        content: d.content ?? '',
        category: d.category ?? '',
        imaginedPrice: d.imaginedPrice ?? '',
      };
    },
    [draftEdits],
  );

  const handleDraftFieldChange = (
    draftId: string,
    patch: Partial<{ itemName: string; status: ShoppingDraftStatus; content: string; category: string; imaginedPrice: string }>,
  ) => {
    setDraftEdits((prev) => {
      const d = pendingDrafts.find((entry) => entry.id === draftId);
      if (!d) return prev;
      const base = prev[draftId] ?? {
        itemName: d.itemName,
        status: d.status,
        content: d.content ?? '',
        category: d.category ?? '',
        imaginedPrice: d.imaginedPrice ?? '',
      };
      return { ...prev, [draftId]: { ...base, ...patch } };
    });
  };

  const handleConfirmDraft = async (d: XingyePendingShoppingDraft) => {
    if (!ownerAgentId) return;
    setDraftBusyId(d.id);
    setDraftError(null);
    try {
      const working = draftWorkingValue(d);
      const entry = await confirmShoppingDraft(ownerAgentId, d.id, {
        itemName: working.itemName,
        status: working.status,
        content: working.content.trim() ? working.content : null,
        category: working.category.trim() ? working.category : null,
        imaginedPrice: working.imaginedPrice.trim() ? working.imaginedPrice : null,
      });
      const normalized = normalizeShoppingEntry(entry);
      setEntries((prev) =>
        [normalized, ...prev.filter((p) => p.id !== normalized.id)].sort(
          (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
        ),
      );
      setPendingDrafts((prev) => prev.filter((p) => p.id !== d.id));
      setDraftEdits((prev) => {
        if (!(d.id in prev)) return prev;
        const { [d.id]: _omitted, ...rest } = prev;
        return rest;
      });
    } catch (err) {
      setDraftError(err instanceof Error ? err.message : String(err));
    } finally {
      setDraftBusyId(null);
    }
  };

  const handleDiscardDraft = async (d: XingyePendingShoppingDraft) => {
    if (!ownerAgentId) return;
    if (!window.confirm('确定丢弃这条待确认购物草稿？此操作不可恢复，但角色可在下次巡检里重新提议。')) {
      return;
    }
    setDraftBusyId(d.id);
    setDraftError(null);
    try {
      const ok = await discardShoppingDraft(ownerAgentId, d.id);
      if (ok) {
        setPendingDrafts((prev) => prev.filter((p) => p.id !== d.id));
        setDraftEdits((prev) => {
          if (!(d.id in prev)) return prev;
          const { [d.id]: _omitted, ...rest } = prev;
          return rest;
        });
      } else {
        await reloadEntries();
      }
    } catch (err) {
      setDraftError(err instanceof Error ? err.message : String(err));
    } finally {
      setDraftBusyId(null);
    }
  };

  useEffect(() => {
    setSelectedId(null);
    setComposeOpen(false);
    setEditing(false);
    setSaveError(null);
    setListError(null);
  }, [ownerAgentId]);

  useEffect(() => {
    void reloadEntries();
  }, [reloadEntries]);

  const selected = useMemo(
    () => (selectedId ? entries.find((entry) => entry.id === selectedId) ?? null : null),
    [entries, selectedId],
  );

  const visibleEntries = useMemo(() => {
    if (filter === 'all') return entries;
    return entries.filter((entry) => entry.metadata.status === filter);
  }, [entries, filter]);

  const updateDraft = (patch: Partial<ShoppingDraft>) => {
    setDraft((prev) => ({ ...prev, ...patch }));
  };

  const openCompose = () => {
    setDraft(emptyDraft());
    setUserIntent('');
    setSaveError(null);
    setAiError(null);
    setComposeOpen(true);
    setEditing(false);
  };

  const openEdit = () => {
    if (!selected) return;
    setDraft(draftFromEntry(selected));
    setUserIntent('');
    setSaveError(null);
    setAiError(null);
    setComposeOpen(false);
    setEditing(true);
  };

  const handleGenerateDraft = async () => {
    if (!ownerAgent) return;
    setAiBusy(true);
    setAiError(null);
    try {
      const result = await generateShoppingDraftWithAI({
        agent: ownerAgent,
        ownerProfile: ownerProfile ?? null,
        userIntent: userIntent.trim(),
      });
      setDraft({
        itemName: result.itemName,
        status: result.status,
        platformStyle: result.platformStyle,
        category: result.category ?? '',
        imaginedPrice: result.imaginedPrice ?? '',
        reason: result.reason ?? '',
        tagsText: (result.tags ?? []).join(', '),
        content: result.content,
      });
    } catch (err) {
      setAiError(err instanceof Error ? err.message : String(err));
    } finally {
      setAiBusy(false);
    }
  };

  const saveDraft = async () => {
    if (!ownerAgentId) return;
    if (!draft.itemName.trim()) {
      setSaveError('请先写下物品名。');
      return;
    }
    setSaveBusy(true);
    setSaveError(null);
    try {
      const input = buildInputFromDraft(draft);
      if (editing && selected) {
        const updated = await updateAppEntry(ownerAgentId, SHOPPING_APP_ID, selected.id, input);
        if (updated) {
          const normalized = normalizeShoppingEntry(updated);
          setEntries((prev) =>
            prev.map((entry) => (entry.id === normalized.id ? normalized : entry)).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
          );
          setSelectedId(normalized.id);
        } else {
          await reloadEntries();
        }
        setEditing(false);
      } else {
        const row = normalizeShoppingEntry(await appendAppEntry(ownerAgentId, SHOPPING_APP_ID, input));
        setEntries((prev) => [row, ...prev.filter((entry) => entry.id !== row.id)]);
        setSelectedId(row.id);
        setComposeOpen(false);
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaveBusy(false);
    }
  };

  const handleDeleteSelected = async () => {
    if (!selected || !ownerAgentId) return;
    if (!window.confirm('确定删除这条购物记录？此操作不可恢复。')) return;
    setDeleteBusy(true);
    try {
      const ok = await deleteAppEntry(ownerAgentId, SHOPPING_APP_ID, selected.id);
      if (ok) {
        setEntries((prev) => prev.filter((entry) => entry.id !== selected.id));
        setSelectedId(null);
        setEditing(false);
      } else {
        await reloadEntries();
      }
    } finally {
      setDeleteBusy(false);
    }
  };

  const closeEditor = () => {
    setComposeOpen(false);
    setEditing(false);
    setSaveError(null);
  };

  if (!ownerAgentId) {
    return (
      <div className={styles.phoneShell} aria-label="购物记录">
        <div className={styles.phoneStatusBar}>
          <button type="button" className={styles.phoneBackButton} onClick={onBack}>
            返回首页
          </button>
          <span>购物</span>
        </div>
        <div className={styles.phoneBody}>
          <section className={styles.phoneAppCard}>
            <h3 className={styles.phoneAppTitle}>购物记录不可用</h3>
            <p className={styles.phoneAppHint}>请选择有效角色后再打开购物记录。</p>
          </section>
        </div>
      </div>
    );
  }

  const editorOpen = composeOpen || editing;
  const title = editing ? '编辑购物记录' : '新增购物记录';

  return (
    <div className={styles.phoneShell} aria-label="购物记录">
      <div className={styles.phoneStatusBar}>
        {selected && !editorOpen ? (
          <button type="button" className={styles.phoneBackButton} onClick={() => setSelectedId(null)}>
            返回列表
          </button>
        ) : (
          <button type="button" className={styles.phoneBackButton} onClick={editorOpen ? closeEditor : onBack}>
            {editorOpen ? '取消' : '返回首页'}
          </button>
        )}
        <span>购物</span>
      </div>

      <div className={styles.phoneBody}>
        {listError ? (
          <p className={styles.phoneAppHint} role="alert">
            加载失败：{listError}
          </p>
        ) : null}
        {loading && entries.length === 0 ? <p className={styles.phoneAppHint}>加载中…</p> : null}

        {editorOpen ? (
          <section className={styles.phoneShoppingEditor} aria-label={title}>
            <header className={styles.phoneShoppingHeader}>
              <p className={styles.phoneShoppingKicker}>SIMULATED RECORD</p>
              <h2 className={styles.phoneShoppingTitle}>{title}</h2>
              <p className={styles.phoneShoppingSafeNote}>只记录 TA 自己的小手机购物想法，不连接真实平台。</p>
            </header>
            <label className={styles.phoneFormField}>
              <span>购物意图</span>
              <textarea
                rows={2}
                value={userIntent}
                placeholder="可选：想让 TA 整理什么方向的购物想法"
                onChange={(e) => setUserIntent(e.target.value)}
                data-testid="phone-shopping-intent-input"
              />
            </label>
            <button
              type="button"
              className={styles.phoneModalGhostButton}
              onClick={() => void handleGenerateDraft()}
              disabled={aiBusy || saveBusy || !ownerAgent}
              data-testid="phone-shopping-ai-button"
            >
              {aiBusy ? '生成中…' : '让 TA 自己整理'}
            </button>
            {aiError ? (
              <p className={styles.phoneAppHint} role="alert">
                {aiError}
              </p>
            ) : null}
            <label className={styles.phoneFormField}>
              <span>物品名</span>
              <input value={draft.itemName} onChange={(e) => updateDraft({ itemName: e.target.value })} />
            </label>
            <label className={styles.phoneFormField}>
              <span>状态</span>
              <select
                className={styles.phoneInlineSelect}
                value={draft.status}
                onChange={(e) => updateDraft({ status: e.target.value as ShoppingEntryStatus })}
              >
                {FILTERS.filter((item) => item.value !== 'all').map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.phoneFormField}>
              <span>记录风格</span>
              <select
                className={styles.phoneInlineSelect}
                value={draft.platformStyle}
                onChange={(e) => updateDraft({ platformStyle: e.target.value as ShoppingDraft['platformStyle'] })}
              >
                {Object.entries(PLATFORM_STYLE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.phoneFormField}>
              <span>类别</span>
              <input value={draft.category} onChange={(e) => updateDraft({ category: e.target.value })} />
            </label>
            <label className={styles.phoneFormField}>
              <span>价格感</span>
              <input
                value={draft.imaginedPrice}
                placeholder="只写角色想象里的价格感"
                onChange={(e) => updateDraft({ imaginedPrice: e.target.value })}
              />
            </label>
            <label className={styles.phoneFormField}>
              <span>记录原因</span>
              <input value={draft.reason} onChange={(e) => updateDraft({ reason: e.target.value })} />
            </label>
            <label className={styles.phoneFormField}>
              <span>标签</span>
              <input value={draft.tagsText} onChange={(e) => updateDraft({ tagsText: e.target.value })} />
            </label>
            <label className={styles.phoneFormField}>
              <span>备注</span>
              <textarea
                rows={4}
                value={draft.content}
                onChange={(e) => updateDraft({ content: e.target.value })}
              />
            </label>
            {saveError ? (
              <p className={styles.phoneAppHint} role="alert">
                {saveError}
              </p>
            ) : null}
            <div className={styles.phoneShoppingActions}>
              <button
                type="button"
                className={styles.phonePrimaryAction}
                onClick={saveDraft}
                disabled={saveBusy || aiBusy}
              >
                {editing ? '保存修改' : '保存记录'}
              </button>
            </div>
          </section>
        ) : selected ? (
          <section className={styles.phoneShoppingDetail}>
            <p className={styles.phoneShoppingSafeNote}>这只是 TA 自己的小手机购物记录，不连接真实平台。</p>
            <div className={styles.phoneShoppingDetailHead}>
              <span className={styles.phoneShoppingStatusChip}>{STATUS_LABELS[selected.metadata.status]}</span>
              <span className={styles.phoneShoppingPlatformChip}>
                {PLATFORM_STYLE_LABELS[selected.metadata.platformStyle ?? 'generic']}
              </span>
            </div>
            <h2 className={styles.phoneShoppingDetailTitle}>{selected.metadata.itemName}</h2>
            <p className={styles.phoneShoppingMeta}>{formatDateTime(selected.updatedAt)}</p>
            {selected.metadata.category ? <p className={styles.phoneShoppingMeta}>类别：{selected.metadata.category}</p> : null}
            {selected.metadata.imaginedPrice ? (
              <p className={styles.phoneShoppingMeta}>价格感：{selected.metadata.imaginedPrice}</p>
            ) : null}
            {selected.metadata.reason ? <p className={styles.phoneShoppingReason}>{selected.metadata.reason}</p> : null}
            <p className={styles.phoneShoppingBody}>{selected.content || '没有备注。'}</p>
            {selected.metadata.tags?.length ? (
              <div className={styles.phoneTagRow}>
                {selected.metadata.tags.map((tag) => (
                  <span key={tag}>{tag}</span>
                ))}
              </div>
            ) : null}
            <div className={styles.phoneShoppingActions}>
              <button type="button" className={styles.phoneShortcutButton} onClick={openEdit}>
                编辑记录
              </button>
              <button
                type="button"
                className={styles.phoneShortcutButton}
                onClick={handleDeleteSelected}
                disabled={deleteBusy}
              >
                删除这条记录
              </button>
            </div>
          </section>
        ) : (
          <section className={styles.phoneShoppingLayout}>
            <header className={styles.phoneShoppingHeader}>
              <p className={styles.phoneShoppingKicker}>SHOPPING NOTES</p>
              <h2 className={styles.phoneShoppingTitle}>{displayName || ownerAgent?.name || 'TA'} 的购物记录</h2>
              <p className={styles.phoneShoppingSafeNote}>模拟订单、收藏和想买清单，不含真实购买、推荐、价格查询或链接。</p>
            </header>

            {pendingDrafts.length > 0 ? (
              <section
                aria-label="待确认购物草稿"
                data-testid="phone-shopping-pending-drafts"
                style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
              >
                <p className={styles.phoneShoppingSafeNote}>
                  待确认草稿 · 来自心跳巡检。这些是 TA 在巡检里想加进购物清单的东西，还没出现在「已生成」列表里。
                  点「确认生成」才会真正写入；离开页面再回来不会丢草稿。
                </p>
                {draftError ? (
                  <p className={styles.phoneAppHint} role="alert">
                    {draftError}
                  </p>
                ) : null}
                {pendingDrafts.map((d) => {
                  const working = draftWorkingValue(d);
                  const busy = draftBusyId === d.id;
                  return (
                    <div
                      key={d.id}
                      className={styles.phoneShoppingCard}
                      style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}
                      data-testid={`phone-shopping-draft-${d.id}`}
                    >
                      <input
                        type="text"
                        value={working.itemName}
                        onChange={(e) => handleDraftFieldChange(d.id, { itemName: e.target.value })}
                        placeholder="物品名"
                        aria-label="待确认购物草稿物品名"
                        data-testid={`phone-shopping-draft-name-${d.id}`}
                        disabled={busy}
                        style={{ font: 'inherit', background: 'transparent', border: '1px dashed rgba(0,0,0,0.2)', padding: '4px 6px' }}
                      />
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <select
                          className={styles.phoneInlineSelect}
                          value={working.status}
                          onChange={(e) =>
                            handleDraftFieldChange(d.id, { status: e.target.value as ShoppingDraftStatus })
                          }
                          disabled={busy}
                          aria-label="待确认购物草稿状态"
                          data-testid={`phone-shopping-draft-status-${d.id}`}
                        >
                          {FILTERS.filter((item) => item.value !== 'all').map((item) => (
                            <option key={item.value} value={item.value}>
                              {item.label}
                            </option>
                          ))}
                        </select>
                        <input
                          type="text"
                          value={working.category}
                          onChange={(e) => handleDraftFieldChange(d.id, { category: e.target.value })}
                          placeholder="类别（可选）"
                          aria-label="待确认购物草稿类别"
                          disabled={busy}
                          style={{ flex: 1, font: 'inherit', background: 'transparent', border: '1px dashed rgba(0,0,0,0.2)', padding: '4px 6px' }}
                        />
                        <input
                          type="text"
                          value={working.imaginedPrice}
                          onChange={(e) => handleDraftFieldChange(d.id, { imaginedPrice: e.target.value })}
                          placeholder="价格感（可选）"
                          aria-label="待确认购物草稿价格感"
                          disabled={busy}
                          style={{ flex: 1, font: 'inherit', background: 'transparent', border: '1px dashed rgba(0,0,0,0.2)', padding: '4px 6px' }}
                        />
                      </div>
                      <textarea
                        value={working.content}
                        onChange={(e) => handleDraftFieldChange(d.id, { content: e.target.value })}
                        rows={2}
                        placeholder="备注（可选）"
                        aria-label="待确认购物草稿备注"
                        disabled={busy}
                        style={{ width: '100%', font: 'inherit', background: 'transparent', border: '1px dashed rgba(0,0,0,0.2)', padding: '6px' }}
                      />
                      {d.reason ? (
                        <p className={styles.phoneAppHint} style={{ margin: 0 }}>
                          理由：{d.reason}
                        </p>
                      ) : null}
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <button
                          type="button"
                          className={styles.phonePrimaryAction}
                          onClick={() => void handleConfirmDraft(d)}
                          disabled={busy}
                          data-testid={`phone-shopping-draft-confirm-${d.id}`}
                        >
                          {busy ? '处理中…' : '确认生成'}
                        </button>
                        <button
                          type="button"
                          className={styles.phoneModalGhostButton}
                          onClick={() => void handleDiscardDraft(d)}
                          disabled={busy}
                          data-testid={`phone-shopping-draft-discard-${d.id}`}
                        >
                          丢弃
                        </button>
                      </div>
                    </div>
                  );
                })}
              </section>
            ) : null}

            <div className={styles.phoneShoppingFilterRow} aria-label="购物状态筛选">
              {FILTERS.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  className={`${styles.phoneShoppingFilterButton} ${filter === item.value ? styles.phoneShoppingFilterButtonActive : ''}`}
                  onClick={() => setFilter(item.value)}
                >
                  {item.label}
                </button>
              ))}
            </div>

            {visibleEntries.length === 0 && !loading ? (
              <p className={styles.phoneJournalEmpty} data-testid="phone-shopping-empty">
                还没有购物记录。
              </p>
            ) : null}

            <div className={styles.phoneShoppingList}>
              {visibleEntries.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className={styles.phoneShoppingCard}
                  onClick={() => setSelectedId(entry.id)}
                >
                  <span className={styles.phoneShoppingStatusChip}>{STATUS_LABELS[entry.metadata.status]}</span>
                  <span className={styles.phoneShoppingCardMain}>
                    <strong>{entry.metadata.itemName}</strong>
                    <span>{excerpt(entry.content || entry.metadata.reason || '')}</span>
                  </span>
                  {entry.metadata.imaginedPrice ? (
                    <span className={styles.phoneShoppingPrice}>{entry.metadata.imaginedPrice}</span>
                  ) : null}
                </button>
              ))}
            </div>

            <button type="button" className={styles.phonePrimaryAction} onClick={openCompose}>
              新增购物记录
            </button>
          </section>
        )}
      </div>
    </div>
  );
}
