import { useCallback, useEffect, useState } from 'react';
import type { Agent } from '../types';
import type { XingyeRoleProfileDisplay } from './xingye-profile-store';
import {
  collectRecentContextForAgent,
  describeRecentContextForPrompt,
} from './xingye-recent-context';
import {
  generateRelationshipStateSuggestion,
  type XingyeRelationshipStateSuggestion,
} from './xingye-state-ai';
import { appendXingyeEventOnce } from './xingye-event-log';
import {
  resetRelationshipState,
  updateRelationshipState,
  useRelationshipState,
  type XingyeRelationshipState,
  type XingyeRelationshipStateHistoryItem,
} from './xingye-state-store';
import {
  confirmRelationshipStateDraft,
  discardRelationshipStateDraft,
  listRelationshipStateDrafts,
  type XingyePendingRelationshipStateDraft,
} from './xingye-relationship-state-drafts';
import styles from './XingyeShell.module.css';

interface RelationshipStatePanelProps {
  agent: Agent;
  profile: Partial<XingyeRoleProfileDisplay>;
}

type RelationshipSuggestionWithEventId = XingyeRelationshipStateSuggestion & {
  suggestionId: string;
};

const METRICS: Array<{
  key: keyof Pick<XingyeRelationshipStateSuggestion, 'affectionDelta' | 'trustDelta' | 'loyaltyDelta' | 'jealousyDelta' | 'corruptionDelta'>;
  label: string;
  stateKey: 'affection' | 'trust' | 'loyalty' | 'jealousy' | 'corruption';
  min: number;
  max: number;
}> = [
  { key: 'affectionDelta', label: '好感度', stateKey: 'affection', min: -100, max: 150 },
  { key: 'trustDelta', label: '信任', stateKey: 'trust', min: -100, max: 100 },
  { key: 'loyaltyDelta', label: '忠诚', stateKey: 'loyalty', min: -100, max: 100 },
  { key: 'jealousyDelta', label: '醋意', stateKey: 'jealousy', min: 0, max: 100 },
  { key: 'corruptionDelta', label: '黑化值', stateKey: 'corruption', min: 0, max: 100 },
];

function formatDelta(value: number): string {
  if (value > 0) return `+${value}`;
  return String(value);
}

