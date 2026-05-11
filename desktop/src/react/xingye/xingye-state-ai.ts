import type { Agent } from '../types';
import { hanaFetch } from '../hooks/use-hana-fetch';
import type { XingyeRoleProfileDisplay } from './xingye-profile-store';
import type { XingyeRelationshipState, XingyeRelationshipStatePatch } from './xingye-state-store';
import {
  buildRelationshipStatePrompt,
  type XingyeRelationshipStateTrigger,
} from './xingye-state-prompts';

export type XingyeRelationshipStateSuggestion = Required<XingyeRelationshipStatePatch>;

export interface GenerateRelationshipStateSuggestionArgs {
  agent: Pick<Agent, 'id' | 'name' | 'yuan'>;
  profile: Partial<XingyeRoleProfileDisplay> | null | undefined;
  state: XingyeRelationshipState;
  recentChatSummary?: string;
  sourceNotes?: string[];
  trigger?: XingyeRelationshipStateTrigger;
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
  const prompt = buildRelationshipStatePrompt({
    ...args,
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
