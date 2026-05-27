import { hanaFetch } from '../hooks/use-hana-fetch';
import type { Agent } from '../types';
import type { XingyeRoleProfile, XingyeRoleProfileMap } from './xingye-profile-store';
import type { XingyePhoneAiPayload } from './xingye-phone-ai-types';
import { buildRuleFallbackAiContacts } from './xingye-contact-generator';
import {
  applyAiContactUpdates,
  applyAiGeneratedContacts,
  addSmsMessage,
  clearAllVirtualContactsForOwner,
  createPhoneContactSnapshot,
  ensureGeneratedVirtualContacts,
  computePhoneContactGenerationInputHash,
  withVirtualContactAiGenerationLock,
  isStalePhoneContactGenerationRunning,
  getContactAiUpdateState,
  getLatestPhoneContactSnapshot,
  getPhoneContactGenerationState,
  getPhoneContactMeta,
  getPhoneContacts,
  getSmsThreads,
  getSmsThread,
  getUnconsumedContactChangesForSms,
  getVirtualContacts,
  markContactChangesConsumedBySms,
  normalizeAiContactUpdate,
  normalizeAiGeneratedContact,
  profileLikelyForbidsBlocked,
  ensureContactDistribution,
  reconcileVirtualContactInferenceFields,
  restorePhoneContactSnapshot,
  saveContactAiUpdateState,
  sanitizeEnrichmentSuggestionFields,
  savePhoneContactMeta,
  setPhoneContactGenerationState,
  setPhoneAiGenerationState,
  setSmsHistoryGenerationState,
  type XingyeAiContactUpdate,
  type XingyeAiGeneratedContact,
  type XingyeContactChangeLogItem,
  type XingyeContactGenerationMode,
  type XingyeContactUpdateMode,
  type XingyeContactTargetType,
  type XingyePhoneContactView,
} from './xingye-phone-store';
import {
  buildContactIncrementalUpdatePrompt,
  buildContactRegenerateAllPrompt,
  buildContactRollbackAndUpdatePrompt,
  buildContactsEnrichmentPrompt,
  buildSmsHistoryPrompt,
  buildSmsIncrementalUpdatePrompt,
  buildVirtualContactGenerationPrompt,
} from './xingye-phone-prompts';
import {
  collectRecentContextForAgent,
  type XingyeRecentContext,
} from './xingye-recent-context';
import { resolveXingyeSpeakerUserName } from './xingye-speaker-context';
import {
  buildXingyeLoreRuntimeQueryText,
  collectXingyeLoreRuntimeContext,
  formatXingyeLoreRuntimeContextBlock,
  type XingyeLoreRuntimeContextPurpose,
} from './xingye-lore-runtime-context';
import { listSmsDrafts } from './xingye-sms-drafts';

function buildLoreContextForPhone(params: {
  agentId: string;
  purpose: XingyeLoreRuntimeContextPurpose;
  ownerProfile: XingyeRoleProfile | null | undefined;
  contacts: XingyePhoneContactView[];
  recentContext?: XingyeRecentContext | null;
  smsSummary?: ReadonlyArray<{ latest?: string | null | undefined; latestContent?: string | null | undefined }>;
  reasons?: ReadonlyArray<string | null | undefined>;
}): string {
  const { agentId, purpose, ownerProfile, contacts, recentContext, smsSummary, reasons } = params;
  const profileParts: Array<string | undefined> = ownerProfile
    ? [
      ownerProfile.displayName,
      ownerProfile.shortBio,
      ownerProfile.identitySummary,
      ownerProfile.backgroundSummary,
      ownerProfile.personalitySummary,
      ownerProfile.relationshipLabel,
      ownerProfile.values,
      ownerProfile.taboos,
      ownerProfile.relationshipMode,
    ]
    : [];
  const contactParts: Array<string | undefined> = [];
  for (const c of contacts.slice(0, 20)) {
    contactParts.push(c.displayName, c.remark, c.impression, c.relationshipHint, c.shortBio, c.faction);
  }
  const smsParts = (smsSummary ?? []).flatMap((s) => [s.latest ?? undefined, s.latestContent ?? undefined]);
  const reasonParts = (reasons ?? []).filter((r): r is string => typeof r === 'string' && !!r.trim());
  const queryText = buildXingyeLoreRuntimeQueryText([
    ...profileParts,
    recentContext?.summaryText,
    ...contactParts,
    ...smsParts,
    ...reasonParts,
  ]);
  const context = collectXingyeLoreRuntimeContext(agentId, {
    purpose,
    queryText,
    maxChars: 2_000,
  });
  return formatXingyeLoreRuntimeContextBlock(context);
}

function asValidIso(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return null;
  return new Date(timestamp).toISOString();
}

function pickPrimaryChangeAction(actions: XingyeContactChangeLogItem['action'][]): XingyeContactChangeLogItem['action'] {
  const rank: Record<XingyeContactChangeLogItem['action'], number> = {
    delete: 5,
    block: 4,
    restore: 3,
    update: 2,
    add: 1,
  };
  if (!actions.length) return 'update';
  return [...actions].sort((a, b) => (rank[b] ?? 0) - (rank[a] ?? 0))[0]!;
}

function getSmsFallbackCreatedAt(params: {
  contactIndex: number;
  messageIndex: number;
  status: XingyePhoneContactView['status'];
}): string {
  const now = Date.now();
  const statusBiasDays = params.status === 'deleted' ? 28 : (params.status === 'blocked' ? 14 : 0);
  const baseDays = (params.contactIndex + 1) * 2 + statusBiasDays;
  const hourOffset = params.messageIndex * 5 + (params.contactIndex % 3);
  return new Date(now - (baseDays * 24 + hourOffset) * 60 * 60 * 1000).toISOString();
}

