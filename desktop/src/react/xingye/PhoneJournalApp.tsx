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

const CN_NUMERALS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
const CN_WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

function chineseDay(d: number): string {
  if (d <= 10) return CN_NUMERALS[d - 1];
  if (d < 20) return `十${CN_NUMERALS[d - 11]}`;
  if (d === 20) return '二十';
  if (d < 30) return `二十${CN_NUMERALS[d - 21]}`;
  if (d === 30) return '三十';
  return `三十${CN_NUMERALS[d - 31]}`;
}

function chineseMonth(m: number): string {
  if (m === 1) return '一月';
  if (m === 2) return '二月';
  if (m === 3) return '三月';
  if (m === 4) return '四月';
  if (m === 5) return '五月';
  if (m === 6) return '六月';
  if (m === 7) return '七月';
  if (m === 8) return '八月';
  if (m === 9) return '九月';
  if (m === 10) return '十月';
  if (m === 11) return '十一月';
  return '十二月';
}

/**
 * 设计稿风格的日组标题："今天 · 五月十四  星期四" / "五月十二  星期二"。
 */
function formatGroupHeading(dayKey: string): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const today = new Date();
  const isToday =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  const cnDate = `${chineseMonth(m)}${chineseDay(d)}`;
  const weekday = `星期${CN_WEEKDAYS[date.getDay()]}`;
  return isToday ? `今天 · ${cnDate}  ${weekday}` : `${cnDate}  ${weekday}`;
}

/**
 * 详情页 meta 行的日期格式："2026 · 05 · 14 · THU"。
 */
function dayLabelForDetail(dayKey: string): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const weekday = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][date.getDay()];
  const mm = String(m).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  return `${y} · ${mm} · ${dd} · ${weekday}`;
}

/**
 * 不同日记卡的 washi tape 颜色（按 entry index 循环）。
 */
const WASHI_TAPE_COLORS = ['#fbe3a8', '#f4b5b5', '#c5e4d0', '#d6c7f0', '#b8d4ec'];

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
  const [draftMood, setDraftMood] = useState('');
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
    setDraftMood('');
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
      if (r.mood) setDraftMood(r.mood);
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
      const mood = draftMood.trim() || undefined;
      const row = await appendJournalEntry(ownerAgentId, { title, body, mood });
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
        {listError ? (
          <p className={styles.phoneAppHint} role="alert">
            加载失败：{listError}
          </p>
        ) : null}
        {listLoading && entries.length === 0 ? <p className={styles.phoneAppHint}>加载中…</p> : null}

        {!selected ? (
          <div className={styles.phoneJournalLayout}>
            <div aria-hidden className={styles.phoneJournalPaperTexture} />
            <header className={styles.phoneJournalPageHeader}>
              <div className={styles.phoneJournalKicker}>JOURNAL · 日记本</div>
              <h2 className={styles.phoneJournalPageTitle}>{ta} 的日记</h2>
            </header>

            {grouped.length === 0 && !listLoading ? (
              <p className={styles.phoneJournalEmpty} data-testid="phone-journal-empty">
                还没有日记。点右下角「记」添加一条记录（写入当前角色目录，刷新或重启后仍在）。
              </p>
            ) : null}
            {grouped.length > 0
              ? grouped.map(([dayKey, list]) => (
                  <div key={dayKey} className={styles.phoneJournalGroup}>
                    <div className={styles.phoneJournalGroupLabel}>
                      <span aria-hidden className={styles.phoneJournalGroupDash} />
                      <span>{formatGroupHeading(dayKey)}</span>
                    </div>
                    <div className={styles.phoneJournalGroupCards}>
                      {list.map((e, idx) => {
                        const tapeColor = WASHI_TAPE_COLORS[idx % WASHI_TAPE_COLORS.length];
                        const slant = idx % 2 === 0 ? styles.phoneJournalCardSlant0 : styles.phoneJournalCardSlant1;
                        return (
                          <button
                            key={e.id}
                            type="button"
                            className={`${styles.phoneJournalCard} ${slant}`}
                            onClick={() => setSelectedId(e.id)}
                          >
                            <span aria-hidden className={styles.phoneJournalTape} style={{ background: tapeColor }} />
                            <div className={styles.phoneJournalCardHead}>
                              <h4 className={styles.phoneJournalCardTitle}>{e.title}</h4>
                              {e.mood ? (
                                <span
                                  className={styles.phoneJournalMoodChip}
                                  data-testid={`phone-journal-mood-${e.id}`}
                                >
                                  「{e.mood}」
                                </span>
                              ) : null}
                            </div>
                            <p className={styles.phoneJournalCardExcerpt}>{excerptForJournalList(e.body)}</p>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))
              : null}

            <button
              type="button"
              className={styles.phoneJournalWaxSealButton}
              onClick={openCompose}
              disabled={listLoading}
              aria-label="写日记"
            >
              记
            </button>
          </div>
        ) : (
          <div className={styles.phoneJournalDetail}>
            <div aria-hidden className={styles.phoneJournalDetailRules} />
            <p className={styles.phoneJournalDetailMeta}>{dayLabelForDetail(selected.dayKey)}</p>
            <h2 className={styles.phoneJournalDetailTitle}>{selected.title}</h2>
            {selected.mood ? (
              <p className={styles.phoneJournalMoodChip} data-testid="phone-journal-detail-mood">
                「{selected.mood}」
              </p>
            ) : null}
            <div className={styles.phoneJournalDetailBodyScroll}>
              <pre className={styles.phoneJournalDetailBody}>{selected.body}</pre>
            </div>
            <div aria-hidden className={styles.phoneJournalInkStamp}>
              {ta}
              <br />
              之印
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
              <label className={styles.phoneFormField}>
                <span>心情</span>
                <input
                  value={draftMood}
                  onChange={(e) => setDraftMood(e.target.value)}
                  placeholder="2–6 字短语，如「平淡 / 想他 / 安静」（可选）"
                  maxLength={24}
                  data-testid="phone-journal-mood-input"
                />
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
