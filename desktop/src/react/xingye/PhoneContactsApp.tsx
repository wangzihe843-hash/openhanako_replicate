import { useEffect, useMemo, useState } from 'react';
import type { Agent } from '../types';
import { PhoneContactDetail } from './PhoneContactDetail';
import { PhoneContactSections } from './PhoneContactSections';
import { useXingyeRoleProfile, type XingyeRoleProfileMap } from './xingye-profile-store';
import { enrichContactsWithAI } from './xingye-phone-ai';
import {
  generateVirtualContactsWithAI,
  regenerateAllContactsWithAI,
  rollbackAndUpdateContactsWithAI,
  updateContactsFromRecentContextWithAI,
} from './xingye-phone-ai';
import {
  blockPhoneContact,
  deletePhoneContact,
  ensureGeneratedVirtualContacts,
  getContactAiUpdateState,
  getPhoneContactGenerationState,
  getPhoneContacts,
  getPhoneAiGenerationState,
  getPhoneProfileFingerprint,
  linkVirtualContactToAgent,
  restorePhoneContact,
  savePhoneContactMeta,
  unlinkVirtualContactFromAgent,
  type XingyePhoneContactView,
  useXingyePhoneStorageVersion,
} from './xingye-phone-store';
import styles from './XingyeShell.module.css';

