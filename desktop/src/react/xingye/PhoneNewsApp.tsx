import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Agent } from '../types';
import styles from './XingyeShell.module.css';
import {
  appendAppEntry,
  deleteAppEntry,
  listAppEntries,
  type AppEntry,
} from './xingye-app-entry-store';
import {
  flattenNewsMetadataToContent,
  normalizeNewsEntryMetadata,
  type NewsEntryMetadata,
} from './xingye-news-types';
import { generateNewsDraftWithAI } from './xingye-news-ai';
import type { XingyeRoleProfile } from './xingye-profile-store';

export interface PhoneNewsAppProps {
  ownerAgent: Agent | null;
  ownerProfile?: XingyeRoleProfile | null;
  displayName: string;
  onBack: () => void;
}

type NewsEntry = AppEntry & {
  appId: 'news';
  metadata: NewsEntryMetadata;
};

const NEWS_APP_ID = 'news';

function normalizeNewsEntry(entry: AppEntry): NewsEntry | null {
  const meta = normalizeNewsEntryMetadata(entry.metadata);
  if (!meta) return null;
  return { ...entry, appId: 'news', metadata: meta };
}

function formatIssueDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}年${String(d.getMonth() + 1).padStart(2, '0')}月${String(d.getDate()).padStart(2, '0')}日`;
}

function excerpt(text: string, max = 60): string {
  const one = text.replace(/\s+/g, ' ').trim();
  if (one.length <= max) return one;
  return `${one.slice(0, Math.max(1, max - 1))}…`;
}

export function PhoneNewsApp({ ownerAgent, ownerProfile, displayName, onBack }: PhoneNewsAppProps) {
  const ownerAgentId = ownerAgent?.id ?? '';
  const [entries, setEntries] = useState<NewsEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [userIntent, setUserIntent] = useState('');
  const [showIntentBox, setShowIntentBox] = useState(false);

  const reload = useCallback(async () => {
    if (!ownerAgentId) {
      setEntries([]);
      return;
    }
    setLoading(true);
    setMessage(null);
    try {
      const rows = await listAppEntries(ownerAgentId, NEWS_APP_ID);
      const normalized = rows
        .map(normalizeNewsEntry)
        .filter((e): e is NewsEntry => Boolean(e))
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      setEntries(normalized);
    } catch (err) {
      setMessage(`加载失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }, [ownerAgentId]);

  useEffect(() => {
    setSelectedId(null);
    setUserIntent('');
    setShowIntentBox(false);
    void reload();
  }, [ownerAgentId, reload]);

  const selected = useMemo(
    () => entries.find((e) => e.id === selectedId) ?? null,
    [entries, selectedId],
  );

  const handleGenerate = async () => {
    if (!ownerAgent || generating) return;
    setGenerating(true);
    setMessage(null);
    try {
      const issueDateIso = new Date().toISOString();
      const meta = await generateNewsDraftWithAI({
        agent: ownerAgent,
        ownerProfile: ownerProfile ?? null,
        userIntent: userIntent.trim() || undefined,
        issueDateIso,
      });
      const content = flattenNewsMetadataToContent(meta);
      const entry = await appendAppEntry(ownerAgentId, NEWS_APP_ID, {
        title: meta.masthead,
        content,
        source: 'user_generated',
        metadata: meta as unknown as Record<string, unknown>,
      });
      const normalized = normalizeNewsEntry(entry);
      if (normalized) {
        setEntries((prev) => [normalized, ...prev.filter((e) => e.id !== normalized.id)]);
        setSelectedId(normalized.id);
      }
      setUserIntent('');
      setShowIntentBox(false);
    } catch (err) {
      setMessage(`生成失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setGenerating(false);
    }
  };

  const handleDelete = async (entry: NewsEntry) => {
    if (!ownerAgentId) return;
    if (!window.confirm(`确定删除这期《${entry.metadata.masthead}》？`)) return;
    try {
      const ok = await deleteAppEntry(ownerAgentId, NEWS_APP_ID, entry.id);
      if (ok) {
        setEntries((prev) => prev.filter((e) => e.id !== entry.id));
        if (selectedId === entry.id) setSelectedId(null);
      } else {
        await reload();
      }
    } catch (err) {
      setMessage(`删除失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  if (!ownerAgentId) {
    return (
      <div className={styles.phoneShell} aria-label="报纸">
        <div className={styles.phoneStatusBar}>
          <button type="button" className={styles.phoneBackButton} onClick={onBack}>返回首页</button>
          <span>报纸</span>
        </div>
        <div className={styles.phoneBody}>
          <section className={styles.phoneAppCard}>
            <h3 className={styles.phoneAppTitle}>报纸不可用</h3>
            <p className={styles.phoneAppHint}>请选择有效角色后再打开报纸。</p>
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.phoneShell} aria-label="报纸">
      <div className={styles.phoneStatusBar}>
        {selected ? (
          <button type="button" className={styles.phoneBackButton} onClick={() => setSelectedId(null)}>返回列表</button>
        ) : (
          <button type="button" className={styles.phoneBackButton} onClick={onBack}>返回首页</button>
        )}
        <span>报纸</span>
      </div>

      <div className={styles.phoneBody}>
        {message ? <p className={styles.phoneAppHint} role="alert">{message}</p> : null}

        {selected ? (
          <section
            aria-label="报纸详情"
            data-testid="phone-news-detail"
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 16,
              padding: '16px 12px',
              background: '#f7f1e1',
              color: '#1d1a14',
              fontFamily: 'Georgia, "Source Han Serif SC", "Noto Serif SC", serif',
              border: '1px solid #d4c8a8',
            }}
          >
            <header style={{ borderBottom: '2px solid #1d1a14', paddingBottom: 8 }}>
              <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700, letterSpacing: 2 }}>
                {selected.metadata.masthead}
              </h2>
              <p style={{ margin: '4px 0 0', fontSize: 12, opacity: 0.7 }}>
                {formatIssueDate(selected.metadata.issueDate)}
              </p>
            </header>

            {selected.metadata.sections.map((section, idx) => (
                <article
                  key={`${section.kind}-${idx}`}
                  data-testid={`phone-news-section-${section.kind}`}
                  style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
                >
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                    <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{section.title}</h3>
                    {section.byline ? (
                      <small style={{ fontSize: 11, opacity: 0.55 }}>{section.byline}</small>
                    ) : null}
                  </div>
                  <p
                    style={{
                      margin: 0,
                      fontSize: 14,
                      lineHeight: 1.7,
                      whiteSpace: 'pre-wrap',
                      textIndent: '2em',
                    }}
                  >
                    {section.body}
                  </p>
                </article>
              ))}

            <footer style={{ display: 'flex', gap: 8, paddingTop: 8 }}>
              <button
                type="button"
                className={styles.phoneShortcutButton}
                onClick={() => handleDelete(selected)}
              >
                删除本期
              </button>
            </footer>
          </section>
        ) : (
          <section aria-label="报纸列表" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <header style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <p className={styles.phoneAppHint} style={{ margin: 0 }}>NEWS</p>
              <h2 style={{ margin: 0, fontSize: 18 }}>{displayName || ownerAgent?.name || 'TA'} 的小报</h2>
              <p className={styles.phoneAppHint} style={{ margin: 0 }}>
                第三方报刊视角的世界与感情速报。每期 2–4 个板块，由模型一次性生成，不需要外部图片。
              </p>
            </header>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {showIntentBox ? (
                <label className={styles.phoneFormField}>
                  <span>今天想读什么（可空，给模型一句话提示）</span>
                  <input
                    type="text"
                    value={userIntent}
                    onChange={(e) => setUserIntent(e.target.value)}
                    placeholder="例：写一期偏向都市夜生活的、感情专栏可以更暧昧一点"
                    disabled={generating}
                    data-testid="phone-news-intent-input"
                  />
                </label>
              ) : null}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className={styles.phonePrimaryAction}
                  onClick={() => void handleGenerate()}
                  disabled={generating}
                  data-testid="phone-news-generate"
                >
                  {generating ? '正在排版本期…' : '生成今日报纸'}
                </button>
                <button
                  type="button"
                  className={styles.phoneShortcutButton}
                  onClick={() => setShowIntentBox((v) => !v)}
                  disabled={generating}
                >
                  {showIntentBox ? '收起提示' : '加一句提示'}
                </button>
              </div>
            </div>

            {loading && entries.length === 0 ? (
              <p className={styles.phoneAppHint}>加载中…</p>
            ) : entries.length === 0 ? (
              <p className={styles.phoneJournalEmpty} data-testid="phone-news-empty">
                还没有任何一期。点「生成今日报纸」让模型出一期。
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {entries.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    className={styles.phoneReadingCard}
                    onClick={() => setSelectedId(entry.id)}
                    data-testid={`phone-news-card-${entry.id}`}
                    style={{ textAlign: 'left' }}
                  >
                    <strong>{entry.metadata.masthead}</strong>
                    <span>{formatIssueDate(entry.metadata.issueDate)} · {entry.metadata.sections.length} 个板块</span>
                    <small>{excerpt(entry.metadata.sections[0]?.body ?? '')}</small>
                  </button>
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
