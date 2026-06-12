import { listLoreEntries, type XingyeLoreCategory, type XingyeLoreEntry } from './xingye-lore-store';
import { getXingyePersistenceStorage } from './xingye-persistence';
import {
  getConfirmedVirtualContacts,
  getContactProfile,
  normalizeContactNameForDedupe,
  resolveContactDisplayName,
  type XingyeContactTargetType,
} from './xingye-phone-store';

/** 与 xingye-phone-store 内部的 StorageLike 同形（那边没导出）；仅测试注入用。 */
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * 「通讯录候选池 + 关系设定库身份对齐」共享 hint。
 *
 * 邮件初始化、文件管理「人际关系」资料草稿等模块都需要：
 *   1. 从通讯录拉一批联系人当「亲友 / 同事」候选池（带昵称 + 印象，口吻才自然）；
 *   2. 把联系人和设定库（lore）里描述的同一个人对齐，避免模型把「通讯录里的人」与
 *      「设定库里的人」当成两个人、生成两份雷同内容。
 *
 * 这两件事在 mail / moments 里各写过一份（且 mail 那份还缺 impression / remark 对齐）；
 * 这里收口成单一来源，让邮件与文件管理走同一套读取 + 渲染 + 去重文案。
 *
 * 联系人详情页（xingye-contact-profile-ai）上线后，这里同时承担「详情页 → 其他 app」
 * 的反哺通道：已初始化详情的联系人会带上 profileDetail（签名 / IP属地 / 近期联系记录），
 * 让邮件 / 短信 / 文件 / 朋友圈在生成时吃到更丰满的人设。详情未初始化 → 字段缺省，
 * 各消费方表现与从前一致。
 */
export type XingyeContactProfileDetailHint = {
  /** 这个人自己写的个性签名（详情页字段，非主人视角）。 */
  signature?: string;
  /** IP属地 / 所在之地。 */
  ipAddress?: string;
  /** 最近联系记录摘要「channel｜whenLabel｜summary」，新→旧，最多几条。 */
  recentLog?: string[];
};

export type XingyeContactLoreHint = {
  id: string;
  /** 展示名：走 resolveContactDisplayName（备注名 remark 优先 → 通讯录原名），与通讯录 UI 同源。 */
  displayName: string;
  kind?: string;
  shortBio?: string;
  relationshipHint?: string;
  /** TA（手机主人）对这位联系人的印象——主人视角，不是联系人视角。 */
  impression?: string;
  /**
   * 与该联系人指向同一个人的设定库条目标题（本地确定性匹配得到）。
   * 非空 = 通讯录里的这个人也出现在设定库里 → prompt 据此告诉模型「这是同一个人，别另写一份」。
   */
  loreAliases?: string[];
  /** 联系人详情页（若已初始化）的摘要；缺省 = 详情还没生成，消费方按从前的瘦 hint 处理。 */
  profileDetail?: XingyeContactProfileDetailHint;
};

/**
 * 视作「在描述某个具体的人」的 lore 分类——只在这些分类里找与联系人同名的条目，
 * 避免拿联系人名字去误配地点 / 组织 / 规则类设定。
 * - relationship：关系类（本仓库里混装 user + peer 的关系动力学）。
 * - character：人物类（具名 NPC 的小传通常落在这里）。
 */
const IDENTITY_MATCH_LORE_CATEGORIES: ReadonlySet<XingyeLoreCategory> = new Set<XingyeLoreCategory>([
  'relationship',
  'character',
]);

/** 单字名太容易误配（「晴」命中一切含「晴」的标题），匹配 token 至少 2 字。 */
const MIN_MATCH_TOKEN_LENGTH = 2;
const DEFAULT_CONTACT_HINT_LIMIT = 12;
const MAX_LORE_ALIASES_PER_CONTACT = 3;
/** 详情页反哺给其他 app 的「近期往来」条数上限——背景提示而非数据搬运，喂多了挤预算。 */
const MAX_PROFILE_RECENT_LOG = 3;
const MAX_PROFILE_LOG_SUMMARY_CHARS = 50;
const MAX_PROFILE_SIGNATURE_CHARS = 60;

/**
 * 读取某个联系人的详情页摘要（签名 / IP属地 / 近期联系记录）。
 * 仅当详情已经初始化（initializedAt 非空）才返回；骨架 profile（只有印象历史）视为无详情。
 * 任何读取失败 → null，绝不抛错。
 */
