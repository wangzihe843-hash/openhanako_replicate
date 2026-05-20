import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import type { SecretSpaceCategoryId } from './SecretSpaceHome';
import { formatXingyeSpeakerContextForPrompt } from './xingye-speaker-context';

/**
 * 允许走 `generateSecretSpaceRecordWithAI` 的秘密空间分类（与 `SecretSpaceCategoryId` 子集对齐）。
 * - 含 `state`：TA 状态分类可追加 JSONL 短笔记；上方仍有 RelationshipStatePanel。
 * - 不含 `memory_fragment`：私藏回忆与记忆候选流程单独维护。
 */
export const SECRET_SPACE_AI_GENERABLE_CATEGORIES = [
  'state',
  'draft_reply',
  'dream',
  'saved_item',
  'unsent_moment',
] as const;

export type SecretSpaceAiGenerableCategory = (typeof SECRET_SPACE_AI_GENERABLE_CATEGORIES)[number];

export function isSecretSpaceAiGenerableCategory(
  id: SecretSpaceCategoryId,
): id is SecretSpaceAiGenerableCategory {
  return SECRET_SPACE_AI_GENERABLE_CATEGORIES.some((c) => c === id);
}

function renderLoreSection(loreContextText: string | null | undefined): string | null {
  if (typeof loreContextText !== 'string') return null;
  const trimmed = loreContextText.trim();
  if (!trimmed) return null;
  return [
    trimmed,
    '【关于上方设定参考】',
    '- 为世界观与叙事约束，不要逐字复述。',
    '- 与角色资料或最近聊天冲突时，以角色资料与最近聊天为准。',
  ].join('\n');
}

const CATEGORY_TASK: Record<SecretSpaceAiGenerableCategory, string> = {
  state:
    '生成一条与「TA 当前状态、情绪或关系快照」相关的短文字笔记：语气符合角色；像随手记下的状态备忘，不要写成系统说明或元描述。',
  draft_reply:
    '生成一条「尚未发送给用户的回复草稿」：第一人称、符合角色语气；像手机里未发出的消息草稿，不要写成创作说明或旁白。',
  dream:
    '生成一段简短的梦境记录：象征化、碎片化即可；不要完整小说，不要解梦说教。',
  saved_item:
    '生成一条「角色收藏的文字记录」：可以是摘录感、备忘录式摘要或一句惦记；若用户提供了「收藏线索/种子」，必须与之呼应。',
  unsent_moment:
    '生成一条「未发送的朋友圈动态草稿」：纯文本、短句为主；像社交软件草稿，不要配图说明或 Markdown。',
};

/**
 * 各分类可选的元信息说明，追加到 JSON schema 描述里。模型可选填，不写就省略。
 * 注意：source / meta / tags 都是已有字段，客户端会把这些塞进 meta 或 tags 显示。
 */
const CATEGORY_META_GUIDE: Record<SecretSpaceAiGenerableCategory, string | null> = {
  state: null,
  draft_reply:
    'meta 字段：收件人，如「给 你」/「给 妈妈」/「给 自己」，一句话指明对象；不确定可省略。',
  dream:
    'tags 字段：2–6 个梦中意象关键词（每个 ≤ 12 字符），如 ["水","回不去的车","听到歌"]；意象不清晰可省略。',
  saved_item:
    'meta 字段：分类，从「句子 / 对话 / 瞬间 / 片段」四选一（可省略）。source 字段：出处（可虚构），如「—— Camus《西西弗神话》」或「—— 周二夜，与你」（可省略）。',
  unsent_moment:
    'meta 字段：为什么没发出去（一句话，从 TA 的视角，可省略），如「—— 太琐碎，没发」。',
};

/**
 * 构造秘密空间 AI 生成 prompt（仅 JSON 输出说明 + 结构化输入）。
 * `recentChatBlock` 已由 `describeRecentContextForPrompt` 生成，可为「无聊天」降级文案。
 */
export function buildSecretSpaceGenerationPrompt(args: {
  category: SecretSpaceAiGenerableCategory;
  agent: Pick<Agent, 'id' | 'name' | 'yuan'>;
  userName?: string;
  profile: XingyeRoleProfile | null | undefined;
  recentChatBlock: string;
  loreContextText: string | null | undefined;
  /** 仅 saved_item：用户可选的种子/线索 */
  seedText?: string | null;
}): string {
  const { category, agent, profile, recentChatBlock, seedText } = args;
  const loreSection = renderLoreSection(args.loreContextText);
  const speakerContextBlock = formatXingyeSpeakerContextForPrompt({
    userName: args.userName,
    agentName: profile?.displayName ?? agent.name,
    gender: profile?.gender,
  });
  const seedTrimmed = typeof seedText === 'string' ? seedText.replace(/\s+/g, ' ').trim() : '';

  const metaGuide = CATEGORY_META_GUIDE[category];
  const parts: string[] = [
    '你是星野模式「秘密空间」文本生成器。只返回严格 JSON，不要 Markdown，不要解释。',
    `任务：${CATEGORY_TASK[category]}`,
    '长度建议：正文 content 控制在约 800 字以内；标题 title 简短。',
    '禁止写入 OpenHanako memory、不要把本输出当作已同步设定；不要生成通讯录或短信任务说明。',
    ...(metaGuide ? [metaGuide] : []),
    '',
    '输出 JSON schema（仅此结构；除 title/content 外其余字段均可选，模型不确定时直接省略字段名，不要输出空字符串占位）：',
    JSON.stringify(
      category === 'dream'
        ? { title: 'string', content: 'string', tags: ['string'] }
        : category === 'saved_item'
        ? { title: 'string', content: 'string', meta: 'string', source: 'string' }
        : category === 'draft_reply' || category === 'unsent_moment'
        ? { title: 'string', content: 'string', meta: 'string' }
        : { title: 'string', content: 'string' },
      null,
      2,
    ),
    '',
    '当前角色:',
    JSON.stringify({
      id: agent.id,
      name: agent.name,
      yuan: agent.yuan,
      profile: profile ?? null,
    }, null, 2),
    '',
    speakerContextBlock,
    '',
    '最近 OpenHanako 聊天参考（可能为空；为空时仅依据资料与设定参考）：',
    recentChatBlock,
  ];

  if (category === 'saved_item') {
    parts.push(
      '',
      '用户可选的收藏线索/种子（若无则写「（无）」并仅凭资料与设定参考创作）：',
      seedTrimmed || '（无）',
    );
  }

  if (loreSection) {
    parts.push('', loreSection);
  }

  return parts.join('\n');
}