function formatUpdatedAt(value: string): string {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function createSuggestionId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `rs-suggestion-${crypto.randomUUID()}`;
  }
  return `rs-suggestion-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function summarizeRelationshipState(state: XingyeRelationshipState) {
  return {
    affection: state.affection,
    trust: state.trust,
    loyalty: state.loyalty,
    jealousy: state.jealousy,
    corruption: state.corruption,
    mood: state.mood,
    relationshipKey: state.relationshipKey,
    relationshipLabel: state.relationshipLabel,
    updatedAt: state.updatedAt,
  };
}

function summarizeReason(reason: string): string {
  return reason.replace(/\s+/g, ' ').trim().slice(0, 180);
}

function getAppliedFields(suggestion: XingyeRelationshipStateSuggestion): string[] {
  const fields: string[] = [];
  if (suggestion.affectionDelta) fields.push('affectionDelta');
  if (suggestion.trustDelta) fields.push('trustDelta');
  if (suggestion.loyaltyDelta) fields.push('loyaltyDelta');
  if (suggestion.jealousyDelta) fields.push('jealousyDelta');
  if (suggestion.corruptionDelta) fields.push('corruptionDelta');
  if (suggestion.mood) fields.push('mood');
  if (suggestion.stateSummary) fields.push('stateSummary');
  if (suggestion.reason) fields.push('reason');
  return fields;
}

function appendRelationshipStateEventBestEffort(
  agentId: string,
  input: Parameters<typeof appendXingyeEventOnce>[1],
  dedupeKey: string,
) {
  void appendXingyeEventOnce(agentId, input, dedupeKey).catch((error) => {
    console.warn('[RelationshipStatePanel] failed to append Xingye event:', error);
  });
}

function RelationshipHistoryCard({ state }: { state: XingyeRelationshipStateHistoryItem }) {
  return (
    <details className={styles.relationshipHistoryCard} aria-label={`旧状态 ${state.mood}`}>
      <summary>
        <span>旧状态</span>
        <strong>{state.mood}</strong>
        <small>{formatUpdatedAt(state.updatedAt)}</small>
      </summary>
      <div className={styles.relationshipHistoryBody}>
        <div className={styles.relationshipInfoGrid}>
          <div className={styles.relationshipInfoItem}>
            <span>关系阶段</span>
            <strong>{state.relationshipLabel}</strong>
          </div>
          <div className={styles.relationshipInfoItem}>
            <span>好感度</span>
            <strong>{state.affection}</strong>
          </div>
          <div className={styles.relationshipInfoItem}>
            <span>信任</span>
            <strong>{state.trust}</strong>
          </div>
          <div className={styles.relationshipInfoItem}>
            <span>忠诚</span>
            <strong>{state.loyalty}</strong>
          </div>
        </div>
        <div className={styles.relationshipTextBlock}>
          <span>状态摘要</span>
          <p>{state.stateSummary || '暂无状态摘要。'}</p>
        </div>
        <div className={styles.relationshipTextBlock}>
          <span>变化原因</span>
          <p>{state.lastReason || '暂无变化原因。'}</p>
        </div>
      </div>
    </details>
  );
}

export function RelationshipStatePanel({ agent, profile }: RelationshipStatePanelProps) {
  const relationshipState = useRelationshipState(agent.id, profile);
  const [suggestion, setSuggestion] = useState<RelationshipSuggestionWithEventId | null>(null);
  const [refreshState, setRefreshState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [debugOpen, setDebugOpen] = useState(false);
  const [pendingDrafts, setPendingDrafts] = useState<XingyePendingRelationshipStateDraft[]>([]);
  const [draftBusyId, setDraftBusyId] = useState<string | null>(null);

  const reloadDrafts = useCallback(async () => {
    try {
      const rows = await listRelationshipStateDrafts(agent.id);
      setPendingDrafts(rows);
    } catch {
      setPendingDrafts([]);
    }
  }, [agent.id]);

  useEffect(() => {
    void reloadDrafts();
  }, [reloadDrafts]);

  const handleConfirmDraft = useCallback(async (draftId: string) => {
    setDraftBusyId(draftId);
    setError(null);
    try {
      await confirmRelationshipStateDraft(agent.id, draftId);
      await reloadDrafts();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDraftBusyId(null);
    }
  }, [agent.id, reloadDrafts]);

  const handleDiscardDraft = useCallback(async (draftId: string) => {
    if (typeof window !== 'undefined' && !window.confirm('确定丢弃这条心跳巡检提议的关系状态草稿？此操作不可恢复，但角色可在下次巡检里重新提议。')) {
      return;
    }
    setDraftBusyId(draftId);
    setError(null);
    try {
      await discardRelationshipStateDraft(agent.id, draftId);
      await reloadDrafts();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDraftBusyId(null);
    }
  }, [agent.id, reloadDrafts]);

  if (!relationshipState) return null;

  const handleRefresh = async () => {
    setRefreshState('loading');
    setError(null);
    setSuggestion(null);
    try {
      const recentContext = collectRecentContextForAgent({ agentId: agent.id });
      const recentChatSummary = describeRecentContextForPrompt(recentContext);
      const sourceNotes = [...recentContext.sourceNotes];
      const nextSuggestion = await generateRelationshipStateSuggestion({
        agent,
        profile,
        state: relationshipState,
        recentChatSummary,
        sourceNotes,
        trigger: 'manual_refresh',
      });
      const suggestionId = createSuggestionId();
      setSuggestion({ ...nextSuggestion, suggestionId });
      appendRelationshipStateEventBestEffort(agent.id, {
        type: 'relationship_state.suggested',
        source: 'RelationshipStatePanel',
        subjectId: relationshipState.targetId,
        payload: {
          suggestionId,
          mood: nextSuggestion.mood,
          affectionDelta: nextSuggestion.affectionDelta,
          trustDelta: nextSuggestion.trustDelta,
          loyaltyDelta: nextSuggestion.loyaltyDelta,
          jealousyDelta: nextSuggestion.jealousyDelta,
          corruptionDelta: nextSuggestion.corruptionDelta,
          reasonSummary: summarizeReason(nextSuggestion.reason),
          recentContextCount: sourceNotes.length,
        },
      }, `relationship_state.suggested:${agent.id}:${suggestionId}`);
      setRefreshState('idle');
    } catch (err) {
      setRefreshState('error');
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleAccept = () => {
    if (!suggestion) return;
    const previous = relationshipState;
    const next = updateRelationshipState(agent.id, suggestion);
    appendRelationshipStateEventBestEffort(agent.id, {
      type: 'relationship_state.applied',
      source: 'RelationshipStatePanel',
      subjectId: next.targetId,
      payload: {
        suggestionId: suggestion.suggestionId,
        previous: summarizeRelationshipState(previous),
        next: summarizeRelationshipState(next),
        appliedFields: getAppliedFields(suggestion),
      },
    }, `relationship_state.applied:${agent.id}:${suggestion.suggestionId}:${next.updatedAt}`);
    setSuggestion(null);
    setError(null);
  };

  const handleReject = () => {
    setSuggestion(null);
    setError(null);
  };

  const handleReset = () => {
    resetRelationshipState(agent.id, profile);
    setSuggestion(null);
    setError(null);
  };

  return (
    <section className={styles.detailSection} aria-label="TA 当前状态">
      <div className={styles.relationshipStateHeader}>
        <div>
          <h3 className={styles.detailSectionTitle}>TA 当前状态</h3>
          <p className={styles.relationshipStateHint}>仅记录当前角色对 user 的态度与自身心情。</p>
        </div>
        <button
          type="button"
          className={styles.secondaryButton}
          onClick={handleRefresh}
          disabled={refreshState === 'loading'}
        >
          {refreshState === 'loading' ? '生成建议中...' : '手动刷新状态'}
        </button>
      </div>

      <div className={styles.relationshipStateBody}>
        <div className={styles.relationshipMoodHero} aria-label="此刻心情">
          <span aria-hidden className={styles.relationshipMoodHeroBloom} />
          <div className={styles.relationshipMoodHeroKicker}>NOW · 此刻 / 心情</div>
          <div className={styles.relationshipMoodHeroMood}>
            {relationshipState.mood || '——'}
          </div>
          {relationshipState.stateSummary ? (
            <div className={styles.relationshipMoodHeroSummary}>
              —— {relationshipState.stateSummary}
            </div>
          ) : null}
        </div>

        <div className={styles.relationshipStageCard}>
          <span>关系阶段</span>
          <strong>{relationshipState.relationshipLabel}</strong>
          <small>{relationshipState.relationshipKey}</small>
        </div>
        <div className={styles.relationshipMetricGrid}>
          {METRICS.map((metric) => {
            const value = relationshipState[metric.stateKey];
            const percent = ((value - metric.min) / (metric.max - metric.min)) * 100;
            return (
              <div className={styles.relationshipMetric} key={metric.stateKey}>
                <div>
                  <span>{metric.label}</span>
                  <strong>{value}</strong>
                </div>
                <div className={styles.relationshipMetricTrack} aria-hidden="true">
                  <i style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
                </div>
              </div>
            );
          })}
        </div>

        <div className={styles.relationshipInfoGrid}>
          <div className={styles.relationshipInfoItem}>
            <span>更新时间</span>
            <strong>{formatUpdatedAt(relationshipState.updatedAt)}</strong>
          </div>
        </div>

        <div className={styles.relationshipTextBlock}>
          <span>状态摘要</span>
          <p>{relationshipState.stateSummary || '暂无状态摘要。'}</p>
        </div>
        <div className={styles.relationshipTextBlock}>
          <span>上次变化原因</span>
          <p>{relationshipState.lastReason || '暂无变化原因。'}</p>
        </div>

        {error && <div className={styles.relationshipError}>状态建议生成失败：{error}</div>}

        {pendingDrafts.length > 0 ? (
          <section
            className={styles.relationshipSuggestion}
            style={{ borderLeft: '3px solid #ffb84a' }}
            data-testid="relationship-state-pending-drafts"
            aria-label="待确认草稿 · 来自心跳巡检"
          >
            <div className={styles.relationshipSuggestionHeader}>
              <strong>待确认草稿 · 来自心跳巡检</strong>
              <span>这是 TA 主动提议的状态变化，应用后才会落到本地</span>
            </div>
            {pendingDrafts.map((d) => {
              const deltaItems = METRICS
                .map((metric) => ({ metric, delta: d[metric.key] }))
                .filter(({ delta }) => delta !== 0);
              return (
                <div
                  key={d.id}
                  style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 8 }}
                  data-testid={`relationship-state-draft-row-${d.id}`}
                >
                  {deltaItems.length > 0 ? (
                    <div className={styles.relationshipDeltaGrid}>
                      {deltaItems.map(({ metric, delta }) => (
                        <div key={metric.key} aria-label={`${metric.label} 建议变化 ${formatDelta(delta)}`}>
                          <span>{metric.label} 建议变化</span>
                          <strong>{formatDelta(delta)}</strong>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {d.mood || d.stateSummary ? (
                    <div className={styles.relationshipInfoGrid}>
                      {d.mood ? (
                        <div className={styles.relationshipInfoItem}>
                          <span>建议心情</span>
                          <strong>{d.mood}</strong>
                        </div>
                      ) : null}
                      {d.stateSummary ? (
                        <div className={styles.relationshipInfoItem}>
                          <span>建议摘要</span>
                          <strong>{d.stateSummary}</strong>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  {d.reasonText ? (
                    <div className={styles.relationshipTextBlock}>
                      <span>建议原因</span>
                      <p>{d.reasonText}</p>
                    </div>
                  ) : null}
                  <div className={styles.relationshipSuggestionActions}>
                    <button
                      type="button"
                      onClick={() => void handleConfirmDraft(d.id)}
                      disabled={draftBusyId === d.id}
                      data-testid={`relationship-state-draft-confirm-${d.id}`}
                    >
                      应用建议
                    </button>
                    <button
                      type="button"
                      className={styles.secondaryButton}
                      onClick={() => void handleDiscardDraft(d.id)}
                      disabled={draftBusyId === d.id}
                      data-testid={`relationship-state-draft-discard-${d.id}`}
                    >
                      丢弃
                    </button>
                  </div>
                </div>
              );
            })}
          </section>
        ) : null}

        {relationshipState.previousStates?.length ? (
          <div className={styles.relationshipHistoryList}>
            {relationshipState.previousStates.map((state) => (
              <RelationshipHistoryCard
                key={`${state.updatedAt}-${state.affection}-${state.trust}`}
                state={state}
              />
            ))}
          </div>
        ) : null}

        {suggestion && (
          <div className={styles.relationshipSuggestion}>
            <div className={styles.relationshipSuggestionHeader}>
              <strong>AI 状态建议</strong>
              <span>接受后才会写入本地状态</span>
            </div>
            <div className={styles.relationshipDeltaGrid}>
              {METRICS.map((metric) => {
                const delta = formatDelta(suggestion[metric.key]);
                return (
                  <div key={metric.key} aria-label={`${metric.label} 建议变化 ${delta}`}>
                    <span>{metric.label} 建议变化</span>
                    <strong>{delta}</strong>
                  </div>
                );
              })}
            </div>
            <div className={styles.relationshipInfoGrid}>
              <div className={styles.relationshipInfoItem}>
                <span>建议心情</span>
                <strong>{suggestion.mood}</strong>
              </div>
              <div className={styles.relationshipInfoItem}>
                <span>建议摘要</span>
                <strong>{suggestion.stateSummary}</strong>
              </div>
            </div>
            <div className={styles.relationshipTextBlock}>
              <span>建议原因</span>
              <p>{suggestion.reason}</p>
            </div>
            <div className={styles.relationshipSuggestionActions}>
              <button type="button" onClick={handleAccept}>接受建议</button>
              <button type="button" className={styles.secondaryButton} onClick={handleReject}>拒绝建议</button>
            </div>
          </div>
        )}

        <details className={styles.relationshipDebug} open={debugOpen} onToggle={(event) => setDebugOpen(event.currentTarget.open)}>
          <summary>调试工具</summary>
          <p>重置会删除该角色的本地状态，并按当前关系标签重新初始化。</p>
          <button type="button" className={styles.secondaryButton} onClick={handleReset}>重置状态</button>
        </details>
      </div>
    </section>
  );
}
