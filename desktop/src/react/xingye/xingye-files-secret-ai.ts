import { hanaFetch } from '../hooks/use-hana-fetch';
import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import type { XingyeLoreEntry } from './xingye-lore-store';
import type { XingyeVirtualContact } from './xingye-phone-store';
import { buildHiddenFolderSeedPrompt } from './xingye-files-secret-prompts';
import type {
  XingyeHiddenFileEntry,
  XingyeHiddenFileEntryKind,
} from './xingye-files-secret-store';
import {
  buildSecretFilesContinuityAnchorBlock,
  detectSecretFilesDuplicate,
} from './xingye-files-secret-dedupe';

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
  /**
   * 「抽屉里已存在的条目」——用于做反重复 anchor 与入库前兜底去重。
   * 调用方应按时间倒序传（listHiddenEntries 默认就是这个顺序）。
   */
  existingEntries?: XingyeHiddenFileEntry[] | null;
  count?: number;
  timeoutMs?: number;
}): Promise<XingyeHiddenSeedDraft[]> {
  const { agent, profile } = params;
  const count = params.count ?? 3;
  const timeoutMs = params.timeoutMs ?? 90_000;
  const stableLoreBlock = (params.stableLoreBlock ?? '').trim();
  const npcSummary = summarizeNpcs(params.loreEntries, params.virtualContacts, 600);
  const existingEntries = Array.isArray(params.existingEntries) ? params.existingEntries : [];
  const continuityAnchorBlock = buildSecretFilesContinuityAnchorBlock(existingEntries);

  const prompt = buildHiddenFolderSeedPrompt({
    agent,
    profile,
    stableLoreBlock,
    npcSummary,
    count,
    continuityAnchorBlock,
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

  /**
   * 入库前兜底：即使 prompt 端塞了 anchor，模型仍可能写出与已有条目几乎同名的
   * 新条目。这里按 kind 维度过 detectSecretFilesDuplicate，命中 exact_dup / similar
   * 直接丢弃；同时去掉 batch 内自身重复（两条都是 weakness · 手会抖）。
   *
   * 全部被滤掉时回退到原始 normalized——把"完全不去重"也算作合法返回，让 UI 自行
   * 决定降级，而不是抛错（种子生成失败 UX 较差）。
   */
  const filtered: XingyeHiddenSeedDraft[] = [];
  // simulate "已入库" 集合：existingEntries + 已经接受的本批 draft
  const accumulator: XingyeHiddenFileEntry[] = existingEntries.slice();
  for (const draft of normalized) {
    const detection = detectSecretFilesDuplicate(
      { title: draft.title, kind: draft.kind },
      accumulator,
    );
    if (detection.kind !== 'unique') continue;
    filtered.push(draft);
    accumulator.push({
      id: `__pending-${filtered.length}`,
      key: `__pending-${filtered.length}`,
      agentId: agent.id,
      kind: draft.kind,
      title: draft.title,
      body: draft.body,
      source: 'ai_seed',
      createdAt: new Date(0).toISOString(),
    });
  }
  return filtered.length ? filtered : normalized;
}

export { normalizeSeedResult as normalizeHiddenSeedResultForTests };