export function buildContactProfileDetailHint(
  ownerAgentId: string,
  targetType: XingyeContactTargetType,
  targetId: string,
  storage?: StorageLike | null,
): XingyeContactProfileDetailHint | null {
  try {
    const profile = storage === undefined
      ? getContactProfile(ownerAgentId, targetType, targetId)
      : getContactProfile(ownerAgentId, targetType, targetId, storage);
    if (!profile?.initializedAt) return null;
    const hint: XingyeContactProfileDetailHint = {};
    const signature = profile.signature?.trim();
    if (signature) hint.signature = Array.from(signature).slice(0, MAX_PROFILE_SIGNATURE_CHARS).join('');
    const ipAddress = profile.ipAddress?.trim();
    if (ipAddress) hint.ipAddress = ipAddress;
    const recentLog = profile.contactLog
      .slice(0, MAX_PROFILE_RECENT_LOG)
      .map((e) => {
        const summary = Array.from(e.summary.trim()).slice(0, MAX_PROFILE_LOG_SUMMARY_CHARS).join('');
        return `${e.channel}｜${e.whenLabel || '近来'}｜${summary}`;
      })
      .filter((line) => Boolean(line.trim()));
    if (recentLog.length) hint.recentLog = recentLog;
    if (!hint.signature && !hint.ipAddress && !hint.recentLog) return null;
    return hint;
  } catch {
    return null;
  }
}

/**
 * 详情摘要 → 联系人列表里的附加行（邮件 / 文件 / 朋友圈共用）。
 * 「勿照搬」提示直接焊在行内：联系记录是已发生的往来，是人设背景，不是供复读的内容模板。
 */
function formatProfileDetailLine(detail: XingyeContactProfileDetailHint): string | null {
  const parts: string[] = [];
  if (detail.signature) parts.push(`个性签名「${detail.signature}」`);
  if (detail.ipAddress) parts.push(`IP属地：${detail.ipAddress}`);
  if (detail.recentLog?.length) {
    parts.push(`近期往来（新→旧，背景参考，勿原样照搬成新内容）：${detail.recentLog.join('／')}`);
  }
  if (!parts.length) return null;
  return `  ↳ 详情页：${parts.join('；')}`;
}

