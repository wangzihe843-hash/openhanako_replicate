import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../stores';
import { sessionScopedListIncludes, sessionScopedValue } from '../../stores/session-slice';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { XingyeAgentAvatar } from '../../xingye/XingyeAgentAvatar';
import { PixelRoom } from '../../companion/PixelRoom';
import { useI18n } from '../../hooks/use-i18n';
import type { PetOptions, PetWindowState } from '../../companion/pet-types';
import {
  latestCompanionTerminalChange,
  resolveCompanionState,
  terminalCompanionState,
  type CompanionStatusResponse,
  type CompanionTaskStatus,
  type CompanionTerminalState,
} from './companion-status';
import styles from './CompanionStatusCard.module.css';

const POLL_MS = 1500;
const FEEDBACK_MS = 4000;

interface RegistryView {
  scopeKey: string;
  tasks: CompanionTaskStatus[];
  feedback: { state: CompanionTerminalState; expiresAt: number } | null;
  unavailable: boolean;
}

const STATE_SYMBOLS = {
  idle: '·', busy: '◌', waiting: '…', blocked: '!',
  completed: '✓', failed: '×', canceled: '–', unavailable: '?',
} as const;

/** A display-only character: runtime facts determine status; animation never starts an agent turn. */
export function CompanionStatusCard() {
  const { t } = useI18n();
  const sessionPath = useStore((state) => state.currentSessionPath);
  const sessionId = useStore((state) => state.currentSessionId);
  const agentId = useStore((state) => state.currentAgentId);
  const agent = useStore((state) => state.agents.find((entry) => entry.id === state.currentAgentId) ?? null);
  const connected = useStore((state) => state.connected);
  const streaming = useStore((state) => {
    const path = state.currentSessionPath;
    return !!path && sessionScopedListIncludes(state, state.streamingSessions, path);
  });
  const awaitingApproval = useStore((state) => {
    const path = state.currentSessionPath;
    return !!path && !!sessionScopedValue(state, state.pendingSessionConfirmationsByPath, path);
  });
  const inlineError = useStore((state) => {
    const path = state.currentSessionPath;
    return !!path && !!sessionScopedValue(state, state.inlineErrors, path);
  });
  const [registryView, setRegistryView] = useState<RegistryView | null>(null);
  const [roomOpen, setRoomOpen] = useState(false);
  const [petWindowState, setPetWindowState] = useState<PetWindowState | null>(null);
  const [petError, setPetError] = useState('');
  const mounted = useRef(false);
  const petStateEventVersion = useRef(0);
  const petOperationVersion = useRef(0);

  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    let receivedState = false;
    const off = window.platform?.onPetState?.((value) => {
      petStateEventVersion.current += 1;
      receivedState = true;
      setPetWindowState(value);
    });
    void window.platform?.petState?.().then((value) => {
      if (!disposed && !receivedState) setPetWindowState(value);
    }).catch(() => {});
    return () => { disposed = true; mounted.current = false; if (typeof off === 'function') off(); };
  }, []);

  const changePet = async (operation: () => Promise<PetWindowState | null> | undefined) => {
    const operationVersion = ++petOperationVersion.current;
    const eventVersion = petStateEventVersion.current;
    const isCurrent = () => mounted.current && petOperationVersion.current === operationVersion
      && petStateEventVersion.current === eventVersion;
    try {
      const next = await operation();
      if (!isCurrent()) return;
      if (next) { setPetWindowState(next); setPetError(''); }
      else setPetError(t('companion.card.petUnavailable'));
    } catch { if (isCurrent()) setPetError(t('companion.card.petUnavailable')); }
  };
  const setPetOptions = (options: PetOptions) => changePet(() => window.platform?.petSetOptions?.(options));

  const scopeKey = agentId && sessionPath ? `${agentId}\u0000${sessionId || sessionPath}` : null;
  useEffect(() => {
    if (!scopeKey || !sessionPath || !connected) return;
    let disposed = false;
    let inFlight = false;
    let cursor: number | null = null;
    let controller: AbortController | null = null;
    const query = sessionId
      ? `sessionId=${encodeURIComponent(sessionId)}`
      : `path=${encodeURIComponent(sessionPath)}`;

    const poll = async () => {
      if (disposed || inFlight || document.visibilityState === 'hidden') return;
      inFlight = true;
      controller = new AbortController();
      try {
        const response = await hanaFetch(
          `/api/sessions/presentation-status?${query}&afterSequence=${cursor ?? 0}`,
          { signal: controller.signal, timeout: 10000 },
        );
        const data = await response.json() as CompanionStatusResponse;
        if (disposed) return;
        if (!Number.isSafeInteger(data.sequence) || !Number.isFinite(data.serverTime)
          || !Array.isArray(data.tasks) || !Array.isArray(data.changes)) {
          throw new Error('Invalid task presentation status');
        }
        // A first load, including a server restart, is a baseline. Old terminal
        // records must not replay a completion or failure animation.
        const baseline = cursor === null || data.sequence < cursor;
        cursor = data.sequence;
        const now = Date.now();
        const terminal = baseline ? null : latestCompanionTerminalChange(data.changes, data.serverTime);
        const terminalState = terminal ? terminalCompanionState(terminal.status) : null;
        setRegistryView((previous) => ({
          scopeKey,
          tasks: data.tasks,
          feedback: terminalState
            ? { state: terminalState, expiresAt: now + FEEDBACK_MS }
            : previous?.scopeKey === scopeKey && previous.feedback && previous.feedback.expiresAt > now
              ? previous.feedback
              : null,
          unavailable: false,
        }));
      } catch (error) {
        if (disposed || (error instanceof DOMException && error.name === 'AbortError')) return;
        setRegistryView({ scopeKey, tasks: [], feedback: null, unavailable: true });
      } finally {
        inFlight = false;
        controller = null;
      }
    };

    void poll();
    const timer = window.setInterval(() => void poll(), POLL_MS);
    const onVisibility = () => { if (document.visibilityState === 'visible') void poll(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      controller?.abort();
    };
  }, [connected, scopeKey, sessionId, sessionPath]);

  if (!agent || !scopeKey || !sessionPath) return null;
  const current = registryView?.scopeKey === scopeKey ? registryView : null;
  const state = resolveCompanionState({
    tasks: current?.tasks ?? [],
    streaming,
    awaitingApproval,
    inlineError,
    feedback: current?.feedback && current.feedback.expiresAt > Date.now() ? current.feedback.state : null,
    unavailable: !connected || !current || current.unavailable,
  });
  return (
    <section className={`universal-card ${styles.card}`} aria-label={t('companion.card.ariaLabel', { name: agent.name })} data-state={state}>
      <div className={styles.summary}>
        <div className={styles.stage} aria-hidden="true">
          <div className={styles.halo} />
          <XingyeAgentAvatar agent={agent} className={styles.character} alt="" />
          <span className={styles.symbol}>{STATE_SYMBOLS[state]}</span>
        </div>
        <div className={styles.copy}>
          <strong className={styles.name}>{agent.name}</strong>
          <span className={styles.status} role="status" aria-live="polite">{t(`companion.status.${state}`)}</span>
        </div>
      </div>
      <div className={styles.actions}>
        <button type="button" aria-expanded={roomOpen} onClick={() => setRoomOpen((open) => !open)}>{t(roomOpen ? 'companion.card.closeRoom' : 'companion.card.openRoom')}</button>
        {petWindowState?.supported && (
          <>
            <button type="button" onClick={() => void changePet(() => petWindowState.visible ? window.platform?.petHide?.() : window.platform?.petShow?.())}>
              {t(petWindowState.visible ? 'companion.card.hidePet' : 'companion.card.showPet')}
            </button>
            {petWindowState.visible && (
              <>
                <button type="button" aria-pressed={petWindowState.paused} onClick={() => void setPetOptions({ paused: !petWindowState.paused })}>{t(petWindowState.paused ? 'companion.card.resume' : 'companion.card.pause')}</button>
                <button type="button" aria-pressed={petWindowState.alwaysOnTop} onClick={() => void setPetOptions({ alwaysOnTop: !petWindowState.alwaysOnTop })}>{t(petWindowState.alwaysOnTop ? 'companion.card.unpin' : 'companion.card.pin')}</button>
                <button type="button" aria-pressed={petWindowState.clickThrough} onClick={() => void setPetOptions({ clickThrough: !petWindowState.clickThrough })}>
                  {t(petWindowState.clickThrough ? 'companion.card.restoreClick' : 'companion.card.clickThrough')}
                </button>
              </>
            )}
          </>
        )}
      </div>
      {petError && <span className={styles.petError} role="alert">{petError}</span>}
      {roomOpen && <PixelRoom key={scopeKey} scopeKey={scopeKey} sessionPath={sessionPath} agentName={agent.name} companionState={state} />}
    </section>
  );
}
