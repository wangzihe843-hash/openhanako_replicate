/**
 * Phase 2：从当前角色的「关系 / 人物」类 lore 里，挑出还没有对应 agent 的非 user 实体，
 * 作为「可升级为独立角色」的候选。纯函数（便于单测）；判定靠名字匹配（lore 与 agent 之间
 * 无外键，只能名字对齐，参见 xingye-contact-lore-link 的同款思路）。
 *
 * 「同世界观 agent」判定：若当前角色的关系/人物实体里，有任意一个已对应到现有 agent，
 * 则认为世界里已经有 peer agent（hasExistingPeerAgent=true）；否则即用户说的「没有同世界观 agent」。
 * user 那条关系无 targetType 字段、难以确定性识别，交给后续 LLM peer-suggest 轮排除。
 */
import type { XingyeLoreCategory } from './xingye-lore-store';

export interface PeerScanLoreEntry {
  title: string;
  category: XingyeLoreCategory;
  keywords?: string[];
}

export interface PeerScanInput {
  loreEntries: PeerScanLoreEntry[];
  /** 现有 agent 的显示名（应已排除当前角色自己）。 */
  agentNames: string[];
  /** 已 link 到某个 agent 的虚拟联系人显示名（这些视为已成角色）。 */
  linkedContactNames?: string[];
}

export interface PeerCandidate {
  name: string;
  sourceTitle: string;
  category: 'relationship' | 'character';
}

export interface PeerScanResult {
  candidates: PeerCandidate[];
  hasExistingPeerAgent: boolean;
}

function norm(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '');
}

/**
 * 名字**精确**匹配（归一化后相等）。用于「写入定位」场景优先精确命中——避免子串包含的
 * peerNameMatches 把「寒鸦」误配到「寒鸦影」这类条目上、把链接段串写进错误实体。
 */
export function peerNameEquals(a: string, b: string): boolean {
  const na = norm(a);
  const nb = norm(b);
  return !!na && na === nb;
}

/** 名字匹配：归一化相等，或一方完整包含另一方（长度≥2，避免单字误配）。 */
export function peerNameMatches(a: string, b: string): boolean {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length >= 2 && nb.length >= 2) {
    return na.includes(nb) || nb.includes(na);
  }
  return false;
}

export function scanPeerUpgradeCandidates(input: PeerScanInput): PeerScanResult {
  const agentNames = (input.agentNames ?? []).map((n) => (n ?? '').trim()).filter(Boolean);
  const linkedNames = (input.linkedContactNames ?? []).map((n) => (n ?? '').trim()).filter(Boolean);

  const candidates: PeerCandidate[] = [];
  const seen = new Set<string>();
  let hasExistingPeerAgent = false;

  for (const entry of input.loreEntries ?? []) {
    const category = entry?.category;
    if (category !== 'relationship' && category !== 'character') continue;
    const title = (entry?.title ?? '').trim();
    if (!title) continue;

    // 实体别名集合：标题 + 关键词，用来和现有 agent / 联系人对齐。
    const aliases = [title, ...((entry.keywords ?? []).map((k) => (k ?? '').trim()).filter(Boolean))];

    const matchesAgent = agentNames.some((an) => aliases.some((al) => peerNameMatches(an, al)));
    if (matchesAgent) {
      hasExistingPeerAgent = true;
      continue; // 已是 agent，不再作为候选
    }

    const matchesLinked = linkedNames.some((cn) => aliases.some((al) => peerNameMatches(cn, al)));
    if (matchesLinked) continue; // 已 link 到某 agent

    const key = norm(title);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ name: title, sourceTitle: title, category });
  }

  return { candidates, hasExistingPeerAgent };
}