function parsePayload(raw: unknown): XingyePhoneAiPayload {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { contacts?: unknown[] }).contacts)) {
    throw new Error('AI 返回格式错误：contacts 缺失');
  }
  return {
    contacts: (raw as { contacts: unknown[] }).contacts
      .filter((item): item is XingyePhoneAiPayload['contacts'][number] => !!item && typeof item === 'object' && typeof (item as { targetId?: unknown }).targetId === 'string')
      .map(item => ({
        ...(item as XingyePhoneAiPayload['contacts'][number]),
        messages: Array.isArray((item as { messages?: unknown[] }).messages)
          ? (item as { messages: unknown[] }).messages.filter((msg): msg is NonNullable<XingyePhoneAiPayload['contacts'][number]['messages']>[number] => (
            !!msg
            && typeof msg === 'object'
            && ((msg as { from?: unknown }).from === 'owner' || (msg as { from?: unknown }).from === 'target')
            && typeof (msg as { content?: unknown }).content === 'string'
          ))
          : [],
      })),
  };
}

async function requestPhoneAi(input: {
  kind:
    | 'contacts_enrichment'
    | 'sms_history'
    | 'virtual_contacts_generate'
    | 'contacts_incremental_update'
    | 'contacts_regenerate_all'
    | 'contacts_rollback_update';
  ownerAgentId: string;
  ownerProfile: XingyeRoleProfile | null | undefined;
  contacts: XingyePhoneContactView[];
  existingThreads?: unknown[];
  prompt: string;
  timeoutMs?: number;
  /** 后端目前只使用 prompt；结构化字段挂在请求体里便于以后服务端单独消费。 */
  recentContext?: XingyeRecentContext | null;
}): Promise<{ raw: unknown }> {
  const timeoutMs = input.timeoutMs ?? 90_000;
  const response = await hanaFetch('/api/xingye/phone-generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeout: timeoutMs,
    body: JSON.stringify({
      kind: input.kind,
      ownerAgentId: input.ownerAgentId,
      ownerProfile: input.ownerProfile ?? null,
      contacts: input.contacts.map(contact => ({
        targetType: contact.targetType,
        targetId: contact.targetId,
        displayName: contact.displayName,
        remark: contact.remark,
        impression: contact.impression,
        relationshipHint: contact.relationshipHint,
        tags: contact.tags,
        faction: contact.faction,
        status: contact.status,
        kind: contact.kind,
        generatedReason: contact.generatedReason,
      })),
      existingThreads: input.existingThreads ?? [],
      recentContext: input.recentContext
        ? {
          messages: input.recentContext.messages,
          summaryText: input.recentContext.summaryText,
          sourceNotes: input.recentContext.sourceNotes,
        }
        : null,
      prompt: input.prompt,
      timeoutMs,
    }),
  });
  let data: any;
  try {
    data = await response.json();
  } catch {
    throw new Error('解析失败');
  }
  if (!response.ok || data?.ok === false || data?.error) {
    throw new Error(`模型调用失败：${data?.error || response.statusText || 'unknown error'}`);
  }
  return { raw: data.result };
}

function mergeContactSuggestion(ownerAgentId: string, contact: XingyePhoneContactView, suggestion: XingyePhoneAiPayload['contacts'][number]) {
  const existing = getPhoneContactMeta(ownerAgentId, contact.targetType, contact.targetId);
  const manualFields = new Set(existing?.manualEditedFields ?? []);
  const cleaned = sanitizeEnrichmentSuggestionFields({
    remark: suggestion.remark,
    impression: suggestion.impression,
    relationshipHint: suggestion.relationshipHint,
  });
  savePhoneContactMeta(ownerAgentId, contact.targetType, contact.targetId, {
    remark: manualFields.has('remark') ? existing?.remark : (cleaned.remark ?? existing?.remark),
    impression: manualFields.has('impression') ? existing?.impression : (cleaned.impression ?? existing?.impression),
    relationshipHint: manualFields.has('relationshipHint') ? existing?.relationshipHint : (cleaned.relationshipHint ?? existing?.relationshipHint),
    tags: manualFields.has('tags') ? (existing?.tags ?? []) : (suggestion.tags ?? existing?.tags ?? []),
    faction: manualFields.has('faction') ? existing?.faction : (suggestion.faction ?? existing?.faction),
    status: manualFields.has('status') ? existing?.status : (suggestion.status ?? existing?.status ?? contact.status),
    source: 'ai_generated',
  }, undefined, { markManualFields: false });
}

function parseGeneratedContacts(raw: unknown): XingyeAiGeneratedContact[] {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { contacts?: unknown[] }).contacts)) {
    throw new Error('解析失败');
  }
  return (raw as { contacts: unknown[] }).contacts
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map((item) => ({
      targetType: 'virtual_contact' as const,
      displayName: typeof item.displayName === 'string' ? item.displayName.trim() : '',
      kind: typeof item.kind === 'string' ? item.kind as XingyeAiGeneratedContact['kind'] : 'unknown',
      shortBio: typeof item.shortBio === 'string' ? item.shortBio : undefined,
      remark: typeof item.remark === 'string' ? item.remark : undefined,
      impression: typeof item.impression === 'string' ? item.impression : undefined,
      relationshipHint: typeof item.relationshipHint === 'string' ? item.relationshipHint : undefined,
      tags: Array.isArray(item.tags) ? item.tags.filter(tag => typeof tag === 'string') as string[] : [],
      faction: typeof item.faction === 'string' ? item.faction : undefined,
      status: typeof item.status === 'string' ? item.status as XingyeAiGeneratedContact['status'] : 'active',
      generatedReason: typeof item.generatedReason === 'string' ? item.generatedReason : 'AI generated',
    }))
    .filter(item => !!item.displayName)
    .map(normalizeAiGeneratedContact);
}

