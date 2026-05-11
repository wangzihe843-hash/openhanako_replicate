import type { Agent } from '../types';
import { getPhoneContactListTitle, type XingyePhoneContactView } from './xingye-phone-store';
import styles from './XingyeShell.module.css';

interface PhoneContactDetailProps {
  contact: XingyePhoneContactView;
  agents: Agent[];
  remarkDraft: string;
  impressionDraft: string;
  relationDraft: string;
  tagsDraft: string;
  factionDraft: string;
  onChange: (field: 'remark' | 'impression' | 'relation' | 'tags' | 'faction', value: string) => void;
  onSave: () => void;
  onBlockToggle: () => void;
  onDeleteToggle: () => void;
  onLinkAgent: (linkedAgentId: string) => void;
  onUnlinkAgent: () => void;
  onOpenSms: () => void;
}

export function PhoneContactDetail({
  contact,
  agents,
  remarkDraft,
  impressionDraft,
  relationDraft,
  tagsDraft,
  factionDraft,
  onChange,
  onSave,
  onBlockToggle,
  onDeleteToggle,
  onLinkAgent,
  onUnlinkAgent,
  onOpenSms,
}: PhoneContactDetailProps) {
  const linkOptions = agents.filter(agent => agent.id !== contact.ownerAgentId);
  const listTitle = getPhoneContactListTitle(contact);
  return (
    <section className={styles.phoneAppCard}>
      <h3 className={styles.phoneAppTitle}>{listTitle}</h3>
      <p className={styles.phoneAppHint}>
        类型：{contact.targetType} · 状态：{contact.status} · source：{contact.source ?? 'manual'}
      </p>
      {contact.shortBio?.trim() ? <p className={styles.phoneAppHint}>简介：{contact.shortBio}</p> : null}
      {contact.generatedReason?.trim() ? (
        <p className={styles.phoneGeneratedReason}>生成依据：{contact.generatedReason}</p>
      ) : null}
      {contact.linkedAgentId ? <p className={styles.phoneAppHint}>已关联角色：{contact.linkedAgentId}</p> : null}

      <label className={styles.phoneFormField}>
        <span>备注</span>
        <input value={remarkDraft} onChange={event => onChange('remark', event.target.value)} />
      </label>
      <label className={styles.phoneFormField}>
        <span>大概印象</span>
        <textarea rows={4} value={impressionDraft} onChange={event => onChange('impression', event.target.value)} />
      </label>
      <label className={styles.phoneFormField}>
        <span>关系提示</span>
        <input value={relationDraft} onChange={event => onChange('relation', event.target.value)} />
      </label>
      <label className={styles.phoneFormField}>
        <span>标签（逗号分隔）</span>
        <input value={tagsDraft} onChange={event => onChange('tags', event.target.value)} />
      </label>
      <label className={styles.phoneFormField}>
        <span>势力阵营</span>
        <input value={factionDraft} onChange={event => onChange('faction', event.target.value)} />
      </label>

      {contact.targetType === 'virtual_contact' ? (
        <div className={styles.phoneActionRow}>
          <select className={styles.phoneInlineSelect} defaultValue={contact.linkedAgentId ?? ''} onChange={event => onLinkAgent(event.target.value)}>
            <option value="">关联现有角色（占位）</option>
            {linkOptions.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
          </select>
          {contact.linkedAgentId ? <button type="button" className={styles.secondaryButton} onClick={onUnlinkAgent}>取消关联</button> : null}
        </div>
      ) : null}

      <div className={styles.phoneActionRow}>
        <button type="button" className={styles.secondaryButton} onClick={onSave}>保存</button>
        <button type="button" className={styles.secondaryButton} onClick={onOpenSms} disabled={contact.targetType === 'user'}>
          {contact.targetType === 'user' ? '用户短信后续接入' : '查看短信'}
        </button>
      </div>
      <div className={styles.phoneActionRow}>
        <button type="button" className={styles.phoneWeakAction} onClick={onBlockToggle}>
          {contact.status === 'blocked' ? '取消拉黑' : '拉黑'}
        </button>
        <button type="button" className={styles.phoneWeakAction} onClick={onDeleteToggle}>
          {contact.status === 'deleted' ? '恢复联系人' : '删除联系人'}
        </button>
      </div>
    </section>
  );
}
