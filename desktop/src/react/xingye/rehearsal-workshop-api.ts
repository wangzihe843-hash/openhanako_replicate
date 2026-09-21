import { hanaFetch } from '../hooks/use-hana-fetch';
import type { ServerConnection } from '../services/server-connection';
import { normalizeRehearsalPatch, type RehearsalMode } from './rehearsal-workshop-state';

export async function postRehearsalTurn(
  request: {
    agentId: string; profile: Record<string, unknown>; input: string; mode: RehearsalMode;
    previousText: string; feedback: string; loreEntries: { title: string; content: string }[];
  },
  options: { signal: AbortSignal; connection: ServerConnection },
) {
  const response = await hanaFetch('/api/xingye/lore-studio/rehearsal', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
    timeout: 95_000, signal: options.signal, connection: options.connection, throwOnHttpError: false,
  });
  const data: { error?: string; turn?: { text?: unknown; rationale?: unknown; profilePatch?: unknown } } = await response.json();
  if (!response.ok || !data.turn || typeof data.turn.text !== 'string' || !data.turn.text.trim()) {
    throw new Error(data.error || '模型未返回有效试演正文。');
  }
  return {
    text: data.turn.text.slice(0, 8000),
    rationale: typeof data.turn.rationale === 'string' ? data.turn.rationale.slice(0, 2000) : '',
    profilePatch: normalizeRehearsalPatch(data.turn.profilePatch),
  };
}