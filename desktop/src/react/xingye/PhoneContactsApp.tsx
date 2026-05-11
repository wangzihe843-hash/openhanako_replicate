import { useMemo, useState } from 'react';
import type { Agent } from '../types';
import type { XingyeRoleProfileMap } from './xingye-profile-store';
import { XingyeAgentAvatar } from './XingyeAgentAvatar';
import {
  getPhoneContacts,
  savePhoneContactMeta,
  useXingyePhoneStorageVersion,
} from './xingye-phone-store';
import styles from './XingyeShell.module.css';

interface PhoneContactsAppProps {
  ownerAgent: Agent | null;
  agents: Agent[];
  currentAgentId: string | null;
  profiles: XingyeRoleProfileMap;
  onBack: () => void;
  onOpenSms: (targetAgentId: string) => void;
}

export function PhoneContactsApp({
  ownerAgent,
  agents,
  currentAgentId,
  profiles,
  onBack,
  onOpenSms,
}: PhoneContactsAppProps) {
  const _phoneStorageVersion = useXingyePhoneStorageVersion();
  const ownerAgentId = ownerAgent?.id ?? currentAgentId ?? '';
  const contacts = useMemo(
    () => getPhoneContacts(ownerAgentId, agents, profiles),
    [ownerAgentId, agents, profiles, _phoneStorageVersion],
  );
  const [selectedTargetAgentId, setSelectedTargetAgentId] = useState<string | null>(null);
  const selectedContact = contacts.find(contact => contact.targetAgentId === selectedTargetAgentId) ?? null;
  const [remarkDraft, setRemarkDraft] = useState('');
  const [impressionDraft, setImpressionDraft] = useState('');

  const openContact = (targetAgentId: string) => {
    const contact = contacts.find(item => item.targetAgentId === targetAgentId);
    setSelectedTargetAgentId(targetAgentId);
    setRemarkDraft(contact?.remark ?? '');
    setImpressionDraft(contact?.impression ?? '');
  };

  const saveContact = () => {
    if (!ownerAgentId || !selectedContact) return;
    savePhoneContactMeta(ownerAgentId, selectedContact.targetAgentId, {
      remark: remarkDraft,
      impression: impressionDraft,
      source: 'manual',
    });
  };

  return (
    <div className={styles.phoneShell} aria-label="通讯录">
      <div className={styles.phoneStatusBar}>
        <button type="button" className={styles.phoneBackButton} onClick={selectedContact ? () => setSelectedTargetAgentId(null) : onBack}>
          {selectedContact ? '返回列表' : '返回首页'}
        </button>
        <span>通讯录</span>
      </div>

      <div className={styles.phoneBody}>
        {!selectedContact ? (
          <>
            <section className={styles.phoneAppCard}>
              <h3 className={styles.phoneAppTitle}>联系人</h3>
              <p className={styles.phoneAppHint}>
                这是“{ownerAgent?.name ?? '当前角色'}眼中的其他角色”，备注与印象按 ownerAgentId + targetAgentId 分开保存。
              </p>
            </section>
            <section className={styles.phoneList} aria-label="通讯录角色列表">
              {contacts.map(contact => (
                <button
                  key={contact.targetAgentId}
                  className={styles.phoneListItem}
                  type="button"
                  onClick={() => openContact(contact.targetAgentId)}
                >
                  <span className={styles.phoneListAvatar}>
                    <XingyeAgentAvatar agent={contact.agent} alt={contact.remark} />
                  </span>
                  <span className={styles.phoneListText}>
                    <strong>{contact.remark}</strong>
                    <span>原名：{contact.targetName} / 星野名：{contact.targetDisplayName}</span>
                    <span>{contact.impression}</span>
                  </span>
                </button>
              ))}
              {contacts.length === 0 ? (
                <div className={styles.phoneEmptyStateCard}>当前没有可显示的其他角色联系人。</div>
              ) : null}
            </section>
          </>
        ) : (
          <section className={styles.phoneAppCard}>
            <div className={styles.phoneContactHeader}>
              <span className={styles.phoneContactAvatar}>
                <XingyeAgentAvatar agent={selectedContact.agent} alt={selectedContact.remark} />
              </span>
              <div className={styles.phoneContactHeading}>
                <h3 className={styles.phoneAppTitle}>{selectedContact.remark}</h3>
                <p className={styles.phoneAppHint}>原名：{selectedContact.targetName} / 星野名：{selectedContact.targetDisplayName}</p>
              </div>
            </div>

            <label className={styles.phoneFormField}>
              <span>当前角色对 TA 的备注</span>
              <input value={remarkDraft} onChange={event => setRemarkDraft(event.target.value)} placeholder="例如：小测试" />
            </label>

            <label className={styles.phoneFormField}>
              <span>当前角色对 TA 的大概印象</span>
              <textarea
                rows={4}
                value={impressionDraft}
                onChange={event => setImpressionDraft(event.target.value)}
                placeholder="例如：有点冒失，但很真诚。"
              />
            </label>

            <div className={styles.phoneTagRow}>
              <span>关系标签占位：{selectedContact.relationshipHint ?? '尚未设置'}</span>
            </div>

            <div className={styles.phoneActionRow}>
              <button type="button" className={styles.secondaryButton} onClick={saveContact}>
                保存备注与印象
              </button>
              <button type="button" className={styles.secondaryButton} onClick={() => onOpenSms(selectedContact.targetAgentId)}>
                查看短信
              </button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
