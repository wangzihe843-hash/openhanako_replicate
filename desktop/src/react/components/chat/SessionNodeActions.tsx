import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ChatMessage } from '../../stores/chat-types';
import { useStore } from '../../stores';
import {
  activateForkedSession, forkSessionTurn, retrySessionTurn,
  generateDialogueVariant, listDialogueVariants, updateDialogueVariant,
  type DialogueVariantCandidate, type ForkedSessionHandler, type SessionNodeTarget,
} from '../../stores/message-turn-actions';
import { presentError } from '../../errors/error-presenter';
import type { MessageFooterAction } from './MessageFooterActions';

interface Options {
  sessionPath: string;
  target: SessionNodeTarget | null;
  retryMessage?: ChatMessage;
  onForkCreated?: ForkedSessionHandler;
  disabled?: boolean;
}

export function useSessionNodeActions({ sessionPath, target, retryMessage, onForkCreated, disabled = false }: Options): { actions: MessageFooterAction[]; busy: boolean } {
  const scopeKey = JSON.stringify([sessionPath, target?.role, target?.role === 'assistant_turn' ? target.turnInputEntryId : target?.entryId]);
  const [view, setView] = useState<{ scopeKey: string; busy: boolean; candidate: DialogueVariantCandidate | null; generating: boolean }>({ scopeKey, busy: false, candidate: null, generating: false });
  const sameScope = view.scopeKey === scopeKey;
  const busy = sameScope && view.busy;
  const candidate = sameScope ? view.candidate : null;
  const generating = sameScope && view.generating;
  const busyRef = useRef(false);
  const generationRef = useRef(0);
  const requestRef = useRef<{ sessionPath: string; requestId: string; generation: number } | null>(null);

  useLayoutEffect(() => {
    generationRef.current += 1;
    busyRef.current = false;
    setView({ scopeKey, busy: false, candidate: null, generating: false });
    return () => {
      generationRef.current += 1;
      busyRef.current = false;
      const request = requestRef.current;
      requestRef.current = null;
      if (request) {
        // Retain the original session identity during navigation/unmount. A late
        // provider or cancellation response cannot update the replacement view.
        void updateDialogueVariant(request.sessionPath, 'cancel', { requestId: request.requestId }).catch(() => {});
      }
    };
  }, [scopeKey]);

  const updateView = useCallback((generation: number, patch: Partial<Omit<typeof view, 'scopeKey'>>) => {
    if (generationRef.current !== generation) return;
    setView(current => generationRef.current === generation && current.scopeKey === scopeKey ? { ...current, ...patch } : current);
  }, [scopeKey]);
  const finishOperation = useCallback((generation: number) => {
    if (generationRef.current !== generation) return;
    if (requestRef.current?.generation === generation) requestRef.current = null;
    busyRef.current = false;
    updateView(generation, { busy: false, generating: false });
  }, [updateView]);
  const t = window.t ?? ((key: string) => key);
  const label = (key: string, fallback: string) => { const value = t(key); return value === key ? fallback : value; };
  const story = useStore(state => (state.sessions?.find(session => session.path === sessionPath) as unknown as { memoryScope?: { realm?: string } } | undefined)?.memoryScope?.realm === 'story');

  const handleRetry = useCallback(async () => {
    if (!target || busyRef.current || disabled) return;
    const generation = ++generationRef.current;
    busyRef.current = true; updateView(generation, { busy: true });
    try {
      await retrySessionTurn(sessionPath, target, { ...(retryMessage ? { message: retryMessage } : {}), mode: 'task_retry' });
    } finally { finishOperation(generation); }
  }, [disabled, retryMessage, sessionPath, target, updateView, finishOperation]);

  const handleVariant = useCallback(async (fresh = false) => {
    if (!target || busyRef.current || disabled) return;
    const generation = ++generationRef.current;
    busyRef.current = true; updateView(generation, { busy: true });
    try {
      if (!fresh) {
        const listed = await listDialogueVariants(sessionPath);
        if (generationRef.current !== generation) return;
        const saved = listed.find(value => value.status === 'ready' && (
          target.role === 'assistant_turn' ? value.turnInputEntryId === target.turnInputEntryId
            : value.sourceEntryId === target.entryId
        ));
        if (saved) { updateView(generation, { candidate: saved }); return; }
      }
      if (generationRef.current !== generation) return;
      const requestId = crypto.randomUUID();
      requestRef.current = { sessionPath, requestId, generation };
      updateView(generation, { generating: true });
      const next = await generateDialogueVariant(sessionPath, target, requestId);
      if (next?.status === 'ready') updateView(generation, { candidate: next });
    } finally { finishOperation(generation); }
  }, [disabled, sessionPath, target, updateView, finishOperation]);

  const handleCandidate = useCallback(async (action: 'adopt' | 'discard') => {
    if (!candidate || busyRef.current) return;
    const generation = ++generationRef.current;
    busyRef.current = true; updateView(generation, { busy: true });
    try {
      if (await updateDialogueVariant(sessionPath, action, { candidateId: candidate.candidateId })) updateView(generation, { candidate: null });
    } finally { finishOperation(generation); }
  }, [candidate, sessionPath, updateView, finishOperation]);

  const handleCancel = useCallback(() => {
    const request = requestRef.current;
    if (!request || request.generation !== generationRef.current) return;
    // Invalidate before awaiting cancellation: an already-in-flight generation
    // response must never reopen its preview, even if cancellation is delayed.
    const generation = ++generationRef.current;
    requestRef.current = null;
    busyRef.current = false;
    updateView(generation, { busy: false, generating: false, candidate: null });
    void updateDialogueVariant(request.sessionPath, 'cancel', { requestId: request.requestId }).catch(() => {});
  }, [updateView]);

  const handleFork = useCallback(async (narrative = false) => {
    if (!target || busyRef.current || disabled) return;
    const generation = ++generationRef.current;
    busyRef.current = true; updateView(generation, { busy: true });
    try {
      const forked = narrative ? await forkSessionTurn(sessionPath, target, 'narrative_branch') : await forkSessionTurn(sessionPath, target);
      if (!forked || generationRef.current !== generation) return;
      await (onForkCreated || activateForkedSession)(forked);
      if (!narrative && target.role === 'user' && retryMessage) {
        await retrySessionTurn(forked.sessionPath, target, { message: retryMessage });
      }
    } catch (error) {
      if (generationRef.current === generation) useStore.getState().setInlineError?.(sessionPath, presentError(error), 6000);
    } finally { finishOperation(generation); }
  }, [disabled, onForkCreated, retryMessage, sessionPath, target, updateView, finishOperation]);

  const preview = (candidate || generating) && typeof document !== 'undefined' ? createPortal(
    <div role="dialog" aria-modal="true" aria-label={label('common.dialogueVariant', 'Expression variant')}
      onClick={event => event.stopPropagation()}
      style={{ position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(0,0,0,.4)', display: 'grid', placeItems: 'center', padding: 24 }}>
      <section style={{ background: 'var(--bg-primary, white)', color: 'var(--text-primary, #222)', borderRadius: 12, padding: 24, width: 'min(640px, 100%)', maxHeight: '80vh', overflow: 'auto' }}>
        <h3>{label('common.dialogueVariant', 'Expression variant')}</h3>
        <p>{label('common.dialogueVariantHelp', 'Only the latest completed response can be replaced after explicit adoption. Task results are reused; no tools run. Fork first to change a historical response.')}</p>
        {generating ? <p>{label('common.generatingVariant', 'Generating expression…')}</p> : <div style={{ whiteSpace: 'pre-wrap', margin: '20px 0' }}>{candidate?.text}</div>}
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {generating ? <button onClick={handleCancel}>{label('common.cancel', 'Cancel')}</button> : <>
            <button disabled={busy || disabled} onClick={() => { void handleCandidate('adopt'); }}>{label('common.adoptVariant', 'Adopt expression')}</button>
            <button disabled={busy} onClick={() => { void handleCandidate('discard'); }}>{label('common.discardVariant', 'Discard')}</button>
            <button disabled={busy || disabled} onClick={() => { void handleVariant(true); }}>{label('common.anotherVariant', 'Another expression')}</button>
            <button disabled={busy} onClick={() => updateView(generationRef.current, { candidate: null })}>{label('common.close', 'Close')}</button>
          </>}
        </div>
      </section>
    </div>, document.body,
  ) : null;

  const actions: MessageFooterAction[] = target ? [
    ...(target.role !== 'user' ? [{
      id: 'dialogue-variant', title: label('common.dialogueVariant', 'Expression variant'),
      icon: <><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M4 4h16v12H9l-5 4V4z" /><path d="M8 8h8M8 12h5" /></svg>{preview}</>, onClick: () => { void handleVariant(); }, disabled: disabled || busy,
    }] : []),
    { id: 'task-retry', title: label('common.taskRetry', 'Retry task'), icon: <RegenerateIcon />, onClick: () => { void handleRetry(); }, disabled: disabled || busy || story },
    { id: 'fork-session', title: t('common.forkSession'), icon: <ForkIcon />, onClick: () => { void handleFork(); }, disabled: disabled || busy },
    ...(story ? [{ id: 'narrative-branch', title: label('common.narrativeBranch', 'Narrative branch'), icon: <ForkIcon />, onClick: () => { void handleFork(true); }, disabled: disabled || busy }] : []),
  ] : [];
  return { actions, busy };
}

function RegenerateIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 3v5m0 0h-5m5 0-3-2.708A9 9 0 1 0 20.777 14" />
    </svg>
  );
}

function ForkIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 512 512" fill="currentColor" aria-hidden="true">
      <path d="M124,166.291V345.709a76,76,0,1,0,32,0V282H308a80.091,80.091,0,0,0,80-80V165.311a75.983,75.983,0,1,0-32,1.733V202a48.055,48.055,0,0,1-48,48H156V166.291a76,76,0,1,0-32,0ZM324,92a44,44,0,1,1,44,44A44.049,44.049,0,0,1,324,92ZM184,420a44,44,0,1,1-44-44A44.049,44.049,0,0,1,184,420ZM140,48A44,44,0,1,1,96,92,44.049,44.049,0,0,1,140,48Z" />
    </svg>
  );
}
