import { useEffect, useRef, useState } from 'react';
import { useStore } from '../stores';
import { hanaFetch } from '../hooks/use-hana-fetch';
import { loadSessions, switchSession } from '../stores/session-actions';
import { resolveServerConnection } from '../services/server-connection';
import { renderCharacterCardText } from '../../../../shared/xingye-character-card';
import type { XingyeRoleProfile } from './xingye-profile-store';
import styles from './XingyeGreetingLauncher.module.css';

type Props = { agentId: string; profile: XingyeRoleProfile | null; onCreated?: () => void };

/** Switching role/server remounts the request owner; late creation never steals the new view. */
export function XingyeGreetingLauncher(props: Props) {
  const connectionKey = useStore(state => JSON.stringify(resolveServerConnection(state)));
  return <GreetingLauncher key={`${connectionKey}:${props.agentId}`} {...props} />;
}

function GreetingLauncher({ agentId, profile, onCreated }: Props) {
  const userName = useStore(state => state.userName);
  const agentName = useStore(state => state.agents.find(agent => agent.id === agentId)?.name);
  const [index, setIndex] = useState(profile?.firstMessage?.trim() ? 0 : -1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const active = useRef(true);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; controller.current?.abort(); };
  }, []);
  const options = [profile?.firstMessage ?? '', ...(profile?.alternateGreetings ?? [])];
  const raw = index === -1 ? '' : options[index] ?? '';
  const rendered = renderCharacterCardText(raw, profile?.displayName || agentName || agentId, userName || 'User');
  const tooLong = raw.length > 16_000 || rendered.length > 16_000;
  const valid = index === -1 || !!raw.trim();

  async function create() {
    if (inFlight.current || !valid || tooLong) return;
    const connection = resolveServerConnection(useStore.getState());
    if (!connection) { setError('尚未连接服务器，请连接后重试。'); return; }
    const connectionKey = JSON.stringify(connection);
    const initial = useStore.getState();
    const originalView = JSON.stringify([initial.currentSessionPath, initial.currentSessionId, initial.selectedAgentId]);
    const ownsView = () => {
      const current = useStore.getState();
      return active.current && JSON.stringify(resolveServerConnection(current)) === connectionKey
        && JSON.stringify([current.currentSessionPath, current.currentSessionId, current.selectedAgentId]) === originalView;
    };
    inFlight.current = true;
    setBusy(true);
    setError('');
    const request = new AbortController();
    controller.current = request;
    try {
      const response = await hanaFetch('/api/sessions/new-detached', {
        method: 'POST', connection, signal: request.signal, timeout: 60_000, throwOnHttpError: false,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId, memoryEnabled: initial.memoryEnabled,
          xingyeGreetingIndex: index, xingyeGreetingExpectedText: raw, xingyeGreetingExpectedRenderedText: rendered }),
      });
      const data = await response.json();
      if (!response.ok || data.error) throw new Error(typeof data.error === 'string' ? data.error : '创建聊天失败。');
      if (data.agentId !== agentId || typeof data.path !== 'string' || !data.path || !data.sessionId) {
        throw new Error('服务器未返回完整的角色聊天信息。');
      }
      if (!ownsView()) return;
      await loadSessions();
      if (!ownsView()) return;
      await switchSession(data.path);
      if (active.current && JSON.stringify(resolveServerConnection(useStore.getState())) === connectionKey
        && useStore.getState().currentSessionPath === data.path) onCreated?.();
    } catch (reason) {
      if (active.current && !request.signal.aborted && ownsView()) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      inFlight.current = false;
      if (active.current) setBusy(false);
    }
  }

  return <section className={styles.panel} aria-label="新聊天开场白">
    <h4>新聊天开场白</h4>
    <p>只用于新建聊天；当前聊天不会被替换。开场由已保存的角色文本直接呈现。</p>
    <label>选择开场白<select value={index} disabled={busy} onChange={event => setIndex(Number(event.target.value))}>
      <option value={-1}>空白聊天（不用开场白）</option>
      {options.map((text, position) => text.trim() ? <option key={position} value={position}>
        {position === 0 ? '默认开场白' : `备选开场白 ${position}`}
      </option> : null)}
    </select></label>
    {raw ? <pre className={styles.preview}>{rendered}</pre> : <p>新聊天将从你的第一条消息开始。</p>}
    {tooLong && <p role="alert">开场白超过 16000 字符，请缩短并保存后再创建。</p>}
    <button type="button" disabled={busy || !valid || tooLong} onClick={() => { void create(); }}>
      {busy ? '正在创建…' : index === -1 ? '新建空白聊天' : '用此开场新建聊天'}
    </button>
    {error && <p role="alert">{error}</p>}
  </section>;
}
