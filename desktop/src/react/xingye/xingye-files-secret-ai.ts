import { hanaFetch } from '../hooks/use-hana-fetch';
import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import type { XingyeLoreEntry } from './xingye-lore-store';
import type { XingyeVirtualContact } from './xingye-phone-store';
import { buildHiddenFolderSeedPrompt } from './xingye-files-secret-prompts';
import type { XingyeHiddenFileEntryKind } from './xingye-files-secret-store';

export type XingyeHiddenSeedDraft = {
  kind: XingyeHiddenFileEntryKind;
  title: string;
  body: string;
};

function asString(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

function normalizeKind(value: unknown): XingyeHiddenFileEntryKind {
  if (
    value === 'weakness'
    || value === 'guilty_pleasure'
    || value === 'secret_taste'
    || value === 'secret_plan'
  ) {
    return value;
  }
  return 'secret_taste';
}

function normalizeSeedResult(raw: unknown): XingyeHiddenSeedDraft[] {
  if (!raw || typeof raw !== 'object') return [];
  const record = raw as Record<string, unknown>;
  const rawEntries = Array.isArray(record.entries) ? record.entries : [];
  const out: XingyeHiddenSeedDraft[] = [];
  for (const item of rawEntries) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const title = asString(r.title, 160);
    const body = asString(r.body, 1200);
    if (!title || !body) continue;
    out.push({ kind: normalizeKind(r.kind), title, body });
    if (out.length >= 4) break;
  }
  return out;
}

function summarizeNpcs(
  loreEntries: XingyeLoreEntry[] | null | undefined,
  contacts: XingyeVirtualContact[] | null | undefined,
  maxChars: number,
): string {
  const names: string[] = [];
  const seen = new Set<string>();
  const push = (name: string | undefined | null) => {
    const t = (name ?? '').trim();
    if (!t) return;
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    names.push(t);
  };
  if (Array.isArray(loreEntries)) {
    for (const e of loreEntries) {
      if (e?.enabled && e.category === 'character') push(e.title);
    }
  }
  if (Array.isArray(contacts)) {
    for (const c of contacts) {
      if (c?.status !== 'deleted' && c?.status !== 'blocked') push(c.displayName);
    }
  }
  if (!names.length) return '';
  const joined = names.join('、');
  if (joined.length <= maxChars) return joined;
  return `${joined.slice(0, Math.max(1, maxChars - 1))}…`;
}

/**
 * 调 `POST /api/xingye/phone-generate`（kind: files_secret_seed），生成 2-3 条种子条目。
 *
 * 与其他 AI 模块一致的失败语义：任何阶段抛错都会包成 Error 抛给调用方；
 * UI 自行决定是否提示用户「TA 这次没想起来什么，先把抽屉空着也行」。
 */
export async function generateHiddenSeedsWithAI(params: {
  agent: Agent;
  profile: XingyeRoleProfile | null | undefined;
  stableLoreBlock?: string;
  loreEntries?: XingyeLoreEntry[] | null;
  virtualContacts?: XingyeVirtualContact[] | null;
  count?: number;
  timeoutMs?: number;
}): Promise<XingyeHiddenSeedDraft[]> {
  const { agent, profile } = params;
  const count = params.count ?? 3;
  const timeoutMs = params.timeoutMs ?? 90_000;
  const stableLoreBlock = (params.stableLoreBlock ?? '').trim();
  const npcSummary = summarizeNpcs(params.loreEntries, params.virtualContacts, 600);

  const prompt = buildHiddenFolderSeedPrompt({
    agent,
    profile,
    stableLoreBlock,
    npcSummary,
    count,
  });

  const response = await hanaFetch('/api/xingye/phone-generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeout: timeoutMs,
    body: JSON.stringify({
      kind: 'files_secret_seed',
      ownerAgentId: agent.id,
      agentId: agent.id,
      prompt,
      timeoutMs,
    }),
  });

  let data: { ok?: boolean; error?: string; result?: unknown; details?: unknown };
  try {
    data = await response.json();
  } catch {
    throw new Error('解析服务器响应失败');
  }

  if (!response.ok || data?.ok === false || data?.error) {
    const details = Array.isArray(data?.details)
      ? `：${(data.details as { message?: string }[]).map((item) => item.message ?? '').join('；')}`
      : '';
    throw new Error(`${data?.error || '模型调用失败'}${details}`);
  }

  const normalized = normalizeSeedResult(data?.result);
  if (!normalized.length) {
    throw new Error('模型返回无效：entries 为空或格式不符');
  }
  return normalized;
}

export { normalizeSeedResult as normalizeHiddenSeedResultForTests };
