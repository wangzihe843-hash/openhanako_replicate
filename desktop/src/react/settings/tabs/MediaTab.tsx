import React, { useState, useCallback, useEffect } from 'react';
import { useSettingsStore } from '../store';
import { hanaFetch } from '../api';
import { t } from '../helpers';
import { MediaProviderDetail } from './media/MediaProviderDetail';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsRow } from '../components/SettingsRow';
import { SelectWidget } from '@/ui';
import { Toggle } from '../widgets/Toggle';
import styles from '../Settings.module.css';

interface MediaProvider {
  providerId: string;
  displayName?: string;
  hasCredentials: boolean;
  unavailableReason?: string | null;
  models: { id: string; name: string; protocolId?: string; adapterAvailable?: boolean }[];
  availableModels: { id: string; name: string }[];
}

interface MediaConfig {
  defaultImageModel?: { id: string; provider: string };
  providerDefaults?: Record<string, any>;
}

interface SpeechModel {
  id: string;
  name?: string;
  displayName?: string;
  protocolId?: string;
  adapterAvailable?: boolean;
}

interface SpeechProvider {
  providerId: string;
  displayName?: string;
  hasCredentials: boolean;
  unavailableReason?: string | null;
  models: SpeechModel[];
  availableModels?: { id: string; name: string }[];
}

interface SpeechConfig {
  enabled: boolean;
  defaultModel?: { id: string; provider: string };
}

type SpeechConfigPatch = {
  enabled?: boolean;
  defaultModel?: SpeechConfig['defaultModel'] | null;
};

type MediaSelection =
  | { kind: 'imageGeneration'; providerId: string }
  | { kind: 'speechRecognition'; providerId: string };

function encodeConfigPatch(updates: Partial<MediaConfig>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(updates).map(([key, value]) => [key, value === undefined ? null : value]),
  );
}

function applyConfigPatch(prev: MediaConfig, updates: Partial<MediaConfig>): MediaConfig {
  const next: MediaConfig = { ...prev };
  for (const [key, value] of Object.entries(updates) as Array<[keyof MediaConfig, MediaConfig[keyof MediaConfig]]>) {
    if (value === undefined) delete next[key];
    else next[key] = value as any;
  }
  return next;
}

function encodeSpeechConfigPatch(updates: SpeechConfigPatch): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(updates).map(([key, value]) => [key, value === undefined ? null : value]),
  );
}

function applySpeechConfigPatch(prev: SpeechConfig, updates: SpeechConfigPatch): SpeechConfig {
  const next: SpeechConfig = { ...prev };
  if (typeof updates.enabled === 'boolean') next.enabled = updates.enabled;
  if ('defaultModel' in updates) {
    if (updates.defaultModel) next.defaultModel = updates.defaultModel;
    else delete next.defaultModel;
  }
  return next;
}

function mergeSpeechConfig(prev: SpeechConfig, incoming: any): SpeechConfig {
  const next: SpeechConfig = { ...prev };
  if (typeof incoming?.enabled === 'boolean') next.enabled = incoming.enabled;
  if (incoming && Object.prototype.hasOwnProperty.call(incoming, 'defaultModel')) {
    if (incoming.defaultModel) next.defaultModel = incoming.defaultModel;
    else delete next.defaultModel;
  }
  return next;
}

function speechModelLabel(model: SpeechModel | { id: string; name: string }): string {
  return 'displayName' in model && model.displayName ? model.displayName : model.name || model.id;
}

function getRunnableSpeechModels(provider: SpeechProvider): Array<{ id: string; name: string }> {
  if (!provider.hasCredentials) return [];
  if (Array.isArray(provider.availableModels)) {
    return provider.availableModels.map(model => ({ id: model.id, name: model.name || model.id }));
  }
  return (provider.models || [])
    .filter(model => model.adapterAvailable !== false)
    .map(model => ({ id: model.id, name: speechModelLabel(model) }));
}

function textOrFallback(key: string, fallback: string): string {
  const value = t(key);
  return value === key ? fallback : value;
}

