import type { Agent } from '../types';
import { hanaFetch } from '../hooks/use-hana-fetch';
import type { XingyeRoleProfileDisplay } from './xingye-profile-store';
import {
  buildXingyeLoreRuntimeQueryText,
  collectXingyeLoreRuntimeContext,
  formatXingyeLoreRuntimeContextBlock,
} from './xingye-lore-runtime-context';
import type { XingyeRelationshipState, XingyeRelationshipStatePatch } from './xingye-state-store';
import {
  buildRelationshipStatePrompt,
  type XingyeRelationshipStateTrigger,
} from './xingye-state-prompts';
import { resolveXingyeSpeakerUserName } from './xingye-speaker-context';

export type XingyeRelationshipStateSuggestion = Required<XingyeRelationshipStatePatch>;

export interface GenerateRelationshipStateSuggestionArgs {
  agent: Pick<Agent, 'id' | 'name' | 'yuan'>;
  profile: Partial<XingyeRoleProfileDisplay> | null | undefined;
  state: XingyeRelationshipState;
  recentChatSummary?: string;
  sourceNotes?: string[];
  /** 可选；未传时由本模块按 profile / state / recentChatSummary 自动构造 */
  loreContextText?: string;
  trigger?: XingyeRelationshipStateTrigger;
}

function buildLoreContextForRelationshipState(params: {
  agentId: string;
  profile: Partial<XingyeRoleProfileDisplay> | null | undefined;
  state: XingyeRelationshipState;
  recentChatSummary: string;
}): string {
  const profile = params.profile ?? {};
  const profileParts: Array<string | undefined> = [
    profile.displayName,
    profile.shortBio,
    profile.identitySummary,
    profile.backgroundSummary,
    profile.personalitySummary,
    profile.relationshipLabel,
    profile.values,
    profile.taboos,
    profile.relationshipMode,
  ];
  const stateParts: Array<string | undefined> = [
    params.state.mood,
    params.state.relationshipLabel,
    params.state.stateSummary,
    params.state.lastReason,
  ];
  const queryText = buildXingyeLoreRuntimeQueryText([
    ...profileParts,
    ...stateParts,
    params.recentChatSummary.trim() || undefined,
  ]);
  const context = collectXingyeLoreRuntimeContext(params.agentId, {
    purpose: 'relationship_state',
    queryText,
    maxChars: 2000,
  });
  return formatXingyeLoreRuntimeContextBlock(context);
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0;
}

function asShortString(value: unknown, fallback: string, maxLength: number): string {
  if (typeof value !== 'string') return fallback;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, maxLength) : fallback;
}

function clampDelta(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function normalizeRelationshipStateSuggestion(value: unknown): XingyeRelationshipStateSuggestion {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

  return {
    affectionDelta: clampDelta(asNumber(record.affectionDelta), -12, 12),
    trustDelta: clampDelta(asNumber(record.trustDelta), -10, 10),
    loyaltyDelta: clampDelta(asNumber(record.loyaltyDelta), -8, 8),
    jealousyDelta: clampDelta(asNumber(record.jealousyDelta), -8, 12),
    corruptionDelta: clampDelta(asNumber(record.corruptionDelta), -8, 8),
    mood: asShortString(record.mood, '平静', 12),
    stateSummary: asShortString(record.stateSummary, '上下文不足，状态保持平稳。', 180),
    reason: asShortString(record.reason, '上下文不足，本次建议保持保守。', 180),
  };
}

export async function generateRelationshipStateSuggestion(
  args: GenerateRelationshipStateSuggestionArgs,
): Promise<XingyeRelationshipStateSuggestion> {
  const recentChatSummary = args.recentChatSummary?.trim() ?? '';
  const userName = await resolveXingyeSpeakerUserName();
  const loreContextText = args.loreContextText?.trim()
    ? args.loreContextText
    : buildLoreContextForRelationshipState({
      agentId: args.agent.id,
      profile: args.profile,
      state: args.state,
      recentChatSummary,
    });
  const prompt = buildRelationshipStatePrompt({
    ...args,
    userName,
    recentChatSummary,
    loreContextText,
    trigger: args.trigger ?? 'manual_refresh',
  });

  const response = await hanaFetch('/api/xingye/phone-generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: 'relationship_state',
      agentId: args.agent.id,
      ownerAgentId: args.agent.id,
      prompt,
      timeoutMs: 60_000,
    }),
  });
  const data = await response.json();
  if (!response.ok || data?.ok === false || data?.error) {
    const details = Array.isArray(data?.details)
      ? `：${data.details.map((item: { tier?: string; message?: string }) => `${item.tier ?? 'model'} ${item.message ?? ''}`).join('；')}`
      : '';
    throw new Error(`${data?.error || '状态建议生成失败'}${details}`);
  }

  return normalizeRelationshipStateSuggestion(data?.result);
}
