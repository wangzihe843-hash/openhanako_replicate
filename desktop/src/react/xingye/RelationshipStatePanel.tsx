import { useMemo, useState } from 'react';
import type { Agent } from '../types';
import type { XingyeRoleProfileDisplay } from './xingye-profile-store';
import {
  generateRelationshipStateSuggestion,
  type XingyeRelationshipStateSuggestion,
} from './xingye-state-ai';
import {
  resetRelationshipState,
  updateRelationshipState,
  useRelationshipState,
} from './xingye-state-store';
import styles from './XingyeShell.module.css';

interface RelationshipStatePanelProps {
  agent: Agent;
  profile: Partial<XingyeRoleProfileDisplay>;
}

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

export function RelationshipStatePanel({ agent, profile }: RelationshipStatePanelProps) {
  const relationshipState = useRelationshipState(agent.id, profile);
  const [suggestion, setSuggestion] = useState<XingyeRelationshipStateSuggestion | null>(null);
  const [refreshState, setRefreshState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [debugOpen, setDebugOpen] = useState(false);

  const recentContextNote = useMemo(() => (
    '本次状态刷新未读取小手机短信或通讯录；最近 OpenHanako 聊天摘要将在后续安全接入后作为只读上下文。'
  ), []);

  if (!relationshipState) return null;

  const handleRefresh = async () => {
    setRefreshState('loading');
    setError(null);
    setSuggestion(null);
    try {
      const nextSuggestion = await generateRelationshipStateSuggestion({
        agent,
        profile,
        state: relationshipState,
        recentChatSummary: '',
        sourceNotes: [recentContextNote],
        trigger: 'manual_refresh',
      });
      setSuggestion(nextSuggestion);
      setRefreshState('idle');
    } catch (err) {
      setRefreshState('error');
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleAccept = () => {
    if (!suggestion) return;
    updateRelationshipState(agent.id, suggestion);
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
            <span>当前心情</span>
            <strong>{relationshipState.mood}</strong>
          </div>
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

        {suggestion && (
          <div className={styles.relationshipSuggestion}>
            <div className={styles.relationshipSuggestionHeader}>
              <strong>AI 状态建议</strong>
              <span>接受后才会写入本地状态</span>
            </div>
            <div className={styles.relationshipDeltaGrid}>
              {METRICS.map((metric) => (
                <div key={metric.key}>
                  <span>{metric.label}</span>
                  <strong>{formatDelta(suggestion[metric.key])}</strong>
                </div>
              ))}
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
