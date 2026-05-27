import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import type { XingyeLoreEntry } from './xingye-lore-store';
import type { XingyeVirtualContact } from './xingye-phone-store';

/**
 * 一条隐藏文件夹密码候选。
 *
 * - `value`：用于 hash 对比的明文（trim、不必预先 lowercase——store.hashPassword 会自己 lowercase）。
 * - `label`：人话标签，用作 UI 提示（如「你的姓名」「联系人 林雾 的名字」），密码被换时可以记一下。
 * - `kind`：来源分类，主要给测试断言用，也给 UI 决定是否给出「试试看你/TA 的什么」提示。
 */
export type XingyeHiddenPasswordCandidate = {
  value: string;
  label: string;
  kind:
    | 'agent_name'
    | 'agent_initials'
    | 'agent_yuan'
    | 'user_name'
    | 'user_initials'
    | 'npc_name'
    | 'contact_name';
};

export type XingyeHiddenPasswordContext = {
  agent: Pick<Agent, 'id' | 'name' | 'yuan'> | null | undefined;
  profile: XingyeRoleProfile | null | undefined;
  userName: string | null | undefined;
  loreEntries: XingyeLoreEntry[] | null | undefined;
  virtualContacts: XingyeVirtualContact[] | null | undefined;
};

const LATIN_INITIAL_RE = /[A-Za-z]/;

/**
 * 取一个名字里所有 ASCII 字母的首字母（不分词，按片段切）。
 *
 * 「Lin Wu」 → "LW"；「林雾」 → ""；「林 Wu」 → "W"；「Jane Doe-Smith」 → "JDS"。
 * 中文无法本地拿到拼音首字母——不依赖第三方库，宁缺毋滥。
 */
function asciiInitials(name: string): string {
  const parts = name.split(/[\s_\-·.]+/).filter(Boolean);
  let out = '';
  for (const part of parts) {
    const first = part.match(LATIN_INITIAL_RE);
    if (first) out += first[0].toUpperCase();
  }
  return out;
}

/**
 * 把一个名字裁成「典型密码形态」候选集合。
 *
 * 对一个 name="Lin Wu" / "林雾"：
 *  - 原名（trim）
 *  - 原名去空格
 *  - asciiInitials → 「LW」（只 latin 字母）
 *  - 单字 / 双字 / 三字中文名 不再额外拆 ——「林雾」就是「林雾」，没必要把「林」「雾」单独当密码（太弱）
 */
function expandNameToCandidates(name: string): string[] {
  const out = new Set<string>();
  const trimmed = name.trim();
  if (!trimmed) return [];
  out.add(trimmed);
  const collapsed = trimmed.replace(/\s+/g, '');
  if (collapsed && collapsed !== trimmed) out.add(collapsed);
  const initials = asciiInitials(trimmed);
  if (initials.length >= 2) out.add(initials);
  return Array.from(out);
}

function pushCandidate(
  acc: XingyeHiddenPasswordCandidate[],
  seen: Set<string>,
  value: string,
  label: string,
  kind: XingyeHiddenPasswordCandidate['kind'],
): void {
  const v = value.trim();
  if (!v) return;
  if (v.length < 2) return;
  const dedupeKey = `${kind}::${v.toLowerCase()}`;
  if (seen.has(dedupeKey)) return;
  seen.add(dedupeKey);
  acc.push({ value: v, label, kind });
}

/**
 * 从已知字段派生候选密码池。**不**包含任何「生日 / 重要日期」——
 * Agent / Profile schema 里没这种字段（确认过），不会编造。
 *
 * 候选优先级（label 上用 kind 标，UI 想要的话可以按 kind 排序展示）：
 *   1. agent 全名 / displayName + 拉丁首字母
 *   2. agent.yuan（角色所属的"圆"）
 *   3. user 名 + 拉丁首字母
 *   4. lore 里 category==='character' 的 NPC 名（仅 enabled）
 *   5. virtual contacts displayName（仅 active 状态）
 *
 * 顺序无副作用，只影响心跳重锁随机挑选时的索引。
 */
