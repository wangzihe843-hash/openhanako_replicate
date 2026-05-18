import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Agent } from '../types';
import { useXingyeRoleProfile, type XingyeRoleProfileMap } from './xingye-profile-store';
import { XingyeAgentAvatar } from './XingyeAgentAvatar';
import { generateSmsHistoryWithAI, generateSmsUpdatesForChangedContactsWithAI } from './xingye-phone-ai';
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
import {
  confirmSmsDraft,
  discardSmsDraft,
  listSmsDrafts,
  type SmsDraftTargetType,
  type XingyePendingSmsDraft,
} from './xingye-sms-drafts';
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
  const contactsForSms = useMemo(
    () => contacts.filter(item => item.targetType !== 'user'),
    [contacts],
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
  const [smsIncrementalState, setSmsIncrementalState] = useState<'idle' | 'running' | 'success' | 'error'>('idle');
  const [smsIncrementalError, setSmsIncrementalError] = useState<string | null>(null);

  /** 心跳巡检产出的「待确认短信草稿」——落在 apps/sms/drafts.jsonl，没有 thread。 */
  const [pendingDrafts, setPendingDrafts] = useState<XingyePendingSmsDraft[]>([]);
  /**
   * 行内编辑缓冲。Key = draft.id。
   * `targetType:targetId` 让用户在 confirm 前可以重新选收件人（比如 matchName 没匹配
   * 上 / 用户想改给别人发）；内容编辑同 mail 草稿。
   */
  const [pendingDraftEdits, setPendingDraftEdits] = useState<
    Record<string, { content: string; targetType: SmsDraftTargetType; targetId: string }>
  >({});
  const [pendingDraftBusyId, setPendingDraftBusyId] = useState<string | null>(null);
  const [pendingDraftError, setPendingDraftError] = useState<string | null>(null);

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
      contacts: contactsForSms,
      profileFingerprint,
      mode: 'empty_only',
    }).catch(() => {});
  }, [ownerAgentId, ownerAgent, ownerProfile, contactsForSms, profileFingerprint, smsHistoryState?.generatedAt, smsAiState?.status]);

  const threads = useMemo(() => getSmsThreads(ownerAgentId), [ownerAgentId, version]);
  const visibleThreads = useMemo(
    () => threads.filter(thread => thread.targetType !== 'user'),
    [threads],
  );
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
      contacts: contactsForSms,
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
      contacts: contactsForSms,
      profileFingerprint,
      mode: 'replace_ai',
    }).catch(() => {});
  };

  const reloadPendingSmsDrafts = useCallback(async () => {
    if (!ownerAgentId) {
      setPendingDrafts([]);
      setPendingDraftEdits({});
      return;
    }
    try {
      const drafts = await listSmsDrafts(ownerAgentId);
      setPendingDrafts(drafts);
    } catch (err) {
      console.warn('[PhoneSmsApp] listSmsDrafts failed:', err);
    }
  }, [ownerAgentId]);

  useEffect(() => {
    void reloadPendingSmsDrafts();
  }, [reloadPendingSmsDrafts, version]);

  /**
   * 草稿正文与收件人的"working value"。
   * 收件人解析顺序：edits → draft.targetId → 按 displayName/matchName 在通讯录里查同名联系人。
   * 都解析不上就让 targetId='' （UI 上 confirm 按钮 disable，提示用户先选）。
   */
  const pendingDraftWorkingValue = useCallback(
    (d: XingyePendingSmsDraft): { content: string; targetType: SmsDraftTargetType; targetId: string } => {
      const edit = pendingDraftEdits[d.id];
      if (edit) return edit;
      let resolvedTargetId = d.targetId ?? '';
      if (!resolvedTargetId) {
        const name = (d.displayName ?? d.matchName ?? '').trim();
        if (name) {
          const match = contactsForSms.find(
            (c) => c.targetType === d.targetType && (c.displayName === name || c.remark === name),
          );
          if (match) resolvedTargetId = match.targetId;
        }
      }
      return { content: d.content, targetType: d.targetType, targetId: resolvedTargetId };
    },
    [pendingDraftEdits, contactsForSms],
  );

  const handlePendingDraftFieldChange = (
    draftId: string,
    patch: Partial<{ content: string; targetType: SmsDraftTargetType; targetId: string }>,
  ) => {
    setPendingDraftEdits((prev) => {
      const d = pendingDrafts.find((entry) => entry.id === draftId);
      if (!d) return prev;
      const base = prev[draftId] ?? pendingDraftWorkingValue(d);
      return { ...prev, [draftId]: { ...base, ...patch } };
    });
  };

  const handleConfirmPendingDraft = async (d: XingyePendingSmsDraft) => {
    if (!ownerAgentId) return;
    const working = pendingDraftWorkingValue(d);
    if (!working.targetId) {
      setPendingDraftError('请先为这条草稿选定收件人（通讯录里未能自动匹配）。');
      return;
    }
    setPendingDraftBusyId(d.id);
    setPendingDraftError(null);
    try {
      await confirmSmsDraft(ownerAgentId, d.id, {
        targetType: working.targetType,
        targetId: working.targetId,
        content: working.content,
      });
      setPendingDrafts((prev) => prev.filter((p) => p.id !== d.id));
      setPendingDraftEdits((prev) => {
        if (!(d.id in prev)) return prev;
        const { [d.id]: _omitted, ...rest } = prev;
        return rest;
      });
    } catch (err) {
      setPendingDraftError(err instanceof Error ? err.message : String(err));
    } finally {
      setPendingDraftBusyId(null);
    }
  };

  const handleDiscardPendingDraft = async (d: XingyePendingSmsDraft) => {
    if (!ownerAgentId) return;
    if (!window.confirm('确定丢弃这条待确认短信草稿？此操作不可恢复，但角色可在下次巡检里重新提议。')) {
      return;
    }
    setPendingDraftBusyId(d.id);
    setPendingDraftError(null);
    try {
      const ok = await discardSmsDraft(ownerAgentId, d.id);
      if (ok) {
        setPendingDrafts((prev) => prev.filter((p) => p.id !== d.id));
        setPendingDraftEdits((prev) => {
          if (!(d.id in prev)) return prev;
          const { [d.id]: _omitted, ...rest } = prev;
          return rest;
        });
      } else {
        await reloadPendingSmsDrafts();
      }
    } catch (err) {
      setPendingDraftError(err instanceof Error ? err.message : String(err));
    } finally {
      setPendingDraftBusyId(null);
    }
  };

  const handleIncrementalSmsFromContacts = async () => {
    if (!ownerAgent) return;
    setSmsIncrementalState('running');
    setSmsIncrementalError(null);
    try {
      await generateSmsUpdatesForChangedContactsWithAI({
        ownerAgent,
        ownerProfile,
        contacts,
        agents,
        profiles,
      });
      setSmsIncrementalState('success');
    } catch (err) {
      setSmsIncrementalState('error');
      setSmsIncrementalError(err instanceof Error ? err.message : String(err));
    }
  };

  const smsIncrementalBusy = smsIncrementalState === 'running';

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
          {smsIncrementalState === 'success' ? (
            <p className={styles.phoneAppHint}>已根据通讯录变化尝试补新短信。</p>
          ) : null}
          {smsIncrementalState === 'error' && smsIncrementalError ? (
            <p className={styles.phoneAppHint}>补新短信失败：{smsIncrementalError}</p>
          ) : null}
          <div className={styles.phoneActionRow}>
            <button type="button" className={styles.phoneWeakAction} onClick={handleRegenerateEmptyThreads} disabled={!ownerAgent || smsAiState?.status === 'running' || smsIncrementalBusy}>
              重新生成旧短信（仅空线程）
            </button>
            <button type="button" className={styles.phoneWeakAction} onClick={handleClearAiAndRegenerate} disabled={!ownerAgent || smsAiState?.status === 'running' || smsIncrementalBusy}>
              清除 AI 旧短信并重新生成
            </button>
            <button
              type="button"
              className={styles.phoneWeakAction}
              onClick={handleIncrementalSmsFromContacts}
              disabled={!ownerAgent || smsAiState?.status === 'running' || smsIncrementalBusy}
            >
              {smsIncrementalBusy ? '补新短信中…' : '根据通讯录变化补新短信'}
            </button>
          </div>
        </section>

        {!selectedTarget && pendingDrafts.length > 0 ? (
          <section
            aria-label="待确认短信草稿"
            data-testid="phone-sms-pending-drafts"
            style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
          >
            <p className={styles.phoneAppHint}>
              待确认草稿 · 来自心跳巡检。这些是 TA 在巡检里想发的短信，还没出现在任何 thread 里。
              点「确认发送」会作为 TA 发出的消息写进对应联系人的短信线程。
            </p>
            {pendingDraftError ? (
              <p className={styles.phoneAppHint} role="alert">{pendingDraftError}</p>
            ) : null}
            {pendingDrafts.map((d) => {
              const working = pendingDraftWorkingValue(d);
              const busy = pendingDraftBusyId === d.id;
              const candidateContacts = contactsForSms.filter((c) => c.targetType === working.targetType);
              const recipientLabel = d.displayName ?? d.matchName ?? d.targetId ?? '（未指定）';
              return (
                <div
                  key={d.id}
                  className={styles.phoneAppCard}
                  style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}
                  data-testid={`phone-sms-pending-draft-${d.id}`}
                >
                  <p className={styles.phoneAppHint} style={{ margin: 0 }}>
                    收件人提示：{recipientLabel}（{d.targetType === 'agent' ? '其他角色' : '虚拟联系人'}）
                  </p>
                  <label className={styles.phoneFormField}>
                    <span>实际收件人</span>
                    <select
                      className={styles.phoneInlineSelect}
                      value={working.targetId}
                      onChange={(e) =>
                        handlePendingDraftFieldChange(d.id, { targetId: e.target.value })
                      }
                      disabled={busy}
                      data-testid={`phone-sms-pending-draft-target-${d.id}`}
                    >
                      <option value="">— 请选择联系人 —</option>
                      {candidateContacts.map((c) => (
                        <option key={`${c.targetType}:${c.targetId}`} value={c.targetId}>
                          {c.remark || c.displayName || c.targetId}
                        </option>
                      ))}
                    </select>
                  </label>
                  <textarea
                    value={working.content}
                    onChange={(e) => handlePendingDraftFieldChange(d.id, { content: e.target.value })}
                    rows={3}
                    maxLength={240}
                    placeholder="短信正文（≤240 字符）"
                    aria-label="待确认短信草稿正文"
                    data-testid={`phone-sms-pending-draft-content-${d.id}`}
                    disabled={busy}
                    style={{ width: '100%', font: 'inherit', background: 'transparent', border: '1px dashed rgba(0,0,0,0.2)', padding: '6px' }}
                  />
                  {d.reason ? (
                    <p className={styles.phoneAppHint} style={{ margin: 0 }}>
                      理由：{d.reason}
                    </p>
                  ) : null}
                  <div className={styles.phoneActionRow}>
                    <button
                      type="button"
                      className={styles.secondaryButton}
                      onClick={() => void handleConfirmPendingDraft(d)}
                      disabled={busy || !working.targetId || !working.content.trim()}
                      data-testid={`phone-sms-pending-draft-confirm-${d.id}`}
                    >
                      {busy ? '处理中…' : '确认发送'}
                    </button>
                    <button
                      type="button"
                      className={styles.phoneWeakAction}
                      onClick={() => void handleDiscardPendingDraft(d)}
                      disabled={busy}
                      data-testid={`phone-sms-pending-draft-discard-${d.id}`}
                    >
                      丢弃
                    </button>
                  </div>
                </div>
              );
            })}
          </section>
        ) : null}

        {!selectedTarget ? (
          <section className={styles.phoneList} aria-label="短信线程列表">
            {visibleThreads.map(thread => {
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
            {visibleThreads.length === 0 ? (
              <div className={styles.phoneEmptyStateCard}>
                {threads.length > 0
                  ? '当前不显示与「你」的短信线程（单聊请用 OpenHanako 原生聊天）。其他联系人暂无短信。'
                  : '还没有短信线程。可先去通讯录编辑联系人，再进入短信详情添加一条 mock 消息。'}
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
