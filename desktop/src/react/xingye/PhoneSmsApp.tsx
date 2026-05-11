import { useEffect, useMemo, useState } from 'react';
import type { Agent } from '../types';
import { useXingyeRoleProfile, type XingyeRoleProfileMap } from './xingye-profile-store';
import { XingyeAgentAvatar } from './XingyeAgentAvatar';
import { generateSmsHistoryWithAI } from './xingye-phone-ai';
import {
  addMockSmsMessage,
  clearAiSmsHistory,
  getPhoneContacts,
  getPhoneAiGenerationState,
  getPhoneProfileFingerprint,
  getSmsHistoryGenerationState,
  getSmsThread,
  getSmsThreads,
  type XingyeContactTargetType,
  useXingyePhoneStorageVersion,
} from './xingye-phone-store';
import styles from './XingyeShell.module.css';

interface PhoneSmsAppProps {
  ownerAgent: Agent | null;
  agents: Agent[];
  profiles: XingyeRoleProfileMap;
  initialTarget?: { targetType: XingyeContactTargetType; targetId: string } | null;
  onBack: () => void;
}

function formatSmsTime(iso: string): string {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return iso;
  const date = new Date(timestamp);
  return `${date.getMonth() + 1}/${date.getDate()} ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
}

export function PhoneSmsApp({ ownerAgent, agents, profiles, initialTarget, onBack }: PhoneSmsAppProps) {
  const version = useXingyePhoneStorageVersion();
  const ownerAgentId = ownerAgent?.id ?? '';
  const ownerProfile = useXingyeRoleProfile(ownerAgentId);
  const profileFingerprint = getPhoneProfileFingerprint(ownerAgent, ownerProfile);
  const contacts = useMemo(
    () => getPhoneContacts(ownerAgentId, agents, profiles, { includeDeleted: true }),
    [ownerAgentId, agents, profiles, version],
  );
  const contactsByTarget = useMemo(
    () => new Map(contacts.map(contact => [`${contact.targetType}:${contact.targetId}`, contact] as const)),
    [contacts],
  );
  const [selectedTarget, setSelectedTarget] = useState<{ targetType: XingyeContactTargetType; targetId: string } | null>(initialTarget ?? null);
  const [draftMessage, setDraftMessage] = useState('');
  const [direction, setDirection] = useState<'incoming' | 'outgoing'>('outgoing');
  const [showTestTools, setShowTestTools] = useState(false);
  const smsAiState = getPhoneAiGenerationState(ownerAgentId, 'sms_history');
  const smsHistoryState = getSmsHistoryGenerationState(ownerAgentId);

  useEffect(() => {
    setSelectedTarget(initialTarget ?? null);
  }, [initialTarget]);

  useEffect(() => {
    if (!ownerAgent) return;
    if (smsHistoryState?.generatedAt) return;
    if (smsAiState?.status === 'running') return;
    generateSmsHistoryWithAI({
      ownerAgent,
      ownerProfile,
      contacts,
      profileFingerprint,
      mode: 'empty_only',
    }).catch(() => {});
  }, [ownerAgentId, ownerAgent, ownerProfile, contacts, profileFingerprint, smsHistoryState?.generatedAt, smsAiState?.status]);

  const threads = useMemo(() => getSmsThreads(ownerAgentId), [ownerAgentId, version]);
  const selectedThread = selectedTarget ? getSmsThread(ownerAgentId, selectedTarget.targetType, selectedTarget.targetId) : null;
  const selectedContact = selectedTarget ? contactsByTarget.get(`${selectedTarget.targetType}:${selectedTarget.targetId}`) ?? null : null;

  const handleAddMockMessage = () => {
    if (!selectedTarget) return;
    addMockSmsMessage(ownerAgentId, selectedTarget.targetType, selectedTarget.targetId, draftMessage, direction);
    setDraftMessage('');
  };

  const handleRegenerateEmptyThreads = () => {
    if (!ownerAgent) return;
    if (!window.confirm('仅为“空短信线程”补生成旧短信。已有消息不会覆盖，继续吗？')) return;
    generateSmsHistoryWithAI({
      ownerAgent,
      ownerProfile,
      contacts,
      profileFingerprint,
      mode: 'empty_only',
    }).catch(() => {});
  };

  const handleClearAiAndRegenerate = () => {
    if (!ownerAgent) return;
    if (!window.confirm('将清除 AI 生成的旧短信并重新生成。手动 mock 消息会保留，继续吗？')) return;
    clearAiSmsHistory(ownerAgent.id);
    generateSmsHistoryWithAI({
      ownerAgent,
      ownerProfile,
      contacts,
      profileFingerprint,
      mode: 'replace_ai',
    }).catch(() => {});
  };

  return (
    <div className={styles.phoneShell} aria-label="短信">
      <div className={styles.phoneStatusBar}>
        <button type="button" className={styles.phoneBackButton} onClick={selectedTarget ? () => setSelectedTarget(null) : onBack}>
          {selectedTarget ? '返回列表' : '返回首页'}
        </button>
        <span>短信</span>
      </div>

      <div className={styles.phoneBody}>
        <section className={styles.phoneAppCard}>
          <h3 className={styles.phoneAppTitle}>短信</h3>
          <p className={styles.phoneAppHint}>
            当前手机主人：{ownerAgent?.name ?? '未选择角色'}。这些是 TA 手机里的角色间短信模拟，不是 OpenHanako 原生聊天。
          </p>
          {smsAiState?.status === 'running' ? (
            <p className={styles.phoneAppHint}>正在整理 TA 手机里的旧短信… 这可能需要几十秒。</p>
          ) : null}
          {smsAiState?.status === 'failed' ? (
            <div className={styles.phoneActionRow}>
              <span className={styles.phoneAppHint}>生成失败，可重试：{smsAiState.error ?? '未知错误'}</span>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={handleRegenerateEmptyThreads}
              >
                重试
              </button>
            </div>
          ) : null}
          {smsAiState?.status === 'success' ? <p className={styles.phoneAppHint}>旧短信已缓存，本次不会重复生成。</p> : null}
          <div className={styles.phoneActionRow}>
            <button type="button" className={styles.phoneWeakAction} onClick={handleRegenerateEmptyThreads} disabled={!ownerAgent || smsAiState?.status === 'running'}>
              重新生成旧短信（仅空线程）
            </button>
            <button type="button" className={styles.phoneWeakAction} onClick={handleClearAiAndRegenerate} disabled={!ownerAgent || smsAiState?.status === 'running'}>
              清除 AI 旧短信并重新生成
            </button>
          </div>
        </section>

        {!selectedTarget ? (
          <section className={styles.phoneList} aria-label="短信线程列表">
            {threads.map(thread => {
              const contact = contactsByTarget.get(`${thread.targetType}:${thread.targetId}`);
              const latest = thread.messages[thread.messages.length - 1];
              if (!contact || contact.status === 'deleted') return null;
              return (
                <button
                  key={thread.id}
                  className={styles.phoneListItem}
                  type="button"
                  onClick={() => setSelectedTarget({ targetType: thread.targetType, targetId: thread.targetId })}
                >
                  <span className={styles.phoneListAvatar}>
                    {contact.agent ? <XingyeAgentAvatar agent={contact.agent} alt={contact.remark} /> : (contact.remark || '?').slice(0, 1)}
                  </span>
                  <span className={styles.phoneListText}>
                    <strong>{contact.remark}</strong>
                    <span>{latest?.content ?? '还没有短信内容'}</span>
                    <span>{formatSmsTime(latest?.createdAt ?? thread.updatedAt)}</span>
                  </span>
                </button>
              );
            })}
            {threads.length === 0 ? (
              <div className={styles.phoneEmptyStateCard}>
                还没有短信线程。可先去通讯录编辑联系人，再进入短信详情添加一条 mock 消息。
              </div>
            ) : null}
          </section>
        ) : (
          <>
            <section className={styles.phoneThreadHeader}>
              <span className={styles.phoneListAvatar}>
                {selectedContact ? (
                  selectedContact.agent ? <XingyeAgentAvatar agent={selectedContact.agent} alt={selectedContact.remark} /> : (selectedContact.remark || '?').slice(0, 1)
                ) : (
                  <span>?</span>
                )}
              </span>
              <div className={styles.phoneListText}>
                <strong>{selectedContact?.remark ?? '未知联系人'}</strong>
                <span>对方：{selectedContact?.displayName ?? selectedTarget?.targetId}</span>
              </div>
            </section>

            <section className={styles.phoneMessageList} aria-label="短信详情">
              {selectedThread?.messages.length ? [...selectedThread.messages]
                .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
                .map(message => {
                  const outgoing = message.fromAgentId === ownerAgentId;
                  return (
                    <article
                      key={message.id}
                      className={`${styles.phoneMessageBubble} ${outgoing ? styles.phoneMessageBubble_outgoing : styles.phoneMessageBubble_incoming}`}
                    >
                      <p>{message.content}</p>
                      <time dateTime={message.createdAt}>{formatSmsTime(message.createdAt)}</time>
                    </article>
                  );
              }) : (
                <div className={styles.phoneEmptyStateCard}>
                  暂无短信记录。后续可扩展为 AI 自动生成角色间短信；当前仅支持手动 mock 消息。
                </div>
              )}
            </section>

            <section className={styles.phoneComposer}>
              <button
                type="button"
                className={styles.phoneWeakAction}
                onClick={() => setShowTestTools(prev => !prev)}
              >
                {showTestTools ? '收起测试工具' : '测试工具 / 添加 mock 消息'}
              </button>
              {showTestTools ? (
                <>
                  <p className={styles.phoneAppHint}>仅用于测试短信 UI，不属于正式短信历史生成能力。</p>
                  <label className={styles.phoneFormField}>
                    <span>添加 mock 消息</span>
                    <textarea
                      rows={3}
                      value={draftMessage}
                      onChange={event => setDraftMessage(event.target.value)}
                      placeholder="输入一条测试短信"
                    />
                  </label>
                  <div className={styles.phoneActionRow}>
                    <select
                      className={styles.phoneInlineSelect}
                      value={direction}
                      onChange={event => setDirection(event.target.value as 'incoming' | 'outgoing')}
                    >
                      <option value="outgoing">我发给对方</option>
                      <option value="incoming">对方发给我</option>
                    </select>
                    <button type="button" className={styles.secondaryButton} disabled={!draftMessage.trim()} onClick={handleAddMockMessage}>
                      添加测试消息
                    </button>
                  </div>
                </>
              ) : null}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
