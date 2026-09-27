import { useEffect, useRef, useState } from 'react';
import { hanaFetch } from '../../api';
import { t } from '../../helpers';
import styles from '../../Settings.module.css';

type WorkVersion = {
  id: string; groupId: string; version: number; category: string; content: string;
  scope: { kind: 'workspace'; path: string };
  source: { reference: string; result: string };
  verification: { method: string; evidence: string | null };
  status: 'proposed' | 'verified' | 'active' | 'superseded' | 'revoked';
  replacesId: string | null;
};

const statusLabelKeys = { proposed: 'proposed', verified: 'verified', active: 'active', superseded: 'superseded', revoked: 'revoked' };
const resultLabelKeys = { success: 'resultSuccess', failure: 'resultFailure', partial: 'resultPartial', unknown: 'resultUnknown' };

async function readResponse(response: Response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

export function AgentExperienceVersions({ agentId, enabled }: { agentId: string | null; enabled: boolean }) {
  const requestVersion = useRef(0);
  const agentEpoch = useRef(0);
  const currentAgentId = useRef(agentId);
  currentAgentId.current = agentId;
  const [versions, setVersions] = useState<WorkVersion[]>([]);
  const [evidence, setEvidence] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = async (id: string) => {
    const version = ++requestVersion.current;
    const data = await readResponse(await hanaFetch(`/api/agents/${encodeURIComponent(id)}/experience-versions`));
    if (version !== requestVersion.current || id !== currentAgentId.current) return;
    setVersions(Array.isArray(data.versions) ? data.versions : []);
  };

  useEffect(() => {
    const epoch = ++agentEpoch.current;
    ++requestVersion.current;
    setVersions([]);
    setEvidence({});
    setError('');
    setBusy(false);
    if (!agentId || !enabled) return;
    void refresh(agentId).catch(cause => {
      if (agentId === currentAgentId.current && agentEpoch.current === epoch) setError(String(cause));
    });
  }, [agentId, enabled]);

  const act = async (row: WorkVersion, action: 'verify' | 'activate' | 'revoke') => {
    if (!agentId) return;
    const epoch = agentEpoch.current;
    const isCurrent = () => currentAgentId.current === agentId && agentEpoch.current === epoch;
    setBusy(true);
    setError('');
    try {
      await readResponse(await hanaFetch(`/api/agents/${encodeURIComponent(agentId)}/experience-versions/${encodeURIComponent(row.id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, evidence: evidence[row.id] }),
      }));
      if (!isCurrent()) return;
      await refresh(agentId);
    } catch (cause) { if (isCurrent()) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (isCurrent()) setBusy(false); }
  };

  if (!enabled) return null;
  return <div className={styles['experience-version-list']}>
    <p>{t('settings.experienceVersions.intro')}</p>
    {error && <p role="alert">{error}</p>}
    {versions.length === 0 && <p>{t('settings.experienceVersions.empty')}</p>}
    {[...versions].reverse().map(row => <div key={row.id} className={styles['experience-version-row']}>
      <strong>{row.category} · v{row.version} · {t(`settings.experienceVersions.${statusLabelKeys[row.status]}`)}</strong>
      <span>{row.content}</span>
      <small>{t('settings.experienceVersions.workspace', { path: row.scope.path })}</small>
      <small>{t('settings.experienceVersions.sourceResult', {
        result: t(`settings.experienceVersions.${resultLabelKeys[row.source.result as keyof typeof resultLabelKeys] || 'resultUnknown'}`),
        reference: row.source.reference,
      })}</small>
      <small>{t('settings.experienceVersions.verificationMethod', { method: row.verification.method })}</small>
      {row.verification.evidence && <small>{t('settings.experienceVersions.verificationEvidence', { evidence: row.verification.evidence })}</small>}
      {row.replacesId && <small>{t('settings.experienceVersions.replaces', { id: row.replacesId })}</small>}
      {row.status === 'proposed' && <>
        <input aria-label={t('settings.experienceVersions.evidenceLabel', { id: row.id })} placeholder={t('settings.experienceVersions.evidencePlaceholder')} value={evidence[row.id] || ''}
          onChange={event => setEvidence(current => ({ ...current, [row.id]: event.target.value }))} />
        <button type="button" disabled={busy || !evidence[row.id]?.trim()} onClick={() => void act(row, 'verify')}>{t('settings.experienceVersions.verify')}</button>
      </>}
      {row.status === 'verified' && <button type="button" disabled={busy} onClick={() => void act(row, 'activate')}>{t('settings.experienceVersions.activate')}</button>}
      {['proposed', 'verified', 'active'].includes(row.status) && <button type="button" disabled={busy} onClick={() => void act(row, 'revoke')}>{t('settings.experienceVersions.revoke')}</button>}
    </div>)}
  </div>;
}
