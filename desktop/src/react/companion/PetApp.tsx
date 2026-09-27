import { useEffect, useRef, useState } from 'react';
import {
  latestCompanionTerminalChange, resolveCompanionState, terminalCompanionState,
  type CompanionStatusResponse, type CompanionTaskStatus, type CompanionTerminalState,
} from '../components/right-workspace/companion-status';
import type { PetContext, PetOptions, PetWindowState } from './pet-types';
import styles from './PetApp.module.css';

const POLL_MS = 1500;
const FEEDBACK_MS = 4000;
const LOCALE_REFRESH_MS = 30_000;

function localeKey(locale: string): string {
  if (locale === 'zh-TW' || locale === 'zh-Hant') return 'zh-TW';
  if (locale.startsWith('zh')) return 'zh';
  if (locale.startsWith('ja')) return 'ja';
  if (locale.startsWith('ko')) return 'ko';
  return 'en';
}

interface RegistryView {
  scope: string;
  tasks: CompanionTaskStatus[];
  feedback: { state: CompanionTerminalState; expiresAt: number } | null;
  unavailable: boolean;
}

function scopeFor(context: PetContext | null): string | null {
  return context ? `${context.agentId}\u0000${context.sessionId || context.sessionPath}` : null;
}

export function PetApp() {
  const [locale, setLocale] = useState(window.i18n?.locale ?? 'zh');
  const [windowState, setWindowState] = useState<PetWindowState | null>(null);
  const [context, setContext] = useState<PetContext | null>(null);
  const [registry, setRegistry] = useState<RegistryView | null>(null);
  const [resumeEpoch, setResumeEpoch] = useState(0);
  const mounted = useRef(false);
  const stateEventVersion = useRef(0);
  const optionsVersion = useRef(0);
  const scope = scopeFor(context);
  const paused = windowState?.paused === true;
  const connected = context?.connected === true;
  const sessionId = context?.sessionId;
  const sessionPath = context?.sessionPath;

  useEffect(() => { setRegistry(null); }, [scope, paused, connected, resumeEpoch]);

  useEffect(() => {
    mounted.current = true;
    const bridge = window.hanaPet;
    if (!bridge) return () => { mounted.current = false; };
    let disposed = false;
    let receivedState = false;
    let receivedContext = false;
    const offState = bridge.onState((state) => {
      stateEventVersion.current += 1;
      receivedState = true;
      receivedContext = true;
      setWindowState(state);
      setContext(state.context);
    });
    const offContext = bridge.onContext((value) => {
      receivedContext = true;
      setContext(value);
    });
    const offResume = bridge.onResume(() => setResumeEpoch((value) => value + 1));
    void bridge.getState().then((state) => {
      if (disposed || !state) return;
      // The initial IPC snapshot can arrive after a newer event for either field.
      if (!receivedState) setWindowState(state);
      if (!receivedContext) setContext(state.context);
    }).catch(() => {});
    return () => { disposed = true; mounted.current = false; offState(); offContext(); offResume(); };
  }, []);

  useEffect(() => {
    const bridge = window.hanaPet;
    if (!bridge || !window.i18n) return;
    let disposed = false;
    let inFlight = false;
    let controller: AbortController | null = null;
    const refreshLocale = async () => {
      if (disposed || inFlight || document.visibilityState === 'hidden') return;
      inFlight = true;
      const request = new AbortController();
      controller = request;
      const timeout = window.setTimeout(() => request.abort(), 10_000);
      try {
        const connection = await bridge.getConnection();
        if (disposed || request.signal.aborted) return;
        const port = Number(connection?.port);
        if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !connection?.token) return;
        const response = await fetch(`http://127.0.0.1:${port}/api/config`, {
          headers: { Authorization: `Bearer ${connection.token}` }, signal: request.signal,
        });
        if (!response.ok) return;
        const config: unknown = await response.json();
        if (disposed || request.signal.aborted || !config || typeof config !== 'object' || !('locale' in config)) return;
        const configuredLocale = config.locale;
        if (typeof configuredLocale !== 'string' || !configuredLocale.trim()) return;
        if (localeKey(configuredLocale) !== window.i18n.locale) {
          await window.i18n.load(configuredLocale);
          if (disposed || request.signal.aborted) return;
          setLocale(window.i18n.locale);
          document.documentElement.lang = window.i18n.locale;
        }
      } catch { /* Keep the last loaded language while the server is unavailable. */ }
      finally {
        window.clearTimeout(timeout);
        if (controller === request) controller = null;
        inFlight = false;
      }
    };
    void refreshLocale();
    const timer = window.setInterval(() => void refreshLocale(), LOCALE_REFRESH_MS);
    const onVisibility = () => { if (document.visibilityState === 'visible') void refreshLocale(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      controller?.abort();
    };
  }, []);

  useEffect(() => {
    if (!sessionPath || !scope || paused || !connected) return;
    const bridge = window.hanaPet;
    if (!bridge) return;
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
      let timedOut = false;
      const timeout = window.setTimeout(() => { timedOut = true; controller?.abort(); }, 10000);
      try {
        const connection = await bridge.getConnection();
        const port = Number(connection?.port);
        if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !connection?.token) throw new Error('Server unavailable');
        const response = await fetch(`http://127.0.0.1:${port}/api/sessions/presentation-status?${query}&afterSequence=${cursor ?? 0}`, {
          headers: { Authorization: `Bearer ${connection.token}` }, signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Status ${response.status}`);
        const data = await response.json() as CompanionStatusResponse;
        if (disposed) return;
        if (!Number.isSafeInteger(data.sequence) || !Number.isFinite(data.serverTime)
          || !Array.isArray(data.tasks) || !Array.isArray(data.changes)) throw new Error('Invalid task status');
        const baseline = cursor === null || data.sequence < cursor;
        cursor = data.sequence;
        const terminal = baseline ? null : latestCompanionTerminalChange(data.changes, data.serverTime);
        const terminalState = terminal ? terminalCompanionState(terminal.status) : null;
        const now = Date.now();
        setRegistry((previous) => ({
          scope, tasks: data.tasks,
          feedback: terminalState ? { state: terminalState, expiresAt: now + FEEDBACK_MS }
            : previous?.scope === scope && previous.feedback && previous.feedback.expiresAt > now ? previous.feedback : null,
          unavailable: false,
        }));
      } catch (error) {
        if (!disposed && (timedOut || !(error instanceof DOMException && error.name === 'AbortError'))) {
          setRegistry({ scope, tasks: [], feedback: null, unavailable: true });
        }
      } finally { window.clearTimeout(timeout); inFlight = false; controller = null; }
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
  }, [scope, connected, sessionId, sessionPath, paused, resumeEpoch]);

  const current = registry?.scope === scope ? registry : null;
  const status = resolveCompanionState({
    tasks: current?.tasks ?? [], streaming: context?.streaming === true,
    awaitingApproval: context?.awaitingApproval === true, inlineError: context?.inlineError === true,
    feedback: current?.feedback && current.feedback.expiresAt > Date.now() ? current.feedback.state : null,
    unavailable: !context?.connected || !current || current.unavailable,
  });

  const setOptions = (options: PetOptions) => {
    const requestVersion = ++optionsVersion.current;
    const eventVersion = stateEventVersion.current;
    void window.hanaPet?.setOptions(options).then((state) => {
      if (state && mounted.current && optionsVersion.current === requestVersion && stateEventVersion.current === eventVersion) {
        setWindowState(state);
      }
    }).catch(() => {});
  };

  return (
    <main className={styles.pet} lang={locale} data-state={status} data-paused={paused ? 'true' : 'false'}>
      <header className={styles.dragBar} title={window.t('companion.pet.drag')}>
        <span className={styles.grip}>⋮⋮</span>
        <span className={styles.name}>{context?.agentName || window.t('companion.pet.partner')}</span>
        <button type="button" className={styles.close} title={window.t('companion.card.hidePet')} aria-label={window.t('companion.card.hidePet')} onClick={() => { void window.hanaPet?.hide().catch(() => {}); }}>×</button>
      </header>
      <div className={styles.stage} aria-hidden="true">
        <div className={styles.shadow} />
        <div className={styles.sprite}>
          <span className={styles.hair} /><span className={styles.face} />
          <span className={styles.leftEye} /><span className={styles.rightEye} />
          <span className={styles.body} /><span className={styles.leftFoot} /><span className={styles.rightFoot} />
        </div>
      </div>
      <p className={styles.status} role="status" aria-live="polite">{paused ? window.t('companion.pet.paused') : context ? window.t(`companion.status.${status}`) : window.t('companion.pet.waitingForSession')}</p>
      <nav className={styles.controls} aria-label={window.t('companion.pet.controls')}>
        <button type="button" onClick={() => { void window.hanaPet?.openMain().catch(() => {}); }} title={window.t('companion.pet.openMain')}>{window.t('companion.pet.session')}</button>
        <button type="button" onClick={() => setOptions({ paused: !paused })} title={window.t(paused ? 'companion.pet.resume' : 'companion.pet.pause')}>{window.t(paused ? 'companion.card.resume' : 'companion.card.pause')}</button>
        <button type="button" onClick={() => setOptions({ alwaysOnTop: !windowState?.alwaysOnTop })} aria-pressed={windowState?.alwaysOnTop === true} title={window.t('companion.pet.pin')}>{window.t(windowState?.alwaysOnTop ? 'companion.card.unpin' : 'companion.card.pin')}</button>
        <button type="button" onClick={() => setOptions({ clickThrough: true })} title={window.t('companion.pet.clickThrough')} aria-label={window.t('companion.pet.clickThrough')}>{window.t('companion.pet.passThrough')}</button>
      </nav>
    </main>
  );
}
