/**
 * Phase 2：把一个 peer 候选升级为独立 agent，并把「当前角色的世界观 + 旧↔新角色关系」带过去。
 *
 * 关系与世界观都用**模版/复制**，不让模型凭空编：
 * - 世界观：直接复制当前角色的 worldview lore 到新 agent（换新 id、改归属），可选按新角色背景微调。
 * - 旧↔新关系：双向写一条 relationship lore，正文用 buildXingyePeerAgentLoreTemplateContent 模版填名字。
 * - 新角色↔用户的关系**数值**：走 ensureRelationshipState 模版播种（标签→好感→信任/忠诚、醋意 0、
 *   黑化按 tendency），绝不让模型给数值。
 */
import { hanaFetch } from '../hooks/use-hana-fetch';
import {
  createLoreEntry,
  listLoreEntries,
  updateLoreEntry,
  type XingyeLoreEntry,
} from './xingye-lore-store';
import { saveXingyeRoleProfile } from './xingye-profile-store';
import { ensureRelationshipState } from './xingye-state-store';
import { buildXingyePeerAgentLoreTemplateContent } from './xingye-lore-peer-agent-template';
import { emptyStudioSession, saveStudioSession } from './lore-studio-session';
import { peerNameEquals, peerNameMatches } from './lore-studio-peer';
import type { StudioPeerCandidate } from './lore-studio-types';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

/** 源侧条目里出现这个标记 = 已被本流程追加过 peer 链接（占位或已 link），模糊匹配时跳过，免串味。 */
const PEER_LINKAGE_MARKER = '现在是独立角色';

/** 复制一批 worldview 条目到目标 agent（换新 id、改归属，保留注入方式/关键词）。 */
export function copyWorldviewToAgent(
  targetAgentId: string,
  worldviewEntries: Pick<XingyeLoreEntry, 'title' | 'content' | 'insertionMode' | 'keywords' | 'visibility' | 'priority'>[],
  storage?: StorageLike | null,
): XingyeLoreEntry[] {
  const created: XingyeLoreEntry[] = [];
  for (const e of worldviewEntries) {
    if (!e?.title?.trim() || !e?.content?.trim()) continue;
    created.push(
      createLoreEntry(
        targetAgentId,
        {
          title: e.title,
          content: e.content,
          category: 'worldview',
          insertionMode: e.insertionMode ?? 'keyword',
          keywords: e.keywords ?? [],
          visibility: e.visibility ?? 'canonical',
          priority: e.priority,
        },
        storage ?? undefined,
      ),
    );
  }
  return created;
}

export interface PeerLinkNames {
  sourceAgentId: string;
  sourceName: string;
  newAgentId: string;
  newName: string;
  userName: string;
  /** 来自 LLM 的一句关系定性（可选；作为模版起点注释，不是凭空数值）。 */
  note?: string;
}

/** 给「源角色已认识此人」的既有条目追加的链接段：对方现在是独立 agent + 实体区分 + dm。 */
function buildPeerLinkageNote(names: PeerLinkNames): string {
  const user = names.userName?.trim() || '用户';
  return [
    '',
    '---',
    `【「${names.newName}」现在是独立角色】`,
    `「${names.newName}」现在是一个可单独对话的 AI 角色（agent，id：${names.newAgentId}）——和你一样的独立存在，不是「${user}」（用户），也不是你自己。`,
    '你可以用 `dm` 工具按该 id 主动私信 TA；要不要联系、何时联系由你自己判断。',
  ].join('\n');
}

/**
 * 双向写 peer 关系 lore。两侧不对称（刻意）：
 * - 源角色：候选本就来自它 Phase 1 写过的关系/人物 lore——命中就在那条上追加 peer 链接段
 *   （复用已写好的内容、不新增空模板）；没命中（罕见）才写一条有实质内容的，而不是空占位模板。
 * - 新角色：是白纸 → 用 peer 模版脚手架，跳转过去后的「peer 微调」会据新背景把它填满。
 */
