/**
 * Server / Node 端读 Xingye agent profile.json 的「关系字段」并渲染成主聊天 system
 * prompt 段：「# 你对 user 的关系与态度」。
 *
 * 与 desktop/src/react/xingye/RelationshipStatePanel.tsx + xingye-state-store.ts 是
 * 同一条链路的终点：
 *
 *   秘密空间「TA 的状态」(state-store, localStorage)
 *     │ 用户接受 AI 建议 / 心跳巡检 confirm draft
 *     ▼
 *   updateRelationshipState 内部根据 affection 重算 relationshipLabel
 *     │ syncRelationshipLabelToProfile fire-and-forget
 *     ▼
 *   profile.json 的 relationshipLabel 被更新
 *     │ readXingyeRelationshipPreambleSync 同步读取
 *     ▼
 *   主对话 system prompt 注入「# 你对 user 的关系与态度」段（本文件）
 *
 * 设计要点：
 *  - 渲染在 gender preamble 之后、stable lore（lore-memory.md）之前。原因与 gender
 *    一致：lore 里常包含其他人物的关系、称谓、对话，LLM 没先吃到「你对 user 的关系」
 *    会被 lore 中的关系叙述带偏（比如把 lore 里写的"前任"误当成当前关系）。
 *  - 只读 profile.relationshipLabel / relationshipMode 两个字段；mood / affection 等
 *    数值仍在 localStorage 里、server 读不到，等以后落盘再说。当前 label 已经能表达
 *    关系阶段（朋友 / 知己 / 恋人 / 仇敌 / ...），用来调态度足够。
 *  - 任何故障静默返回 null，绝不阻塞主聊天。
 *
 * 与 desktop 端 RelationshipStatePanel 没有直接 import 关系；这是兄弟实现，
 * 通过 profile.json 这个文件系统接口解耦。
 */

import { readXingyeProfileJsonSync } from './xingye-profile-file.js';

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function trimOrFallback(value, fallback) {
  const trimmed = normalizeString(value);
  return trimmed || fallback;
}

/**
 * 纯函数：把已读好的 profile 渲染成 { title, body }。
 * relationshipLabel 与 relationshipMode 都为空 → 返回 null（让上层静默跳过整段）。
 *
 * locale 以 'zh' 开头 → 中文版；否则英文版。
 */
export function buildXingyeAgentRelationshipPreamble({ profile, agentName, userName, locale } = {}) {
  if (!profile || typeof profile !== 'object') return null;
  const relationshipLabel = normalizeString(profile.relationshipLabel);
  const relationshipMode = normalizeString(profile.relationshipMode);
  if (!relationshipLabel && !relationshipMode) return null;

  const isZh = String(locale || '').startsWith('zh');
  const agent = trimOrFallback(agentName, isZh ? '当前角色' : 'the assistant');
  const user = trimOrFallback(userName, isZh ? '用户' : 'the user');

  if (isZh) {
    const lines = [
      `- 你是 ${agent}。${user} 不是陌生人 —— 你与 ${user} 的当前关系如下，请用这层关系决定你的语气、距离、称呼与态度。`,
    ];
    if (relationshipLabel) {
      lines.push(`- 你与 ${user} 的当前关系：**${relationshipLabel}**。`);
    }
    if (relationshipMode) {
      lines.push(`- 关系细节 / 相处模式：${relationshipMode}`);
    }
    lines.push(
      '- 该关系是「当前」的，而不是历史的；下方的设定库 / 记忆里如果出现与此冲突的旧关系（前任、断交、生疏期等），以本段为准。',
      '- 关系阶段会随聊天与 user 的互动自然演变；不要在每条回复里反复声明这层关系，但你的态度应当让 user 能直接感受到这层关系（亲近 / 疏远 / 信任 / 戒备 / ...）。',
      `- 如果当前关系已经很亲近（如「恋人」「朝夕相许」「知己」），不必再用客套话；如果当前关系冷淡或对立（如「水火不容」「心有芥蒂」），不要假装亲热。`,
    );
    return {
      title: '# 你对 user 的关系与态度',
      body: lines.join('\n'),
    };
  }

  const lines = [
    `- You are ${agent}. ${user} is not a stranger — your current relationship with ${user} is described below. Let this relationship shape your tone, distance, address forms, and attitude.`,
  ];
  if (relationshipLabel) {
    lines.push(`- Your current relationship with ${user}: **${relationshipLabel}**.`);
  }
  if (relationshipMode) {
    lines.push(`- Relationship details / how you relate: ${relationshipMode}`);
  }
  lines.push(
    '- This is the CURRENT relationship, not a historical one. If lore or memory below describes a conflicting prior state (an ex, an estrangement, a falling-out), this section overrides it.',
    '- The relationship evolves naturally through interaction; do not re-declare it in every reply, but your tone should make the relationship felt (closeness / distance / trust / wariness / ...).',
    `- If the relationship is already intimate (e.g. lover, bond, close friend), drop the small talk. If it is cold or hostile (e.g. enemy, estranged), do not feign warmth.`,
  );
  return {
    title: '# Your Relationship with User',
    body: lines.join('\n'),
  };
}

/**
 * 主聊天 system prompt 入口。读 profile.json → buildXingyeAgentRelationshipPreamble。
 * 任何故障静默返回 null（不阻塞主聊天）。
 */
export function readXingyeAgentRelationshipPreambleSync({ hanakoHome, agentId, agentName, userName, locale } = {}) {
  let profile = null;
  try {
    profile = readXingyeProfileJsonSync({ hanakoHome, agentId });
  } catch {
    return null;
  }
  if (!profile) return null;
  return buildXingyeAgentRelationshipPreamble({ profile, agentName, userName, locale });
}
