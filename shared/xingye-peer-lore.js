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

/**
 * @param {object} opts
 * @param {string} opts.agentId   - 拥有这条关系 lore 的 agent（视角方）
 * @param {string} opts.agentDir  - 该 agent 的数据目录（runtime lore 从这里解析）
 * @param {string} [opts.hanakoHome] - 可选，官方 store 主路径；不传也能从 agentDir 解析
 * @param {string} [opts.peerName] - 对话对象的显示名（当 query 关键词）
 * @param {string} [opts.peerId]   - 对话对象的 id（当 query 关键词）
 * @param {number} [opts.maxChars]
 * @returns {string} 命中的关系 lore 文本块；无命中 / 故障 → ''
 */
export function buildXingyePeerRelationshipLore({
  agentId,
  agentDir,
  hanakoHome,
  peerName,
  peerId,
  maxChars = 1200,
} = {}) {
  try {
    if (!agentId || !agentDir) return '';
    const query = [peerName, peerId].map((v) => (typeof v === 'string' ? v.trim() : '')).filter(Boolean).join('\n');
    if (!query) return '';
    const entries = readXingyeRuntimeLoreEntriesSync({ hanakoHome, agentId, agentDir });
    if (!Array.isArray(entries) || entries.length === 0) return '';
    const ctx = buildXingyeRuntimeLoreContext({ entries, agentId, userText: query, maxChars });
    return (ctx?.text || '').trim();
  } catch {
    return '';
  }
}
