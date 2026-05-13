import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Agent } from '../types';
import styles from './XingyeShell.module.css';
import { generateJournalDraftWithAI } from './xingye-journal-ai';
import {
  appendJournalEntry,
  deleteJournalEntry,
  listJournalEntries,
  type XingyeJournalEntry,
} from './xingye-journal-store';
import { useXingyeRoleProfile } from './xingye-profile-store';

export interface PhoneJournalAppProps {
  ownerAgent: Agent | null;
  displayName: string;
  onBack: () => void;
}

function formatGroupHeading(dayKey: string): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  }).format(date);
}

function dayLabelForDetail(dayKey: string): string {
  return formatGroupHeading(dayKey);
}

/** 列表索引用：不展示全文，避免长日记占满列表 */
function excerptForJournalList(body: string, maxChars = 96): string {
  const collapsed = body.replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, Math.max(1, maxChars - 1))}…`;
}

export function PhoneJournalApp({ ownerAgent, displayName, onBack }: PhoneJournalAppProps) {
  const ownerAgentId = ownerAgent?.id ?? '';
  const ownerProfile = useXingyeRoleProfile(ownerAgentId);
  const [entries, setEntries] = useState<XingyeJournalEntry[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftBody, setDraftBody] = useState('');
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [draftAiBusy, setDraftAiBusy] = useState(false);
  const [draftAiError, setDraftAiError] = useState<string | null>(null);

  const reloadEntries = useCallback(async () => {
    if (!ownerAgentId) {
      setEntries([]);
      return;
    }
    setListLoading(true);
    setListError(null);
    try {
      const rows = await listJournalEntries(ownerAgentId);
      setEntries(rows);
    } catch (e) {
      setListError(e instanceof Error ? e.message : String(e));
    } finally {
      setListLoading(false);
    }
  }, [ownerAgentId]);

  useEffect(() => {
    setSelectedId(null);
    setComposeOpen(false);
    setSaveError(null);
    setListError(null);
  }, [ownerAgentId]);

  useEffect(() => {
    void reloadEntries();
  }, [reloadEntries]);

  const selected = useMemo(
    () => (selectedId ? entries.find((e) => e.id === selectedId) ?? null : null),
    [entries, selectedId],
  );

  const grouped = useMemo(() => {
    const map = new Map<string, XingyeJournalEntry[]>();
    const sorted = [...entries].sort((a, b) => (a.dayKey < b.dayKey ? 1 : a.dayKey > b.dayKey ? -1 : 0));
    for (const e of sorted) {
      const list = map.get(e.dayKey) ?? [];
      list.push(e);
      map.set(e.dayKey, list);
    }
    return Array.from(map.entries());
  }, [entries]);

  const ta = displayName || ownerAgent?.name || 'TA';

  const openCompose = () => {
    setDraftTitle('');
    setDraftBody('');
    setSaveError(null);
    setDraftAiError(null);
    setComposeOpen(true);
  };

  const handleGenerateDraft = async () => {
    if (!ownerAgent) return;
    setDraftAiBusy(true);
    setDraftAiError(null);
    try {
      const r = await generateJournalDraftWithAI({ agent: ownerAgent, ownerProfile });
      setDraftTitle(r.title);
      setDraftBody(r.body);
    } catch (e) {
      setDraftAiError(e instanceof Error ? e.message : String(e));
    } finally {
      setDraftAiBusy(false);
    }
  };

  const saveCompose = async () => {
    const title = draftTitle.trim() || '无标题';
    const body = draftBody.trim();
    if (!body || !ownerAgentId) {
      return;
    }
    setSaveBusy(true);
    setSaveError(null);
    try {
      const row = await appendJournalEntry(ownerAgentId, { title, body });
      setEntries((prev) => {
        const next = [row, ...prev.filter((p) => p.id !== row.id)];
        next.sort((a, b) => {
          if (a.dayKey !== b.dayKey) return a.dayKey < b.dayKey ? 1 : -1;
          const taMs = Date.parse(a.createdAt);
          const tbMs = Date.parse(b.createdAt);
          return tbMs - taMs;
        });
        return next;
      });
      setComposeOpen(false);
      setSelectedId(row.id);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaveBusy(false);
    }
  };

  const handleDeleteSelected = async () => {
    if (!selected || !ownerAgentId) return;
    if (!window.confirm('确定删除这条日记？此操作不可恢复。')) return;
    setDeleteBusy(true);
    try {
      const ok = await deleteJournalEntry(ownerAgentId, selected.id);
      if (ok) {
        setEntries((prev) => prev.filter((e) => e.id !== selected.id));
        setSelectedId(null);
      } else {
        await reloadEntries();
      }
    } finally {
      setDeleteBusy(false);
    }
  };

  if (!ownerAgentId) {
    return (
      <div className={styles.phoneShell} aria-label="日记">
        <div className={styles.phoneStatusBar}>
          <button type="button" className={styles.phoneBackButton} onClick={onBack}>
            返回首页
          </button>
          <span>日记</span>
        </div>
        <div className={styles.phoneBody}>
          <section className={styles.phoneAppCard}>
            <h3 className={styles.phoneAppTitle}>日记不可用</h3>
            <p className={styles.phoneAppHint}>
              未选择角色 / 小手机不可用。日记写入当前角色在 HANA_HOME 下的星野目录，不能使用隐式角色回退。
            </p>
            <p className={styles.phoneAppHint}>请返回星野角色页，选择有效角色后再打开小手机日记。</p>
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.phoneShell} aria-label="日记">
      <div className={styles.phoneStatusBar}>
        {selected ? (
          <button type="button" className={styles.phoneBackButton} onClick={() => setSelectedId(null)}>
            返回列表
          </button>
        ) : (
          <button type="button" className={styles.phoneBackButton} onClick={onBack}>
            返回首页
          </button>
        )}
        <span>日记</span>
      </div>

      <div className={styles.phoneBody}>
        <p className={styles.mmChatIntro}>
          <strong>{ta} 的日记本</strong>：纯文本，按角色保存在本机{' '}
          <code className={styles.inlineCode}>agents/&lt;agentId&gt;/xingye/journal/entries.jsonl</code>
          ；换角色互不串数据。需已连接服务且星野存储可用。
        </p>
        {listError ? (
          <p className={styles.phoneAppHint} role="alert">
            加载失败：{listError}
          </p>
        ) : null}
        {listLoading && entries.length === 0 ? <p className={styles.phoneAppHint}>加载中…</p> : null}

        {!selected ? (
          <div className={styles.phoneJournalLayout}>
            <div className={styles.phoneJournalToolbar}>
              <p className={styles.phoneSectionTitle} style={{ margin: 0 }}>
                按日期分组
              </p>
              <button type="button" className={styles.phoneJournalPrimaryButton} onClick={openCompose} disabled={listLoading}>
                写日记
              </button>
            </div>

            {grouped.length === 0 && !listLoading ? (
              <p className={styles.phoneJournalEmpty} data-testid="phone-journal-empty">
                还没有日记。点「写日记」添加一条记录（写入当前角色目录，刷新或重启后仍在）。
              </p>
            ) : null}
            {grouped.length > 0
              ? grouped.map(([dayKey, list]) => (
                  <div key={dayKey} className={styles.phoneJournalGroup}>
                    <p className={styles.phoneJournalGroupLabel}>{formatGroupHeading(dayKey)}</p>
                    {list.map((e) => (
                      <button
                        key={e.id}
                        type="button"
                        className={styles.phoneJournalCard}
                        onClick={() => setSelectedId(e.id)}
                      >
                        <p className={styles.phoneJournalCardTitle}>{e.title}</p>
                        <p className={styles.phoneJournalCardExcerpt}>{excerptForJournalList(e.body)}</p>
                      </button>
                    ))}
                  </div>
                ))
              : null}
          </div>
        ) : (
          <div className={styles.phoneJournalDetail}>
            <p className={styles.phoneJournalDetailMeta}>{dayLabelForDetail(selected.dayKey)}</p>
            <h3 className={styles.phoneAppTitle} style={{ margin: 0 }}>
              {selected.title}
            </h3>
            <div className={styles.phoneJournalDetailBodyScroll}>
              <pre className={styles.phoneJournalDetailBody}>{selected.body}</pre>
            </div>
            <div style={{ marginTop: 12 }}>
              <button
                type="button"
                className={styles.phoneModalGhostButton}
                onClick={() => void handleDeleteSelected()}
                disabled={deleteBusy}
              >
                {deleteBusy ? '删除中…' : '删除这条日记'}
              </button>
            </div>
          </div>
        )}
      </div>

      {composeOpen ? (
        <div
          className={styles.phoneModalOverlay}
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setComposeOpen(false);
          }}
        >
          <div className={styles.phoneModalSheet} role="dialog" aria-modal="true" aria-labelledby="phone-journal-compose-title">
            <h3 id="phone-journal-compose-title" className={styles.phoneModalTitle}>
              写日记
            </h3>
            <div className={styles.phoneModalBody}>
              <label className={styles.phoneFormField}>
                <span>标题</span>
                <input value={draftTitle} onChange={(e) => setDraftTitle(e.target.value)} placeholder="可选" />
              </label>
              <label className={styles.phoneFormField}>
                <span>正文</span>
                <textarea value={draftBody} onChange={(e) => setDraftBody(e.target.value)} rows={6} placeholder="写点什么…" />
              </label>
              <div style={{ marginTop: 8 }}>
                <button
                  type="button"
                  className={styles.phoneModalGhostButton}
                  onClick={() => void handleGenerateDraft()}
                  disabled={draftAiBusy || saveBusy}
                >
                  {draftAiBusy ? '生成中…' : '生成草稿'}
                </button>
              </div>
              {draftAiError ? (
                <p className={styles.phoneAppHint} role="alert">
                  {draftAiError}
                </p>
              ) : null}
              {saveError ? (
                <p className={styles.phoneAppHint} role="alert">
                  {saveError}
                </p>
              ) : null}
            </div>
            <div className={styles.phoneModalActions}>
              <button type="button" className={styles.phoneModalGhostButton} onClick={() => setComposeOpen(false)} disabled={saveBusy || draftAiBusy}>
                取消
              </button>
              <button type="button" className={styles.phoneJournalPrimaryButton} onClick={() => void saveCompose()} disabled={saveBusy || draftAiBusy}>
                {saveBusy ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
