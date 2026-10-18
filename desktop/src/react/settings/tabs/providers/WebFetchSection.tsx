import React, { useEffect, useState } from 'react';
import { useSettingsStore } from '../../store';
import { autoSaveGlobalModels, t } from '../../helpers';
import { hanaFetch } from '../../api';
import { loadSettingsConfig } from '../../actions';
import { SelectWidget } from '@/ui';
import { KeyInput } from '../../widgets/KeyInput';
import { isOfficialDeepSeekBaseUrl } from '../../../../../../shared/deepseek-tools.ts';
import styles from '../../Settings.module.css';

export function WebFetchSection({ providers }: { providers: Record<string, { base_url?: string }> }) {
  const global = useSettingsStore(s => s.globalModelsConfig);
  const showToast = useSettingsStore(s => s.showToast);
  const config = global?.web_fetch || {};
  const provider = config.provider || 'direct';
  const reference = config.credential_provider || '';
  const savedKey = config.api_key || '';
  const [key, setKey] = useState(savedKey);
  const [edited, setEdited] = useState(false);
  useEffect(() => { if (!edited) setKey(savedKey); }, [savedKey, edited]);
  const officialIds = Object.entries(providers)
    .filter(([, entry]) => isOfficialDeepSeekBaseUrl(entry.base_url)).map(([id]) => id);
  const search = global?.search;
  const hasSearchCredential = Boolean(search?.credential_provider || search?.api_keys?.deepseek
    || (search?.provider === 'deepseek' && search?.api_key));

  return <section aria-label={t('settings.api.fetchProvider')} className={styles['settings-form-grid']}>
    <div className={`${styles['settings-form-field']} ${styles['settings-form-field-half']}`}>
      <label className={styles['settings-form-label']}>{t('settings.api.fetchProvider')}</label>
      <SelectWidget
        options={[{ value: 'direct', label: t('settings.api.fetchDirect') }, { value: 'deepseek', label: 'DeepSeek Fetch' }]}
        value={provider}
        onChange={value => autoSaveGlobalModels({ web_fetch: {
          provider: value,
          ...(value === 'deepseek' && !reference && !hasSearchCredential && officialIds.length === 1
            ? { credential_provider: officialIds[0] } : {}),
        } })}
      />
      <span className={styles['settings-form-hint']}>{t('settings.api.fetchCostHint')}</span>
    </div>
    {provider === 'deepseek' && <div className={`${styles['settings-form-field']} ${styles['settings-form-field-half']}`}>
      <label className={styles['settings-form-label']}>{t('settings.api.deepseekCredentialProvider')}</label>
      <SelectWidget
        options={[
          { value: '', label: t('settings.api.fetchInheritSearch') },
          ...officialIds.map(id => ({ value: id, label: id })),
          ...(reference && !officialIds.includes(reference)
            ? [{ value: reference, label: `${reference} (${t('settings.api.deepseekReferenceUnavailable')})` }] : []),
        ]}
        value={reference}
        onChange={value => autoSaveGlobalModels({ web_fetch: { credential_provider: value } })}
      />
      <div className={styles['search-api-key-controls']}>
        <KeyInput value={key} onChange={value => { setKey(value); setEdited(true); }} placeholder={t('settings.api.apiKeyPlaceholder')} />
        <button className={styles['search-verify-btn']} onClick={async () => {
          try {
            const response = await hanaFetch('/api/preferences/models', {
              method: 'PUT', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ web_fetch: { api_key: key } }),
            });
            const data = await response.json();
            if (!response.ok || data.error) throw new Error('save failed');
            await loadSettingsConfig();
            setEdited(false);
            showToast(t('settings.autoSaved'), 'success');
          } catch {
            // Keep the draft on a rejected save; never ask for the key again.
            showToast(t('settings.saveFailed'), 'error');
          }
        }}>{t('settings.api.fetchSaveKey')}</button>
      </div>
      <span className={styles['settings-form-hint']}>{t('settings.api.fetchKeyHint')}</span>
    </div>}
  </section>;
}
