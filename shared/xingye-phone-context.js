/**
 * Agent Phone 每轮动态上下文。
 *
 * Phone session 会复用 30 分钟 prompt snapshot，所以不能只靠 system prompt / systemAppend
 * 承载会变化的 profile、keyword lore 和“我对当前发言者的关系”。本模块每次投递都现读：
 * - 当前 agent 自己的完整叙事型 profile 字段；
 * - 当前 agent 自己最新的全部 canonical always lore；
 * - 私聊对象 / 本批群聊真实发言者的定向关系 lore；
 * - 被本轮聊天正文命中的其它 keyword lore。
 */

import { readXingyeAgentPhoneProfileContextSync } from './xingye-profile-file.js';
import { readXingyeRuntimeLoreEntriesSync } from './xingye-runtime-lore-file.js';
import {
  buildXingyeRuntimeLoreContext,
  buildXingyeStableLoreMemoryContext,
} from './xingye-lore-context.js';
import {
  buildXingyePeerRelationshipLore,
  isXingyePeerRelationshipLoreEntry,
} from './xingye-peer-lore.js';

const MAX_PEER_RELATIONSHIP_CHARS = 4_800;
const MAX_LATEST_ALWAYS_LORE_CHARS = 2_400;
const MAX_TOPICAL_LORE_CHARS = 2_400;
const MAX_PHONE_TURN_CONTEXT_CHARS = 14_400;

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizePeerRefs(peerRefs, selfId) {
  const seen = new Set();
  const out = [];
  for (const peer of Array.isArray(peerRefs) ? peerRefs : []) {
    const id = normalizeString(peer?.id);
    if (!id || id === selfId || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: normalizeString(peer?.name) || id });
  }
  return out;
}

/**
 * @returns {string} 可放进 Phone ephemeral system context 的内部上下文；无内容返回空串。
 */
export function buildXingyeAgentPhoneTurnContext({
  agentId,
  agentDir,
  hanakoHome,
  agentName,
  locale,
  messageText,
  peerRefs,
} = {}) {
  const aid = normalizeString(agentId);
  const dir = normalizeString(agentDir);
  if (!aid || !dir) return '';
  const isZh = String(locale || '').startsWith('zh');
  const parts = [];
  const peers = normalizePeerRefs(peerRefs, aid);

  if (peers.length > 0) {
    const selfLabel = normalizeString(agentName) || aid;
    const peerLabels = peers.map((peer) => peer.name !== peer.id ? `${peer.name}（${peer.id}）` : peer.id);
    parts.push(isZh
      ? [
        '# 实体与关系边界',
        `- 你自己是 ${selfLabel}（agent id：${aid}）。`,
        '- “用户”是使用产品的人，不是下面任何一个 agent 发言者。profile 中“与用户的关系/相处模式”只描述你与用户。',
        `- 本轮 agent 发言者是：${peerLabels.join('、')}。TA 们是其他独立 AI agent，不是用户，也不是你自己。`,
        '- 下方“你与本轮发言者的既定关系”只描述你与对应 agent；不得把亲友、情敌、同事等关系转移到用户身上。',
      ].join('\n')
      : [
        '# Entity and Relationship Boundaries',
        `- You are ${selfLabel} (agent id: ${aid}).`,
        '- “The user” means the person using the product, not any agent speaker below. Profile fields labeled “Relationship with the user” apply only to the user.',
        `- The agent speaker(s) in this turn are: ${peerLabels.join(', ')}. They are other independent AI agents, not the user and not you.`,
        '- “Your Established Relationship with Speaker” applies only to that agent; never transfer friend, rival, family, or romantic roles to the user.',
      ].join('\n'));
  }

  let loreEntries = [];
  try {
    loreEntries = readXingyeRuntimeLoreEntriesSync({ hanakoHome, agentId: aid, agentDir: dir });
  } catch {
    loreEntries = [];
  }

  const profile = readXingyeAgentPhoneProfileContextSync({
    hanakoHome,
    agentId: aid,
    agentName,
    locale,
  });
  if (profile) parts.push(profile);

  // Phone's frozen base excludes Xingye sections. This is the sole source of
  // always lore, so removals and disabling take effect on the next turn too.
  const includedAlwaysIds = new Set();
  try {
    const latestAlways = buildXingyeStableLoreMemoryContext({
      entries: loreEntries,
      agentId: aid,
      maxChars: MAX_LATEST_ALWAYS_LORE_CHARS,
    });
    const latestAlwaysLore = latestAlways.text.trim();
    if (latestAlwaysLore) {
      for (const entry of latestAlways.entries) includedAlwaysIds.add(entry.id);
      parts.push([
        isZh
          ? '## 当前 always Lore'
          : '## Current Always Lore',
        latestAlwaysLore,
      ].join('\n'));
    }
  } catch {
    // Optional role context must never block phone delivery.
  }

  const relationships = [];
  let relationshipChars = 0;
  for (const peer of peers) {
    const remaining = MAX_PEER_RELATIONSHIP_CHARS - relationshipChars;
    if (remaining < 240) break;
    const lore = buildXingyePeerRelationshipLore({
      agentId: aid,
      agentDir: dir,
      hanakoHome,
      peerName: peer.name,
      peerId: peer.id,
      // Legacy peer relations may be `always`; do not render the same entry
      // again when it has already been included in the always section above.
      entries: loreEntries.filter((entry) => !includedAlwaysIds.has(entry.id)),
      maxChars: Math.min(1_200, remaining),
    });
    if (!lore) continue;
    const label = peer.name !== peer.id ? `${peer.name}（${peer.id}）` : peer.id;
    const block = `${isZh ? `## 你与本轮发言者 ${label} 的既定关系` : `## Your Established Relationship with Speaker ${label}`}\n${lore}`;
    relationships.push(block);
    relationshipChars += block.length;
  }
  if (relationships.length > 0) {
    parts.push([
      isZh
        ? '以下关系按真实 sender 身份定向命中。用它决定语气、距离与分寸，不要把它当成用户关系，也不要编造未写明的细节。'
        : 'These relationships were selected from the real sender identities. Let them shape tone, distance, and boundaries; do not confuse them with the user relationship or invent unstated details.',
      ...relationships,
    ].join('\n\n'));
  }

  const queryText = normalizeString(messageText);
  if (queryText) {
    try {
      // relationship / character 型 peer 关系由真实 sender 定向选择；正文只负责触发其余
      // topical keyword lore，避免仅提到未发言第三人就加载其 agent 关系。
      const topicalEntries = Array.isArray(loreEntries)
        ? loreEntries.filter((entry) => !isXingyePeerRelationshipLoreEntry(entry))
        : [];
      const topical = buildXingyeRuntimeLoreContext({
        entries: topicalEntries,
        agentId: aid,
        userText: queryText,
        maxChars: MAX_TOPICAL_LORE_CHARS,
      }).text.trim();
      if (topical) {
        parts.push(`${isZh ? '## 本轮聊天正文命中的其它设定' : '## Other Lore Matched by This Phone Turn'}\n${topical}`);
      }
    } catch {
      // Phone delivery must keep working when optional Xingye files are missing/corrupt.
    }
  }

  if (parts.length === 0) return '';
  const context = [
    isZh ? '# 本轮动态角色上下文（内部）' : '# Dynamic Role Context for This Turn (Internal)',
    ...parts,
  ].join('\n\n');
  return context.length <= MAX_PHONE_TURN_CONTEXT_CHARS
    ? context
    : `${context.slice(0, MAX_PHONE_TURN_CONTEXT_CHARS - 1).trimEnd()}…`;
}
