import { memo, useEffect, useRef, useState } from 'react';
import type { TaskOutcome } from '../../../../../lib/task-outcome/task-outcome';
import { openInternalLink } from '../../utils/link-open';
import { loadChannels, openChannel } from '../../stores/channel-actions';
import { useStore } from '../../stores';
import { switchTab } from '../channels/ChannelTabBar';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { ChatResourceCard } from './ChatResourceCard';
import styles from './TaskOutcomeCard.module.css';

const FALLBACK: Record<string, string> = {
  'taskOutcome.channelTitle': 'Channel post result',
  'taskOutcome.webTitle': 'Web reading result',
  'taskOutcome.workflowTitle': 'Workflow result',
  'taskOutcome.taskTitle': 'Task result',
  'taskOutcome.execution': 'Execution',
  'taskOutcome.goal': 'Goal',
  'taskOutcome.verified': 'Verified',
  'taskOutcome.partial': 'Partial',
  'taskOutcome.failed': 'Failed',
  'taskOutcome.unverified': 'Unverified',
  'taskOutcome.completed': 'Completed',
  'taskOutcome.running': 'Running',
  'taskOutcome.unknown': 'Unknown',
  'taskOutcome.scopeChannel': 'Saved in the local channel; recipient reading is unverified',
  'taskOutcome.scopeChannelUnverified': 'Local channel write is unverified; recipient reading is unverified',
  'taskOutcome.scopeWeb': 'One response text only',
  'taskOutcome.scopeGoal': 'Requested goal',
  'taskOutcome.source': 'Source',
  'taskOutcome.receipt': 'Receipt',
  'taskOutcome.sender': 'Sender',
  'taskOutcome.openChannel': 'Verify receipt and open channel',
  'taskOutcome.channelUnavailable': 'Channel is unavailable in this account or is disabled.',
  'taskOutcome.receiptMissing': 'The saved receipt could not be found in the current channel.',
  'taskOutcome.hash': 'Text SHA-256',
  'taskOutcome.characters': 'Returned characters',
  'taskOutcome.missing': 'Missing coverage',
  'taskOutcome.next': 'Needs review',
  'taskOutcome.nextAction.inspect_channel_receipt': 'Inspect the channel receipt before retrying.',
  'taskOutcome.nextAction.review_missing_coverage': 'Review the unread parts before claiming full coverage.',
  'taskOutcome.nextAction.inspect_read_evidence': 'Inspect the stored read evidence.',
  'taskOutcome.nextAction.verify_goal_artifacts': 'Verify the requested goal from receipts or artifacts.',
};

function label(key: string): string {
  const translated = window.t?.(key);
  return translated && translated !== key ? translated
    : FALLBACK[key] || (key.startsWith('taskOutcome.reason.') ? key.slice('taskOutcome.reason.'.length).replaceAll('_', ' ') : key);
}

function sourceUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch { return null; }
}

export function taskOutcomeGoalLabel(goalResult: TaskOutcome['goalResult']): string {
  return label(`taskOutcome.${goalResult}`);
}

