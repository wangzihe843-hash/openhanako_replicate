import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Agent } from '../types';
import styles from './XingyeShell.module.css';
import { generateScheduleDraftWithAI } from './xingye-schedule-ai';
import {
  appendScheduleEntry,
  deleteScheduleEntry,
  listScheduleEntries,
  updateScheduleEntryStatus,
  type XingyeScheduleEntry,
  type XingyeScheduleSource,
  type XingyeScheduleStatus,
} from './xingye-schedule-store';
import type { XingyeRoleProfile } from './xingye-profile-store';

export interface PhoneScheduleAppProps {
  ownerAgent: Agent | null;
  ownerProfile: XingyeRoleProfile | null | undefined;
  displayName: string;
  onBack: () => void;
}

const STATUS_LABELS: Record<XingyeScheduleStatus, string> = {
  planned: '计划中',
  done: '已完成',
  skipped: '已跳过',
};

const WEEKDAYS_CN = ['日', '一', '二', '三', '四', '五', '六'];
const MONTHS_CN = [
  '一月', '二月', '三月', '四月', '五月', '六月',
  '七月', '八月', '九月', '十月', '十一月', '十二月',
];

/**
 * 客户端把 category 字符串映射到 iOS 系统色调色板。category 缺失时回退到红色，
 * 表示「未分类」，与设计稿一致。
 */
const CATEGORY_BAR_COLOR: Record<string, string> = {
  约定: '#ff9500',
  提醒: '#34c759',
  自己定的: '#007aff',
  也许吧: '#af52de',
  平常: '#8e8e93',
};
const CATEGORY_BAR_FALLBACK = '#ff3b30';

function todayDateLabel(): string {
  return '今天';
}

