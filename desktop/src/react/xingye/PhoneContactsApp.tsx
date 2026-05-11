import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../stores';
import type { Agent, Channel } from '../types';
import { PhoneContactDetail } from './PhoneContactDetail';
import { PhoneContactSections } from './PhoneContactSections';
import {
  PhoneContactsBlockedView,
  PhoneContactsDeletedView,
  PhoneContactsFactionsHomeView,
  PhoneContactsFactionDetailView,
  PhoneContactsGroupsView,
  PhoneContactsNewFriendsView,
  PhoneContactsTagDetailView,
  PhoneContactsTagsHomeView,
  type PhoneContactsSectionId,
} from './PhoneContactsSectionView';
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
import { collectRecentContextForAgent } from './xingye-recent-context';
import styles from './XingyeShell.module.css';

type ContactsListView =
  | 'home'
  | PhoneContactsSectionId
  | 'tag_detail'
  | 'faction_detail';

interface PhoneContactsAppProps {
  ownerAgent: Agent | null;
  agents: Agent[];
  currentAgentId: string | null;
  profiles: XingyeRoleProfileMap;
  channels: Channel[];
  onBack: () => void;
  onOpenSms: (targetType: 'agent' | 'virtual_contact' | 'user', targetId: string) => void;
  onOpenGroupChatTab?: () => void;
}

