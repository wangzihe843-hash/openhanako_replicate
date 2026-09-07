/**
 * xingye-peer-lore.js — 「定向」取出 agent 对某一个 peer 的关系 lore
 *
 * 背景：peer 关系 lore 统一用 keyword 模式（关键词=对方名字+id），主聊天里靠用户消息命中。
 * 但自主流程（inter-agent DM / 心跳开场白）走缓存 prompt、没有 userText，keyword 不会命中。
 * 这里把"当前对话对象"的名字+id 当作 query 文本，复用同一个 keyword 引擎，**只**取出与
 * 那一个 peer 相关的关系 lore，定向喂进自主流程——既不瞎编关系，也不把其他 peer 的关系一起塞。
 *
 * 纯读 + 纯函数封装；任何故障返回 ''，绝不阻塞 DM / 心跳。
 */

import { readXingyeRuntimeLoreEntriesSync } from './xingye-runtime-lore-file.js';
import { buildXingyeRuntimeLoreContext } from './xingye-lore-context.js';

const PEER_RELATIONSHIP_CATEGORIES = new Set(['relationship', 'character']);

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizedIdentity(value) {
  return normalizeString(value).toLocaleLowerCase();
}

export function isXingyePeerRelationshipLoreEntry(entry) {
  return PEER_RELATIONSHIP_CATEGORIES.has(normalizeString(entry?.category));
}

function hasExactPeerKeyword(entry, peerIdentities) {
  return Array.isArray(entry?.keywords)
    && entry.keywords.some((keyword) => peerIdentities.has(normalizedIdentity(keyword)));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Early Lore Studio relationship entries stored only the peer's then-current
 * display name as a keyword, but their generated linkage sentence also stored
 * `id：<peerId>`. Recognize that structured linkage exactly so a later rename
 * does not orphan the relationship. The trailing boundary prevents `agent-1`
 * from selecting an entry linked to `agent-10`.
 */
function hasExactLegacyPeerLinkage(entry, peerId) {
  const content = normalizeString(entry?.content);
  const id = normalizeString(peerId);
  if (!content || !id) return false;
  const pattern = new RegExp(
    `(?:agent\\s+)?id\\s*[:：]\\s*${escapeRegExp(id)}(?=$|[\\s,，。;；:：)）\\]】>])`,
    'iu',
  );
  return pattern.test(content);
}

function peerRelationshipEntries(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter(isXingyePeerRelationshipLoreEntry)
    // 早期 Lore Studio 把 peer 关系误存成 always。它们已经在稳定 lore 中可见，但仍应
    // 被识别为“已建立关系”并能参与定向 DM / 群聊上下文；这里仅为选择器建立临时视图，
    // 不改磁盘数据。manual 条目继续尊重手动注入语义。
    .filter((entry) => entry?.insertionMode === 'keyword' || entry?.insertionMode === 'always')
    .map((entry) => entry?.insertionMode === 'always'
      ? { ...entry, insertionMode: 'keyword' }
      : entry);
}

/**
 * @param {object} opts
 * @param {string} opts.agentId   - 拥有这条关系 lore 的 agent（视角方）
 * @param {string} opts.agentDir  - 该 agent 的数据目录（runtime lore 从这里解析）
 * @param {string} [opts.hanakoHome] - 可选，官方 store 主路径；不传也能从 agentDir 解析
 * @param {string} [opts.peerName] - 对话对象的显示名（当 query 关键词）
 * @param {string} [opts.peerId]   - 对话对象的 id（当 query 关键词）
 * @param {Array<object>} [opts.entries] - 可选，调用方已经读取的 lore；用于一轮内复用
 * @param {number} [opts.maxChars]
 * @returns {string} 命中的关系 lore 文本块；无命中 / 故障 → ''
 */
export function buildXingyePeerRelationshipLore({
  agentId,
  agentDir,
  hanakoHome,
  peerName,
  peerId,
  entries: suppliedEntries,
  maxChars = 1200,
} = {}) {
  try {
    if (!agentId || (!agentDir && !Array.isArray(suppliedEntries))) return '';
    const identities = [peerName, peerId].map(normalizedIdentity).filter(Boolean);
    const query = identities.join('\n');
    if (!query) return '';
    const peerIdentities = new Set(identities);
    const sourceEntries = Array.isArray(suppliedEntries)
      ? suppliedEntries
      : readXingyeRuntimeLoreEntriesSync({ hanakoHome, agentId, agentDir });
    // Peer identity is structured data, not topical prose. Match the stored alias/name/id
    // exactly so Bob/Bobby and 明/小明 cannot select one another's relationship.
    const entries = peerRelationshipEntries(sourceEntries)
      .filter((entry) =>
        hasExactPeerKeyword(entry, peerIdentities)
        || hasExactLegacyPeerLinkage(entry, peerId),
      )
      // Runtime lore still requires a keyword match. Supply the exact linked id
      // to this in-memory compatibility view; never mutate the stored lore.
      .map((entry) => hasExactPeerKeyword(entry, peerIdentities)
        ? entry
        : { ...entry, keywords: [...(Array.isArray(entry.keywords) ? entry.keywords : []), peerId] });
    if (!Array.isArray(entries) || entries.length === 0) return '';
    const ctx = buildXingyeRuntimeLoreContext({ entries, agentId, userText: query, maxChars });
    return (ctx?.text || '').trim();
  } catch {
    return '';
  }
}