function parseContactUpdates(raw: unknown): XingyeAiContactUpdate[] {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { updates?: unknown[] }).updates)) {
    throw new Error('解析失败');
  }
  return (raw as { updates: unknown[] }).updates
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map((item) => ({
      action: typeof item.action === 'string' ? item.action as XingyeAiContactUpdate['action'] : 'update',
      targetType: typeof item.targetType === 'string' ? item.targetType as XingyeAiContactUpdate['targetType'] : 'virtual_contact',
      targetId: typeof item.targetId === 'string' ? item.targetId : undefined,
      matchName: typeof item.matchName === 'string' ? item.matchName : undefined,
      contact: item.contact && typeof item.contact === 'object'
        ? parseGeneratedContacts({ contacts: [item.contact] })[0]
        : undefined,
      patch: item.patch && typeof item.patch === 'object' ? item.patch as XingyeAiContactUpdate['patch'] : undefined,
      reason: typeof item.reason === 'string' ? item.reason : 'AI update',
    }))
    .map(normalizeAiContactUpdate);
}

function setContactUpdateState(
  ownerAgentId: string,
  mode: XingyeContactUpdateMode,
  status: 'running' | 'success' | 'failed',
  error?: string,
) {
  const previous = getContactAiUpdateState(ownerAgentId);
  saveContactAiUpdateState(ownerAgentId, {
    ownerAgentId,
    mode,
    status,
    startedAt: status === 'running' ? new Date().toISOString() : previous?.startedAt,
    finishedAt: status === 'running' ? undefined : new Date().toISOString(),
    error,
    version: (previous?.version ?? 0) + 1,
  });
}

export async function enrichContactsWithAI(params: {
  ownerAgent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  contacts: XingyePhoneContactView[];
  profileFingerprint: string;
}) {
  const { ownerAgent, ownerProfile, contacts, profileFingerprint } = params;
  setPhoneAiGenerationState(ownerAgent.id, 'contacts_enrichment', {
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: undefined,
    error: undefined,
    profileFingerprint,
    version: 1,
  });
  try {
    const userName = await resolveXingyeSpeakerUserName();
    const loreContextText = buildLoreContextForPhone({
      agentId: ownerAgent.id,
      purpose: 'phone_contacts',
      ownerProfile,
      contacts,
    });
    const prompt = buildContactsEnrichmentPrompt({ ownerAgent, ownerProfile, contacts, userName, loreContextText });
    const { raw } = await requestPhoneAi({
      kind: 'contacts_enrichment',
      ownerAgentId: ownerAgent.id,
      ownerProfile,
      contacts,
      prompt,
      timeoutMs: 90_000,
    });
    const payload = parsePayload(raw);
    for (const suggestion of payload.contacts) {
      const contact = contacts.find(item => item.targetType === suggestion.targetType && item.targetId === suggestion.targetId);
      if (!contact) continue;
      mergeContactSuggestion(ownerAgent.id, contact, suggestion);
    }
    setPhoneAiGenerationState(ownerAgent.id, 'contacts_enrichment', {
      status: 'success',
      finishedAt: new Date().toISOString(),
      profileFingerprint,
      error: undefined,
      version: 1,
    });
  } catch (error) {
    setPhoneAiGenerationState(ownerAgent.id, 'contacts_enrichment', {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      profileFingerprint,
      error: error instanceof Error ? error.message : String(error),
      version: 1,
    });
    throw error;
  }
}

export async function generateVirtualContactsWithAI(params: {
  ownerAgent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  contacts: XingyePhoneContactView[];
  agents: Agent[];
  profiles: Record<string, XingyeRoleProfile | undefined>;
  profileFingerprint: string;
  mode?: XingyeContactUpdateMode;
}) {
  const { ownerAgent } = params;
  return withVirtualContactAiGenerationLock(ownerAgent.id, () => generateVirtualContactsWithAISequential(params));
}

