import React, { useEffect, useMemo, useState } from 'react';
import { hanaFetch } from '../api';
import { t } from '../helpers';
import { useSettingsStore } from '../store';
import { renderMarkdown } from '../../utils/markdown';
import { SettingsRow } from '../components/SettingsRow';
import { SettingsSection } from '../components/SettingsSection';
import { ComputerUseSection } from './ComputerUseSection';
import styles from '../Settings.module.css';

const CACHE_SNAPSHOT_EXPERIMENT_ID = 'memory.cache_snapshot_reflection';

type ExperimentMode = 'off' | 'shadow' | 'write';

type ExperimentDefinition = {
  id: string;
  titleKey: string;
  descriptionKey: string;
  owner: string;
  value: unknown;
  status: string;
  risk: string;
  restartPolicy: string;
  valueSchema?: {
    type: string;
    presentation?: {
      type: string;
    };
  };
};

type CacheSnapshotObservation = {
  status: 'success' | 'failed' | 'skipped';
  reason?: string;
  createdAt?: string;
  sessionPath?: string;
  trigger?: string;
  usage?: {
    model?: string;
    cachedTokens?: number;
    missTokens?: number;
    latencyMs?: number;
  };
  summaryPreview?: string;
  memoryMdPreview?: string;
};

function normalizeMode(value: unknown): ExperimentMode {
  return value === 'shadow' || value === 'write' ? value : 'off';
}

function formatObservationTime(value?: string): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function experimentHint(experiment: ExperimentDefinition) {
  const parts = [
    t(`settings.experiments.status.${experiment.status}`),
    t(`settings.experiments.risk.${experiment.risk}`),
    t(`settings.experiments.restart.${experiment.restartPolicy}`),
  ].filter(Boolean);
  return parts.join(' · ');
}

function SwitchButton({
  checked,
  disabled,
  label,
  onClick,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      className={`hana-toggle${checked ? ' on' : ''}${disabled ? ' disabled' : ''}`}
      disabled={disabled}
      onClick={onClick}
    />
  );
}

function ObservationPanel({ observation, onClear }: {
  observation: CacheSnapshotObservation | null;
  onClear: () => void;
}) {
  return (
    <div className={styles['experiments-observation']}>
      {!observation ? (
        <div className={styles['experiments-empty']}>
          {t('settings.experiments.cacheSnapshot.emptyPreview')}
        </div>
      ) : (
        <>
          <div className={styles['experiments-observation-meta']}>
            {formatObservationTime(observation.createdAt) && (
              <span>{formatObservationTime(observation.createdAt)}</span>
            )}
            {observation.trigger && <span>{observation.trigger}</span>}
            {observation.status && <span>{observation.status}</span>}
            {observation.usage?.model && <span>{observation.usage.model}</span>}
            {typeof observation.usage?.cachedTokens === 'number' && (
              <span>cache {observation.usage.cachedTokens}/{observation.usage.missTokens || 0}</span>
            )}
            {typeof observation.usage?.latencyMs === 'number' && (
              <span>{observation.usage.latencyMs}ms</span>
            )}
          </div>

          {observation.reason && (
            <div className={styles['experiments-observation-error']}>{observation.reason}</div>
          )}

          {observation.summaryPreview?.trim() && (
            <div className={styles['experiments-preview-block']}>
              <h3>{t('settings.experiments.cacheSnapshot.summaryTitle')}</h3>
              <pre>{observation.summaryPreview}</pre>
            </div>
          )}

          {observation.memoryMdPreview?.trim() ? (
            <div className={styles['experiments-preview-block']}>
              <h3>{t('settings.experiments.cacheSnapshot.previewTitle')}</h3>
              <div
                className={`${styles['compiled-memory-md']} md-content`}
                dangerouslySetInnerHTML={{ __html: renderMarkdown(observation.memoryMdPreview) }}
              />
            </div>
          ) : (
            <div className={styles['experiments-empty']}>
              {observation.reason || t('settings.experiments.cacheSnapshot.emptyPreview')}
            </div>
          )}

          <button type="button" className={styles['experiments-clear-btn']} onClick={onClear}>
            {t('settings.experiments.cacheSnapshot.clearObservation')}
          </button>
        </>
      )}
    </div>
  );
}