function SpeechProviderDetail({
  providerId,
  provider,
  config,
}: {
  providerId: string;
  provider: SpeechProvider;
  config: SpeechConfig | null;
}) {
  const runnableModels = getRunnableSpeechModels(provider);
  const isDefault = (modelId: string) =>
    config?.defaultModel?.id === modelId && config.defaultModel.provider === providerId;

  return (
    <div className={styles['pv-detail-inner']}>
      <div className={styles['pv-detail-header']}>
        <h2 className={styles['pv-detail-title']}>{provider.displayName || providerId}</h2>
      </div>

      <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: 'var(--space-md)', display: 'flex', alignItems: 'center', gap: '6px' }}>
        <span style={{
          width: 6, height: 6, borderRadius: '50%',
          background: provider.hasCredentials ? 'var(--success)' : 'var(--text-muted)',
          display: 'inline-block',
        }} />
        {provider.hasCredentials ? t('settings.media.credentialOk') : t('settings.media.credentialMissing')}
      </div>

      <div className={styles['pv-models']}>
        <div className={styles['pv-fav-section']}>
          <div className={styles['pv-fav-title']}>
            {textOrFallback('settings.media.speechModels', '转录模型')}
            <span className={styles['pv-models-count']}>{runnableModels.length}</span>
          </div>
          {runnableModels.length > 0 ? (
            <div className={styles['pv-fav-list']}>
              {runnableModels.map(model => (
                <div key={model.id} className={styles['pv-fav-item']}>
                  <span className={styles['pv-fav-item-name']} title={model.id}>{model.name || model.id}</span>
                  <span className={styles['pv-fav-item-id']}>{model.id}</span>
                  {isDefault(model.id) && (
                    <span style={{
                      fontSize: '0.6rem', color: 'var(--accent)',
                      background: 'var(--accent-light)', padding: '1px 6px',
                      borderRadius: '4px', fontWeight: 500, flexShrink: 0,
                    }}>
                      {t('settings.media.default')}
                    </span>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className={styles['pv-empty']}>{t('settings.media.noProvider')}</div>
          )}
        </div>
      </div>
    </div>
  );
}

export function MediaTab() {
  const [providers, setProviders] = useState<Record<string, MediaProvider>>({});
  const [config, setConfig] = useState<MediaConfig>({});
  const [speechProviders, setSpeechProviders] = useState<Record<string, SpeechProvider>>({});
  const [speechConfig, setSpeechConfig] = useState<SpeechConfig | null>(null);
  const [selected, setSelected] = useState<MediaSelection | null>(null);
  const showToast = useSettingsStore(s => s.showToast);

  const loadImageProviders = useCallback(async () => {
    try {
      const res = await hanaFetch('/api/plugins/image-gen/providers');
      const data = await res.json();
      const nextProviders = data.providers || {};
      setProviders(nextProviders);
      setConfig(data.config || {});
      setSelected(current => {
        if (current?.kind === 'speechRecognition') return current;
        if (current?.kind === 'imageGeneration' && nextProviders[current.providerId]) return current;
        const ids = Object.keys(nextProviders);
        const providerId = ids.find(id => nextProviders[id]?.hasCredentials) || ids[0] || null;
        return providerId ? { kind: 'imageGeneration', providerId } : null;
      });
    } catch { /* plugin not loaded yet */ }
  }, []);

  const loadSpeechProviders = useCallback(async () => {
    try {
      const res = await hanaFetch('/api/speech-recognition/providers');
      const data = await res.json();
      const nextProviders = data.providers || {};
      setSpeechProviders(nextProviders);
      setSpeechConfig(mergeSpeechConfig({ enabled: false }, data.config || {}));
      setSelected(current => {
        if (current?.kind !== 'speechRecognition') return current;
        if (nextProviders[current.providerId]) return current;
        return null;
      });
    } catch (err: any) {
      setSpeechProviders({});
      setSpeechConfig({ enabled: false });
      showToast(err.message || 'Failed to load speech recognition providers', 'error');
    }
  }, [showToast]);

  useEffect(() => {
    loadImageProviders();
    loadSpeechProviders();
  }, [loadImageProviders, loadSpeechProviders]);

  const providerIds = Object.keys(providers);
  const speechProviderIds = Object.keys(speechProviders);
  const allImageModels = providerIds.flatMap(pid =>
    (providers[pid].models || []).map(m => ({ ...m, provider: pid }))
  );
  const allSpeechModels = speechProviderIds.flatMap(pid =>
    getRunnableSpeechModels(speechProviders[pid]).map(m => ({ ...m, provider: pid }))
  );
  const speechEnabled = speechConfig?.enabled === true;
  const speechRecognitionEnabledLabel = textOrFallback('settings.media.speechRecognitionEnabled', '发送语音条时转录');
  const defaultSpeechModelLabel = textOrFallback('settings.media.defaultSpeechModel', '语音条转录模型');
  const selectedImageProviderId = selected?.kind === 'imageGeneration' ? selected.providerId : null;
  const selectedSpeechProviderId = selected?.kind === 'speechRecognition' ? selected.providerId : null;

  const saveConfig = async (updates: Partial<MediaConfig>) => {
    try {
      const res = await hanaFetch('/api/plugins/image-gen/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: encodeConfigPatch(updates) }),
      });
      const data = await res.json().catch(() => null);
      if (data?.values) setConfig(data.values);
      else setConfig(prev => applyConfigPatch(prev, updates));
      showToast(t('settings.saved'), 'success');
    } catch (err: any) {
      showToast(err.message || 'Save failed', 'error');
    }
  };

  const saveSpeechConfig = async (updates: SpeechConfigPatch) => {
    try {
      const res = await hanaFetch('/api/speech-recognition/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: encodeSpeechConfigPatch(updates) }),
      });
      const data = await res.json().catch(() => null);
      setSpeechConfig(prev => {
        const base = prev || { enabled: false };
        if (data?.config) return mergeSpeechConfig(base, data.config);
        if (data?.values) return mergeSpeechConfig(base, data.values);
        return applySpeechConfigPatch(base, updates);
      });
      showToast(t('settings.saved'), 'success');
    } catch (err: any) {
      showToast(err.message || 'Save failed', 'error');
    }
  };

  return (
    <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="media">
      {/* pv-layout：double-column variant 做外壳，内部 DOM 保留原样 */}
      <SettingsSection variant="double-column">
        <div className={styles['pv-layout']}>
          {/* Left: Provider list */}
          <div className={styles['pv-list']}>
            <div className={styles['pv-list-group-label']}>{t('settings.media.imageGeneration')}</div>
            {providerIds.map(pid => {
              const p = providers[pid];
              return (
                <button
                  key={pid}
                  className={`${styles['pv-list-item']}${selectedImageProviderId === pid ? ' ' + styles['selected'] : ''}${!p.hasCredentials ? ' ' + styles['dim'] : ''}`}
                  onClick={() => setSelected({ kind: 'imageGeneration', providerId: pid })}
                >
                  <span className={`${styles['pv-status-dot']}${p.hasCredentials ? ' ' + styles['on'] : ''}`} />
                  <span className={styles['pv-list-item-name']}>{p.displayName || pid}</span>
                  <span className={styles['pv-list-item-count']}>{p.models.length}</span>
                </button>
              );
            })}

            {/* Placeholder sections for future capabilities */}
            <div className={styles['pv-list-divider']} />
            <div className={styles['pv-list-group-label']}>
              {t('settings.media.speechRecognition')}
            </div>
            {speechProviderIds.map(pid => {
              const p = speechProviders[pid];
              const runnableCount = getRunnableSpeechModels(p).length;
              return (
                <button
                  key={pid}
                  type="button"
                  className={`${styles['pv-list-item']}${selectedSpeechProviderId === pid ? ' ' + styles['selected'] : ''}${!p.hasCredentials || runnableCount === 0 ? ' ' + styles['dim'] : ''}`}
                  onClick={() => setSelected({ kind: 'speechRecognition', providerId: pid })}
                  title={p.unavailableReason || undefined}
                >
                  <span className={`${styles['pv-status-dot']}${p.hasCredentials && runnableCount > 0 ? ' ' + styles['on'] : ''}`} />
                  <span className={styles['pv-list-item-name']}>{p.displayName || pid}</span>
                  <span className={styles['pv-list-item-count']}>{runnableCount}</span>
                </button>
              );
            })}

            <div className={styles['pv-list-divider']} />
            <div className={styles['pv-list-group-label']} style={{ color: 'var(--text-muted)' }}>
              {t('settings.media.speechSynthesis')}
            </div>
            <div className={styles['pv-list-item']} style={{ opacity: 0.3, pointerEvents: 'none' }}>
              <span className={styles['pv-status-dot']} />
              <span className={styles['pv-list-item-name']} style={{ fontStyle: 'italic', fontSize: '0.7rem' }}>
                {t('settings.media.comingSoon')}
              </span>
            </div>
          </div>

          {/* Right: Provider detail */}
          <div className={styles['pv-detail']}>
            {selectedImageProviderId && providers[selectedImageProviderId] ? (
              <MediaProviderDetail
                providerId={selectedImageProviderId}
                provider={providers[selectedImageProviderId]}
                config={config}
                onSaveConfig={saveConfig}
                onRefresh={loadImageProviders}
              />
            ) : selectedSpeechProviderId && speechProviders[selectedSpeechProviderId] ? (
              <SpeechProviderDetail
                providerId={selectedSpeechProviderId}
                provider={speechProviders[selectedSpeechProviderId]}
                config={speechConfig}
              />
            ) : (
              <div className={styles['pv-empty']}>
                {t('settings.media.noProvider')}
              </div>
            )}
          </div>
        </div>
      </SettingsSection>

      {/* 全局默认：标准 inline row */}
      <SettingsSection title={t('settings.media.globalDefault')}>
        <SettingsRow
          label={t('settings.media.defaultModel')}
          control={
            <SelectWidget
              value={config.defaultImageModel ? `${config.defaultImageModel.provider}/${config.defaultImageModel.id}` : ''}
              onChange={(val) => {
                if (!val) {
                  saveConfig({ defaultImageModel: undefined });
                  return;
                }
                const [provider, ...rest] = val.split('/');
                saveConfig({ defaultImageModel: { id: rest.join('/'), provider } });
              }}
              options={[
                { value: '', label: '—' },
                ...allImageModels.map(m => {
                  const providerHasCredentials = providers[m.provider]?.hasCredentials === true;
                  const adapterAvailable = m.adapterAvailable !== false;
                  const label = `${m.provider} / ${m.name || m.id}`;
                  const unavailableReason = !providerHasCredentials
                    ? t('settings.media.credentialMissing')
                    : !adapterAvailable
                      ? t('settings.media.adapterMissing')
                      : '';
                  return {
                    value: `${m.provider}/${m.id}`,
                    label: unavailableReason ? `${label} (${unavailableReason})` : label,
                    disabled: !providerHasCredentials || !adapterAvailable,
                  };
                }),
              ]}
            />
          }
        />
        <SettingsRow
          label={speechRecognitionEnabledLabel}
          control={
            <Toggle
              ariaLabel={speechRecognitionEnabledLabel}
              on={speechConfig ? speechEnabled : undefined}
              onChange={(enabled) => saveSpeechConfig({ enabled })}
            />
          }
        />
        <SettingsRow
          label={defaultSpeechModelLabel}
          control={
            <SelectWidget
              value={speechConfig?.defaultModel ? `${speechConfig.defaultModel.provider}/${speechConfig.defaultModel.id}` : ''}
              onChange={(val) => {
                if (!val) {
                  saveSpeechConfig({ defaultModel: undefined });
                  return;
                }
                const [provider, ...rest] = val.split('/');
                saveSpeechConfig({ defaultModel: { id: rest.join('/'), provider } });
              }}
              disabled={!speechEnabled || allSpeechModels.length === 0}
              options={[
                { value: '', label: '—' },
                ...(speechEnabled ? allSpeechModels.map(m => ({
                  value: `${m.provider}/${m.id}`,
                  label: `${m.provider} / ${m.name || m.id}`,
                })) : []),
              ]}
            />
          }
        />
      </SettingsSection>
    </div>
  );
}