async function generateVirtualContactsWithAISequential(params: {
  ownerAgent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  contacts: XingyePhoneContactView[];
  agents: Agent[];
  profiles: Record<string, XingyeRoleProfile | undefined>;
  profileFingerprint: string;
  mode?: XingyeContactUpdateMode;
}) {
  const { ownerAgent, ownerProfile, contacts, profileFingerprint, agents, profiles } = params;
  const mode = params.mode ?? 'initial_ai_generate';
  const isRegenerate = mode === 'regenerate_all';
  const sortedAgentIds = agents.map(a => a.id).sort();
  const inputHash = computePhoneContactGenerationInputHash(profileFingerprint, sortedAgentIds);
  const softBlock = profileLikelyForbidsBlocked(ownerProfile, ownerAgent);
  const distCtx = isRegenerate
    ? { intent: 'regenerate' as const, profileAllowsNoBlocked: softBlock }
    : { intent: 'initial' as const };

  let existingGen = getPhoneContactGenerationState(ownerAgent.id);
  if (existingGen?.status === 'running' && isStalePhoneContactGenerationRunning(existingGen)) {
    const finStale = new Date().toISOString();
    setPhoneContactGenerationState(ownerAgent.id, {
      ...existingGen,
      status: 'failed',
      finishedAt: finStale,
      error: 'stale_run_aborted',
      version: existingGen.version,
    });
    existingGen = getPhoneContactGenerationState(ownerAgent.id);
  }

  const startedAt = new Date().toISOString();
  setPhoneContactGenerationState(ownerAgent.id, {
    ownerAgentId: ownerAgent.id,
    generatedAt: startedAt,
    profileFingerprint,
    inputHash,
    mode: 'ai',
    version: 1,
    status: 'running',
    startedAt,
  });

  setContactUpdateState(ownerAgent.id, mode, 'running');
  try {
    const userName = await resolveXingyeSpeakerUserName();
    const recentContext = collectRecentContextForAgent({ agentId: ownerAgent.id });
    const loreContextText = buildLoreContextForPhone({
      agentId: ownerAgent.id,
      purpose: 'phone_contacts',
      ownerProfile,
      contacts,
      recentContext,
    });
    const prompt = isRegenerate
      ? buildContactRegenerateAllPrompt({ ownerAgent, ownerProfile, contacts, recentContext, userName, loreContextText })
      : buildVirtualContactGenerationPrompt({ ownerAgent, ownerProfile, contacts, intent: 'initial', recentContext, userName, loreContextText });
    const { raw } = await requestPhoneAi({
      kind: isRegenerate ? 'contacts_regenerate_all' : 'virtual_contacts_generate',
      ownerAgentId: ownerAgent.id,
      ownerProfile,
      contacts,
      prompt,
      recentContext,
      timeoutMs: 120_000,
    });
    let generated = parseGeneratedContacts(raw);
    const aiReturnedCount = generated.length;
    /** 仅去掉本批里 displayName 字面重复；是否与已有联系人为同一人由 prompt 要求模型用 shortBio/impression 等语义自检。 */
    const seenBatch = new Set<string>();
    generated = generated.filter((c) => {
      const k = c.displayName.trim().toLowerCase();
      if (!k) return false;
      if (seenBatch.has(k)) return false;
      seenBatch.add(k);
      return true;
    });
    generated = ensureContactDistribution(generated, distCtx);
    let ruleFallbackPadded = 0;
    if (isRegenerate) {
      const minCount = 8;
      const maxCount = 16;
      if (generated.length > maxCount) generated = generated.slice(0, maxCount);
      if (generated.length < minCount) {
        const nameSet = new Set(generated.map(c => c.displayName.trim().toLowerCase()).filter(Boolean));
        const extras = buildRuleFallbackAiContacts(
          { ownerAgentId: ownerAgent.id, agent: ownerAgent, profile: ownerProfile, agents },
          minCount - generated.length,
          nameSet,
        );
        ruleFallbackPadded = extras.length;
        const normalizedExtras = extras.map(c => normalizeAiGeneratedContact(c));
        generated = [...generated, ...normalizedExtras];
        generated = ensureContactDistribution(generated, distCtx);
        if (generated.length > maxCount) generated = generated.slice(0, maxCount);
      }
    }
    const applyResult = applyAiGeneratedContacts(ownerAgent.id, generated, {
      mergeMatchingDisplayName: isRegenerate ? 'regenerate' : 'prefer-active-only',
    });
    const virtuals = getVirtualContacts(ownerAgent.id);
    const finishedAt = new Date().toISOString();
    setPhoneContactGenerationState(ownerAgent.id, {
      ownerAgentId: ownerAgent.id,
      generatedAt: finishedAt,
      profileFingerprint,
      inputHash,
      mode: 'ai',
      version: 1,
      status: 'success',
      startedAt,
      finishedAt,
    });
    setContactUpdateState(ownerAgent.id, mode, 'success');
    const noticeBits: string[] = [];
    if (ruleFallbackPadded) noticeBits.push(`AI 返回数量偏少，已用本地规则补足 ${ruleFallbackPadded} 个。`);
    if (applyResult.createdCount === 0 && applyResult.mergedCount > 0) {
      noticeBits.push('生成结果与已有联系人重复，未新增；已合并刷新印象。');
    } else if (applyResult.createdCount > 0 && applyResult.mergedCount > 0) {
      noticeBits.push(`实际新增 ${applyResult.createdCount} 条，合并刷新 ${applyResult.mergedCount} 条（同名归并）。`);
    } else if (applyResult.createdCount > 0) {
      noticeBits.push(`实际新增 ${applyResult.createdCount} 条联系人。`);
    }
    return {
      generatedBy: 'ai' as const,
      count: virtuals.length,
      aiReturnedCount,
      ruleFallbackPadded,
      createdCount: applyResult.createdCount,
      mergedCount: applyResult.mergedCount,
      skippedCount: applyResult.skippedCount,
      notice: noticeBits.length ? noticeBits.join(' ') : undefined,
    };
  } catch (error) {
    const fin = new Date().toISOString();
    const errMsg = error instanceof Error ? error.message : String(error);
    setPhoneContactGenerationState(ownerAgent.id, {
      ownerAgentId: ownerAgent.id,
      generatedAt: startedAt,
      profileFingerprint,
      inputHash,
      mode: 'ai',
      version: 1,
      status: 'failed',
      startedAt,
      finishedAt: fin,
      error: errMsg,
    });
    ensureGeneratedVirtualContacts(ownerAgent.id, ownerAgent, ownerProfile, agents, profiles as XingyeRoleProfileMap);
    setContactUpdateState(ownerAgent.id, mode, 'failed', errMsg);
    return { generatedBy: 'rule_fallback' as const, count: 0, error: errMsg };
  }
}