interface PhoneContactsAppProps {
  ownerAgent: Agent | null;
  agents: Agent[];
  currentAgentId: string | null;
  profiles: XingyeRoleProfileMap;
  onBack: () => void;
  onOpenSms: (targetType: 'agent' | 'virtual_contact' | 'user', targetId: string) => void;
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
  const ownerProfile = useXingyeRoleProfile(ownerAgentId);
  const profileFingerprint = getPhoneProfileFingerprint(ownerAgent, ownerProfile);
  const contacts = useMemo(
    () => getPhoneContacts(ownerAgentId, agents, profiles, { includeDeleted: true }),
    [ownerAgentId, agents, profiles, _phoneStorageVersion],
  );
  const virtualContacts = contacts.filter(item => item.targetType === 'virtual_contact');
  const generationState = getPhoneContactGenerationState(ownerAgentId);
  const contactUpdateState = getContactAiUpdateState(ownerAgentId);
  const [selectedContactKey, setSelectedContactKey] = useState<string | null>(null);
  const selectedContact = contacts.find(contact => `${contact.targetType}:${contact.targetId}` === selectedContactKey) ?? null;
  const [remarkDraft, setRemarkDraft] = useState('');
  const [impressionDraft, setImpressionDraft] = useState('');
  const [relationDraft, setRelationDraft] = useState('');
  const [tagsDraft, setTagsDraft] = useState('');
  const [factionDraft, setFactionDraft] = useState('');
  const aiState = getPhoneAiGenerationState(ownerAgentId, 'contacts_enrichment');
  const [aiManageOpen, setAiManageOpen] = useState(false);
  const [aiManageNotice, setAiManageNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!ownerAgent || !ownerAgentId) return;
    if (virtualContacts.length > 0) return;
    if (generationState) return;
    generateVirtualContactsWithAI({
      ownerAgent,
      ownerProfile,
      contacts,
      agents,
      profiles,
      profileFingerprint,
      mode: 'initial_ai_generate',
    }).then((result) => {
      if (result.generatedBy === 'rule_fallback') {
        setAiManageNotice('AI 生成失败，已使用本地规则生成联系人。');
      } else {
        setAiManageNotice(result.notice ?? null);
      }
    }).catch(() => {
      ensureGeneratedVirtualContacts(ownerAgentId, ownerAgent, ownerProfile, agents, profiles);
      setAiManageNotice('AI 生成失败，已使用本地规则生成联系人。');
    });
  }, [ownerAgentId, ownerAgent, ownerProfile, contacts, agents, profiles, profileFingerprint, virtualContacts.length, generationState]);

  const openContact = (contact: XingyePhoneContactView) => {
    setSelectedContactKey(`${contact.targetType}:${contact.targetId}`);
    setRemarkDraft(contact?.remark ?? '');
    setImpressionDraft(contact?.impression ?? '');
    setRelationDraft(contact?.relationshipHint ?? '');
    setTagsDraft((contact?.tags ?? []).join(','));
    setFactionDraft(contact?.faction ?? '');
  };

  const saveContact = () => {
    if (!ownerAgentId || !selectedContact) return;
    savePhoneContactMeta(ownerAgentId, selectedContact.targetType, selectedContact.targetId, {
      remark: remarkDraft,
      impression: impressionDraft,
      relationshipHint: relationDraft,
      tags: tagsDraft.split(',').map(item => item.trim()).filter(Boolean),
      faction: factionDraft,
      source: 'manual',
    });
  };

  const handleEnrichContacts = async () => {
    if (!ownerAgent) return;
    try {
      await enrichContactsWithAI({
        ownerAgent,
        ownerProfile,
        contacts,
        profileFingerprint,
      });
    } catch {
      // state is already persisted in xingye-phone-store
    }
  };

  const handleGenerateContacts = async () => {
    if (!ownerAgent) return;
    try {
      const result = await generateVirtualContactsWithAI({
        ownerAgent,
        ownerProfile,
        contacts,
        agents,
        profiles,
        profileFingerprint,
        mode: 'initial_ai_generate',
      });
      if (result.generatedBy === 'rule_fallback') {
        setAiManageNotice('AI 生成失败，已使用本地规则生成联系人。');
      } else {
        setAiManageNotice(result.notice ?? 'AI 联系人生成完成。');
      }
    } catch (error) {
      setAiManageNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const handleUpdateContacts = async () => {
    if (!ownerAgent) return;
    try {
      await updateContactsFromRecentContextWithAI({ ownerAgent, ownerProfile, contacts });
      setAiManageNotice('联系人更新完成。');
    } catch (error) {
      setAiManageNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const handleRegenerateAll = async () => {
    if (!ownerAgent) return;
    if (!window.confirm('将重新生成全部虚拟联系人。会先保存快照，并尽量保留已关联角色。是否继续？')) return;
    try {
      const result = await regenerateAllContactsWithAI({
        ownerAgent,
        ownerProfile,
        contacts,
        agents,
        profiles,
        profileFingerprint,
      });
      if (result.generatedBy === 'rule_fallback') {
        setAiManageNotice('AI 重新生成失败，已 fallback 规则联系人。');
      } else {
        setAiManageNotice(result.notice ?? '重新生成完成。');
      }
    } catch (error) {
      setAiManageNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const handleRollbackAndUpdate = async () => {
    if (!ownerAgent) return;
    try {
      await rollbackAndUpdateContactsWithAI({ ownerAgent, ownerProfile, agents, profiles });
      setAiManageNotice('已回滚上次联系人并完成增量更新。');
    } catch (error) {
      setAiManageNotice(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className={styles.phoneShell} aria-label="通讯录">
      <div className={styles.phoneStatusBar}>
        <button type="button" className={styles.phoneBackButton} onClick={selectedContact ? () => setSelectedContactKey(null) : onBack}>
          {selectedContact ? '返回列表' : '返回首页'}
        </button>
        <span>通讯录</span>
      </div>

      <div className={styles.phoneBody}>
        {!selectedContact ? (
          <>
            <section className={styles.phoneAppCard}>
              <h3 className={styles.phoneAppTitle}>通讯录</h3>
              <p className={styles.phoneAppHint}>
                这是“当前角色眼中的社交网络”。联系人可能是真实角色，也可能只是 TA 手机里的虚拟联系人。
              </p>
              <div className={styles.phoneActionRow}>
                <button type="button" className={styles.phoneWeakAction} onClick={() => setAiManageOpen(prev => !prev)}>
                  {aiManageOpen ? '收起 AI 管理' : 'AI 联系人管理'}
                </button>
                <span className={styles.phoneAppHint}>
                  {generationState?.mode === 'ai' ? 'AI 生成' : generationState?.mode === 'rule' ? '本地规则生成' : '未生成'}
                </span>
              </div>
              {aiManageOpen ? (
                <div className={styles.phoneActionRow}>
                  <button type="button" className={styles.secondaryButton} onClick={handleGenerateContacts} disabled={!ownerAgent || contactUpdateState?.status === 'running'}>
                    AI 生成联系人
                  </button>
                  <button type="button" className={styles.secondaryButton} onClick={handleUpdateContacts} disabled={!ownerAgent || contactUpdateState?.status === 'running'}>
                    更新联系人
                  </button>
                  <button type="button" className={styles.secondaryButton} onClick={handleRegenerateAll} disabled={!ownerAgent || contactUpdateState?.status === 'running'}>
                    重新生成全部
                  </button>
                  <button type="button" className={styles.secondaryButton} onClick={handleRollbackAndUpdate} disabled={!ownerAgent || contactUpdateState?.status === 'running'}>
                    回滚上次并更新
                  </button>
                </div>
              ) : null}
              {contactUpdateState?.status === 'running' ? <p className={styles.phoneAppHint}>AI 更新中…</p> : null}
              {contactUpdateState?.status === 'failed' ? <p className={styles.phoneAppHint}>AI 更新失败：{contactUpdateState.error ?? '未知错误'}</p> : null}
              {aiManageNotice ? <p className={styles.phoneAppHint}>{aiManageNotice}</p> : null}
              <div className={styles.phoneActionRow}>
                <button type="button" className={styles.secondaryButton} onClick={handleEnrichContacts} disabled={!ownerAgent || aiState?.status === 'running'}>
                  {aiState?.status === 'running' ? 'AI 补全中…' : 'AI 补全印象'}
                </button>
                {aiState?.status === 'failed' ? <span className={styles.phoneAppHint}>补全失败：{aiState.error ?? '可重试'}</span> : null}
                {aiState?.status === 'success' ? <span className={styles.phoneAppHint}>补全完成</span> : null}
              </div>
            </section>
            <PhoneContactSections contacts={contacts} onSelect={openContact} />
            <section className={styles.phoneAppCard}>
              <h4 className={styles.phoneSectionTitle}>新的朋友</h4>
              <p className={styles.phoneAppHint}>以后这里会显示 TA 新认识的人、关系变化和待确认的社交请求。</p>
              <h4 className={styles.phoneSectionTitle}>群聊入口</h4>
              <p className={styles.phoneAppHint}>这里是通讯录里的群聊入口占位，不是短信。</p>
              <h4 className={styles.phoneSectionTitle}>标签 / 势力阵营</h4>
              <p className={styles.phoneAppHint}>默认标签：亲近的人、需要观察、不可靠、同伴、危险；默认阵营：自己人、中立、对立、未知。</p>
            </section>
          </>
        ) : (
          <PhoneContactDetail
            contact={selectedContact}
            agents={agents}
            remarkDraft={remarkDraft}
            impressionDraft={impressionDraft}
            relationDraft={relationDraft}
            tagsDraft={tagsDraft}
            factionDraft={factionDraft}
            onChange={(field, value) => {
              if (field === 'remark') setRemarkDraft(value);
              if (field === 'impression') setImpressionDraft(value);
              if (field === 'relation') setRelationDraft(value);
              if (field === 'tags') setTagsDraft(value);
              if (field === 'faction') setFactionDraft(value);
            }}
            onSave={saveContact}
            onOpenSms={() => onOpenSms(selectedContact.targetType as 'agent' | 'virtual_contact' | 'user', selectedContact.targetId)}
            onBlockToggle={() => {
              if (selectedContact.status === 'blocked') {
                restorePhoneContact(ownerAgentId, selectedContact.targetType, selectedContact.targetId);
              } else {
                blockPhoneContact(ownerAgentId, selectedContact.targetType, selectedContact.targetId);
              }
            }}
            onDeleteToggle={() => {
              if (selectedContact.status === 'deleted') {
                restorePhoneContact(ownerAgentId, selectedContact.targetType, selectedContact.targetId);
              } else {
                deletePhoneContact(ownerAgentId, selectedContact.targetType, selectedContact.targetId);
              }
            }}
            onLinkAgent={(linkedAgentId) => {
              if (!linkedAgentId) return;
              linkVirtualContactToAgent(ownerAgentId, selectedContact.targetId, linkedAgentId);
            }}
            onUnlinkAgent={() => unlinkVirtualContactFromAgent(ownerAgentId, selectedContact.targetId)}
          />
        )}
      </div>
    </div>
  );
}
