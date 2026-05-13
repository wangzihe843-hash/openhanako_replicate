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

function todayDateLabel(): string {
  return '今天';
}

function uniqueDateLabels(entries: XingyeScheduleEntry[]): string[] {
  const seen = new Set<string>();
  const labels = [todayDateLabel()];
  seen.add(todayDateLabel());
  for (const entry of entries) {
    if (!seen.has(entry.dateLabel)) {
      labels.push(entry.dateLabel);
      seen.add(entry.dateLabel);
    }
  }
  return labels;
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
  const [selectedDateLabel, setSelectedDateLabel] = useState(todayDateLabel());
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
    setSelectedDateLabel(todayDateLabel());
  }, [ownerAgentId]);

  useEffect(() => {
    void reloadEntries();
  }, [reloadEntries]);

  useEffect(() => {
    if (entries.length === 0) return;
    if (entries.some((entry) => entry.dateLabel === selectedDateLabel)) return;
    setSelectedDateLabel(entries[0].dateLabel);
  }, [entries, selectedDateLabel]);

  const dateLabels = useMemo(() => uniqueDateLabels(entries), [entries]);
  const selected = useMemo(
    () => (selectedId ? entries.find((entry) => entry.id === selectedId) ?? null : null),
    [entries, selectedId],
  );
  const entriesForSelectedDate = useMemo(
    () => entries.filter((entry) => entry.dateLabel === selectedDateLabel),
    [entries, selectedDateLabel],
  );
  const ta = displayName || ownerAgent?.name || 'TA';

  const openCompose = () => {
    setDraft(emptyDraft(selectedDateLabel));
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
      setSelectedDateLabel(result.dateLabel);
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
      setSelectedDateLabel(row.dateLabel);
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
        <p className={styles.mmChatIntro}>
          <strong>{ta} 的日程</strong>：普通手机安排记录，保存在{' '}
          <code className={styles.inlineCode}>xingye/schedule/entries.jsonl</code>；不触发提醒、通知或后台任务。
        </p>
        {listError ? (
          <p className={styles.phoneAppHint} role="alert">
            加载失败：{listError}
          </p>
        ) : null}
        {loading && entries.length === 0 ? <p className={styles.phoneAppHint}>加载中…</p> : null}

        {!selected ? (
          <div className={styles.scheduleLayout}>
            <div className={styles.scheduleToolbar}>
              <div className={styles.scheduleTodayBlock}>
                <span className={styles.scheduleTodayKicker}>今天</span>
                <strong>{selectedDateLabel}</strong>
              </div>
              <button type="button" className={styles.phoneJournalPrimaryButton} onClick={openCompose} disabled={loading}>
                新建
              </button>
            </div>

            <div className={styles.scheduleDateStrip} aria-label="日期条">
              {dateLabels.map((label) => (
                <button
                  key={label}
                  type="button"
                  className={`${styles.scheduleDateChip}${label === selectedDateLabel ? ` ${styles.scheduleDateChipActive}` : ''}`}
                  onClick={() => setSelectedDateLabel(label)}
                >
                  {label === todayDateLabel() ? <span>今天</span> : null}
                  <strong>{label}</strong>
                </button>
              ))}
            </div>

            <div className={styles.scheduleGroup} role="list" aria-label={`${selectedDateLabel} 日程`}>
              {entriesForSelectedDate.length === 0 && !loading ? (
                <p className={styles.phoneJournalEmpty} data-testid="phone-schedule-empty">
                  这一天还没有安排
                </p>
              ) : null}
              {entriesForSelectedDate.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className={styles.scheduleCard}
                  aria-label={`${entry.title}，${STATUS_LABELS[entry.status]}`}
                  onClick={() => setSelectedId(entry.id)}
                >
                  <span className={styles.scheduleCardTime}>{entry.timeText || entry.dateLabel}</span>
                  <span className={styles.scheduleCardMain}>
                    <strong>{entry.title}</strong>
                    <span>{entry.note ? excerpt(entry.note, 72) : excerpt(entry.content, 72)}</span>
                  </span>
                  <span className={`${styles.scheduleStatusPill} ${styles[`scheduleStatus_${entry.status}`]}`}>
                    {STATUS_LABELS[entry.status]}
                  </span>
                </button>
              ))}
            </div>
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