function dedupeNonEmpty(values: Iterable<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const t = v.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/**
 * 纯函数：给定一个联系人的若干「名字 token」（展示名 / 通讯录原名 / 备注名），
 * 在候选 lore 条目里找出指向同一个人的条目，返回其标题列表（去重，最多 maxAliases 条）。
 *
 * 匹配规则（先用通讯录去重同源的 normalizeContactNameForDedupe 归一化再比对）：
 * - token 与某条 lore 的 title 完全相等；或
 * - token 完整出现在 title 里（title 含整段联系人名，如 联系人「母亲」↔《我与母亲的旧事》）；或
 * - token 与某个 keyword 完全相等。
 * token 长度 < 2 跳过。
 *
 * 设计取向偏 recall：用户的诉求是「别生成两份雷同内容」，宁可多提示一次「这是同一个人」，
 * 也不要漏配导致重复。代价是偶发误配（如「李明」↔《李明华》），但后果轻微——只是让模型
 * 把两个人当一个人处理一次，且仅作用于这一次生成。
 */
export function matchContactNamesToLore(
  contactNames: ReadonlyArray<string | null | undefined>,
  loreEntries: ReadonlyArray<Pick<XingyeLoreEntry, 'title' | 'keywords'>>,
  maxAliases = MAX_LORE_ALIASES_PER_CONTACT,
): string[] {
  const tokens = dedupeNonEmpty(
    contactNames
      .map((n) => normalizeContactNameForDedupe(n ?? ''))
      .filter((t) => t.length >= MIN_MATCH_TOKEN_LENGTH),
  );
  if (!tokens.length) return [];

  const matched: string[] = [];
  for (const entry of loreEntries) {
    const title = (entry?.title ?? '').trim();
    if (!title) continue;
    const normTitle = normalizeContactNameForDedupe(title);
    const normKeywords = (entry?.keywords ?? [])
      .map((k) => normalizeContactNameForDedupe(k))
      .filter(Boolean);
    const hit = tokens.some(
      (t) => normTitle === t || (!!normTitle && normTitle.includes(t)) || normKeywords.includes(t),
    );
    if (hit) matched.push(title);
  }
  return dedupeNonEmpty(matched).slice(0, maxAliases);
}

/**
 * 读取当前 agent 的通讯录，构造候选池 hint（带昵称 + 印象 + 与设定库的身份对齐）。
 *
 * - displayName 走 resolveContactDisplayName（remark 优先），与通讯录 UI 同源；
 * - impression 取联系人对象上的「主人对 TA 的印象」；
 * - loreAliases 由本地匹配 relationship / character 类 lore 得到（options.matchLore=false 可关）。
 *
 * 任意读取失败都优雅降级（联系人空数组 / 不附 loreAliases），不抛错。
 */
export function buildContactLoreHints(
  agentId: string,
  options?: { limit?: number; matchLore?: boolean },
): XingyeContactLoreHint[] {
  const id = (agentId ?? '').trim();
  if (!id) return [];
  const limit = options?.limit ?? DEFAULT_CONTACT_HINT_LIMIT;

  let contacts: ReturnType<typeof getConfirmedVirtualContacts>;
  try {
    // 只取已确认条目：还在「新的朋友」待用户通过的候选不应渗进其他 app 的生成上下文。
    contacts = getConfirmedVirtualContacts(id).slice(0, limit);
  } catch {
    return [];
  }
  if (!contacts.length) return [];

  let loreEntries: XingyeLoreEntry[] = [];
  if (options?.matchLore !== false) {
    try {
      const storage = getXingyePersistenceStorage();
      loreEntries = listLoreEntries(id, storage).filter(
        (e) => e.enabled && IDENTITY_MATCH_LORE_CATEGORIES.has(e.category),
      );
    } catch {
      loreEntries = [];
    }
  }

  return contacts.map((c) => {
    let displayName: string;
    try {
      displayName = resolveContactDisplayName(id, 'virtual_contact', c.id, [], {});
    } catch {
      displayName = c.displayName;
    }
    const hint: XingyeContactLoreHint = {
      id: c.id,
      displayName: displayName || c.displayName,
      kind: c.kind,
      shortBio: c.shortBio,
      relationshipHint: c.relationshipHint,
      impression: c.impression,
    };
    if (loreEntries.length) {
      const aliases = matchContactNamesToLore([displayName, c.displayName, c.remark], loreEntries);
      if (aliases.length) hint.loreAliases = aliases;
    }
    const profileDetail = buildContactProfileDetailHint(id, 'virtual_contact', c.id);
    if (profileDetail) hint.profileDetail = profileDetail;
    return hint;
  });
}

/**
 * prompt 顶部说明：解释「同一个人」标注的含义并要求据此去重。
 * 仅在确有对齐标注时（contactsHaveLoreAlias）插入，避免无意义的噪声指令。
 */
export const CONTACT_LORE_DEDUPE_INSTRUCTION =
  '【同一人对齐】下方联系人若标有「↳ 同一个人：…设定库《…》」，表示通讯录里的这个人，与设定库（lore）里描述的是同一个人——请当作一个人处理，不要把 TA 拆成两条、生成内容雷同的两份。';

/** 是否存在「通讯录 ↔ 设定库」对齐标注（决定是否插入上面那行说明）。 */
export function contactsHaveLoreAlias(hints: ReadonlyArray<XingyeContactLoreHint>): boolean {
  return hints.some((h) => Array.isArray(h.loreAliases) && h.loreAliases.length > 0);
}

/**
 * 把候选联系人渲染成「完整段落」：有对齐标注时先放去重指令、再放列表；空列表返回「（无）」。
 * 供批量/初始化两阶段 prompt 直接当一个块嵌入（builder 只收字符串，保持可单测的纯函数形态）。
 */
export function formatContactLoreSection(hints: ReadonlyArray<XingyeContactLoreHint>): string {
  if (!hints.length) return '（无）';
  const listing = formatContactLoreListingBlock(hints);
  return contactsHaveLoreAlias(hints) ? `${CONTACT_LORE_DEDUPE_INSTRUCTION}\n${listing}` : listing;
}

/**
 * 把候选联系人渲染成 prompt 列表块（邮件 / 文件管理共用，保证两处文案一致）。
 * 空列表返回「（无）」。带 loreAliases 的联系人追加一行「↳ 同一个人：…」对齐提示。
 */
export function formatContactLoreListingBlock(
  hints: ReadonlyArray<XingyeContactLoreHint>,
  limit = DEFAULT_CONTACT_HINT_LIMIT,
): string {
  if (!hints.length) return '（无）';
  return hints
    .slice(0, limit)
    .map((c) => {
      const parts = [c.displayName];
      if (c.kind) parts.push(`关系：${c.kind}`);
      if (c.relationshipHint) parts.push(`备注：${c.relationshipHint}`);
      if (c.impression) parts.push(`印象：${c.impression}`);
      if (c.shortBio) parts.push(`简介：${c.shortBio}`);
      let line = `- ${parts.join('，')}`;
      if (c.loreAliases && c.loreAliases.length) {
        line += `\n  ↳ 同一个人：此联系人即设定库里的 ${c.loreAliases
          .map((t) => `《${t}》`)
          .join('、')}，写到 TA 时按同一人处理，别另起炉灶。`;
      }
      if (c.profileDetail) {
        const detailLine = formatProfileDetailLine(c.profileDetail);
        if (detailLine) line += `\n${detailLine}`;
      }
      return line;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// SMS 专用：按「已在生成名单里的联系人」逐条取详情 + 设定对齐
// ---------------------------------------------------------------------------
// 短信 prompt 的联系人走 contactShape JSON（含 agent 联系人），不经过上面的
// buildContactLoreHints（那条只取 virtual_contact 候选池）。这里提供配套通道：
// 对一批给定联系人（通常已剔除 user）逐条补「详情页摘要 + 与设定库的同一人对齐」，
// 让短信生成既吃到详情人设，又不把通讯录联系人与关系 lore 里的 NPC 当成两个角色。

export type XingyeContactDetailPromptHint = {
  targetType: XingyeContactTargetType;
  targetId: string;
  displayName: string;
  profileDetail?: XingyeContactProfileDetailHint;
  loreAliases?: string[];
};

/**
 * 给一批联系人构建详情/对齐 hint。
 * - targetType=user 一律跳过：user 的详情不进任何生成上下文（user↔TA 的短信/邮件本就不允许生成）；
 * - 既无详情也无 lore 对齐的联系人不出现在结果里（喂了也是空行）；
 * - lore 只载入一次（relationship/character 两类，与候选池同源）；任何读取失败优雅降级。
 */
export function buildContactDetailPromptHints(
  ownerAgentId: string,
  contacts: ReadonlyArray<{
    targetType: XingyeContactTargetType;
    targetId: string;
    displayName: string;
    remark?: string;
    originalName?: string;
  }>,
  options?: { storage?: StorageLike | null },
): XingyeContactDetailPromptHint[] {
  const id = (ownerAgentId ?? '').trim();
  if (!id || !contacts.length) return [];

  let loreEntries: XingyeLoreEntry[] = [];
  try {
    const storage = getXingyePersistenceStorage();
    loreEntries = listLoreEntries(id, storage).filter(
      (e) => e.enabled && IDENTITY_MATCH_LORE_CATEGORIES.has(e.category),
    );
  } catch {
    loreEntries = [];
  }

  const out: XingyeContactDetailPromptHint[] = [];
  for (const c of contacts) {
    if (!c?.targetId || c.targetType === 'user') continue;
    const hint: XingyeContactDetailPromptHint = {
      targetType: c.targetType,
      targetId: c.targetId,
      displayName: c.displayName,
    };
    const profileDetail = buildContactProfileDetailHint(id, c.targetType, c.targetId, options?.storage);
    if (profileDetail) hint.profileDetail = profileDetail;
    if (loreEntries.length) {
      try {
        const aliases = matchContactNamesToLore([c.remark, c.displayName, c.originalName], loreEntries);
        if (aliases.length) hint.loreAliases = aliases;
      } catch {
        /* 对齐失败按无对齐处理 */
      }
    }
    if (!hint.profileDetail && !hint.loreAliases?.length) continue;
    out.push(hint);
  }
  return out;
}

/**
 * 渲染 SMS prompt 的「联系人详情页补充」块。每个联系人带 targetType:targetId 标头，
 * 与 prompt 里联系人 JSON 的键对应；空列表返回「（无）」（调用方据此整段跳过）。
 */
export function formatContactDetailPromptBlock(
  hints: ReadonlyArray<XingyeContactDetailPromptHint>,
): string {
  if (!hints.length) return '（无）';
  return hints
    .map((h) => {
      const lines = [`- ${h.displayName}［${h.targetType}:${h.targetId}］`];
      if (h.profileDetail) {
        const detailLine = formatProfileDetailLine(h.profileDetail);
        if (detailLine) lines.push(detailLine);
      }
      if (h.loreAliases?.length) {
        lines.push(
          `  ↳ 同一个人：此联系人即设定库里的 ${h.loreAliases
            .map((t) => `《${t}》`)
            .join('、')}——写 TA 时按同一个人处理，人设与事实不得与设定打架，不要拆成两个角色。`,
        );
      }
      return lines.join('\n');
    })
    .join('\n');
}
