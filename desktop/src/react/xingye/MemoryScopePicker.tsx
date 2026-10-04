import { useEffect, useRef, useState } from 'react';
import { hanaFetch } from '../hooks/use-hana-fetch';
import { loadSessions } from '../stores/session-actions';
import type { MemoryScopeContext } from '../../../../shared/memory-scope.ts';

export function MemoryScopePicker({ sessionId, agentId, onChange }: {
  sessionId: string; agentId: string; onChange?: () => void;
}) {
  const [scope, setScope] = useState<MemoryScopeContext | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    setScope(null); setError(''); setBusy(false);
    if (!sessionId) return;
    void hanaFetch(`/api/sessions/memory-scope?sessionId=${encodeURIComponent(sessionId)}`, { throwOnHttpError: false })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '无法读取记忆范围');
        if (current === generation.current) setScope(data.memoryScope);
      }).catch((reason) => { if (current === generation.current) setError(String(reason.message || reason)); });
    return () => { generation.current += 1; };
  }, [sessionId, agentId]);
  async function save() {
    if (!scope || busy) return;
    const current = generation.current;
    setBusy(true); setError('');
    try {
      const response = await hanaFetch('/api/sessions/memory-scope', {
        method: 'PUT', headers: { 'content-type': 'application/json' }, throwOnHttpError: false,
        body: JSON.stringify({ sessionId, memoryScope: { ...scope, agentId } }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '无法保存记忆范围');
      if (current !== generation.current) return;
      setScope(data.memoryScope); onChange?.();
      void loadSessions();
    } catch (reason: unknown) {
      if (current === generation.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally { if (current === generation.current) setBusy(false); }
  }
  return <fieldset disabled={busy || !scope} style={{ margin: '12px 0', padding: 12 }}>
    <legend>记忆范围</legend>
    <p>旧记录保留在兼容范围。现实和剧情只读取已明确归属的记忆、关系和世界书，不会自动搬入旧摘要、角色卡场景或置顶内容。基础角色人格仍保留。已有对话请用剧情分支，或新建空白聊天（不含开场白）后设置。</p>
    {scope && <>
      <label>类型 <select aria-label="记忆范围类型" value={scope.realm} onChange={event => {
        const realm = event.target.value as MemoryScopeContext['realm'];
        setScope({ version: 1, agentId, realm, knowledge: realm === 'story' ? 'character' : 'shared', viewpoint: 'character',
          ...(realm === 'story' ? { worldId: '', branchId: 'main', characterId: agentId } : {}) });
      }}><option value="legacy">兼容旧记录</option><option value="reality">现实</option><option value="story">剧情（禁用现实操作）</option></select></label>
      {scope.realm === 'story' && <>
        <label> 世界 <input aria-label="世界标识" value={scope.worldId || ''} onChange={event => setScope({ ...scope, worldId: event.target.value })} /></label>
        <label> 分支 <input aria-label="剧情分支标识" value={scope.branchId || ''} onChange={event => setScope({ ...scope, branchId: event.target.value })} /></label>
        <label> 视角 <select aria-label="角色知识视角" value={scope.viewpoint || 'character'} onChange={event => setScope({ ...scope,
          viewpoint: event.target.value as 'author' | 'character', knowledge: event.target.value === 'author' ? 'author' : 'character', characterId: scope.characterId || agentId })}>
          <option value="character">角色已知</option><option value="author">作者 / 导演（含秘密）</option>
        </select></label>
        {scope.viewpoint !== 'author' && <label> 角色 <input aria-label="视角角色标识" value={scope.characterId || agentId} onChange={event => setScope({ ...scope, characterId: event.target.value })} /></label>}
        <label> 新记忆可见性 <select aria-label="新记忆可见性" value={scope.knowledge} onChange={event => setScope({ ...scope, knowledge: event.target.value as MemoryScopeContext['knowledge'], characterId: scope.characterId || agentId })}>
          <option value="character">仅当前角色</option><option value="shared">分支内共同知识</option><option value="author">仅作者 / 导演</option>
        </select></label>
      </>}
      <button type="button" disabled={busy} onClick={() => void save()}>{busy ? '保存中…' : '保存范围'}</button>
    </>}
    {error && <p role="alert">{error}</p>}
  </fieldset>;
}
