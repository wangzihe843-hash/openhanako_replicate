import { useEffect, useRef, useState } from 'react';
import { hanaFetch } from '../../api';
import { t } from '../../helpers';
import styles from '../../Settings.module.css';

type TopicCandidate = {
  id: string;
  title: string;
  reason: string;
  sourceType: 'shared_memory' | 'world_event' | 'reality_source';
  source: { url?: string; eventId?: string };
  status: 'pending' | 'offered' | 'indeterminate' | 'used' | 'dismissed' | 'expired' | 'invalidated';
  expiresAt: string;
  lastUsedAt: string | null;
};

const typeLabelKeys = { shared_memory: 'sharedType', world_event: 'worldType', reality_source: 'realType' };
const statusLabelKeys = { pending: 'pending', offered: 'offered', indeterminate: 'indeterminate', used: 'used', dismissed: 'dismissed', expired: 'expired', invalidated: 'invalidated' };

async function readResponse(response: Response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function safeSourceUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch { return null; }
}

export function AgentTopicCandidates({ agentId }: { agentId: string | null }) {
  const requestVersion = useRef(0);
  const agentEpoch = useRef(0);
  const currentAgentId = useRef(agentId);
  currentAgentId.current = agentId;
  const [rows, setRows] = useState<TopicCandidate[]>([]);
  const [pins, setPins] = useState<string[]>([]);
  const [sourceType, setSourceType] = useState<'reality_source' | 'shared_memory'>('reality_source');
  const [pinContent, setPinContent] = useState('');
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [reason, setReason] = useState('');
  const [expires, setExpires] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = async (id: string) => {
    const version = ++requestVersion.current;
    const base = `/api/agents/${encodeURIComponent(id)}`;
    const [data, pinData] = await Promise.all([
      readResponse(await hanaFetch(`${base}/topic-candidates`)),
      readResponse(await hanaFetch(`${base}/pinned`)),
    ]);
    if (version !== requestVersion.current || id !== currentAgentId.current) return;
    setRows(Array.isArray(data.candidates) ? data.candidates : []);
    setPins(Array.isArray(pinData.pins) ? pinData.pins.filter((pin: unknown): pin is string => typeof pin === 'string') : []);
  };

  useEffect(() => {
    const epoch = ++agentEpoch.current;
    requestVersion.current += 1;
    setRows([]);
    setPins([]);
    setError('');
    setBusy(false);
    setSourceType('reality_source');
    setPinContent(''); setTitle(''); setUrl(''); setReason(''); setExpires('');
    if (!agentId) return;
    void refresh(agentId).catch((cause) => {
      if (currentAgentId.current === agentId && agentEpoch.current === epoch) setError(String(cause));
    });
  }, [agentId]);

  const add = async () => {
    if (!agentId) return;
    const epoch = agentEpoch.current;
    const isCurrent = () => currentAgentId.current === agentId && agentEpoch.current === epoch;
    setBusy(true);
    setError('');
    try {
      const expiresAt = new Date(expires).toISOString();
      await readResponse(await hanaFetch(`/api/agents/${encodeURIComponent(agentId)}/topic-candidates`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceType, title, sourceUrl: url, pinContent, reason, expiresAt }),
      }));
      if (!isCurrent()) return;
      setTitle(''); setUrl(''); setPinContent(''); setReason(''); setExpires('');
      await refresh(agentId);
    } catch (cause) { if (isCurrent()) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (isCurrent()) setBusy(false); }
  };

  const changeStatus = async (row: TopicCandidate, status: 'pending' | 'dismissed' | 'used') => {
    if (!agentId) return;
    const epoch = agentEpoch.current;
    const isCurrent = () => currentAgentId.current === agentId && agentEpoch.current === epoch;
    setBusy(true);
    setError('');
    try {
      await readResponse(await hanaFetch(`/api/agents/${encodeURIComponent(agentId)}/topic-candidates/${encodeURIComponent(row.id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }),
      }));
      if (!isCurrent()) return;
      await refresh(agentId);
    } catch (cause) { if (isCurrent()) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (isCurrent()) setBusy(false); }
  };

  return <div className={styles['topic-candidates']}>
    <p>{t('settings.topicCandidates.intro')}</p>
    <div className={styles['topic-candidate-form']}>
      <select aria-label={t('settings.topicCandidates.sourceType')} value={sourceType} onChange={event => setSourceType(event.target.value as 'reality_source' | 'shared_memory')}>
        <option value="reality_source">{t('settings.topicCandidates.realSource')}</option>
        <option value="shared_memory">{t('settings.topicCandidates.sharedSource')}</option>
      </select>
      {sourceType === 'reality_source' ? <>
        <input aria-label={t('settings.topicCandidates.realTitle')} placeholder={t('settings.topicCandidates.realTitlePlaceholder')} value={title} onChange={event => setTitle(event.target.value)} />
        <input aria-label={t('settings.topicCandidates.realUrl')} placeholder={t('settings.topicCandidates.realUrlPlaceholder')} value={url} onChange={event => setUrl(event.target.value)} />
      </> : <select aria-label={t('settings.topicCandidates.selectMemory')} value={pinContent} onChange={event => setPinContent(event.target.value)}>
        <option value="">{t('settings.topicCandidates.memoryPlaceholder')}</option>
        {pins.map(pin => <option key={pin} value={pin}>{pin.slice(0, 100)}</option>)}
      </select>}
      <input aria-label={t('settings.topicCandidates.reason')} placeholder={t('settings.topicCandidates.reasonPlaceholder')} value={reason} onChange={event => setReason(event.target.value)} />
      <input aria-label={t('settings.topicCandidates.expiry')} type="datetime-local" value={expires} onChange={event => setExpires(event.target.value)} />
      <button type="button" disabled={!agentId || busy || (sourceType === 'reality_source' ? !title.trim() || !url.trim() : !pinContent) || !reason.trim() || !expires} onClick={() => void add()}>{t('settings.topicCandidates.add')}</button>
    </div>
    {error && <p role="alert">{error}</p>}
    {rows.length === 0 && <p>{t('settings.topicCandidates.empty')}</p>}
    {rows.map(row => {
      const sourceUrl = safeSourceUrl(row.source?.url);
      return <div key={row.id} className={styles['topic-candidate-row']}>
      <strong>{row.title}</strong>
      <span>{t(`settings.topicCandidates.${typeLabelKeys[row.sourceType]}`)} · {t(`settings.topicCandidates.${statusLabelKeys[row.status]}`)} · {t('settings.topicCandidates.expiresAt', { time: new Date(row.expiresAt).toLocaleString() })}</span>
      <span>{row.reason}</span>
      {sourceUrl && <a href={sourceUrl} target="_blank" rel="noopener noreferrer">{t('settings.topicCandidates.viewSource')}</a>}
      {row.status === 'pending' && <button type="button" disabled={busy} onClick={() => void changeStatus(row, 'dismissed')}>{t('settings.topicCandidates.dismiss')}</button>}
      {(row.status === 'offered' || row.status === 'indeterminate') && <>
        <button type="button" disabled={busy} onClick={() => void changeStatus(row, 'used')}>{t('settings.topicCandidates.confirmDelivered')}</button>
        <button type="button" disabled={busy} onClick={() => void changeStatus(row, 'pending')}>{t('settings.topicCandidates.retry')}</button>
        <button type="button" disabled={busy} onClick={() => void changeStatus(row, 'dismissed')}>{t('settings.topicCandidates.dismiss')}</button>
      </>}
    </div>;
    })}
  </div>;
}
