import { useEffect } from 'react';
import { useStore } from '../stores';
import { sessionScopedListIncludes, sessionScopedValue } from '../stores/session-slice';
import type { PetContext } from './pet-types';

/** Keeps the separate pet attached to the main window's actual selection. It never creates a second session. */
export function PetContextSync() {
  const agentId = useStore((state) => state.currentAgentId);
  const agentName = useStore((state) => state.agents.find((agent) => agent.id === state.currentAgentId)?.name ?? '伙伴');
  const sessionPath = useStore((state) => state.currentSessionPath);
  const sessionId = useStore((state) => state.currentSessionId);
  const connected = useStore((state) => state.connected);
  const streaming = useStore((state) => !!state.currentSessionPath
    && sessionScopedListIncludes(state, state.streamingSessions, state.currentSessionPath));
  const awaitingApproval = useStore((state) => !!state.currentSessionPath
    && !!sessionScopedValue(state, state.pendingSessionConfirmationsByPath, state.currentSessionPath));
  const inlineError = useStore((state) => !!state.currentSessionPath
    && !!sessionScopedValue(state, state.inlineErrors, state.currentSessionPath));

  useEffect(() => {
    const context: PetContext | null = agentId && sessionPath ? {
      agentId, agentName, sessionPath, sessionId: sessionId || null,
      connected, streaming, awaitingApproval, inlineError,
    } : null;
    void window.platform?.petSyncContext?.(context)?.catch(() => {});
  }, [agentId, agentName, sessionPath, sessionId, connected, streaming, awaitingApproval, inlineError]);

  return null;
}
