import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../stores';
import { requireServerConnection } from '../services/server-connection';
import { emptyStudioSession, loadStudioSession, saveStudioSession } from './lore-studio-session';
import type { StudioSession, StudioProfileField } from './lore-studio-types';
import { flattenProfilePatch } from './lore-studio-apply';
import { listLoreEntries } from './xingye-lore-store';
import { saveXingyeRoleProfile, xingyeProfileConnectionKey, type XingyeRoleProfile } from './xingye-profile-store';
import { postRehearsalTurn } from './rehearsal-workshop-api';
import { emptyRehearsalDraft, normalizeRehearsalDraft, normalizeRehearsalPatch, REHEARSAL_SCENES, type RehearsalScene, type RehearsalVariant } from './rehearsal-workshop-state';
import styles from './LoreStudioDrawer.module.css';

const FIELD_LABELS: Record<StudioProfileField, string> = {
  shortBio: '简介', identitySummary: '身份摘要', backgroundSummary: '背景摘要', personalitySummary: '人格摘要',
  behaviorLogic: '行为逻辑', values: '价值观', taboos: '禁忌', relationshipMode: '关系模式', speakingStyle: '说话风格',
};
interface Props {
  agentId: string;
  profile: Record<string, unknown>;
  onClose: () => void;
  onAdopted: (patch: Partial<XingyeRoleProfile>) => void;
}
/** Draft-only workshop. The only formal write is the explicit adoption handler. */
export function RehearsalWorkshop({ agentId, profile, onClose, onAdopted }: Props) {
  const [session, setSession] = useState<StudioSession>(() => emptyStudioSession(agentId));
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [adopting, setAdopting] = useState(false);
  const [error, setError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [status, setStatus] = useState('');
  const [selectedFields, setSelectedFields] = useState<StudioProfileField[]>([]);
  const owner = useRef({ agentId, connectionKey: xingyeProfileConnectionKey() });
  const active = useRef(true);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const saveVersion = useRef(0);
  const draft = session.rehearsal ?? emptyRehearsalDraft();
  const selected = draft.variants.find(v => v.id === draft.selectedId);
  const current = useCallback(() => active.current && owner.current.agentId === agentId && owner.current.connectionKey === xingyeProfileConnectionKey(), [agentId]);

  useEffect(() => {
    active.current = true;
    const unsubscribe = useStore.subscribe(() => {
      if (owner.current.connectionKey !== xingyeProfileConnectionKey()) {
        generation.current += 1;
        controller.current?.abort();
      }
    });
    void loadStudioSession(agentId).then(loaded => {
      if (!current()) return;
      setSession({ ...(loaded ?? emptyStudioSession(agentId)), rehearsal: normalizeRehearsalDraft(loaded?.rehearsal) });
      setReady(true);
    }).catch(() => {
      if (current()) setError('无法读取草稿。为保护已保存内容，请关闭后重试。');
    });
    return () => {
      active.current = false;
      generation.current += 1;
      controller.current?.abort();
      unsubscribe();
    };
    // The owner is fixed for this mounted workshop; RoleDetailPanel keys by agent and connection.
  }, [agentId, current]);

  useEffect(() => {
    if (!ready || !current()) return;
    const ticket = ++saveVersion.current;
    void saveStudioSession(session, { strict: true, expectedConnectionKey: owner.current.connectionKey }).then(() => {
      if (current() && ticket === saveVersion.current) setSaveError('');
    }).catch(() => {
      if (current() && ticket === saveVersion.current) setSaveError('草稿尚未保存。请重试保存后再关闭。');
    });
  }, [session, ready, current]);

  function editDraft(edit: Partial<typeof draft>) {
    setSession(previous => ({ ...previous, rehearsal: { ...(previous.rehearsal ?? emptyRehearsalDraft()), ...edit } }));
    setStatus('');
  }
  function editVariant(patch: Partial<RehearsalVariant>) {
    editDraft({ variants: draft.variants.map(v => v.id === draft.selectedId ? { ...v, ...patch } : v) });
  }
  function cancel() {
    generation.current += 1;
    controller.current?.abort();
    setLoading(false);
    setStatus('本次生成已取消，已有草稿保留。');
  }
  async function generate() {
    if (!ready || loading || adopting || !current() || !draft.inputs[draft.scene].trim()) return;
    const ticket = ++generation.current;
    const requestController = new AbortController();
    controller.current = requestController;
    setLoading(true); setError(''); setStatus('');
    try {
      const pendingProfile = flattenProfilePatch(session.draftPlan?.profilePatch);
      const result = await postRehearsalTurn({
        agentId, profile: { ...profile, ...pendingProfile }, input: draft.inputs[draft.scene], mode: draft.mode,
        previousText: selected?.text ?? (draft.mode === 'greeting' && typeof profile.firstMessage === 'string' ? profile.firstMessage : ''),
        feedback: draft.feedback,
        loreEntries: [
          ...listLoreEntries(agentId).filter(entry => entry.enabled && entry.visibility !== 'private'),
          ...(session.draftPlan?.loreEntries ?? []),
        ].slice(0, 12).map(entry => ({ title: entry.title, content: entry.content })),
      }, { signal: requestController.signal, connection: requireServerConnection(useStore.getState(), '存储连接不可用，请重新连接。') });
      if (!current() || ticket !== generation.current || requestController.signal.aborted) return;
      const variant: RehearsalVariant = { ...result, id: crypto.randomUUID(), scene: draft.scene, mode: draft.mode, input: draft.inputs[draft.scene], feedback: draft.feedback };
      editDraft({ variants: [...draft.variants, variant].slice(-30), selectedId: variant.id });
      setSelectedFields([]);
    } catch (err) {
      if (current() && ticket === generation.current && !requestController.signal.aborted) setError(err instanceof Error ? err.message : '试演失败，请重试。');
    } finally {
      if (current() && ticket === generation.current) setLoading(false);
    }
  }
  async function adopt(kind: 'profile' | 'example' | 'greeting') {
    if (!selected || loading || adopting || !current()) return;
    let patch: Partial<XingyeRoleProfile>;
    if (kind === 'profile') {
      patch = flattenProfilePatch(normalizeRehearsalPatch(selected.profilePatch).filter(p => selectedFields.includes(p.field)));
    } else if (kind === 'example') {
      if (!selected.text.trim()) return;
      patch = { messageExample: `<START>\n{{user}}: ${selected.input.trim()}\n{{char}}: ${selected.text.trim()}` };
    } else {
      if (!selected.text.trim()) return;
      patch = { firstMessage: selected.text.trim() };
    }
    if (!Object.keys(patch).length) return;
    setAdopting(true); setError(''); setStatus('');
    try {
      await saveXingyeRoleProfile(agentId, patch);
      if (!current()) return;
      onAdopted(patch);
      setStatus(kind === 'greeting' ? '已采纳为未来新聊天的默认开场，已有聊天保持原样。' : kind === 'example' ? '已采纳为角色示例对白，替换原示例；试演没有写入聊天或记忆。' : '已保存勾选的人设补丁。');
    } catch (err) {
      if (current()) setError(`采纳失败：${err instanceof Error ? err.message : '请重试'}`);
    } finally {
      if (current()) setAdopting(false);
    }
  }
  return (
    <div className={styles.overlay}>
      <section className={styles.drawer} role="dialog" aria-modal="true" aria-label="设定试演与开场白工坊">
        <header className={styles.header}>
          <div><div className={styles.headerTitle}>设定试演与开场白工坊</div><div className={styles.headerSub}>草稿保留 · 明确采纳后才修改角色</div></div>
          <button type="button" className={styles.closeBtn} aria-label="关闭试演工坊" disabled={adopting} onClick={() => { cancel(); onClose(); }}>×</button>
        </header>
        <div className={styles.body}>
          <p className={styles.introHint}>试演不执行工具、不写入正式聊天、关系或长期记忆。使用当前表单与待确认设定草稿；每次生成会调用已配置模型。</p>
          <div role="group" aria-label="试演场景">
            {(Object.keys(REHEARSAL_SCENES) as RehearsalScene[]).map(key => <button key={key} type="button" className={styles.chip} aria-pressed={draft.scene === key} disabled={!ready || loading || adopting} onClick={() => editDraft({ scene: key })}>{REHEARSAL_SCENES[key].label}</button>)}
          </div>
          <label>创作类型<select aria-label="创作类型" value={draft.mode} disabled={!ready || loading || adopting} onChange={event => editDraft({ mode: event.target.value === 'greeting' ? 'greeting' : 'scene' })}><option value="scene">短场景试演</option><option value="greeting">开场白</option></select></label>
          <label>可编辑情境<textarea className={styles.introTextarea} aria-label="试演输入" maxLength={8000} rows={3} value={draft.inputs[draft.scene]} disabled={!ready || loading || adopting} onChange={event => editDraft({ inputs: { ...draft.inputs, [draft.scene]: event.target.value } })} /></label>
          <label>对上一稿的反馈<textarea className={styles.composerTextarea} aria-label="试演反馈" maxLength={8000} rows={2} value={draft.feedback} disabled={!ready || loading || adopting} onChange={event => editDraft({ feedback: event.target.value })} /></label>
          <div><button type="button" disabled={!ready || loading || adopting || !draft.inputs[draft.scene].trim()} onClick={() => void generate()}>{selected ? '根据反馈再试' : '开始试写'}</button>{loading && <button type="button" onClick={cancel}>取消生成</button>}</div>
          {draft.variants.length > 0 && <label>对比草稿<select aria-label="选择试演草稿" value={draft.selectedId} disabled={loading || adopting} onChange={event => { editDraft({ selectedId: event.target.value }); setSelectedFields([]); }}>{draft.variants.map((v, index) => <option key={v.id} value={v.id}>第 {index + 1} 稿 · {REHEARSAL_SCENES[v.scene].label} · {v.mode === 'greeting' ? '开场' : '试演'}</option>)}</select></label>}
          {selected && <>
            <p className={styles.introHint}>本稿情境：{selected.input}</p>
            <label>可编辑正文<textarea className={styles.introTextarea} aria-label="试演正文" rows={6} maxLength={8000} value={selected.text} disabled={loading || adopting} onChange={event => editVariant({ text: event.target.value })} /></label>
            <p>行为理由：{selected.rationale || '本稿未提供理由，请反馈后再试。'}</p>
            {draft.variants.filter(v => v.id !== selected.id).map((v, index) => <details key={v.id}><summary>对照稿 {index + 1} · {REHEARSAL_SCENES[v.scene].label}</summary><p className={styles.introHint}>{v.text}</p><p>{v.rationale}</p></details>)}
            {selected.profilePatch.map((p, index) => <div key={p.field}>
              <label><input type="checkbox" checked={selectedFields.includes(p.field)} disabled={loading || adopting} onChange={event => setSelectedFields(fields => event.target.checked ? [...fields, p.field] : fields.filter(field => field !== p.field))} />采纳{FIELD_LABELS[p.field]}</label>
              <p className={styles.introHint}>当前：{String(profile[p.field] ?? '（空）')}</p>
              <textarea className={styles.composerTextarea} aria-label={`${FIELD_LABELS[p.field]}补丁`} value={p.value} maxLength={3000} disabled={loading || adopting} onChange={event => editVariant({ profilePatch: selected.profilePatch.map((item, i) => i === index ? { ...item, value: event.target.value } : item) })} />
              <p className={styles.introHint}>{p.rationale}</p>
            </div>)}
            <button type="button" disabled={loading || adopting || !selectedFields.length} onClick={() => void adopt('profile')}>采纳勾选的人设补丁</button>
            <p className={styles.introHint}>以下操作替换角色的默认开场或示例对白；已有聊天不会被修改。示例会完整保存，实际对话按 4000 字符预算使用。当前默认开场：{String(profile.firstMessage ?? '（空）')}</p>
            <details><summary>查看将被替换的示例对白</summary><p>{String(profile.messageExample ?? '（空）')}</p></details>
            <button type="button" disabled={loading || adopting || !selected.text.trim()} onClick={() => void adopt('greeting')}>采纳为新聊天默认开场</button>
            <button type="button" disabled={loading || adopting || !selected.text.trim()} onClick={() => void adopt('example')}>采纳为角色示例对白</button>
          </>}
          {error && <p role="alert">{error}</p>}
          {saveError && <p role="alert">{saveError}<button type="button" onClick={() => setSession(previous => ({ ...previous }))}>重试保存草稿</button></p>}
          {status && <p role="status">{status}</p>}
        </div>
      </section>
    </div>
  );
}