function buildDateStrip(today: Date, daysBefore = 2, daysAfter = 4): Date[] {
  const out: Date[] = [];
  for (let i = -daysBefore; i <= daysAfter; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    out.push(d);
  }
  return out;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function shortDateLabel(d: Date): string {
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function fullMonthHeader(d: Date): string {
  return `${d.getFullYear()}年 ${MONTHS_CN[d.getMonth()]}`;
}

function dateKickerLine(d: Date): string {
  return `${shortDateLabel(d)} · 周${WEEKDAYS_CN[d.getDay()]}`;
}

function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function addDays(d: Date, n: number): Date {
  const out = startOfDay(d);
  out.setDate(out.getDate() + n);
  return out;
}

function ymdKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 把自由格式的 dateLabel（"今天"/"明早"/"5月14日"/"2026年5月14日"/...）尽力解析成一个真实日期。
 * 解析不出来的（例如"下次去诊所前"）返回 null，渲染时会保留原文并归到末尾分组。
 */
function parseDateLabel(label: string, today: Date): Date | null {
  const trimmed = label.trim();
  if (!trimmed) return null;
  if (/^(今天|今早|今晚|今夜|今日|今儿)/.test(trimmed)) return startOfDay(today);
  if (/^(明天|明早|明晚|明日)/.test(trimmed)) return addDays(today, 1);
  if (/^后天/.test(trimmed)) return addDays(today, 2);
  if (/^(昨天|昨晚|昨日)/.test(trimmed)) return addDays(today, -1);
  if (/^前天/.test(trimmed)) return addDays(today, -2);
  const m = trimmed.match(/(?:(\d{4})年\s*)?(\d{1,2})月(\d{1,2})日/);
  if (m) {
    const y = m[1] ? Number(m[1]) : today.getFullYear();
    return new Date(y, Number(m[2]) - 1, Number(m[3]));
  }
  return null;
}

function relativeGroupHeader(parsed: Date, today: Date): string {
  const t0 = startOfDay(today).getTime();
  const diff = Math.round((startOfDay(parsed).getTime() - t0) / 86400000);
  const md = shortDateLabel(parsed);
  if (diff === 0) return `今天 · ${md}`;
  if (diff === 1) return `明天 · ${md}`;
  if (diff === -1) return `昨天 · ${md}`;
  if (diff === 2) return `后天 · ${md}`;
  if (diff === -2) return `前天 · ${md}`;
  if (diff > 0 && diff <= 6) return `周${WEEKDAYS_CN[parsed.getDay()]} · ${md}`;
  return md;
}

function excerpt(text: string, max = 64): string {
  const one = text.replace(/\s+/g, ' ').trim();
  if (one.length <= max) return one;
  return `${one.slice(0, Math.max(1, max - 1))}…`;
}

function emptyDraft(dateLabel: string) {
  return {
    title: '',
    dateLabel,
    timeText: '',
    content: '',
    note: '',
    source: 'manual' as XingyeScheduleSource,
    status: 'planned' as XingyeScheduleStatus,
  };
}

export function PhoneScheduleApp({ ownerAgent, ownerProfile, displayName, onBack }: PhoneScheduleAppProps) {
  const ownerAgentId = ownerAgent?.id ?? '';
  const [entries, setEntries] = useState<XingyeScheduleEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [draft, setDraft] = useState(() => emptyDraft(todayDateLabel()));
  const [userIntent, setUserIntent] = useState('');
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [statusBusy, setStatusBusy] = useState<XingyeScheduleStatus | null>(null);

  const reloadEntries = useCallback(async () => {
    if (!ownerAgentId) {
      setEntries([]);
      return;
    }
    setLoading(true);
    setListError(null);
    try {
      const rows = await listScheduleEntries(ownerAgentId);
      setEntries(rows);
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [ownerAgentId]);

  useEffect(() => {
    setSelectedId(null);
    setComposeOpen(false);
    setSaveError(null);
    setAiError(null);
  }, [ownerAgentId]);

  useEffect(() => {
    void reloadEntries();
  }, [reloadEntries]);

  const selected = useMemo(
    () => (selectedId ? entries.find((entry) => entry.id === selectedId) ?? null : null),
    [entries, selectedId],
  );

  /**
   * 把 entries 按 dateLabel 原文聚合成分组，并解析出参考日期，用于排序与红点指示。
   * - 解析成功：按真实日期升序（过去 → 今天 → 未来）
   * - 解析失败（"下次去诊所前" 这类自由文本）：放到末尾，保留原文标题
   * - 即使今天没有 entry，也保留一个"今天"空分组以呈现"这一天还没有安排"提示
   */
  const today = useMemo(() => new Date(), []);
  const todayKey = useMemo(() => ymdKey(today), [today]);
  const dayGroups = useMemo(() => {
    const map = new Map<
      string,
      { dateLabel: string; entries: XingyeScheduleEntry[]; parsed: Date | null }
    >();
    for (const entry of entries) {
      const existing = map.get(entry.dateLabel);
      if (existing) {
        existing.entries.push(entry);
      } else {
        map.set(entry.dateLabel, {
          dateLabel: entry.dateLabel,
          entries: [entry],
          parsed: parseDateLabel(entry.dateLabel, today),
        });
      }
    }
    const hasTodayGroup = Array.from(map.values()).some(
      (g) => g.parsed && ymdKey(g.parsed) === todayKey,
    );
    if (!hasTodayGroup) {
      map.set('__today__', { dateLabel: todayDateLabel(), entries: [], parsed: startOfDay(today) });
    }
    return Array.from(map.values()).sort((a, b) => {
      if (a.parsed && b.parsed) return a.parsed.getTime() - b.parsed.getTime();
      if (a.parsed) return -1;
      if (b.parsed) return 1;
      return a.dateLabel.localeCompare(b.dateLabel);
    });
  }, [entries, today, todayKey]);

  // 顶部日期条上有 entry 的日期需要显示红点；按真实日期 ymd key 匹配。
  const stripDotKeys = useMemo(() => {
    const set = new Set<string>();
    for (const group of dayGroups) {
      if (group.parsed && group.entries.length > 0) set.add(ymdKey(group.parsed));
    }
    return set;
  }, [dayGroups]);

  const openCompose = () => {
    setDraft(emptyDraft(todayDateLabel()));
    setUserIntent('');
    setSaveError(null);
    setAiError(null);
    setComposeOpen(true);
  };

  const updateDraft = (patch: Partial<typeof draft>) => {
    setDraft((prev) => ({ ...prev, ...patch }));
  };

  const handleGenerateDraft = async () => {
    if (!ownerAgent) return;
    setAiBusy(true);
    setAiError(null);
    try {
      const result = await generateScheduleDraftWithAI({
        agent: ownerAgent,
        ownerProfile,
        userIntent: userIntent.trim(),
      });
      setDraft({
        title: result.title,
        dateLabel: result.dateLabel,
        timeText: result.timeText ?? '',
        content: result.content,
        note: result.note ?? '',
        source: 'ai',
        status: result.status,
      });
    } catch (err) {
      setAiError(err instanceof Error ? err.message : String(err));
    } finally {
      setAiBusy(false);
    }
  };

  const saveCompose = async () => {
    if (!ownerAgentId) return;
    setSaveBusy(true);
    setSaveError(null);
    try {
      const row = await appendScheduleEntry(ownerAgentId, {
        title: draft.title,
        dateLabel: draft.dateLabel,
        timeText: draft.timeText,
        content: draft.content,
        note: draft.note,
        source: draft.source,
        status: draft.status,
      });
      setEntries((prev) => [row, ...prev.filter((item) => item.id !== row.id)]);
      setSelectedId(row.id);
      setComposeOpen(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaveBusy(false);
    }
  };

  const handleDeleteSelected = async () => {
    if (!selected || !ownerAgentId) return;
    if (!window.confirm('确定删除这条日程？此操作不可恢复。')) return;
    setDeleteBusy(true);
    try {
      const ok = await deleteScheduleEntry(ownerAgentId, selected.id);
      if (ok) {
        setEntries((prev) => prev.filter((entry) => entry.id !== selected.id));
        setSelectedId(null);
      } else {
        await reloadEntries();
      }
    } finally {
      setDeleteBusy(false);
    }
  };

  const handleUpdateStatus = async (status: XingyeScheduleStatus) => {
    if (!selected || !ownerAgentId) return;
    setStatusBusy(status);
    try {
      const updated = await updateScheduleEntryStatus(ownerAgentId, selected.id, status);
      if (updated) {
        setEntries((prev) => prev.map((entry) => (entry.id === updated.id ? updated : entry)));
      } else {
        await reloadEntries();
      }
    } finally {
      setStatusBusy(null);
    }
  };

  if (!ownerAgentId) {
    return (
      <div className={styles.phoneShell} aria-label="日程">
        <div className={styles.phoneStatusBar}>
          <button type="button" className={styles.phoneBackButton} onClick={onBack}>
            返回首页
          </button>
          <span>日程</span>
        </div>
        <div className={styles.phoneBody}>
          <section className={styles.phoneAppCard}>
            <h3 className={styles.phoneAppTitle}>日程不可用</h3>
            <p className={styles.phoneAppHint}>未选择角色。日程必须写入当前角色的 agent-scoped 星野目录。</p>
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.phoneShell} aria-label="日程">
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
        <span>日程</span>
      </div>

      <div className={styles.phoneBody}>
        {listError ? (
          <p className={styles.phoneAppHint} role="alert">
            加载失败：{listError}
          </p>
        ) : null}
        {loading && entries.length === 0 ? <p className={styles.phoneAppHint}>加载中…</p> : null}

        {!selected ? (
          <div className={styles.scheduleLayout}>
            <div className={styles.scheduleMonthHeader}>
              <div className={styles.scheduleMonthDate}>{dateKickerLine(today)}</div>
              <h1 className={styles.scheduleMonthTitle}>{fullMonthHeader(today)}</h1>
            </div>

            <div className={styles.scheduleCalendarStrip} aria-label="日期条">
              {buildDateStrip(today).map((d) => {
                const isToday = sameDay(d, today);
                const hasDot = stripDotKeys.has(ymdKey(d));
                const klass = `${styles.scheduleCalendarDay}${isToday ? ` ${styles.scheduleCalendarDayToday}` : ''}`;
                return (
                  <div key={d.toISOString()} className={klass}>
                    <span className={styles.scheduleCalendarDayLabel}>{WEEKDAYS_CN[d.getDay()]}</span>
                    <span className={styles.scheduleCalendarDayNumber}>{d.getDate()}</span>
                    <span
                      className={`${styles.scheduleCalendarDayDot}${hasDot ? ` ${styles.scheduleCalendarDayDotActive}` : ''}`}
                      aria-hidden
                    />
                  </div>
                );
              })}
            </div>

            <div className={styles.scheduleScrollArea}>
              {dayGroups.map((group) => {
                const headerText = group.parsed ? relativeGroupHeader(group.parsed, today) : group.dateLabel;
                const isTodayGroup = Boolean(group.parsed && ymdKey(group.parsed) === todayKey);
                return (
                  <div
                    key={group.parsed ? ymdKey(group.parsed) : `lbl:${group.dateLabel}`}
                    className={styles.scheduleDaySection}
                    aria-label={`${group.dateLabel} 日程`}
                  >
                    <div className={styles.scheduleDaySectionLabel}>{headerText}</div>
                    {group.entries.length === 0 && !loading ? (
                      <p
                        className={styles.scheduleDayEmpty}
                        data-testid={isTodayGroup ? 'phone-schedule-empty' : undefined}
                      >
                        这一天还没有安排
                      </p>
                    ) : null}
                    {group.entries.map((entry) => {
                      const isDone = entry.status === 'done';
                      const isSkipped = entry.status === 'skipped';
                      const barColor = (entry.category && CATEGORY_BAR_COLOR[entry.category]) || CATEGORY_BAR_FALLBACK;
                      const timeText = entry.timeText?.trim() || '全天';
                      const tagText = entry.category || STATUS_LABELS[entry.status];
                      const rowClass = [
                        styles.scheduleEventRow,
                        isDone ? styles.scheduleEventRowDone : '',
                        isSkipped ? styles.scheduleEventRowSkipped : '',
                      ]
                        .filter(Boolean)
                        .join(' ');
                      return (
                        <button
                          key={entry.id}
                          type="button"
                          className={rowClass}
                          aria-label={`${entry.title}，${STATUS_LABELS[entry.status]}`}
                          onClick={() => setSelectedId(entry.id)}
                        >
                          <span className={styles.scheduleEventTimeBlock}>
                            <span className={styles.scheduleEventTime}>{timeText}</span>
                            {entry.note ? <span className={styles.scheduleEventDuration}>{excerpt(entry.note, 16)}</span> : null}
                          </span>
                          <span className={styles.scheduleEventBar} style={{ background: barColor }} />
                          <span className={styles.scheduleEventBody}>
                            <span className={styles.scheduleEventTitle}>{entry.title}</span>
                            <span className={styles.scheduleEventTag}>{tagText}</span>
                          </span>
                          <span
                            className={`${styles.scheduleEventCheck}${isDone ? ` ${styles.scheduleEventCheckDone}` : ''}`}
                            aria-hidden
                          >
                            {isDone ? '✓' : ''}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>

            <button
              type="button"
              className={styles.scheduleFab}
              onClick={openCompose}
              disabled={loading}
              aria-label="新建日程"
            >
              +
            </button>
          </div>
        ) : (
          <div className={styles.phoneJournalDetail}>
            <p className={styles.phoneJournalDetailMeta}>
              {selected.dateLabel}{selected.timeText ? ` · ${selected.timeText}` : ''} · {STATUS_LABELS[selected.status]}
            </p>
            <h3 className={styles.phoneAppTitle} style={{ margin: 0 }}>
              {selected.title}
            </h3>
            <div className={styles.phoneJournalDetailBodyScroll}>
              <pre className={styles.phoneJournalDetailBody}>{selected.content}</pre>
              {selected.note ? <p className={styles.scheduleDetailNote}>{selected.note}</p> : null}
            </div>
            <div className={styles.scheduleStatusActions}>
              {(Object.keys(STATUS_LABELS) as XingyeScheduleStatus[]).map((status) => (
                <button
                  key={status}
                  type="button"
                  className={selected.status === status ? styles.scheduleStatusButtonActive : styles.phoneModalGhostButton}
                  disabled={Boolean(statusBusy)}
                  onClick={() => void handleUpdateStatus(status)}
                >
                  {statusBusy === status ? '更新中…' : STATUS_LABELS[status]}
                </button>
              ))}
            </div>
            <div style={{ marginTop: 12 }}>
              <button
                type="button"
                className={styles.phoneModalGhostButton}
                onClick={() => void handleDeleteSelected()}
                disabled={deleteBusy}
              >
                {deleteBusy ? '删除中…' : '删除这条日程'}
              </button>
            </div>
          </div>
        )}
      </div>

      {composeOpen ? (
        <div
          className={styles.phoneModalOverlay}
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setComposeOpen(false);
          }}
        >
          <div className={styles.phoneModalSheet} role="dialog" aria-modal="true" aria-labelledby="phone-schedule-compose-title">
            <h3 id="phone-schedule-compose-title" className={styles.phoneModalTitle}>
              新建日程
            </h3>
            <div className={styles.phoneModalBody}>
              <label className={styles.phoneFormField}>
                <span>日程意图</span>
                <textarea
                  value={userIntent}
                  onChange={(event) => setUserIntent(event.target.value)}
                  rows={2}
                  placeholder="可选：想从最近聊天里整理什么安排"
                />
              </label>
              <button
                type="button"
                className={styles.phoneModalGhostButton}
                onClick={() => void handleGenerateDraft()}
                disabled={aiBusy || saveBusy}
              >
                {aiBusy ? '生成中…' : '根据最近聊天生成'}
              </button>
              {aiError ? (
                <p className={styles.phoneAppHint} role="alert">
                  {aiError}
                </p>
              ) : null}
              <label className={styles.phoneFormField}>
                <span>标题</span>
                <input value={draft.title} onChange={(event) => updateDraft({ title: event.target.value, source: draft.source })} />
              </label>
              <label className={styles.phoneFormField}>
                <span>日期</span>
                <input value={draft.dateLabel} onChange={(event) => updateDraft({ dateLabel: event.target.value })} placeholder="今天 / 明天上午 / 下次去诊所前" />
              </label>
              <label className={styles.phoneFormField}>
                <span>时间</span>
                <input value={draft.timeText} onChange={(event) => updateDraft({ timeText: event.target.value })} placeholder="可选" />
              </label>
              <label className={styles.phoneFormField}>
                <span>内容</span>
                <textarea value={draft.content} onChange={(event) => updateDraft({ content: event.target.value })} rows={4} />
              </label>
              <label className={styles.phoneFormField}>
                <span>备注</span>
                <textarea value={draft.note} onChange={(event) => updateDraft({ note: event.target.value })} rows={2} />
              </label>
              {saveError ? (
                <p className={styles.phoneAppHint} role="alert">
                  {saveError}
                </p>
              ) : null}
            </div>
            <div className={styles.phoneModalActions}>
              <button type="button" className={styles.phoneModalGhostButton} onClick={() => setComposeOpen(false)} disabled={saveBusy || aiBusy}>
                取消
              </button>
              <button type="button" className={styles.phoneJournalPrimaryButton} onClick={() => void saveCompose()} disabled={saveBusy || aiBusy}>
                {saveBusy ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