export function collectHiddenPasswordCandidates(
  ctx: XingyeHiddenPasswordContext,
): XingyeHiddenPasswordCandidate[] {
  const out: XingyeHiddenPasswordCandidate[] = [];
  const seen = new Set<string>();

  const agentName = ctx.profile?.displayName?.trim() || ctx.agent?.name?.trim() || '';
  if (agentName) {
    for (const v of expandNameToCandidates(agentName)) {
      const isInitials = asciiInitials(agentName) === v && v.length >= 2;
      pushCandidate(
        out,
        seen,
        v,
        isInitials ? `${agentName} 的姓名首字母` : `${agentName} 的名字`,
        isInitials ? 'agent_initials' : 'agent_name',
      );
    }
  }

  const yuan = ctx.agent?.yuan?.trim();
  if (yuan) {
    pushCandidate(out, seen, yuan, `所属的 "${yuan}"`, 'agent_yuan');
  }

  const userName = ctx.userName?.trim();
  if (userName) {
    for (const v of expandNameToCandidates(userName)) {
      const isInitials = asciiInitials(userName) === v && v.length >= 2;
      pushCandidate(
        out,
        seen,
        v,
        isInitials ? `${userName} 的姓名首字母` : `${userName} 的名字`,
        isInitials ? 'user_initials' : 'user_name',
      );
    }
  }

  if (Array.isArray(ctx.loreEntries)) {
    for (const entry of ctx.loreEntries) {
      if (!entry || !entry.enabled) continue;
      if (entry.category !== 'character') continue;
      const title = entry.title?.trim();
      if (!title) continue;
      pushCandidate(out, seen, title, `NPC「${title}」的名字`, 'npc_name');
      const initials = asciiInitials(title);
      if (initials.length >= 2) {
        pushCandidate(out, seen, initials, `NPC「${title}」的姓名首字母`, 'npc_name');
      }
    }
  }

  if (Array.isArray(ctx.virtualContacts)) {
    for (const contact of ctx.virtualContacts) {
      if (!contact || contact.status === 'deleted' || contact.status === 'blocked') continue;
      const name = contact.displayName?.trim();
      if (!name) continue;
      pushCandidate(out, seen, name, `联系人「${name}」的名字`, 'contact_name');
      const initials = asciiInitials(name);
      if (initials.length >= 2) {
        pushCandidate(out, seen, initials, `联系人「${name}」的姓名首字母`, 'contact_name');
      }
    }
  }

  return out;
}

/**
 * 在候选池里找一条匹配 `attempt` 的（大小写不敏感）。
 * 找不到返回 null——上层用来决定要不要走「输错密码」反应分支。
 */
export function findCandidateMatch(
  candidates: XingyeHiddenPasswordCandidate[],
  attempt: string,
): XingyeHiddenPasswordCandidate | null {
  const target = attempt.trim().toLowerCase();
  if (!target) return null;
  return candidates.find((c) => c.value.toLowerCase() === target) ?? null;
}

/**
 * 从候选池里随机挑一条（用 `randomSource` 注入便于测试）。
 * 池为空 → 返回 null，调用方需 fallback（一般是不重锁）。
 *
 * 用 `excludeValue` 排除上次的密码——避免每次心跳"重锁"成同一条。
 */
export function pickRandomCandidate(
  candidates: XingyeHiddenPasswordCandidate[],
  options: { excludeValue?: string; randomSource?: () => number } = {},
): XingyeHiddenPasswordCandidate | null {
  if (!candidates.length) return null;
  const exclude = options.excludeValue?.trim().toLowerCase();
  const pool = exclude
    ? candidates.filter((c) => c.value.trim().toLowerCase() !== exclude)
    : candidates;
  const final = pool.length ? pool : candidates;
  const rng = options.randomSource ?? Math.random;
  const idx = Math.floor(rng() * final.length);
  return final[Math.min(idx, final.length - 1)];
}
