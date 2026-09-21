import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../stores';
import { hanaFetch } from '../hooks/use-hana-fetch';
import { resolveServerConnection } from '../services/server-connection';
import { normalizeXingyeExpressionPresets, type XingyeExpressionPresets } from '../../../../shared/xingye-expression-presets';
import { EffectiveExpressionPresets, ExpressionPresetFields } from './ExpressionPresetFields';
import styles from './XingyeExpressionControls.module.css';

type Scene = { text: string; remainingTurns: number | null; presets?: XingyeExpressionPresets };
type ControlState = { agentId: string; sessionId: string; presets: XingyeExpressionPresets; scene: Scene | null };
type Props = { agentId: string; sessionId: string; busy: boolean };

/** Remount on owner/connection changes so late responses cannot cross scopes. */
export function XingyeExpressionControls(props: Props) {
  const connectionKey = useStore(state => JSON.stringify(resolveServerConnection(state)));
  return <ExpressionControlsSession key={JSON.stringify([connectionKey, props.agentId, props.sessionId])} {...props} />;
}

function ExpressionControlsSession({ agentId, sessionId, busy }: Props) {
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<ControlState | null>(null);
  const [presets, setPresets] = useState<XingyeExpressionPresets>({});
  const [overrides, setOverrides] = useState<XingyeExpressionPresets>({});
  const [text, setText] = useState('');
  const [duration, setDuration] = useState('1');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const savingRef = useRef(false);
  const refreshAfterSave = useRef(false);
  const dirty = useRef({ presets: false, scene: false });
  const mounted = useRef(true);
  const requestVersion = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const accept = useCallback((raw: ControlState, syncPresets: boolean, syncScene: boolean) => {
    if (raw.agentId !== agentId || raw.sessionId !== sessionId) throw new Error('会话已切换，请重新打开表达控制。');
    const next = { ...raw, presets: normalizeXingyeExpressionPresets(raw.presets) };
    setSaved(next);
    if (syncPresets) setPresets(next.presets);
    if (syncScene) {
      setText(next.scene?.text ?? '');
      setOverrides(normalizeXingyeExpressionPresets(next.scene?.presets));
      setDuration(next.scene ? String(next.scene.remainingTurns ?? 'scene') : '1');
    }
  }, [agentId, sessionId]);

  useEffect(() => {
    if (busy) return;
    if (savingRef.current) { refreshAfterSave.current = true; return; }
    const version = ++requestVersion.current;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void hanaFetch(`/api/sessions/expression-controls?sessionId=${encodeURIComponent(sessionId)}`, { signal: controller.signal })
      .then(response => response.json())
      .then((data: ControlState) => {
        if (!controller.signal.aborted && mounted.current && version === requestVersion.current) {
          accept(data, !dirty.current.presets, !dirty.current.scene);
        }
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted && mounted.current && version === requestVersion.current) setError(`读取失败：${reason instanceof Error ? reason.message : String(reason)}`);
      })
      .finally(() => {
        if (!controller.signal.aborted && mounted.current && version === requestVersion.current) setLoading(false);
      });
    return () => controller.abort();
  }, [busy, sessionId, accept, reload]);

  async function save(patch: { presets?: XingyeExpressionPresets; scene?: Scene | null }) {
    if (busy || savingRef.current || loading) return;
    const version = ++requestVersion.current;
    savingRef.current = true;
    setSaving(true);
    setError('');
    try {
      const response = await hanaFetch('/api/sessions/expression-controls', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, agentId, ...patch }),
      });
      const data = await response.json() as ControlState;
      if (!mounted.current || version !== requestVersion.current) return;
      accept(data, patch.presets !== undefined, patch.scene !== undefined);
      if (patch.presets !== undefined) dirty.current.presets = false;
      if (patch.scene !== undefined) dirty.current.scene = false;
    } catch (reason) {
      if (mounted.current && version === requestVersion.current) setError(`保存失败：${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      savingRef.current = false;
      if (mounted.current) {
        setSaving(false);
        if (refreshAfterSave.current) { refreshAfterSave.current = false; setReload(value => value + 1); }
      }
    }
  }

  const disabled = busy || saving || loading || !saved;
  return <details className={styles.panel} open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>场景与表达{saved?.scene ? ` · ${saved.scene.remainingTurns === null ? '本场景生效' : `剩余 ${saved.scene.remainingTurns} 轮`}` : ''}</summary>
    {open && <div className={styles.body}>
      <p>仅当前角色的当前主聊天会话生效。刷新后保留，服务重启后清空；不写入永久人设或记忆。请求被接受后即计入一轮，失败或取消也会消耗；重试使用当时剩余的配置。</p>
      {error && <><p className={styles.error} role="alert">{error}</p><div className={styles.actions}><button type="button" disabled={busy || saving || loading} onClick={() => setReload(value => value + 1)}>重新读取</button></div></>}
      {loading && <p role="status">正在读取当前配置…</p>}
      {saved && <>
        <strong>当前有效配置</strong>
        <EffectiveExpressionPresets presets={saved.presets} overrides={saved.scene?.presets} />
        {saved.scene && <p>激活的场景指令：{saved.scene.text || '仅临时表达覆盖'} · {saved.scene.remainingTurns === null ? '直到关闭' : `剩余 ${saved.scene.remainingTurns} 轮`}</p>}
      </>}
      <strong>会话表达预设</strong>
      <ExpressionPresetFields value={presets} disabled={disabled} onChange={value => { dirty.current.presets = true; setPresets(value); }} />
      <div className={styles.actions}><button type="button" disabled={disabled} onClick={() => void save({ presets })}>保存会话预设</button></div>
      <label>临时场景指令<textarea aria-label="临时场景指令" maxLength={2000} rows={3} disabled={disabled} value={text}
        placeholder="例如：用可观察动作表现犹豫，不替我决定下一步。"
        onChange={event => { dirty.current.scene = true; setText(event.target.value); }} /></label>
      <label>有效期 <select aria-label="场景有效期" disabled={disabled} value={duration}
        onChange={event => { dirty.current.scene = true; setDuration(event.target.value); }}>
        {Array.from({ length: 20 }, (_, index) => index + 1).map(turns => <option key={turns} value={turns}>{turns === 1 ? '下一轮' : `接下来 ${turns} 轮`}</option>)}
        <option value="scene">本场景直到关闭</option>
      </select></label>
      <ExpressionPresetFields mode="scene" value={overrides} disabled={disabled} onChange={value => { dirty.current.scene = true; setOverrides(value); }} />
      <div className={styles.actions}>
        <button type="button" disabled={disabled || (!text.trim() && Object.keys(overrides).length === 0)} onClick={() => void save({ scene: { text: text.trim(), remainingTurns: duration === 'scene' ? null : Number(duration), presets: overrides } })}>应用临时场景</button>
        <button type="button" disabled={disabled || !saved?.scene} onClick={() => void save({ scene: null })}>关闭临时场景</button>
      </div>
    </div>}
  </details>;
}
