import { useStore } from '../stores';
import type { Session } from '../types';
import {
  createNewSession,
  ensureSession,
  loadSessions,
  switchSession,
} from '../stores/session-actions';

function sessionModifiedTime(session: Session): number {
  const parsed = Date.parse(session.modified || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

export function findLatestSessionForAgent(
  sessions: Session[],
  agentId: string,
): Session | null {
  return sessions
    .filter((session) => session.agentId === agentId)
    .sort((a, b) => sessionModifiedTime(b) - sessionModifiedTime(a))[0] ?? null;
}

export async function enterXingyeAgentChat(agentId: string): Promise<void> {
  const existingSession = findLatestSessionForAgent(useStore.getState().sessions, agentId);
  if (existingSession) {
    await switchSession(existingSession.path);
    return;
  }

  await createNewSession();
  useStore.setState({ selectedAgentId: agentId });

  const created = await ensureSession();
  if (!created) {
    throw new Error('Failed to create OpenHanako native session for Xingye role.');
  }

  await loadSessions();
}