export async function updateContactsFromRecentContextWithAI(params: {
  ownerAgent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  contacts: XingyePhoneContactView[];
  agents: Agent[];
  profiles: XingyeRoleProfileMap;
}) {
  const { ownerAgent, ownerProfile, contacts, agents, profiles } = params;
  /** 与「回滚上次并更新」配套：否则 latest 长期停留在 regenerate 时的快照，增量更新无法被回滚到正确基线。 */
  createPhoneContactSnapshot(ownerAgent.id, 'incremental_update_before');
  setContactUpdateState(ownerAgent.id, 'incremental_update', 'running');
  try {
    const userName = await resolveXingyeSpeakerUserName();
    const smsSummary = getSmsThreads(ownerAgent.id).slice(0, 20).map(thread => ({
      targetType: thread.targetType,
      targetId: thread.targetId,
      latest: thread.messages[thread.messages.length - 1]?.content ?? '',
      count: thread.messages.length,
    }));
    const recentContext = collectRecentContextForAgent({ agentId: ownerAgent.id });
    const loreContextText = buildLoreContextForPhone({
      agentId: ownerAgent.id,
      purpose: 'phone_contacts',
      ownerProfile,
      contacts,
      recentContext,
      smsSummary,
    });
    const prompt = buildContactIncrementalUpdatePrompt({ ownerAgent, ownerProfile, contacts, smsSummary, recentContext, userName, loreContextText });
    const { raw } = await requestPhoneAi({
      kind: 'contacts_incremental_update',
      ownerAgentId: ownerAgent.id,
      ownerProfile,
      contacts,
      prompt,
      recentContext,
      timeoutMs: 120_000,
    });
    const updates = parseContactUpdates(raw);
    applyAiContactUpdates(ownerAgent.id, updates, {
      agents,
      profiles,
      contactChangeSource: 'contacts_incremental_update',
    });
    reconcileVirtualContactInferenceFields(ownerAgent.id, agents, profiles);
    const contactsAfter = getPhoneContacts(ownerAgent.id, agents, profiles, { includeDeleted: true });
    void generateSmsUpdatesForChangedContactsWithAI({
      ownerAgent,
      ownerProfile,
      contacts: contactsAfter,
      agents,
      profiles,
    }).catch(() => {});
    setContactUpdateState(ownerAgent.id, 'incremental_update', 'success');
    return {
      updatesCount: updates.length,
      recentContext: {
        hasOpenHanakoMessages: recentContext.hasOpenHanakoMessages,
        messageCount: recentContext.messages.length,
        sourceNotes: recentContext.sourceNotes,
      },
    };
  } catch (error) {
    setContactUpdateState(ownerAgent.id, 'incremental_update', 'failed', error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export async function regenerateAllContactsWithAI(params: {
  ownerAgent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  contacts: XingyePhoneContactView[];
  agents: Agent[];
  profiles: Record<string, XingyeRoleProfile | undefined>;
  profileFingerprint: string;
}) {
  const { ownerAgent, ownerProfile, agents, profiles, profileFingerprint } = params;
  /** 快照与列表上限见 xingye-phone-store：仅保留最近 2 份备份，更早的会在写入快照时丢弃。 */
  createPhoneContactSnapshot(ownerAgent.id, 'regenerate_all_before');
  /**
   * 清空 AI 生成的 virtual_contact 后再生成；但保留任何 manualEditedFields 非空 / source=manual 的虚拟
   * 联系人，以满足「重新生成全部不应清掉手动联系人和手动 blocked/deleted 状态」的需求。
   * 余下的同名 AI 候选会通过 applyAiGeneratedContacts 的 dedupe 合并到保留项上。
   */
  clearAllVirtualContactsForOwner(ownerAgent.id, undefined, { preserveManuallyEdited: true });
  const contactsForPrompt = getPhoneContacts(ownerAgent.id, agents, profiles as XingyeRoleProfileMap, { includeDeleted: true });
  return generateVirtualContactsWithAI({
    ownerAgent,
    ownerProfile,
    contacts: contactsForPrompt,
    agents,
    profiles,
    profileFingerprint,
    mode: 'regenerate_all',
  });
}

export async function rollbackAndUpdateContactsWithAI(params: {
  ownerAgent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  agents: Agent[];
  profiles: XingyeRoleProfileMap;
}) {
  const { ownerAgent, ownerProfile, agents, profiles } = params;
  const latest = getLatestPhoneContactSnapshot(ownerAgent.id);
  if (!latest) throw new Error('没有可回滚版本。');
  const restored = restorePhoneContactSnapshot(ownerAgent.id, latest.id);
  if (!restored) throw new Error('回滚失败。');
  const contactsAfterRestore = getPhoneContacts(ownerAgent.id, agents, profiles, { includeDeleted: true });
  setContactUpdateState(ownerAgent.id, 'rollback_and_update', 'running');
  try {
    const userName = await resolveXingyeSpeakerUserName();
    const smsSummary = getSmsThreads(ownerAgent.id).slice(0, 20).map(thread => ({
      targetType: thread.targetType,
      targetId: thread.targetId,
      latest: thread.messages[thread.messages.length - 1]?.content ?? '',
      count: thread.messages.length,
    }));
    const recentContext = collectRecentContextForAgent({ agentId: ownerAgent.id });
    const loreContextText = buildLoreContextForPhone({
      agentId: ownerAgent.id,
      purpose: 'phone_contacts',
      ownerProfile,
      contacts: contactsAfterRestore,
      recentContext,
      smsSummary,
    });
    const prompt = buildContactRollbackAndUpdatePrompt({ ownerAgent, ownerProfile, contacts: contactsAfterRestore, smsSummary, recentContext, userName, loreContextText });
    const { raw } = await requestPhoneAi({
      kind: 'contacts_rollback_update',
      ownerAgentId: ownerAgent.id,
      ownerProfile,
      contacts: contactsAfterRestore,
      prompt,
      recentContext,
      timeoutMs: 120_000,
    });
    const updates = parseContactUpdates(raw);
    applyAiContactUpdates(ownerAgent.id, updates, {
      agents,
      profiles,
      contactChangeSource: 'contacts_rollback_update',
    });
    reconcileVirtualContactInferenceFields(ownerAgent.id, agents, profiles);
    const contactsAfterRollback = getPhoneContacts(ownerAgent.id, agents, profiles, { includeDeleted: true });
    void generateSmsUpdatesForChangedContactsWithAI({
      ownerAgent,
      ownerProfile,
      contacts: contactsAfterRollback,
      agents,
      profiles,
    }).catch(() => {});
    setContactUpdateState(ownerAgent.id, 'rollback_and_update', 'success');
    return {
      snapshotId: latest.id,
      updatesCount: updates.length,
      recentContext: {
        hasOpenHanakoMessages: recentContext.hasOpenHanakoMessages,
        messageCount: recentContext.messages.length,
        sourceNotes: recentContext.sourceNotes,
      },
    };
  } catch (error) {
    setContactUpdateState(ownerAgent.id, 'rollback_and_update', 'failed', error instanceof Error ? error.message : String(error));
    throw error;
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   SMS 反重复连续性锚点
   ─────────────────────────────────────────────────────────────────────────────
   SMS 草稿/历史生成容易反复抛同一句「在吗？」「最近怎么样？」「下次约饭」给同
   一个人。这里抽该联系人最近 5–8 条短信（已发送 + 已确认草稿）的内容首段做样本，
   塞进 prompt 让模型换不同话题或情绪。

   特别注意：SMS 是「对特定联系人」的对话，**anchor 必须按 targetType+targetId
   过滤**——A 给 B 写过的内容不应该污染 A 给 C 的草稿生成。
─────────────────────────────────────────────────────────────────────────── */

type SmsAnchorTarget = {
  targetType: XingyeContactTargetType;
  targetId: string;
};

/**
 * 单联系人 anchor：按 thread 抽最近 5–8 条消息的 content 首 30 字。
 *
 * 数据源：
 *   - getSmsThread → thread.messages（已发送 + AI 生成 + 心跳 confirm 后写入的草稿）；
 *   - listSmsDrafts → 同 targetId 还在「待确认」状态的草稿（content 也算预占的话题）。
 *
 * 顺序：先 thread.messages（已固化的）后 pending drafts（未来的话题），各取最近，
 * 总数封顶 8。
 *
 * 无任何历史 → 空字符串。
 */
export async function buildSmsContinuityAnchorBlock(
  agentId: string,
  target: SmsAnchorTarget,
): Promise<string> {
  try {
    const tType = target.targetType;
    const tId = target.targetId;
    if (!agentId || !tId) return '';
    const samples: string[] = [];

    // 1) thread 里的现存消息：按 createdAt 倒序取最近，标 owner/target。
    const thread = getSmsThread(agentId, tType, tId);
    if (thread?.messages?.length) {
      const sorted = [...thread.messages].sort(
        (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
      );
      for (const msg of sorted) {
        if (samples.length >= 6) break;
        const dir = msg.fromAgentId === agentId ? '己发' : '对方';
        const text = msg.content.trim().slice(0, 30);
        if (!text) continue;
        samples.push(`[${dir}] ${text}`);
      }
    }

    // 2) 同 target 的 pending drafts（也算"打算说的话"，避免再开一条几乎相同的草稿）。
    const pendingDrafts = await listSmsDrafts(agentId);
    const sameTargetDrafts = pendingDrafts.filter(
      (d) => d.targetType === tType && d.targetId === tId,
    );
    for (const d of sameTargetDrafts) {
      if (samples.length >= 8) break;
      const text = d.content.trim().slice(0, 30);
      if (!text) continue;
      samples.push(`[草稿待发] ${text}`);
    }

    if (!samples.length) return '';
    const lines: string[] = [];
    lines.push('- 最近发给这个联系人的短信样本（请避免重复同样话题/同样情绪/同样开场）：');
    for (const s of samples) lines.push(`  · ${s}`);
    lines.push('- 请换不同的话题切入、不同的情绪基调（关心 / 报备 / 询问 / 试探 / 提醒 / 道歉 …），避免和上面任一条措辞相近。');
    return lines.join('\n');
  } catch {
    return '';
  }
}

/**
 * 批量 anchor：buildSmsHistoryPrompt / buildSmsIncrementalUpdatePrompt 是一次给
 * 多个联系人生成，所以按 (targetType, targetId) 分别构建 anchor，组合成一个块。
 *
 * 输出格式：每个联系人一段，前面带「@<displayName> [<targetType>:<targetId>]」标头。
 * 无任何联系人有历史 → 空字符串。
 */
async function buildSmsBatchContinuityAnchorBlock(
  agentId: string,
  targets: ReadonlyArray<{ targetType: XingyeContactTargetType; targetId: string; displayName?: string }>,
): Promise<string> {
  const blocks: string[] = [];
  for (const t of targets) {
    if (t.targetType === 'user') continue;
    const single = await buildSmsContinuityAnchorBlock(agentId, { targetType: t.targetType, targetId: t.targetId });
    if (!single) continue;
    const header = `@${t.displayName ?? t.targetId} [${t.targetType}:${t.targetId}]`;
    blocks.push(`${header}\n${single}`);
  }
  if (!blocks.length) return '';
  return blocks.join('\n\n');
}

export async function generateSmsHistoryWithAI(params: {
  ownerAgent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  contacts: XingyePhoneContactView[];
  profileFingerprint: string;
  mode?: 'empty_only' | 'replace_ai';
}) {
  const { ownerAgent, ownerProfile, contacts, profileFingerprint } = params;
  const mode = params.mode ?? 'empty_only';
  const smsContacts = contacts.filter(item => item.targetType !== 'user');
  setPhoneAiGenerationState(ownerAgent.id, 'sms_history', {
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: undefined,
    error: undefined,
    profileFingerprint,
    version: 1,
  });
  try {
    const userName = await resolveXingyeSpeakerUserName();
    const loreContextText = buildLoreContextForPhone({
      agentId: ownerAgent.id,
      purpose: 'phone_sms',
      ownerProfile,
      contacts: smsContacts,
    });
    // SMS 反重复连续性锚点：按联系人分组抽样近期已发/已收/待发的短信首段，
    // 让模型为同一收件人换不同话题/情绪，不再复读「在吗？」「最近怎么样？」。
    const continuityAnchorBlock = await buildSmsBatchContinuityAnchorBlock(
      ownerAgent.id,
      smsContacts.map((c) => ({ targetType: c.targetType, targetId: c.targetId, displayName: c.displayName })),
    );
    const prompt = buildSmsHistoryPrompt({ ownerAgent, ownerProfile, contacts: smsContacts, userName, loreContextText, continuityAnchorBlock });
    const { raw } = await requestPhoneAi({
      kind: 'sms_history',
      ownerAgentId: ownerAgent.id,
      ownerProfile,
      contacts: smsContacts,
      existingThreads: getSmsThreads(ownerAgent.id).map(thread => ({
        targetType: thread.targetType,
        targetId: thread.targetId,
        messageCount: thread.messages.length,
      })),
      prompt,
      timeoutMs: 120_000,
    });
    const payload = parsePayload(raw);
    const contactIndexMap = new Map<string, number>();
    smsContacts.forEach((contact, index) => {
      contactIndexMap.set(`${contact.targetType}:${contact.targetId}`, index);
    });
    for (const suggestion of payload.contacts) {
      if (suggestion.targetType === 'user') continue;
      const contact = smsContacts.find(item => item.targetType === suggestion.targetType && item.targetId === suggestion.targetId);
      if (!contact) continue;
      if (!suggestion.messages?.length) continue;
      const existingThread = getSmsThread(ownerAgent.id, suggestion.targetType as XingyeContactTargetType, suggestion.targetId);
      if (mode === 'empty_only' && existingThread?.messages.length) continue;
      const contactIndex = contactIndexMap.get(`${contact.targetType}:${contact.targetId}`) ?? 0;
      const sortedMessages = suggestion.messages
        .slice(0, 10)
        .map((message, messageIndex) => ({
          ...message,
          createdAt: asValidIso((message as { createdAt?: unknown }).createdAt)
            ?? getSmsFallbackCreatedAt({ contactIndex, messageIndex, status: contact.status }),
        }))
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
      for (const message of sortedMessages) {
        const content = message.content.trim();
        if (!content) continue;
        addSmsMessage({
          ownerAgentId: ownerAgent.id,
          targetType: suggestion.targetType as XingyeContactTargetType,
          targetId: suggestion.targetId,
          content: content.slice(0, 80),
          direction: message.from === 'owner' ? 'outgoing' : 'incoming',
          source: 'ai_generated',
          createdAt: message.createdAt,
        });
      }
    }
    setSmsHistoryGenerationState(ownerAgent.id, {
      ownerAgentId: ownerAgent.id,
      generatedAt: new Date().toISOString(),
      profileFingerprint,
      contactsIncluded: smsContacts.map(contact => ({ targetType: contact.targetType, targetId: contact.targetId })),
      version: 1,
    });
    setPhoneAiGenerationState(ownerAgent.id, 'sms_history', {
      status: 'success',
      finishedAt: new Date().toISOString(),
      profileFingerprint,
      error: undefined,
      version: 1,
    });
  } catch (error) {
    setPhoneAiGenerationState(ownerAgent.id, 'sms_history', {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      profileFingerprint,
      error: error instanceof Error ? error.message : String(error),
      version: 1,
    });
    throw error;
  }
}

type SmsIncrementalBundle = {
  targetType: XingyeContactTargetType;
  targetId: string;
  action: XingyeContactChangeLogItem['action'];
  changedFields: XingyeContactChangeLogItem['changedFields'];
  mergedReasons: string[];
  changeLogIds: string[];
  contact: XingyePhoneContactView;
  smsSummary: { latestContent?: string; messageCount: number };
};

export async function generateSmsUpdatesForChangedContactsWithAI(params: {
  ownerAgent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  contacts: XingyePhoneContactView[];
  agents: Agent[];
  profiles: XingyeRoleProfileMap;
  storage?: Parameters<typeof getUnconsumedContactChangesForSms>[1];
}): Promise<
  | { ok: true; skipped: true; reason: string }
  | { ok: true; appended: number; consumedLogIds: number }
> {
  const storage = params.storage ?? null;
  const { ownerAgent, ownerProfile, contacts } = params;
  const unconsumed = getUnconsumedContactChangesForSms(ownerAgent.id, storage);
  if (!unconsumed.length) {
    return { ok: true, skipped: true, reason: 'no_unconsumed_changes' };
  }

  type Agg = {
    targetType: XingyeContactTargetType;
    targetId: string;
    changeIds: string[];
    reasons: string[];
    actions: Set<XingyeContactChangeLogItem['action']>;
    fields: Set<string>;
  };
  const groupMap = new Map<string, Agg>();
  for (const log of unconsumed) {
    const key = `${log.targetType}:${log.targetId}`;
    let agg = groupMap.get(key);
    if (!agg) {
      agg = {
        targetType: log.targetType,
        targetId: log.targetId,
        changeIds: [],
        reasons: [],
        actions: new Set(),
        fields: new Set(),
      };
      groupMap.set(key, agg);
    }
    agg.changeIds.push(log.id);
    if (log.reason.trim()) agg.reasons.push(log.reason.trim());
    agg.actions.add(log.action);
    for (const f of log.changedFields) agg.fields.add(f);
  }

  const invalidIds: string[] = [];
  const bundles: SmsIncrementalBundle[] = [];
  for (const agg of groupMap.values()) {
    const contact = contacts.find(c => c.targetType === agg.targetType && c.targetId === agg.targetId);
    if (!contact || contact.targetType === 'user') {
      invalidIds.push(...agg.changeIds);
      continue;
    }
    const thread = getSmsThread(ownerAgent.id, contact.targetType, contact.targetId, storage);
    const messages = thread?.messages ?? [];
    const msgCount = messages.length;
    const latest = messages.length ? messages[messages.length - 1]?.content : '';
    bundles.push({
      targetType: contact.targetType,
      targetId: contact.targetId,
      action: pickPrimaryChangeAction([...agg.actions]),
      changedFields: [...agg.fields] as XingyeContactChangeLogItem['changedFields'],
      mergedReasons: [...new Set(agg.reasons)],
      changeLogIds: agg.changeIds,
      contact,
      smsSummary: { latestContent: latest, messageCount: msgCount },
    });
  }

  if (invalidIds.length) {
    markContactChangesConsumedBySms(ownerAgent.id, invalidIds, storage);
  }

  if (!bundles.length) {
    return { ok: true, skipped: true, reason: 'no_eligible_contacts' };
  }

  const recentContext = collectRecentContextForAgent({ agentId: ownerAgent.id });
  const userName = await resolveXingyeSpeakerUserName();
  const loreContextText = buildLoreContextForPhone({
    agentId: ownerAgent.id,
    purpose: 'phone_sms',
    ownerProfile,
    contacts: bundles.map(b => b.contact),
    recentContext,
    smsSummary: bundles.map(b => ({ latestContent: b.smsSummary.latestContent })),
    reasons: bundles.flatMap(b => b.mergedReasons),
  });
  // SMS 增量更新同样按 target 分组做反重复锚点：避免对同一联系人反复抛同一句
  // 「在吗？」/「我也是」/「下次约饭」。
  const continuityAnchorBlock = await buildSmsBatchContinuityAnchorBlock(
    ownerAgent.id,
    bundles.map((b) => ({ targetType: b.targetType, targetId: b.targetId, displayName: b.contact.displayName })),
  );
  const prompt = buildSmsIncrementalUpdatePrompt({
    ownerAgent,
    ownerProfile,
    changeBundles: bundles,
    recentContext,
    userName,
    loreContextText,
    continuityAnchorBlock,
  });
  const { raw } = await requestPhoneAi({
    kind: 'sms_history',
    ownerAgentId: ownerAgent.id,
    ownerProfile,
    contacts: bundles.map(b => b.contact),
    existingThreads: bundles.map(b => ({
      targetType: b.targetType,
      targetId: b.targetId,
      messageCount: b.smsSummary.messageCount,
    })),
    prompt,
    recentContext,
    timeoutMs: 90_000,
  });
  const payload = parsePayload(raw);
  const bundleIdsToConsume = new Set(bundles.flatMap(b => b.changeLogIds));
  let appended = 0;
  for (const suggestion of payload.contacts) {
    if (suggestion.targetType === 'user') continue;
    const bundle = bundles.find(
      b => b.targetType === suggestion.targetType && b.targetId === suggestion.targetId,
    );
    if (!bundle) continue;
    const maxMsgs = bundle.action === 'delete' ? 1 : 3;
    const existingThread = getSmsThread(
      ownerAgent.id,
      suggestion.targetType as XingyeContactTargetType,
      suggestion.targetId,
      storage,
    );
    const lastTs = existingThread?.messages.length
      ? Math.max(...existingThread.messages.map(m => Date.parse(m.createdAt)))
      : Date.now() - 3_600_000;
    const sortedMessages = (suggestion.messages ?? [])
      .slice(0, maxMsgs)
      .map((message, messageIndex) => ({
        ...message,
        createdAt: asValidIso((message as { createdAt?: unknown }).createdAt)
          ?? new Date(lastTs + (messageIndex + 1) * 120_000).toISOString(),
      }))
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    for (const message of sortedMessages) {
      const content = message.content.trim();
      if (!content) continue;
      addSmsMessage({
        ownerAgentId: ownerAgent.id,
        targetType: suggestion.targetType as XingyeContactTargetType,
        targetId: suggestion.targetId,
        content: content.slice(0, 80),
        direction: message.from === 'owner' ? 'outgoing' : 'incoming',
        source: 'ai_generated',
        createdAt: message.createdAt,
      }, storage);
      appended += 1;
    }
  }

  markContactChangesConsumedBySms(ownerAgent.id, [...bundleIdsToConsume], storage);
  return { ok: true, appended, consumedLogIds: bundleIdsToConsume.size };
}
