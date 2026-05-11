import { hanaFetch } from '../hooks/use-hana-fetch';
import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import type { XingyePhoneAiPayload } from './xingye-phone-ai-types';
import {
  addMockSmsMessage,
  getPhoneContactMeta,
  getSmsThread,
  savePhoneContactMeta,
  setPhoneAiGenerationState,
  setSmsHistoryGenerationState,
  type XingyeContactTargetType,
  type XingyePhoneContactView,
} from './xingye-phone-store';
import { buildContactsEnrichmentPrompt, buildSmsHistoryPrompt } from './xingye-phone-prompts';

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
            && typeof (msg as { createdAt?: unknown }).createdAt === 'string'
          ))
          : [],
      })),
  };
}

async function requestPhoneAi(input: {
  kind: 'contacts_enrichment' | 'sms_history';
  ownerAgentId: string;
  ownerProfile: XingyeRoleProfile | null | undefined;
  contacts: XingyePhoneContactView[];
  existingThreads?: unknown[];
  prompt: string;
  timeoutMs?: number;
}): Promise<XingyePhoneAiPayload> {
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
  try {
    return parsePayload(data.result);
  } catch {
    throw new Error('解析失败');
  }
}

function mergeContactSuggestion(ownerAgentId: string, contact: XingyePhoneContactView, suggestion: XingyePhoneAiPayload['contacts'][number]) {
  const existing = getPhoneContactMeta(ownerAgentId, contact.targetType, contact.targetId);
  const manualFields = new Set(existing?.manualEditedFields ?? []);
  savePhoneContactMeta(ownerAgentId, contact.targetType, contact.targetId, {
    remark: manualFields.has('remark') ? existing?.remark : (suggestion.remark ?? existing?.remark),
    impression: manualFields.has('impression') ? existing?.impression : (suggestion.impression ?? existing?.impression),
    relationshipHint: manualFields.has('relationshipHint') ? existing?.relationshipHint : (suggestion.relationshipHint ?? existing?.relationshipHint),
    tags: manualFields.has('tags') ? (existing?.tags ?? []) : (suggestion.tags ?? existing?.tags ?? []),
    faction: manualFields.has('faction') ? existing?.faction : (suggestion.faction ?? existing?.faction),
    status: manualFields.has('status') ? existing?.status : (suggestion.status ?? existing?.status ?? contact.status),
    source: 'ai_generated',
  }, undefined, { markManualFields: false });
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
    const prompt = buildContactsEnrichmentPrompt({ ownerAgent, ownerProfile, contacts });
    const payload = await requestPhoneAi({
      kind: 'contacts_enrichment',
      ownerAgentId: ownerAgent.id,
      ownerProfile,
      contacts,
      prompt,
      timeoutMs: 90_000,
    });
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

export async function generateSmsHistoryWithAI(params: {
  ownerAgent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  contacts: XingyePhoneContactView[];
  profileFingerprint: string;
}) {
  const { ownerAgent, ownerProfile, contacts, profileFingerprint } = params;
  setPhoneAiGenerationState(ownerAgent.id, 'sms_history', {
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: undefined,
    error: undefined,
    profileFingerprint,
    version: 1,
  });
  try {
    const prompt = buildSmsHistoryPrompt({ ownerAgent, ownerProfile, contacts });
    const payload = await requestPhoneAi({
      kind: 'sms_history',
      ownerAgentId: ownerAgent.id,
      ownerProfile,
      contacts,
      prompt,
      timeoutMs: 120_000,
    });
    for (const suggestion of payload.contacts) {
      const contact = contacts.find(item => item.targetType === suggestion.targetType && item.targetId === suggestion.targetId);
      if (!contact) continue;
      mergeContactSuggestion(ownerAgent.id, contact, suggestion);
      if (!suggestion.messages?.length) continue;
      const existingThread = getSmsThread(ownerAgent.id, suggestion.targetType as XingyeContactTargetType, suggestion.targetId);
      if (existingThread?.messages.length) continue;
      for (const message of suggestion.messages.slice(0, 12)) {
        const content = message.content.trim();
        if (!content) continue;
        addMockSmsMessage(
          ownerAgent.id,
          suggestion.targetType as XingyeContactTargetType,
          suggestion.targetId,
          content.slice(0, 80),
          message.from === 'owner' ? 'outgoing' : 'incoming',
        );
      }
    }
    setSmsHistoryGenerationState(ownerAgent.id, {
      ownerAgentId: ownerAgent.id,
      generatedAt: new Date().toISOString(),
      profileFingerprint,
      contactsIncluded: contacts.map(contact => ({ targetType: contact.targetType, targetId: contact.targetId })),
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
