import { useEffect, useRef, useState } from 'react';
import { useStore } from '../stores';
import { saveXingyeRoleProfile, xingyeProfileConnectionKey, type XingyeRoleProfile } from './xingye-profile-store';
import styles from './XingyeCharacterCardEditor.module.css';

type CardFields = Pick<XingyeRoleProfile, 'scenario' | 'firstMessage' | 'alternateGreetings' | 'messageExample'>;
const fieldsFrom = (profile: XingyeRoleProfile | null): CardFields => ({
  scenario: profile?.scenario ?? '', firstMessage: profile?.firstMessage ?? '',
  alternateGreetings: [...(profile?.alternateGreetings ?? [])], messageExample: profile?.messageExample ?? '',
});

export function XingyeCharacterCardEditor({ agentId, profile, onSaved }: {
  agentId: string;
  profile: XingyeRoleProfile | null;
  onSaved?: (profile: XingyeRoleProfile) => void;
}) {
  const connectionKey = useStore(state => xingyeProfileConnectionKey(state));
  const scope = `${connectionKey}:${agentId}`;
  const activeScope = useRef(scope);
  activeScope.current = scope;
  const mounted = useRef(true);
  const [fields, setFields] = useState<CardFields>(() => fieldsFrom(profile));
  const [saving, setSaving] = useState(false);
  const [readyScope, setReadyScope] = useState(scope);
  const previousSource = useRef({ scope, profile });
  const dirty = useRef(new Set<keyof CardFields>());
  const [notice, setNotice] = useState('');
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const previous = previousSource.current;
    if (previous.scope === scope && dirty.current.size > 0) {
      previousSource.current = { scope, profile };
      setFields(current => ({
        ...fieldsFrom(profile),
        ...Object.fromEntries([...dirty.current].map(key => [key, current[key]])),
      }));
      setNotice('已保存资料有更新；你的未保存编辑仍然保留，可继续保存或重新载入。');
      return;
    }
    dirty.current.clear();
    if (previous.scope !== scope && previous.profile === profile) {
      setFields(fieldsFrom(null));
      setReadyScope('');
      setNotice('角色或连接已切换，等待当前资料加载。');
    } else {
      previousSource.current = { scope, profile };
      setReadyScope(scope);
      setFields(fieldsFrom(profile));
      setNotice('');
    }
    setSaving(false);
  }, [scope, profile]);

  const save = async () => {
    if (saving || readyScope !== scope) return;
    if (dirty.current.size === 0) { setNotice('没有需要保存的修改。'); return; }
    const startedScope = scope;
    const patch = Object.fromEntries([...dirty.current].map(key => [key, fields[key]]));
    setSaving(true);
    setNotice('');
    try {
      const saved = await saveXingyeRoleProfile(agentId, patch);
      if (!mounted.current || activeScope.current !== startedScope) return;
      dirty.current.clear();
      setNotice('已保存。开场在开始新聊天时选用；已有聊天不会被改写。');
      onSaved?.(saved);
    } catch (error) {
      if (mounted.current && activeScope.current === startedScope) setNotice(error instanceof Error ? error.message : '保存失败，请重试。');
    } finally {
      if (mounted.current && activeScope.current === startedScope) setSaving(false);
    }
  };
  const changeFields = (key: keyof CardFields, change: (current: CardFields) => CardFields) => { dirty.current.add(key); setFields(change); };
  const update = (key: 'scenario' | 'firstMessage' | 'messageExample', value: string) => changeFields(key, current => ({ ...current, [key]: value }));

  return (
    <details className={styles.editor}>
      <summary>角色卡场景、开场与表达示例</summary>
      <p>场景和示例分别使用 2000 / 4000 字符预算；完整原文保留。开场最多 16000 字符。支持 {'{{char}}'} / {'{{user}}'}，其它模板不会执行。</p>
      <fieldset disabled={saving || readyScope !== scope}>
        <label>默认场景<textarea aria-label="默认场景" value={fields.scenario} onChange={event => update('scenario', event.target.value)} /></label>
        <label>默认开场<textarea aria-label="默认开场" value={fields.firstMessage} onChange={event => update('firstMessage', event.target.value)} /></label>
        <p>备用开场可包含多行；每项单独保存。</p>
        {fields.alternateGreetings?.map((greeting, index) => (
          <div key={index} className={styles.alternate}>
            <label>备用开场 {index + 1}<textarea aria-label={`备用开场 ${index + 1}`} value={greeting} onChange={event => changeFields('alternateGreetings', current => ({ ...current, alternateGreetings: current.alternateGreetings?.map((item, at) => at === index ? event.target.value : item) }))} /></label>
            <button type="button" onClick={() => changeFields('alternateGreetings', current => ({ ...current, alternateGreetings: current.alternateGreetings?.filter((_item, at) => at !== index) }))}>删除备用开场 {index + 1}</button>
          </div>
        ))}
        <button type="button" onClick={() => changeFields('alternateGreetings', current => ({ ...current, alternateGreetings: [...(current.alternateGreetings ?? []), ''] }))}>添加备用开场</button>
        <label>表达示例<textarea aria-label="表达示例" value={fields.messageExample} onChange={event => update('messageExample', event.target.value)} /></label>
        <p>示例仅用于表达参考，不会成为真实聊天或记忆。清空字段后保存即移除该内容。</p>
        {dirty.current.size > 0 && <button type="button" onClick={() => { dirty.current.clear(); setFields(fieldsFrom(profile)); setNotice('已重新载入保存的角色卡文本。'); }}>重新载入已保存文本</button>}
        <button type="button" onClick={() => { void save(); }}>{saving ? '保存中…' : '保存角色卡文本'}</button>
      </fieldset>
      {notice && <p role="status">{notice}</p>}
    </details>
  );
}