export const TaskOutcomeCard = memo(function TaskOutcomeCard({ block }: { block: { outcome: TaskOutcome } }) {
  const { outcome } = block;
  const [receiptError, setReceiptError] = useState('');
  const receiptIdentity = `${outcome.taskId}\u0000${outcome.revision}`;
  const receiptIdentityRef = useRef(receiptIdentity);
  receiptIdentityRef.current = receiptIdentity;
  const requestVersion = useRef(0);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; requestVersion.current += 1; };
  }, []);
  useEffect(() => {
    requestVersion.current += 1;
    setReceiptError('');
  }, [receiptIdentity]);
  const openReceiptChannel = async (evidence: TaskOutcome['evidence'][number]) => {
    const version = ++requestVersion.current;
    const selected = useStore.getState();
    const sessionPath = selected.currentSessionPath;
    const agentId = selected.currentAgentId;
    const isCurrent = () => mounted.current && requestVersion.current === version
      && receiptIdentityRef.current === receiptIdentity
      && useStore.getState().currentSessionPath === sessionPath
      && useStore.getState().currentAgentId === agentId;
    setReceiptError('');
    try {
      const channelId = evidence.reference;
      const effectId = outcome.actions[0]?.id;
      if (!effectId || !/^[a-f0-9]{64}$/.test(effectId)) {
        if (isCurrent()) setReceiptError(label('taskOutcome.receiptMissing'));
        return;
      }
      const response = await hanaFetch(`/api/channels/${encodeURIComponent(channelId)}/effects/${effectId}/receipt`, {
        throwOnHttpError: false,
      });
      if (!isCurrent()) return;
      if (response.status === 404 || response.status === 409) {
        setReceiptError(label('taskOutcome.receiptMissing'));
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (!isCurrent()) return;
      const present = data.status === 'confirmed'
        && data.receipt?.sender === evidence.sender && data.receipt?.timestamp === evidence.timestamp;
      if (!present) {
        setReceiptError(label('taskOutcome.receiptMissing'));
        return;
      }
      await loadChannels();
      if (!isCurrent()) return;
      if (!useStore.getState().channels.some((channel) => channel.id === channelId && !channel.isDM)) {
        setReceiptError(label('taskOutcome.channelUnavailable'));
        return;
      }
      if (!await openChannel(channelId, false, { stillCurrent: isCurrent })) {
        if (isCurrent()) setReceiptError(label('taskOutcome.channelUnavailable'));
        return;
      }
      if (isCurrent()) switchTab('channels');
    } catch {
      if (isCurrent()) setReceiptError(label('taskOutcome.channelUnavailable'));
    }
  };
  const titleKey = outcome.kind === 'channel_post' ? 'taskOutcome.channelTitle'
    : outcome.kind === 'web_read' ? 'taskOutcome.webTitle'
    : outcome.kind === 'workflow' ? 'taskOutcome.workflowTitle' : 'taskOutcome.taskTitle';
  const hasConfirmedChannelReceipt = outcome.goalResult === 'verified'
    && outcome.evidence.some(evidence => evidence.kind === 'channel_receipt' && evidence.status === 'confirmed');
  const scopeKey = outcome.goalScope === 'local_channel_append'
    ? (hasConfirmedChannelReceipt ? 'taskOutcome.scopeChannel' : 'taskOutcome.scopeChannelUnverified')
    : outcome.goalScope === 'single_response_text' ? 'taskOutcome.scopeWeb' : 'taskOutcome.scopeGoal';
  const tone = outcome.goalResult === 'verified' ? 'success'
    : outcome.goalResult === 'failed' ? 'danger' : outcome.goalResult === 'partial' ? 'accent' : 'muted';
  return (
    <ChatResourceCard
      variant="task"
      title={label(titleKey)}
      subtitle={label(scopeKey)}
      statusLabel={`${label('taskOutcome.goal')}: ${taskOutcomeGoalLabel(outcome.goalResult)}`}
      statusTone={tone}
      expanded
    >
      <div className={styles.details} data-task-outcome={outcome.taskId}>
        <div className={styles.row}>
          <span>{label('taskOutcome.execution')}</span>
          <strong>{label(`taskOutcome.${outcome.lifecycle}`)}</strong>
        </div>
        {outcome.evidence.map((evidence, index) => {
          const url = sourceUrl(evidence.sourceUrl);
          return (
            <div className={styles.evidence} key={`${evidence.kind}:${evidence.reference}:${index}`}>
              {url ? (
                <button type="button" className={styles.source} onClick={() => { void openInternalLink(url, { origin: 'session' }); }} title={url}>
                  {label('taskOutcome.source')}: {evidence.reference}
                </button>
              ) : (
                <>
                  <span>{label('taskOutcome.receipt')}: {evidence.reference}</span>
                  {evidence.kind === 'channel_receipt' && (
                    <button type="button" className={styles.source} onClick={() => { void openReceiptChannel(evidence); }}>
                      {label('taskOutcome.openChannel')}
                    </button>
                  )}
                </>
              )}
              {evidence.sender && <span>{label('taskOutcome.sender')}: {evidence.sender}</span>}
              {evidence.timestamp && <span>{String(evidence.timestamp)}</span>}
              {evidence.contentHash && <code title={evidence.contentHash}>{label('taskOutcome.hash')}: {evidence.contentHash}</code>}
              {evidence.returnedCharacters !== undefined && <span>{label('taskOutcome.characters')}: {evidence.returnedCharacters}</span>}
              {!!evidence.missingReasons?.length && <span>{label('taskOutcome.missing')}: {evidence.missingReasons.map((reason) => label(`taskOutcome.reason.${reason}`)).join(', ')}</span>}
            </div>
          );
        })}
        {!!outcome.pendingDecisions.length && (
          <div className={styles.pending}>{label('taskOutcome.next')}: {outcome.pendingDecisions.map((decision) => label(`taskOutcome.nextAction.${decision}`)).join(' ')}</div>
        )}
        {receiptError && <div className={styles.pending} role="status">{receiptError}</div>}
      </div>
    </ChatResourceCard>
  );
});