export function writePeerRelationshipLore(names: PeerLinkNames, storage?: StorageLike | null): void {
  const noteBlock = names.note?.trim() ? `\n\n【关系起点（可改）】${names.note.trim()}` : '';
  const linkage = buildPeerLinkageNote(names);

  // 源角色侧：找它 Phase 1 关于这个人的关系/人物 lore。优先**精确同名**（避免「寒鸦」误命中
  // 「寒鸦影」这类子串包含）；精确无命中才退回模糊包含，且模糊匹配**跳过本流程刚写/已 link 的
  // 占位条目**（content 含 peer 链接标记）——否则一批里候选 B 会把链接段串写进候选 A 刚建的
  // 「与「A」的关系」占位条目里。
  const sourceEntries = listLoreEntries(names.sourceAgentId, storage ?? undefined).filter(
    (e) => e.category === 'relationship' || e.category === 'character',
  );
  const aliasesOf = (e: XingyeLoreEntry) => [e.title, ...(e.keywords ?? [])];
  const matched =
    sourceEntries.find((e) => aliasesOf(e).some((alias) => peerNameEquals(names.newName, alias))) ??
    sourceEntries.find(
      (e) => !e.content.includes(PEER_LINKAGE_MARKER) && aliasesOf(e).some((alias) => peerNameMatches(names.newName, alias)),
    );

  if (matched) {
    const keywords = Array.from(new Set([...(matched.keywords ?? []), names.newName]));
    // 幂等：已经追加过指向这个新 agent 的链接段（重跑 / 同批多次命中同一条）就不再重复堆叠正文，至多补关键词。
    if (matched.content.includes(`id：${names.newAgentId}`)) {
      updateLoreEntry(matched.id, { keywords }, storage ?? undefined);
    } else {
      updateLoreEntry(matched.id, { content: `${matched.content}${linkage}${noteBlock}`, keywords }, storage ?? undefined);
    }
  } else {
    const content = [
      `【你与「${names.newName}」的关系】`,
      names.note?.trim() || '（待补充：你们怎么认识、目前关系是冷是热、对外口径。）',
      linkage.replace(/^\n/, ''),
    ].join('\n');
    createLoreEntry(
      names.sourceAgentId,
      { title: `与「${names.newName}」的关系`, content, category: 'relationship', insertionMode: 'always', keywords: [names.newName] },
      storage ?? undefined,
    );
  }

  // 新角色侧：白纸，用模版脚手架（peer 微调会填）。
  const onNew = buildXingyePeerAgentLoreTemplateContent({
    userName: names.userName,
    agentName: names.newName,
    peerName: names.sourceName,
    peerId: names.sourceAgentId,
  });
  createLoreEntry(
    names.newAgentId,
    { title: `与「${names.sourceName}」的关系`, content: onNew + noteBlock, category: 'relationship', insertionMode: 'always', keywords: [names.sourceName] },
    storage ?? undefined,
  );
}

export interface CreatePeerAgentInput {
  candidate: StudioPeerCandidate;
  source: { agentId: string; name: string; yuan?: string };
  worldviewEntries: XingyeLoreEntry[];
  userName: string;
}

/**
 * 完整创建一个 peer 角色：建 agent → 写 profile → 复制世界观 → 双向 peer 关系 lore →
 * 播种新角色↔用户关系数值。返回新 agent 的 id/name。
 */
export async function createPeerAgent(input: CreatePeerAgentInput): Promise<{ agentId: string; name: string }> {
  const { candidate, source, worldviewEntries, userName } = input;
  const name = candidate.name.trim();
  if (!name) throw new Error('候选角色缺少名字');

  const identity = `# ${name}\n\n${candidate.roleInWorld ?? ''}`.trim();
  const ishiki = [candidate.whyUpgrade, candidate.suggestedRelationshipToCurrent].filter(Boolean).join('\n\n');

  const res = await hanaFetch('/api/agents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      ...(source.yuan ? { yuan: source.yuan } : {}),
      initialFiles: { identity, ...(ishiki ? { ishiki } : {}) },
    }),
  });
  const data = await res.json();
  if (!res.ok || data?.error || !data?.id) {
    throw new Error(typeof data?.error === 'string' ? data.error : '创建角色失败');
  }
  const newAgentId = String(data.id);
  const newName = typeof data.name === 'string' && data.name.trim() ? data.name : name;

  // profile：从候选派生最小人设
  await saveXingyeRoleProfile(newAgentId, {
    displayName: newName,
    shortBio: candidate.roleInWorld || candidate.whyUpgrade || '',
  });

  // 世界观复制（可选按背景微调由后续在新角色工坊里做）
  copyWorldviewToAgent(newAgentId, worldviewEntries);

  // 双向 peer 关系 lore（模版）
  writePeerRelationshipLore({
    sourceAgentId: source.agentId,
    sourceName: source.name,
    newAgentId,
    newName,
    userName,
    note: candidate.suggestedRelationshipToCurrent,
  });

  // 新角色↔用户关系数值：模版播种（新角色对用户默认陌生，醋意 0，黑化按 tendency 默认 none）
  ensureRelationshipState(newAgentId, { relationshipLabel: '' });

  // 给新角色工坊种一份 peer 上下文：跳转过去后首次整理时，模型会据新背景微调已带来的世界观/关系。
  await saveStudioSession({
    ...emptyStudioSession(newAgentId),
    peerContext: { sourceAgentId: source.agentId, sourceName: source.name },
  });

  return { agentId: newAgentId, name: newName };
}
