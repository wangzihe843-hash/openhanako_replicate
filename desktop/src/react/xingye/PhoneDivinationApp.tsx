import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Agent } from '../types';
import styles from './XingyeShell.module.css';
import divStyles from './PhoneDivinationApp.module.css';
import {
  DIVINATION_METHODS,
  getDivinationMethodLabel,
  isDivinationMethodId,
  resolveRecommendedDivinationMethod,
  type DivinationResolverResolveContextHint,
  type XingyeDivinationAgentLike,
  type XingyeDivinationMethodId,
  type XingyeRecommendedDivinationMethod,
} from './xingye-divination-method-resolver';
import type { XingyeRoleProfile } from './xingye-profile-store';
import { buildDivinationResolverContext } from './xingye-divination-resolver-context';
import { XINGYE_LORE_ENTRIES_CHANGED_EVENT } from './xingye-lore-store';
import {
  appendDivinationEntry,
  deleteDivinationEntry,
  getDivinationEntryAgentTopic,
  getDivinationEntryUserThemeHint,
  loadDivinationEntries,
  type DivinationEntry,
} from './xingye-app-entry-store';
import {
  confirmDivinationDraft,
  discardDivinationDraft,
  listDivinationDrafts,
  type XingyePendingDivinationDraft,
} from './xingye-divination-drafts';
import {
  sanitizeDivinationReadingContent,
  summarizeDivinationContextSources,
  titleForDivinationEntry,
} from './phone-divination-narrative';
import { generateDivinationReadingWithAI } from './xingye-divination-ai';
import { parseDivinationReading } from './phone-divination-parse';
import { getDivinationTheme } from './xingye-divination-themes';
import './xingye-divination-fonts';

export interface PhoneDivinationAppProps {
  ownerAgent: Agent | null;
  ownerProfile: XingyeRoleProfile | null | undefined;
  displayName: string;
  onBack: () => void;
}

const SYMBOL_POOL = ['☰', '☱', '☲', '☳', '☴', '☵', '☶', '☷', '⚊', '⚋', '✦', '◇', '◈', '※'];

function zeroScoresRecord(): XingyeRecommendedDivinationMethod['scores'] {
  return {
    iching_liuyao: 0,
    tarot: 0,
    crystal_ball: 0,
    runes: 0,
    astrology: 0,
    field_oracle: 0,
    oracle_generic: 0,
  };
}

function divinationRecommendationPlaceholder(): XingyeRecommendedDivinationMethod {
  return {
    method: 'oracle_generic',
    methodLabel: getDivinationMethodLabel('oracle_generic'),
    autoSelected: false,
    resolverReason: '正在读取角色资料，用于占法推荐…',
    matchedSignals: [],
    scores: zeroScoresRecord(),
  };
}

function pickRandomSymbols(count: number): string[] {
  const n = Math.min(Math.max(count, 3), 8);
  const out: string[] = [];
  const buf = new Uint32Array(n);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(buf);
  } else {
    for (let i = 0; i < n; i += 1) buf[i] = Math.floor(Math.random() * 0xffffffff);
  }
  for (let i = 0; i < n; i += 1) {
    out.push(SYMBOL_POOL[buf[i]! % SYMBOL_POOL.length]!);
  }
  return out;
}

