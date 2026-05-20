/**
 * Server / Node 端读 Xingye agent profile.json，并把性别字段渲染成主聊天可用的
 * preamble 段。
 *
 * 该文件给 `core/agent.js buildSystemPrompt` 用：在 lore-memory.md 注入之**前**
 * 输出一段「# 角色性别与代词约束」，让 LLM 在读到任何 lore 设定前先吃到性别提示，
 * 避免被 lore 里的人名 / 关系 / 设定文本带歪。
 *
 * 与 desktop 端的 XingyeRoleProfile / formatGenderRulesForPrompt 是兄弟实现 ——
 * desktop 那边管 Xingye 各模块的小 prompt（新闻 / 专访 / 短信 / 占卜 / ...），
 * 这里管 OpenHanako 主聊天的 system prompt。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

const VALID_GENDERS = new Set(['female', 'male', 'nonbinary', 'unspecified']);

function getReadableIdentity({ hanakoHome, agentId } = {}) {
  const home = typeof hanakoHome === 'string' ? hanakoHome.trim() : '';
  const id = typeof agentId === 'string' ? agentId.trim() : '';
  if (!home || !id) return null;
  if (id.includes('/') || id.includes('\\') || id === '.' || id === '..') return null;
  return { home, id };
}

/**
 * 读 agents/{agentId}/xingye/profile.json。
 * 不存在 / JSON 损坏 / 非对象 → 返回 null（调用方静默跳过）。
 * 系统级 I/O 异常（权限等）→ 向上抛。
 */
export function readXingyeProfileJsonSync({ hanakoHome, agentId } = {}) {
  const identity = getReadableIdentity({ hanakoHome, agentId });
  if (!identity) return null;
  const filePath = path.join(identity.home, 'agents', identity.id, 'xingye', 'profile.json');
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function pickValidGender(profile) {
  const g = profile?.gender;
  if (typeof g !== 'string') return null;
  if (!VALID_GENDERS.has(g)) return null;
  if (g === 'unspecified') return null;
  return g;
}

function trimOrFallback(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

/**
 * 纯函数：把已读好的 profile 渲染成 { title, body }。
 * 性别不存在 / unspecified / 非法 → 返回 null。
 *
 * locale 以 'zh' 开头 → 中文版；否则英文版。
 */
export function buildXingyeAgentGenderPreamble({ profile, agentName, userName, locale } = {}) {
  const gender = pickValidGender(profile);
  if (!gender) return null;

  const isZh = String(locale || '').startsWith('zh');
  const agent = trimOrFallback(agentName, isZh ? '当前角色' : 'the assistant');
  const user = trimOrFallback(userName, isZh ? '用户' : 'the user');

  if (isZh) {
    if (gender === 'female') {
      return {
        title: '# 角色性别与代词约束',
        body: [
          `- 你是 ${agent}，性别为**女性**。`,
          `- 当 ${user}（或叙述、NPC 等任何第三方）提及你时，应使用「她」作为代词；称谓可用「姐姐」「女士」「小姐」等。`,
          '- 你自己第一人称仍然是「我」。',
          '- 不要把自己当成男性；不要因为下方设定库 / 记忆 / 用户档案里的人名、对话或设定内容产生性别误判。',
          `- 不要错认 ${user} 的性别 —— 除非 ${user} 自己明说，否则不要预设 ${user} 的性别。`,
        ].join('\n'),
      };
    }
    if (gender === 'male') {
      return {
        title: '# 角色性别与代词约束',
        body: [
          `- 你是 ${agent}，性别为**男性**。`,
          `- 当 ${user}（或叙述、NPC 等任何第三方）提及你时，应使用「他」作为代词；称谓可用「哥哥」「先生」「公子」等。`,
          '- 你自己第一人称仍然是「我」。',
          '- 不要把自己当成女性；不要因为下方设定库 / 记忆 / 用户档案里的人名、对话或设定内容产生性别误判。',
          `- 不要错认 ${user} 的性别 —— 除非 ${user} 自己明说，否则不要预设 ${user} 的性别。`,
        ].join('\n'),
      };
    }
    // nonbinary
    return {
      title: '# 角色性别与代词约束',
      body: [
        `- 你是 ${agent}，性别为**非二元（non-binary）**。`,
        `- 当 ${user}（或叙述、NPC 等任何第三方）提及你时，应使用「TA」作为代词；称谓使用中性的「这位」「朋友」等；避免「他 / 她」二元代词。`,
        '- 你自己第一人称仍然是「我」。',
        '- 不要把自己当成男性或女性。',
        `- 不要错认 ${user} 的性别 —— 除非 ${user} 自己明说，否则不要预设 ${user} 的性别。`,
      ].join('\n'),
    };
  }

  // English
  if (gender === 'female') {
    return {
      title: '# Role Gender and Pronoun Rules',
      body: [
        `- You are ${agent}. Gender: **female**.`,
        `- When ${user} (or any narration / third-party NPC) refers to you, use **"she"** as the pronoun.`,
        '- Your own first-person remains "I".',
        '- Do not let names, dialogue, lore, or memory below mislead you about your gender.',
        `- Do not assume ${user}'s gender unless ${user} states it explicitly.`,
      ].join('\n'),
    };
  }
  if (gender === 'male') {
    return {
      title: '# Role Gender and Pronoun Rules',
      body: [
        `- You are ${agent}. Gender: **male**.`,
        `- When ${user} (or any narration / third-party NPC) refers to you, use **"he"** as the pronoun.`,
        '- Your own first-person remains "I".',
        '- Do not let names, dialogue, lore, or memory below mislead you about your gender.',
        `- Do not assume ${user}'s gender unless ${user} states it explicitly.`,
      ].join('\n'),
    };
  }
  return {
    title: '# Role Gender and Pronoun Rules',
    body: [
      `- You are ${agent}. Gender: **non-binary**.`,
      `- When ${user} (or any narration / third-party NPC) refers to you, use **"they"** as the pronoun.`,
      '- Your own first-person remains "I".',
      `- Avoid binary "he / she" pronouns.`,
      `- Do not assume ${user}'s gender unless ${user} states it explicitly.`,
    ].join('\n'),
  };
}

/**
 * 主聊天 system prompt 入口。读 profile.json → buildXingyeAgentGenderPreamble。
 * 任何故障静默返回 null（不阻塞主聊天）。
 */
export function readXingyeAgentGenderPreambleSync({ hanakoHome, agentId, agentName, userName, locale } = {}) {
  const profile = readXingyeProfileJsonSync({ hanakoHome, agentId });
  if (!profile) return null;
  return buildXingyeAgentGenderPreamble({ profile, agentName, userName, locale });
}