function CacheSnapshotExperiment({ experiment, onValueChange }: {
  experiment: ExperimentDefinition;
  onValueChange: (id: string, value: ExperimentMode) => Promise<void>;
}) {
  const primaryAgentId = useSettingsStore(s => (
    s.agents.find((agent) => agent.isPrimary)?.id || null
  ));
  const [observation, setObservation] = useState<CacheSnapshotObservation | null>(null);
  const [observationLoaded, setObservationLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const mode = normalizeMode(experiment.value);
  const enabled = mode !== 'off';
  const observeOnly = mode === 'shadow';

  const observationUrl = useMemo(() => {
    if (!primaryAgentId) return null;
    return `/api/experiments/memory/cache-snapshot-reflection/observation?agentId=${encodeURIComponent(primaryAgentId)}`;
  }, [primaryAgentId]);

  const loadObservation = async () => {
    if (!observationUrl) return;
    const res = await hanaFetch(observationUrl);
    const data = await res.json();
    setObservation(data.observation || null);
    setObservationLoaded(true);
  };

  useEffect(() => {
    loadObservation().catch(() => {
      setObservation(null);
      setObservationLoaded(true);
    });
  }, [observationUrl]);

  const setMode = async (next: ExperimentMode) => {
    setSaving(true);
    try {
      await onValueChange(experiment.id, next);
      if (next === 'shadow') {
        loadObservation().catch(() => {});
      }
    } finally {
      setSaving(false);
    }
  };

  const clearObservation = async () => {
    if (!observationUrl) return;
    await hanaFetch(observationUrl, { method: 'DELETE' });
    setObservation(null);
  };

  const hint = [
    experimentHint(experiment),
    mode === 'write' ? t('settings.experiments.cacheSnapshot.writeWarning') : '',
  ].filter(Boolean).join(' · ');

  const showObservation = mode === 'shadow' || observationLoaded && !!observation;

  return (
    <>
      <SettingsRow
        label={t(experiment.titleKey)}
        hint={hint}
        hintVariant={mode === 'write' ? 'warn' : 'default'}
        control={(
          <SwitchButton
            checked={enabled}
            disabled={saving}
            label={t(experiment.titleKey)}
            onClick={() => setMode(enabled ? 'off' : 'shadow')}
          />
        )}
      />
      <SettingsRow
        label={t('settings.experiments.cacheSnapshot.observeOnly')}
        hint={t('settings.experiments.cacheSnapshot.observationNote')}
        control={(
          <SwitchButton
            checked={observeOnly}
            disabled={!enabled || saving}
            label={t('settings.experiments.cacheSnapshot.observeOnly')}
            onClick={() => setMode(observeOnly ? 'write' : 'shadow')}
          />
        )}
      />
      {showObservation && (
        <ObservationPanel observation={observation} onClear={clearObservation} />
      )}
    </>
  );
}

export function ExperimentsTab() {
  const showToast = useSettingsStore(s => s.showToast);
  const platformName = useSettingsStore(s => s.platformName);
  const [experiments, setExperiments] = useState<ExperimentDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const memoryExperiments = experiments.filter((experiment) => experiment.owner === 'memory');
  const showComputerUse = platformName !== 'linux';

  useEffect(() => {
    hanaFetch('/api/experiments')
      .then((res) => res.json())
      .then((data) => setExperiments(Array.isArray(data.experiments) ? data.experiments : []))
      .finally(() => setLoading(false));
  }, []);

  const updateExperimentValue = async (id: string, value: ExperimentMode) => {
    const res = await hanaFetch(`/api/experiments/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    const nextValue = data.value ?? value;
    setExperiments((items) => items.map((item) => (
      item.id === id ? { ...item, value: nextValue } : item
    )));
    showToast(t('settings.autoSaved'), 'success');
  };

  return (
    <>
      {showComputerUse && <ComputerUseSection />}
      <SettingsSection
        title={t('settings.experiments.memoryTitle')}
        description={t('settings.experiments.cacheSnapshot.description')}
      >
        {loading ? (
          <div className={styles['experiments-empty']}>Loading...</div>
        ) : memoryExperiments.length === 0 ? (
          <div className={styles['experiments-empty']}>{t('settings.experiments.empty')}</div>
        ) : (
          memoryExperiments.map((experiment) => (
            experiment.id === CACHE_SNAPSHOT_EXPERIMENT_ID ? (
              <CacheSnapshotExperiment
                key={experiment.id}
                experiment={experiment}
                onValueChange={updateExperimentValue}
              />
            ) : null
          ))
        )}
      </SettingsSection>
    </>
  );
}
