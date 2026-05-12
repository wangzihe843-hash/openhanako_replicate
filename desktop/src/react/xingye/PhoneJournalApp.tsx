import { useMemo, useState } from 'react';
import type { Agent } from '../types';
import styles from './XingyeShell.module.css';

export interface PhoneJournalAppProps {
  ownerAgent: Agent | null;
  displayName: string;
  onBack: () => void;
}

interface JournalEntryMock {
  id: string;
  /** ISO 日期（本地日界线按浏览器时区） */
  dayKey: string;
  title: string;
  body: string;
}

/** 纯前端 mock：默认空列表以展示空状态；可通过「写日记」添加条目（仅存页面内存） */
const PHONE_JOURNAL_SEED: JournalEntryMock[] = [];

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

export function PhoneJournalApp({ ownerAgent, displayName, onBack }: PhoneJournalAppProps) {
  const [entries, setEntries] = useState<JournalEntryMock[]>(() => [...PHONE_JOURNAL_SEED]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftBody, setDraftBody] = useState('');

  const selected = useMemo(
    () => (selectedId ? entries.find((e) => e.id === selectedId) ?? null : null),
    [entries, selectedId],
  );

  const grouped = useMemo(() => {
    const map = new Map<string, JournalEntryMock[]>();
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
    setComposeOpen(true);
  };

  const saveCompose = () => {
    const title = draftTitle.trim() || '无标题';
    const body = draftBody.trim();
    if (!body) {
      return;
    }
    const now = new Date();
    const dayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const id = `local-${now.getTime()}`;
    setEntries((prev) => [{ id, dayKey, title, body }, ...prev]);
    setComposeOpen(false);
    setSelectedId(id);
  };

  return (
    <div className={styles.phoneShell} aria-label="日记（文本 mock）">
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
          <strong>{ta} 的日记本</strong>：纯文本占位，数据仅存于当前页面内存；不自动生成、不写工作区。
        </p>

        {!selected ? (
          <div className={styles.phoneJournalLayout}>
            <div className={styles.phoneJournalToolbar}>
              <p className={styles.phoneSectionTitle} style={{ margin: 0 }}>
                按日期分组
              </p>
              <button type="button" className={styles.phoneJournalPrimaryButton} onClick={openCompose}>
                写日记
              </button>
            </div>

            {grouped.length === 0 ? (
              <p className={styles.phoneJournalEmpty} data-testid="phone-journal-empty">
                还没有日记。点「写日记」添加一条纯文本记录（仅本页展示用 mock）。
              </p>
            ) : (
              grouped.map(([dayKey, list]) => (
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
                      <p className={styles.phoneJournalCardExcerpt}>{e.body}</p>
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
        ) : (
          <div className={styles.phoneJournalDetail}>
            <p className={styles.phoneJournalDetailMeta}>{dayLabelForDetail(selected.dayKey)}</p>
            <h3 className={styles.phoneAppTitle} style={{ margin: 0 }}>
              {selected.title}
            </h3>
            <p className={styles.phoneJournalDetailBody}>{selected.body}</p>
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
              写日记（mock）
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
            </div>
            <div className={styles.phoneModalActions}>
              <button type="button" className={styles.phoneModalGhostButton} onClick={() => setComposeOpen(false)}>
                取消
              </button>
              <button type="button" className={styles.phoneJournalPrimaryButton} onClick={saveCompose}>
                保存到本页
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