function excerptReason(text: string, max = 160): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(1, max - 1))}…`;
}

export function PhoneDivinationApp({ ownerAgent, ownerProfile, displayName, onBack }: PhoneDivinationAppProps) {
  const ownerAgentId = ownerAgent?.id ?? '';
  const ta = displayName || ownerAgent?.name || 'TA';

  const [ctxAgentLike, setCtxAgentLike] = useState<XingyeDivinationAgentLike | null>(null);
  const [ctxHint, setCtxHint] = useState<DivinationResolverResolveContextHint>({
    contextLength: 0,
    contextSources: [],
    loreSkippedDisabledCount: 0,
    enabledLoreTitlesInCorpus: [],
    profileOnlyNoEnabledLore: true,
  });
  const [ctxBusy, setCtxBusy] = useState(false);
  const [loreRefreshTick, setLoreRefreshTick] = useState(0);
  const [debouncedThemeHint, setDebouncedThemeHint] = useState('');
  const manualMethodOverrideRef = useRef(false);

  const [entries, setEntries] = useState<DivinationEntry[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [themeHint, setThemeHint] = useState('');
  const [methodId, setMethodId] = useState<XingyeDivinationMethodId>('oracle_generic');
  const [generateBusy, setGenerateBusy] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  /** 待确认草稿（心跳巡检产出的「心象提示」）。 */
  const [pendingDrafts, setPendingDrafts] = useState<XingyePendingDivinationDraft[]>([]);
  const [draftEdits, setDraftEdits] = useState<
    Record<string, { agentQuestion: string; content: string; themeHint: string }>
  >({});
  const [draftBusyId, setDraftBusyId] = useState<string | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedThemeHint(themeHint.trim()), 380);
    return () => window.clearTimeout(t);
  }, [themeHint]);

  useEffect(() => {
    const bump = () => setLoreRefreshTick((n) => n + 1);
    if (typeof window === 'undefined') return undefined;
    window.addEventListener(XINGYE_LORE_ENTRIES_CHANGED_EVENT, bump);
    window.addEventListener('xingye-persistence-changed', bump);
    return () => {
      window.removeEventListener(XINGYE_LORE_ENTRIES_CHANGED_EVENT, bump);
      window.removeEventListener('xingye-persistence-changed', bump);
    };
  }, []);

  useLayoutEffect(() => {
    if (!ownerAgentId) {
      setCtxAgentLike(null);
      setCtxHint({
        contextLength: 0,
        contextSources: [],
        loreSkippedDisabledCount: 0,
        enabledLoreTitlesInCorpus: [],
        profileOnlyNoEnabledLore: true,
      });
      setCtxBusy(false);
      return;
    }
    let cancelled = false;
    setCtxBusy(true);
    void buildDivinationResolverContext(ownerAgentId, ownerAgent, ownerProfile ?? null, {
      divinationQuestion: debouncedThemeHint,
    }).then((built) => {
      if (cancelled) return;
      if (built) {
        setCtxAgentLike(built.agentLike);
        setCtxHint({
          contextLength: built.contextLength,
          contextSources: built.contextSources,
          loreSkippedDisabledCount: built.loreSkippedDisabledCount,
          enabledLoreTitlesInCorpus: built.enabledLoreTitlesInCorpus,
          profileOnlyNoEnabledLore: built.profileOnlyNoEnabledLore,
        });
      } else {
        setCtxAgentLike({ name: ownerAgent?.name, yuan: ownerAgent?.yuan });
        setCtxHint({
          contextLength: 0,
          contextSources: ['(build_failed)'],
          loreSkippedDisabledCount: 0,
          enabledLoreTitlesInCorpus: [],
          profileOnlyNoEnabledLore: true,
        });
      }
      setCtxBusy(false);
    });
    return () => {
      cancelled = true;
    };
  }, [
    ownerAgentId,
    ownerAgent?.id,
    ownerAgent?.name,
    ownerAgent?.yuan,
    ownerProfile?.updatedAt,
    ownerProfile?.agentId,
    debouncedThemeHint,
    loreRefreshTick,
  ]);

  const recommendation = useMemo(() => {
    if (!ownerAgentId) return resolveRecommendedDivinationMethod(null);
    if (ctxBusy || !ctxAgentLike) return divinationRecommendationPlaceholder();
    return resolveRecommendedDivinationMethod(ctxAgentLike, ctxHint);
  }, [ownerAgentId, ctxBusy, ctxAgentLike, ctxHint]);

  const generationMethodId: XingyeDivinationMethodId = manualMethodOverrideRef.current
    ? methodId
    : recommendation.method;
  const generationTheme = getDivinationTheme(generationMethodId);

  useEffect(() => {
    manualMethodOverrideRef.current = false;
  }, [ownerAgentId]);

  useEffect(() => {
    if (!ownerAgentId || ctxBusy || !ctxAgentLike) return;
    if (manualMethodOverrideRef.current) return;
    setMethodId(resolveRecommendedDivinationMethod(ctxAgentLike, ctxHint).method);
  }, [ownerAgentId, ctxBusy, ctxAgentLike, ctxHint]);

  const reloadEntries = useCallback(async () => {
    if (!ownerAgentId) {
      setEntries([]);
      setPendingDrafts([]);
      setDraftEdits({});
      return;
    }
    setListLoading(true);
    setListError(null);
    try {
      const [rows, drafts] = await Promise.all([
        loadDivinationEntries(ownerAgentId),
        listDivinationDrafts(ownerAgentId),
      ]);
      const sorted = [...rows].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      setEntries(sorted);
      setPendingDrafts(drafts);
    } catch (e) {
      setListError(e instanceof Error ? e.message : String(e));
    } finally {
      setListLoading(false);
    }
  }, [ownerAgentId]);

  const draftWorkingValue = useCallback(
    (d: XingyePendingDivinationDraft) => {
      const edit = draftEdits[d.id];
      if (edit) return edit;
      return {
        agentQuestion: d.agentQuestion,
        content: d.content,
        themeHint: d.themeHint ?? '',
      };
    },
    [draftEdits],
  );

  const handleDraftFieldChange = (
    draftId: string,
    patch: Partial<{ agentQuestion: string; content: string; themeHint: string }>,
  ) => {
    setDraftEdits((prev) => {
      const d = pendingDrafts.find((entry) => entry.id === draftId);
      if (!d) return prev;
      const base = prev[draftId] ?? {
        agentQuestion: d.agentQuestion,
        content: d.content,
        themeHint: d.themeHint ?? '',
      };
      return { ...prev, [draftId]: { ...base, ...patch } };
    });
  };

  const handleConfirmDraft = async (d: XingyePendingDivinationDraft) => {
    if (!ownerAgentId) return;
    setDraftBusyId(d.id);
    setDraftError(null);
    try {
      const working = draftWorkingValue(d);
      await confirmDivinationDraft(ownerAgentId, d.id, {
        agentQuestion: working.agentQuestion,
        content: working.content,
        themeHint: working.themeHint.trim() ? working.themeHint : null,
      });
      /** entry list 直接 reload 一遍——entry 形态是 DivinationEntry，借用 loadDivinationEntries 的 normalize。 */
      await reloadEntries();
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

  const handleDiscardDraft = async (d: XingyePendingDivinationDraft) => {
    if (!ownerAgentId) return;
    if (!window.confirm('确定丢弃这条待确认占卜（心象）草稿？此操作不可恢复，但角色可在下次巡检里重新提议。')) return;
    setDraftBusyId(d.id);
    setDraftError(null);
    try {
      const ok = await discardDivinationDraft(ownerAgentId, d.id);
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
    setGenerateError(null);
    setListError(null);
  }, [ownerAgentId]);

  useEffect(() => {
    void reloadEntries();
  }, [reloadEntries]);

  const selected = useMemo(
    () => (selectedId ? entries.find((e) => e.id === selectedId) ?? null : null),
    [entries, selectedId],
  );

  const applyRecommended = () => {
    manualMethodOverrideRef.current = false;
    setMethodId(recommendation.method);
  };

  const handleGenerate = async () => {
    if (!ownerAgentId || !ownerAgent || !ctxAgentLike) return;
    const userTheme = themeHint.trim();
    setGenerateBusy(true);
    setGenerateError(null);
    try {
      const effectiveMethodId = manualMethodOverrideRef.current ? methodId : recommendation.method;
      const contextSummary = summarizeDivinationContextSources(ctxHint.contextSources);
      const symbols = pickRandomSymbols(5);
      const methodLabel = getDivinationMethodLabel(effectiveMethodId);
      const reading = await generateDivinationReadingWithAI({
        agent: ownerAgent,
        methodId: effectiveMethodId,
        methodLabel,
        symbols,
        agentLike: ctxAgentLike,
        userProvidedTheme: userTheme || undefined,
        resolverReason: recommendation.resolverReason,
      });
      const fallbackTitle = titleForDivinationEntry(effectiveMethodId, reading.agentQuestion);
      const row = await appendDivinationEntry(ownerAgentId, {
        title: reading.title || fallbackTitle,
        content: reading.content,
        metadata: {
          method: effectiveMethodId,
          methodLabel,
          question: reading.agentQuestion,
          agentQuestion: reading.agentQuestion,
          userProvidedTheme: userTheme || undefined,
          symbols,
          autoSelected: effectiveMethodId === recommendation.method,
          resolverReason: recommendation.resolverReason,
          contextSummary,
        },
      });
      setEntries((prev) => [row, ...prev.filter((p) => p.id !== row.id)]);
      setSelectedId(row.id);
      setThemeHint('');
    } catch (e) {
      setGenerateError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerateBusy(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!ownerAgentId) return;
    if (!window.confirm('确定删除这条占卜记录？此操作不可恢复。')) return;
    setDeleteBusy(true);
    try {
      const ok = await deleteDivinationEntry(ownerAgentId, id);
      if (ok) {
        setEntries((prev) => prev.filter((e) => e.id !== id));
        if (selectedId === id) setSelectedId(null);
      } else {
        await reloadEntries();
      }
    } finally {
      setDeleteBusy(false);
    }
  };

  const methodFromEntry = (entry: DivinationEntry): XingyeDivinationMethodId | null => {
    if (isDivinationMethodId(entry.metadata.method)) return entry.metadata.method;
    const legacy = (entry.metadata as Record<string, unknown>).methodId;
    return isDivinationMethodId(legacy) ? legacy : null;
  };

  if (!ownerAgentId) {
    return (
      <div className={styles.phoneShell} aria-label="占卜">
        <div className={styles.phoneStatusBar}>
          <button type="button" className={styles.phoneBackButton} onClick={onBack}>
            返回首页
          </button>
          <span>占卜</span>
        </div>
        <div className={styles.phoneBody}>
          <section className={styles.phoneAppCard}>
            <h3 className={styles.phoneAppTitle}>占卜不可用</h3>
            <p className={styles.phoneAppHint}>未选择角色。占卜记录写入当前角色在 HANA_HOME 下的星野目录。</p>
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.phoneShell} aria-label="占卜">
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
        <span>占卜</span>
      </div>

      <div className={styles.phoneBody}>
        <p className={styles.mmChatIntro}>
          <strong>{ta} 的占卜本</strong>：由 TA 自己在小手机里起占、写下此刻想确认的事；这是 TA 的私有 app。你可留一句
          <strong>可选关注方向</strong>（不是替 TA 发问）。生成后这里只显示可直接阅读的占卜正文；推荐占法可手动切换。
        </p>
        {ctxBusy ? <p className={styles.phoneAppHint}>正在读取角色资料…</p> : null}
        {listError ? (
          <p className={styles.phoneAppHint} role="alert">
            加载失败：{listError}
          </p>
        ) : null}

        {!selected ? (
          <>
            <section
              className={`${styles.phoneAppCard} ${divStyles.generationCard} ${generationTheme.className ?? ''}`.trim()}
              aria-label="起卦"
              data-divination-theme={generationMethodId}
            >
              <h3 className={styles.phoneAppTitle} style={{ marginTop: 0 }}>
                {generationTheme.generationLabel}
              </h3>
              <p className={styles.phoneAppHint}>
                推荐：<strong>{recommendation.methodLabel}</strong>
                {methodId !== recommendation.method ? (
                  <button type="button" className={styles.phoneModalGhostButton} style={{ marginLeft: 8 }} onClick={applyRecommended}>
                    采用推荐
                  </button>
                ) : null}
              </p>
              <label className={styles.phoneFormField}>
                <span>占法</span>
                <select
                  value={methodId}
                  onChange={(e) => {
                    manualMethodOverrideRef.current = true;
                    setMethodId(e.target.value as XingyeDivinationMethodId);
                  }}
                  aria-label="选择占法"
                >
                  {DIVINATION_METHODS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>
              <p className={styles.phoneAppHint} style={{ fontSize: '0.82rem', lineHeight: 1.55 }}>
                TA 此刻想确认的那句话由 TA 自己生成；下方输入框<strong>不是</strong>替 TA 发问，只是可选的关注方向。
              </p>
              <label className={styles.phoneFormField}>
                <span>可选关注方向（占卜主题）</span>
                <textarea
                  value={themeHint}
                  onChange={(e) => setThemeHint(e.target.value)}
                  rows={3}
                  data-testid="phone-divination-theme-hint"
                  placeholder="可选：给 TA 一个关注方向，不填则由 TA 自己决定"
                  aria-label="可选关注方向（不是替 TA 问卜）"
                />
              </label>
              {generateError ? (
                <p className={styles.phoneAppHint} role="alert">
                  {generateError}
                </p>
              ) : null}
              <button
                type="button"
                className={styles.phoneJournalPrimaryButton}
                data-testid="phone-divination-generate"
                aria-label={`${generationTheme.generationButtonLabel}并生成占卜记录`}
                onClick={() => void handleGenerate()}
                disabled={generateBusy || ctxBusy}
              >
                {generateBusy ? '生成中…' : generationTheme.generationButtonLabel}
              </button>
            </section>

            {pendingDrafts.length > 0 ? (
              <section
                aria-label="待确认占卜（心象）草稿"
                data-testid="phone-divination-pending-drafts"
                style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
              >
                <p className={styles.phoneAppHint}>
                  待确认草稿 · 来自心跳巡检（心象提示）。这是 TA 在巡检里写下的直觉读出——
                  **不是正式占卜**，没有抽符、没有出卦。点「确认生成」后会和正式占卜并列出现在
                  下方历史记录里（卡片会标为「心象提示」）；离开页面再回来不会丢草稿。
                </p>
                {draftError ? (
                  <p className={styles.phoneAppHint} role="alert">{draftError}</p>
                ) : null}
                {pendingDrafts.map((d) => {
                  const working = draftWorkingValue(d);
                  const busy = draftBusyId === d.id;
                  return (
                    <div
                      key={d.id}
                      className={styles.phoneAppCard}
                      style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 6 }}
                      data-testid={`phone-divination-draft-${d.id}`}
                    >
                      <label className={styles.phoneFormField}>
                        <span>TA 此刻在问</span>
                        <textarea
                          value={working.agentQuestion}
                          onChange={(e) => handleDraftFieldChange(d.id, { agentQuestion: e.target.value })}
                          rows={2}
                          aria-label="待确认心象草稿—agentQuestion"
                          data-testid={`phone-divination-draft-question-${d.id}`}
                          disabled={busy}
                        />
                      </label>
                      <label className={styles.phoneFormField}>
                        <span>心象（TA 自己写下的直觉读出）</span>
                        <textarea
                          value={working.content}
                          onChange={(e) => handleDraftFieldChange(d.id, { content: e.target.value })}
                          rows={5}
                          aria-label="待确认心象草稿—content"
                          data-testid={`phone-divination-draft-content-${d.id}`}
                          disabled={busy}
                        />
                      </label>
                      <label className={styles.phoneFormField}>
                        <span>主题（可选）</span>
                        <input
                          type="text"
                          value={working.themeHint}
                          onChange={(e) => handleDraftFieldChange(d.id, { themeHint: e.target.value })}
                          placeholder="如「关系」「工作」「等待」"
                          aria-label="待确认心象草稿—主题"
                          data-testid={`phone-divination-draft-theme-${d.id}`}
                          disabled={busy}
                        />
                      </label>
                      {d.reason ? (
                        <p className={styles.phoneAppHint} style={{ margin: 0 }}>理由：{d.reason}</p>
                      ) : null}
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <button
                          type="button"
                          className={styles.phoneJournalPrimaryButton}
                          onClick={() => void handleConfirmDraft(d)}
                          disabled={busy}
                          data-testid={`phone-divination-draft-confirm-${d.id}`}
                        >
                          {busy ? '处理中…' : '确认生成'}
                        </button>
                        <button
                          type="button"
                          className={styles.phoneModalGhostButton}
                          onClick={() => void handleDiscardDraft(d)}
                          disabled={busy}
                          data-testid={`phone-divination-draft-discard-${d.id}`}
                        >
                          丢弃
                        </button>
                      </div>
                    </div>
                  );
                })}
              </section>
            ) : null}

            <div className={styles.phoneJournalLayout}>
              <div className={styles.phoneJournalToolbar}>
                <p className={styles.phoneSectionTitle} style={{ margin: 0 }}>
                  历史记录
                </p>
              </div>
              {listLoading && entries.length === 0 ? <p className={styles.phoneAppHint}>加载中…</p> : null}
              {entries.length === 0 && !listLoading ? (
                <p className={styles.phoneJournalEmpty} data-testid="phone-divination-empty">
                  还没有占卜记录。{generationTheme.emptyCtaLabel}
                </p>
              ) : null}
              {entries.map((e) => {
                const mid = methodFromEntry(e);
                const sub = mid ? getDivinationMethodLabel(mid) : '占卜';
                const topic = excerptReason(getDivinationEntryAgentTopic(e.metadata), 36);
                const rowTheme = getDivinationTheme(mid);
                return (
                  <div key={e.id} className={styles.phoneDivinationRow}>
                    <span
                      aria-hidden="true"
                      className={`${divStyles.listBar} ${rowTheme.listBarClassName ?? ''}`.trim()}
                      data-divination-theme={mid ?? 'unknown'}
                    />
                    <button type="button" className={styles.phoneJournalCard} onClick={() => setSelectedId(e.id)}>
                      <p className={styles.phoneJournalCardTitle}>{e.title}</p>
                      <p className={styles.phoneJournalCardExcerpt}>
                        <span className={`${divStyles.listChip} ${rowTheme.listChipClassName ?? ''}`.trim()}>
                          {rowTheme.listChipLabel}
                        </span>
                        {topic ? `TA：${topic} · ` : ''}
                        {sub} · {new Date(e.createdAt).toLocaleString('zh-CN')}
                      </p>
                    </button>
                    <button
                      type="button"
                      className={styles.phoneDivinationRowDelete}
                      aria-label={`删除 ${e.title}`}
                      disabled={deleteBusy}
                      onClick={() => void handleDelete(e.id)}
                    >
                      删除
                    </button>
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          (() => {
            const selectedMethodId = methodFromEntry(selected);
            const detailTheme = getDivinationTheme(selectedMethodId);
            const agentTopic = getDivinationEntryAgentTopic(selected.metadata);
            const userTh = getDivinationEntryUserThemeHint(selected.metadata);
            const sanitized = sanitizeDivinationReadingContent(selected.content);
            const parsed = parseDivinationReading(sanitized);
            const signLabel = parsed.signLabel ?? detailTheme.signSectionLabel;
            const symbols = Array.isArray(selected.metadata?.symbols)
              ? selected.metadata.symbols.filter((x): x is string => typeof x === 'string')
              : [];
            const hasAnySection = Boolean(
              parsed.title || parsed.signFlavor || parsed.body || parsed.actionSign,
            );
            return (
              <div
                className={`${styles.phoneJournalDetail} ${detailTheme.className ?? ''}`.trim()}
                data-divination-theme={selectedMethodId ?? 'unknown'}
              >
                <p className={styles.phoneJournalDetailMeta}>
                  {selectedMethodId ? getDivinationMethodLabel(selectedMethodId) : '占卜'} ·{' '}
                  {new Date(selected.createdAt).toLocaleString('zh-CN')}
                </p>
                <p className={styles.phoneAppHint} style={{ fontSize: '0.82rem', lineHeight: 1.55 }}>
                  {selected.metadata.autoSelected ? '占问时采用推荐占法。' : '占问时采用手动所选占法。'}
                </p>
                {agentTopic ? (
                  <p className={styles.phoneAppHint}>
                    TA 想确认的事：「{agentTopic}」
                  </p>
                ) : null}
                {userTh ? (
                  <p className={styles.phoneAppHint} style={{ fontSize: '0.82rem' }}>
                    记录中的可选关注方向：「{userTh}」（不等同于占问主体）
                  </p>
                ) : null}
                {symbols.length > 0 ? (
                  <p
                    className={styles.phoneAppHint}
                    style={{ letterSpacing: '0.15em' }}
                    data-symbols
                  >
                    {symbols.join(' ')}
                  </p>
                ) : null}
                {hasAnySection ? (
                  <div className={divStyles.sectionList} data-testid="phone-divination-sections">
                    <section
                      className={`${divStyles.section} ${divStyles.sectionTitle}`}
                      data-divination-section="title"
                    >
                      <p className={divStyles.sectionHeader}>标题</p>
                      <p className={divStyles.sectionBody}>{parsed.title ?? selected.title}</p>
                    </section>
                    {parsed.signFlavor ? (
                      <section
                        className={`${divStyles.section} ${divStyles.sectionSign}`}
                        data-divination-section="sign"
                      >
                        <p className={divStyles.sectionHeader}>{signLabel}</p>
                        <p className={divStyles.sectionBody}>{parsed.signFlavor}</p>
                      </section>
                    ) : null}
                    {parsed.body ? (
                      <section
                        className={`${divStyles.section} ${divStyles.sectionBodyText}`}
                        data-divination-section="body"
                      >
                        <p className={divStyles.sectionHeader}>正文</p>
                        <p className={divStyles.sectionBody}>{parsed.body}</p>
                      </section>
                    ) : null}
                    {parsed.actionSign ? (
                      <section
                        className={`${divStyles.section} ${divStyles.sectionAction}`}
                        data-divination-section="action"
                      >
                        <p className={divStyles.sectionHeader}>{parsed.actionLabel ?? detailTheme.actionSectionLabel}</p>
                        <p className={divStyles.sectionBody}>{parsed.actionSign}</p>
                      </section>
                    ) : null}
                    {parsed.lead && !parsed.body ? (
                      <section
                        className={`${divStyles.section} ${divStyles.sectionBodyText}`}
                        data-divination-section="lead"
                      >
                        <p className={divStyles.sectionHeader}>叙事</p>
                        <p className={divStyles.sectionBody}>{parsed.lead}</p>
                      </section>
                    ) : null}
                  </div>
                ) : (
                  <div className={styles.phoneJournalDetailBodyScroll}>
                    <pre className={styles.phoneJournalDetailBody}>{sanitized}</pre>
                  </div>
                )}
                <div style={{ marginTop: 12 }}>
                  <button
                    type="button"
                    className={styles.phoneModalGhostButton}
                    onClick={() => void handleDelete(selected.id)}
                    disabled={deleteBusy}
                  >
                    {deleteBusy ? '删除中…' : '删除此条'}
                  </button>
                </div>
              </div>
            );
          })()
        )}
      </div>
    </div>
  );
}
