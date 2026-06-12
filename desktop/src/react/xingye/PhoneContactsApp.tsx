import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import {
  enrichContactsWithAI,
  generateSmsUpdatesForChangedContactsWithAI,
  generateVirtualContactsWithAI,
  regenerateAllContactsWithAI,
  rollbackAndUpdateContactsWithAI,
  updateContactsFromRecentContextWithAI,
} from './xingye-phone-ai';
import {
  blockPhoneContact,
  deletePhoneContact,
  getContactAiUpdateState,
  getPendingNewContacts,
  getPhoneContactGenerationState,
  getPhoneContacts,
  getPhoneAiGenerationState,
  getVirtualContacts,
  getPhoneProfileFingerprint,
  linkVirtualContactToAgent,
  restorePhoneContact,
  savePhoneContactMeta,
  computePhoneContactGenerationInputHash,
  shouldAutoSkipVirtualContactGeneration,
  unlinkVirtualContactFromAgent,
  type XingyePhoneContactView,
  useXingyePhoneStorageVersion,
} from './xingye-phone-store';
import { collectRecentContextForAgent } from './xingye-recent-context';
import {
  confirmPhoneContactDraft,
  discardPhoneContactDraft,
  listPhoneContactDrafts,
  type XingyePendingPhoneContactDraft,
} from './xingye-phone-contact-drafts';
import { batchInitializeContactProfilesWithAI } from './xingye-contact-profile-ai';
import styles from './XingyeShell.module.css';

type ContactsListView =
  | 'home'
  | PhoneContactsSectionId
  | 'tag_detail'
  | 'faction_detail';

interface PhoneContactsAppProps {
  ownerAgent: Agent | null;
  agents: Agent[];
  profiles: XingyeRoleProfileMap;
  channels: Channel[];
  onBack: () => void;
  onOpenSms: (targetType: 'agent' | 'virtual_contact' | 'user', targetId: string) => void;
  onOpenGroupChatTab?: () => void;
}