export function PhoneContactsApp({
  ownerAgent,
  agents,
  currentAgentId,
  profiles,
  channels,
  onBack,
  onOpenSms,
  onOpenGroupChatTab,
}: PhoneContactsAppProps) {
  const _phoneStorageVersion = useXingyePhoneStorageVersion();
  const ownerAgentId = ownerAgent?.id ?? currentAgentId ?? '';
  const ownerProfile = useXingyeRoleProfile(ownerAgentId);
  const profileFingerprint = getPhoneProfileFingerprint(ownerAgent, ownerProfile);
  const contacts = useMemo(
    () => getPhoneContacts(ownerAgentId, agents, profiles, { includeDeleted: true }),
    [ownerAgentId, agents, profiles, _phoneStorageVersion],
  );
  // 仅用于 UI 提示「点击更新会读到多少条最近聊天」；与真实 AI 调用同一个 helper，
  // 避免提示与实际 prompt 内容脱节。
  const chatSessionsVersionKey = useStore(state => {
    if (!ownerAgentId) return 0;
    const sessionPaths = state.sessions
      .filter(session => session.agentId === ownerAgentId)
      .map(session => session.path);
    return sessionPaths.reduce((acc, path) => acc + (state.chatSessions[path]?.items?.length ?? 0), 0);
  });
  const recentContextPreview = useMemo(
    () => collectRecentContextForAgent({ agentId: ownerAgentId }),
    [ownerAgentId, chatSessionsVersionKey],
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
  const [listView, setListView] = useState<ContactsListView>('home');
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [factionFilter, setFactionFilter] = useState<string | null>(null);

  const openSection = (section: PhoneContactsSectionId) => {
    setSelectedContactKey(null);
    setTagFilter(null);
    setFactionFilter(null);
    setListView(section);
  };

  const openTagDetail = (tag: string) => {
    setSelectedContactKey(null);
    setTagFilter(tag);
    setListView('tag_detail');
  };

  const openFactionDetail = (faction: string) => {
    setSelectedContactKey(null);
    setFactionFilter(faction);
    setListView('faction_detail');
  };

  const goContactsHome = () => {
    setListView('home');
    setTagFilter(null);
    setFactionFilter(null);
    setSelectedContactKey(null);
  };

  const handleStatusBack = () => {
    if (selectedContact) {
      setSelectedContactKey(null);
      return;
    }
    if (listView === 'tag_detail') {
      setListView('tags');
      setTagFilter(null);
      return;
    }
    if (listView === 'faction_detail') {
      setListView('factions');
      setFactionFilter(null);
      return;
    }
    if (listView !== 'home') {
      goContactsHome();
      return;
    }
    onBack();
  };

  const navTitle = selectedContact
    ? '联系人'
    : ({
      home: '通讯录',
      new_friends: '新的朋友',
      groups: '群聊',
      tags: '标签',
      tag_detail: tagFilter ? `标签：${tagFilter}` : '标签',
      factions: '势力阵营',
      faction_detail: factionFilter ? `阵营：${factionFilter}` : '势力阵营',
      blocked: '黑名单',
      deleted: '已删除',
    } as const)[listView];

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
      } else if (result.notice) {
        setAiManageNotice(result.notice);
      } else if ((result.createdCount ?? 0) === 0) {
        setAiManageNotice('生成结果与已有联系人重复，未新增。');
      } else {
        setAiManageNotice(`AI 联系人生成完成，实际新增 ${result.createdCount} 条。`);
      }
    } catch (error) {
      setAiManageNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const handleUpdateContacts = async () => {
    if (!ownerAgent) return;
    try {
      const result = await updateContactsFromRecentContextWithAI({ ownerAgent, ownerProfile, contacts, agents, profiles });
      const ctxNote = result.recentContext.hasOpenHanakoMessages
        ? `已结合最近 OpenHanako 聊天 ${result.recentContext.messageCount} 条。`
        : '未从当前前端缓存读到最近聊天，本次更新可能不会产生变化。请先在「聊天」tab 打开该角色会话并产生新消息，再返回更新。';
      const changeNote = result.updatesCount === 0
        ? '没有发现需要更新的联系人。'
        : `已应用 ${result.updatesCount} 条更新。`;
      setAiManageNotice(`${changeNote} ${ctxNote}`);
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
      const result = await rollbackAndUpdateContactsWithAI({ ownerAgent, ownerProfile, agents, profiles });
      const ctxNote = result.recentContext.hasOpenHanakoMessages
        ? `已结合最近 OpenHanako 聊天 ${result.recentContext.messageCount} 条。`
        : '暂未读到最近聊天，本次仅根据角色资料和通讯录更新。';
      setAiManageNotice(`已回滚上次联系人并完成增量更新。${ctxNote}`);
    } catch (error) {
      setAiManageNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const sectionBaseProps = {
    ownerAgentId,
    agents,
    profiles,
    onBackHome: goContactsHome,
    onSelectContact: openContact,
  };

  return (
    <div className={styles.phoneShell} aria-label="通讯录">
      <div className={styles.phoneStatusBar}>
        <button type="button" className={styles.phoneBackButton} onClick={handleStatusBack}>
          {selectedContact ? '返回' : listView !== 'home' ? '返回' : '返回首页'}
        </button>
        <span>{navTitle}</span>
      </div>

      <div className={styles.phoneBody}>
        {selectedContact ? (
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
        ) : listView === 'home' ? (
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
                <>
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
                  <p className={styles.phoneAppHint}>
                    AI 生成联系人：从角色人设/最近对话发现新联系人。将生成 3–8 个候选，并自动跳过已有或重复联系人。
                  </p>
                  <p className={styles.phoneAppHint}>
                    更新联系人：根据最近对话更新已有联系人印象。没有明确变化时可能不会更新。
                  </p>
                  <p className={styles.phoneAppHint}>
                    {recentContextPreview.hasOpenHanakoMessages
                      ? `更新时会参考最近 OpenHanako 聊天（约 ${recentContextPreview.messages.length} 条）。`
                      : '未从当前前端缓存读到最近聊天。本次更新可能不会产生变化。请先在「聊天」tab 打开该角色会话并产生新消息，再返回更新。'}
                  </p>
                </>
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
            <PhoneContactSections contacts={contacts} onSelect={openContact} onOpenSection={openSection} />
          </>
        ) : listView === 'new_friends' ? (
          <PhoneContactsNewFriendsView
            {...sectionBaseProps}
            onTriggerAiUpdate={handleUpdateContacts}
            aiUpdateBusy={contactUpdateState?.status === 'running'}
          />
        ) : listView === 'groups' ? (
          <PhoneContactsGroupsView
            channels={channels}
            onBackHome={goContactsHome}
            onOpenNativeGroupTab={onOpenGroupChatTab}
          />
        ) : listView === 'tags' ? (
          <PhoneContactsTagsHomeView
            {...sectionBaseProps}
            onOpenTag={openTagDetail}
          />
        ) : listView === 'tag_detail' && tagFilter ? (
          <PhoneContactsTagDetailView
            {...sectionBaseProps}
            tag={tagFilter}
            onBackTags={() => { setListView('tags'); setTagFilter(null); }}
          />
        ) : listView === 'factions' ? (
          <PhoneContactsFactionsHomeView
            {...sectionBaseProps}
            onOpenFaction={openFactionDetail}
          />
        ) : listView === 'faction_detail' && factionFilter ? (
          <PhoneContactsFactionDetailView
            {...sectionBaseProps}
            faction={factionFilter}
            onBackFactions={() => { setListView('factions'); setFactionFilter(null); }}
          />
        ) : listView === 'blocked' ? (
          <PhoneContactsBlockedView {...sectionBaseProps} />
        ) : listView === 'deleted' ? (
          <PhoneContactsDeletedView {...sectionBaseProps} />
        ) : null}
      </div>
    </div>
  );
}
