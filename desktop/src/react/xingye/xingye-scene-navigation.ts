import { hanaFetch } from '../hooks/use-hana-fetch';
import { useStore } from '../stores';
import { switchSession } from '../stores/session-actions';

/** Resolve a stable Pi entry ID against the current branch before using the UI display index. */
export async function navigateXingyeSceneSource(
  agentId: string,
  sessionId: string,
  entryId: string,
  onExit: () => void,
): Promise<void> {
  const session = useStore.getState().sessions.find(row => row.sessionId === sessionId && row.agentId === agentId);
  if (!session) throw new Error('原会话不在当前角色的会话列表中');
  const response = await hanaFetch(`/api/sessions/messages?sessionId=${encodeURIComponent(sessionId)}&all=1`);
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error || '无法定位原消息');
  const message = (Array.isArray(data.messages) ? data.messages : []).find((row: { entryId?: string }) => row.entryId === entryId);
  const messageIndex = Number(message?.id);
  if (!message || !Number.isInteger(messageIndex)) throw new Error('原消息已不在当前分支');
  await switchSession(session.path);
  if (useStore.getState().currentSessionPath !== session.path) throw new Error('无法切换到原会话');
  useStore.getState().requestMessageLocate({ sessionPath: session.path, messageIndex, term: '' });
  onExit();
}