export function PhoneContactsApp({
  ownerAgent,
  agents,
  profiles,
  channels,
  onBack,
  onOpenSms,
  onOpenGroupChatTab,
}: PhoneContactsAppProps) {
  const _phoneStorageVersion = useXingyePhoneStorageVersion();
  const ownerAgentId = ownerAgent?.id ?? '';
  const ownerProfile = useXingyeRoleProfile(ownerAgentId);
  const userName = useStore(state => state.userName);
  const profileFingerprint = getPhoneProfileFingerprint(ownerAgent, ownerProfile);
  const agentIdsKey = useMemo(() => agents.map(a => a.id).sort().join(','), [agents]);
  const contactGenInputHash = useMemo(
    () => computePhoneContactGenerationInputHash(profileFingerprint, agents.map(a => a.id).sort()),
    [profileFingerprint, agentIdsKey],
  );
  const contacts = useMemo(
    () => getPhoneContacts(ownerAgentId, agents, profiles, { includeDeleted: true }),
    [ownerAgentId, agents, profiles, _phoneStorageVersion],
  );
  // 「新的朋友」待确认队列；contacts 默认不含这些条目，数量单独取用于入口角标。
  const pendingNewFriendCount = useMemo(
    () => getPendingNewContacts(ownerAgentId, agents, profiles).length,
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
  const [profileBatchBusy, setProfileBatchBusy] = useState(false);
  const [profileBatchNotice, setProfileBatchNotice] = useState<string | null>(null);
  /** 「停止」按钮与组件卸载共用的取消旗标；批量执行器每条开始前检查。 */
  const profileBatchCancelRef = useRef(false);
  useEffect(() => () => {
    profileBatchCancelRef.current = true;
  }, []);
  const [listView, setListView] = useState<ContactsListView>('home');
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [factionFilter, setFactionFilter] = useState<string | null>(null);
  const [pendingPhoneContactDrafts, setPendingPhoneContactDrafts] = useState<XingyePendingPhoneContactDraft[]>([]);
  const [phoneContactDraftError, setPhoneContactDraftError] = useState<string | null>(null);
  const [phoneContactDraftBusyId, setPhoneContactDraftBusyId] = useState<string | null>(null);

  const reloadPhoneContactDrafts = useCallback(async () => {
    if (!ownerAgentId) {
      setPendingPhoneContactDrafts([]);
      return;
    }
    try {
      const drafts = await listPhoneContactDrafts(ownerAgentId);
      setPendingPhoneContactDrafts(drafts);
    } catch (error) {
      console.warn('[PhoneContactsApp] reload pending phone-contact drafts failed:', error);
    }
  }, [ownerAgentId]);

  useEffect(() => {
    if (listView === 'home' && !selectedContact) {
      void reloadPhoneContactDrafts();
    }
  }, [listView, selectedContact, reloadPhoneContactDrafts, _phoneStorageVersion]);

  const handleConfirmPhoneContactDraft = async (draftId: string) => {
    if (!ownerAgentId) return;
    setPhoneContactDraftError(null);
    setPhoneContactDraftBusyId(draftId);
    try {
      await confirmPhoneContactDraft(ownerAgentId, draftId);
      setPendingPhoneContactDrafts((prev) => prev.filter((d) => d.id !== draftId));
      maybeRunSmsIncrementalAfterContactChange();
    } catch (error) {
      setPhoneContactDraftError(error instanceof Error ? error.message : String(error));
      await reloadPhoneContactDrafts();
    } finally {
      setPhoneContactDraftBusyId(null);
    }
  };

  const handleDiscardPhoneContactDraft = async (draftId: string) => {
    if (!ownerAgentId) return;
    setPhoneContactDraftError(null);
    setPhoneContactDraftBusyId(draftId);
    try {
      const ok = await discardPhoneContactDraft(ownerAgentId, draftId);
      if (ok) {
        setPendingPhoneContactDrafts((prev) => prev.filter((d) => d.id !== draftId));
      } else {
        await reloadPhoneContactDrafts();
      }
    } catch (error) {
      setPhoneContactDraftError(error instanceof Error ? error.message : String(error));
      await reloadPhoneContactDrafts();
    } finally {
      setPhoneContactDraftBusyId(null);
    }
  };

  const formatPatchPreview = (patch: XingyePendingPhoneContactDraft['patch']): Array<{ key: string; label: string; value: string }> => {
    const out: Array<{ key: string; label: string; value: string }> = [];
    if (!patch) return out;
    if (patch.remark !== undefined) out.push({ key: 'remark', label: '备注', value: patch.remark });
    if (patch.impression !== undefined) out.push({ key: 'impression', label: '印象', value: patch.impression });
    if (patch.relationshipHint !== undefined) out.push({ key: 'relationshipHint', label: '关系', value: patch.relationshipHint });
    if (patch.tags !== undefined) out.push({ key: 'tags', label: '标签', value: patch.tags.join(' / ') });
    if (patch.faction !== undefined) out.push({ key: 'faction', label: '阵营', value: patch.faction });
    return out;
  };

  const formatContactPreview = (contact: XingyePendingPhoneContactDraft['contact']): Array<{ key: string; label: string; value: string }> => {
    const out: Array<{ key: string; label: string; value: string }> = [];
    if (!contact) return out;
    out.push({ key: 'kind', label: '种类', value: contact.kind });
    if (contact.shortBio) out.push({ key: 'shortBio', label: '简介', value: contact.shortBio });
    if (contact.impression) out.push({ key: 'impression', label: '印象', value: contact.impression });
    if (contact.relationshipHint) out.push({ key: 'relationshipHint', label: '关系', value: contact.relationshipHint });
    if (contact.remark) out.push({ key: 'remark', label: '备注', value: contact.remark });
    if (contact.tags?.length) out.push({ key: 'tags', label: '标签', value: contact.tags.join(' / ') });
    if (contact.faction) out.push({ key: 'faction', label: '阵营', value: contact.faction });
    if (contact.status) out.push({ key: 'status', label: '状态', value: contact.status });
    if (contact.generatedReason) out.push({ key: 'generatedReason', label: '生成依据', value: contact.generatedReason });
    return out;
  };

  const draftActionLabel = (action: XingyePendingPhoneContactDraft['action']): string => {
    switch (action) {
      case 'add': return '新增';
      case 'block': return '拉黑';
      case 'delete': return '删除';
      case 'restore': return '恢复';
      case 'update':
      default: return '更新';
    }
  };

  const draftConfirmButtonLabel = (action: XingyePendingPhoneContactDraft['action']): string => {
    switch (action) {
      case 'add': return '采纳新增';
      case 'block': return '采纳拉黑';
      case 'delete': return '采纳删除';
      case 'restore': return '采纳恢复';
      case 'update':
      default: return '采纳建议';
    }
  };

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

  const maybeRunSmsIncrementalAfterContactChange = () => {
    if (!ownerAgent) return;
    const fresh = getPhoneContacts(ownerAgentId, agents, profiles, { includeDeleted: true });
    void generateSmsUpdatesForChangedContactsWithAI({
      ownerAgent,
      ownerProfile,
      contacts: fresh,
      agents,
      profiles,
    }).catch(() => {});
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
    if (!ownerAgentId || !ownerAgent) return;
    if (virtualContacts.length > 0) return;
    // virtualContacts 来自默认过滤后的视图（不含待确认条目）；用原始实体表再守一道，
    // 避免「全部还在新的朋友里待确认」时被误判为空通讯录而重跑初始化。
    if (getVirtualContacts(ownerAgentId).length > 0) return;
    if (shouldAutoSkipVirtualContactGeneration(ownerAgentId, profileFingerprint, contactGenInputHash)) return;
    const contactsNow = getPhoneContacts(ownerAgentId, agents, profiles, { includeDeleted: true });
    let cancelled = false;
    void generateVirtualContactsWithAI({
      ownerAgent,
      ownerProfile,
      contacts: contactsNow,
      agents,
      profiles,
      profileFingerprint,
      mode: 'initial_ai_generate',
    }).then((result) => {
      if (cancelled) return;
      if (result.generatedBy === 'rule_fallback') {
        setAiManageNotice('AI 生成失败，已使用本地规则生成联系人。');
      } else {
        setAiManageNotice(result.notice ?? null);
      }
    }).catch((err) => {
      if (cancelled) return;
      setAiManageNotice(err instanceof Error ? err.message : String(err));
    });
    return () => {
      cancelled = true;
    };
  }, [ownerAgentId, ownerAgent, ownerProfile, virtualContacts.length, profileFingerprint, contactGenInputHash, agentIdsKey, _phoneStorageVersion, agents, profiles]);

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
    maybeRunSmsIncrementalAfterContactChange();
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
        /** 手动点按钮新增的联系人先进「新的朋友」待确认；仅自动初始化/重新生成全部直接入册。 */
        newContactGate: 'pending_approval',
      });
      if (result.generatedBy === 'rule_fallback') {
        setAiManageNotice('AI 生成失败，已使用本地规则生成联系人。');
      } else if (result.notice) {
        setAiManageNotice(result.notice);
      } else if ((result.createdCount ?? 0) === 0) {
        setAiManageNotice('生成结果与已有联系人重复，未新增。');
      } else {
        setAiManageNotice(`AI 联系人生成完成，新增 ${result.createdCount} 条已放入「新的朋友」待确认。`);
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
      const pendingNote = result.pendingAddsCount > 0
        ? ` 其中 ${result.pendingAddsCount} 个新联系人在「新的朋友」等你确认。`
        : '';
      setAiManageNotice(`${changeNote}${pendingNote} ${ctxNote}`);
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

  const handleBatchInitProfiles = async () => {
    if (!ownerAgent || profileBatchBusy) return;
    profileBatchCancelRef.current = false;
    setProfileBatchBusy(true);
    setProfileBatchNotice(null);
    try {
      const result = await batchInitializeContactProfilesWithAI({
        ownerAgent,
        ownerProfile,
        contacts,
        onProgress: (done, total, current) => {
          if (current) setProfileBatchNotice(`详情生成中 ${done + 1}/${total}：${current.remark}`);
        },
        shouldCancel: () => profileBatchCancelRef.current,
      });
      if (result.total === 0) {
        setProfileBatchNotice('所有联系人都已有详情，无需生成。');
      } else {
        const bits = [`新生成 ${result.created} 条`];
        if (result.skipped) bits.push(`已有跳过 ${result.skipped} 条`);
        if (result.failed) bits.push(`失败 ${result.failed} 条（可单独打开详情页重试）`);
        setProfileBatchNotice(`${result.cancelled ? '已停止，' : '批量详情生成完成：'}${bits.join('，')}。`);
      }
    } catch (error) {
      setProfileBatchNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setProfileBatchBusy(false);
    }
  };

  const handleRollbackAndUpdate = async () => {
    if (!ownerAgent) return;
    try {
      const result = await rollbackAndUpdateContactsWithAI({ ownerAgent, ownerProfile, agents, profiles });
      const ctxNote = result.recentContext.hasOpenHanakoMessages
        ? `已结合最近 OpenHanako 聊天 ${result.recentContext.messageCount} 条。`
        : '暂未读到最近聊天，本次仅根据角色资料和通讯录更新。';
      const pendingNote = result.pendingAddsCount > 0
        ? `其中 ${result.pendingAddsCount} 个新联系人在「新的朋友」等你确认。`
        : '';
      setAiManageNotice(`已回滚上次联系人并完成增量更新。${pendingNote}${ctxNote}`);
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

  if (!ownerAgent?.id) {
    return (
      <div className={styles.phoneShell} aria-label="通讯录">
        <div className={styles.phoneStatusBar}>
          <button type="button" className={styles.phoneBackButton} onClick={onBack}>
            返回首页
          </button>
          <span>通讯录</span>
        </div>
        <div className={styles.phoneBody}>
          <section className={styles.phoneAppCard}>
            <h3 className={styles.phoneAppTitle}>通讯录不可用</h3>
            <p className={styles.phoneAppHint}>
              未选择角色 / 小手机不可用。通讯录必须绑定当前小手机所属角色，不能使用 OpenHanako 当前聊天角色作为隐式回退。
            </p>
            <p className={styles.phoneAppHint}>请返回星野角色页，选择有效角色后再打开小手机通讯录。</p>
          </section>
        </div>
      </div>
    );
  }

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
            ownerAgent={ownerAgent}
            ownerProfile={ownerProfile}
            userName={userName}
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
              maybeRunSmsIncrementalAfterContactChange();
            }}
            onDeleteToggle={() => {
              if (selectedContact.status === 'deleted') {
                restorePhoneContact(ownerAgentId, selectedContact.targetType, selectedContact.targetId);
              } else {
                deletePhoneContact(ownerAgentId, selectedContact.targetType, selectedContact.targetId);
              }
              maybeRunSmsIncrementalAfterContactChange();
            }}
            onLinkAgent={(linkedAgentId) => {
              if (!linkedAgentId) return;
              linkVirtualContactToAgent(ownerAgentId, selectedContact.targetId, linkedAgentId);
              maybeRunSmsIncrementalAfterContactChange();
            }}
            onUnlinkAgent={() => {
              unlinkVirtualContactFromAgent(ownerAgentId, selectedContact.targetId);
              maybeRunSmsIncrementalAfterContactChange();
            }}
          />
        ) : listView === 'home' ? (
          <>
            {pendingPhoneContactDrafts.length > 0 ? (
              <section
                className={styles.phoneAppCard}
                style={{ borderLeft: '3px solid #ffb84a' }}
                data-testid="phone-contact-pending-drafts"
                aria-label="待确认草稿 · 来自心跳巡检"
              >
                <h3 className={styles.phoneAppTitle}>待确认草稿 · 来自心跳巡检</h3>
                <p className={styles.phoneAppHint}>
                  这是 TA 在心跳巡检里对通讯录提议的草稿（更新 / 新增 / 拉黑 / 删除 / 恢复），**都需要你审阅采纳后才会生效**。AI 不会主动对 user 或真实角色做新增 / 拉黑 / 删除——那些只有你能手动操作。
                </p>
                {phoneContactDraftError ? (
                  <p className={styles.phoneAppHint} role="status">
                    {phoneContactDraftError}
                  </p>
                ) : null}
                {pendingPhoneContactDrafts.map((d) => {
                  const previewItems = d.action === 'add' ? formatContactPreview(d.contact) : formatPatchPreview(d.patch);
                  const displayName = d.displayName ?? d.contact?.displayName ?? '';
                  const who = displayName
                    ? `${displayName}（${d.targetType}）`
                    : (d.targetId
                      ? `${d.targetType}:${d.targetId}`
                      : `${d.targetType}:${d.matchName ?? '?'}`);
                  return (
                    <div
                      key={d.id}
                      className={styles.phoneAppCard}
                      style={{ border: '1px dashed rgba(0,0,0,0.2)', padding: 10, marginBottom: 8 }}
                      data-testid={`phone-contact-pending-draft-${d.id}`}
                      data-action={d.action}
                    >
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'baseline' }}>
                        <strong>通讯录草稿 · {draftActionLabel(d.action)}</strong>
                        <span className={styles.phoneAppHint}>目标 {who}</span>
                        <span className={styles.phoneAppHint}>来源 {d.source}</span>
                      </div>
                      {previewItems.length > 0 ? (
                        <ul style={{ margin: '6px 0', paddingLeft: 18 }}>
                          {previewItems.map((item) => (
                            <li key={item.key} style={{ whiteSpace: 'pre-wrap' }}>
                              <strong>{item.label}</strong>：{item.value}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      {d.reason ? (
                        <p className={styles.phoneAppHint} style={{ margin: 0 }}>
                          理由：{d.reason}
                        </p>
                      ) : null}
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                        <button
                          type="button"
                          className={styles.secondaryButton}
                          onClick={() => void handleConfirmPhoneContactDraft(d.id)}
                          disabled={phoneContactDraftBusyId === d.id}
                          data-testid={`phone-contact-pending-draft-confirm-${d.id}`}
                        >
                          {phoneContactDraftBusyId === d.id ? '处理中…' : draftConfirmButtonLabel(d.action)}
                        </button>
                        <button
                          type="button"
                          className={styles.secondaryButton}
                          onClick={() => void handleDiscardPhoneContactDraft(d.id)}
                          disabled={phoneContactDraftBusyId === d.id}
                          data-testid={`phone-contact-pending-draft-discard-${d.id}`}
                        >
                          丢弃
                        </button>
                      </div>
                    </div>
                  );
                })}
              </section>
            ) : null}
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
                  {generationState?.status === 'running'
                    ? '生成中…'
                    : generationState?.mode === 'ai'
                      ? 'AI 生成'
                      : generationState?.mode === 'rule'
                        ? '本地规则生成'
                        : '未生成'}
                </span>
              </div>
              {aiManageOpen ? (
                <>
                  <div className={styles.phoneActionRow}>
                    <button type="button" className={styles.secondaryButton} onClick={handleGenerateContacts} disabled={contactUpdateState?.status === 'running' || generationState?.status === 'running'}>
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
                    AI 生成联系人：从角色人设/最近对话发现新联系人。将生成 3–8 个候选，自动跳过已有或重复联系人；新增条目会先进入「新的朋友」，你确认后才会出现在通讯录。
                  </p>
                  <p className={styles.phoneAppHint}>
                    更新联系人：根据最近对话更新已有联系人印象。没有明确变化时可能不会更新；如果 TA 认识了新的人，也会先进入「新的朋友」待确认。
                  </p>
                  <p className={styles.phoneAppHint}>
                    {recentContextPreview.hasOpenHanakoMessages
                      ? `更新时会参考最近 OpenHanako 聊天（约 ${recentContextPreview.messages.length} 条）。`
                      : '未从当前前端缓存读到最近聊天。本次更新可能不会产生变化。请先在「聊天」tab 打开该角色会话并产生新消息，再返回更新。'}
                  </p>
                  <div className={styles.phoneActionRow}>
                    <button
                      type="button"
                      className={styles.secondaryButton}
                      data-testid="phone-contacts-batch-profile"
                      onClick={profileBatchBusy ? () => { profileBatchCancelRef.current = true; } : handleBatchInitProfiles}
                      disabled={!ownerAgent}
                    >
                      {profileBatchBusy ? '停止详情生成' : '批量生成联系人详情'}
                    </button>
                  </div>
                  <p className={styles.phoneAppHint}>
                    批量生成联系人详情：给所有还没有详情（ID/IP属地/签名/联系记录）的联系人逐条生成，每条一次模型调用、串行执行，可随时停止；已有详情的自动跳过。
                  </p>
                </>
              ) : null}
              {contactUpdateState?.status === 'running' ? <p className={styles.phoneAppHint}>AI 更新中…</p> : null}
              {contactUpdateState?.status === 'failed' ? <p className={styles.phoneAppHint}>AI 更新失败：{contactUpdateState.error ?? '未知错误'}</p> : null}
              {aiManageNotice ? <p className={styles.phoneAppHint}>{aiManageNotice}</p> : null}
              {/* 批量详情进度放在折叠区外：生成中收起 AI 管理面板也能看到进度。 */}
              {profileBatchNotice ? <p className={styles.phoneAppHint} data-testid="phone-contacts-batch-profile-notice">{profileBatchNotice}</p> : null}
              <div className={styles.phoneActionRow}>
                <button type="button" className={styles.secondaryButton} onClick={handleEnrichContacts} disabled={!ownerAgent || aiState?.status === 'running'}>
                  {aiState?.status === 'running' ? 'AI 补全中…' : 'AI 补全印象'}
                </button>
                {aiState?.status === 'failed' ? <span className={styles.phoneAppHint}>补全失败：{aiState.error ?? '可重试'}</span> : null}
                {aiState?.status === 'success' ? <span className={styles.phoneAppHint}>补全完成</span> : null}
              </div>
            </section>
            <PhoneContactSections
              contacts={contacts}
              pendingNewFriendCount={pendingNewFriendCount}
              onSelect={openContact}
              onOpenSection={openSection}
            />
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
