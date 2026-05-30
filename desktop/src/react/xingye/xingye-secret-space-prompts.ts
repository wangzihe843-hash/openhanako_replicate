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
    '生成一条与「TA 当前状态、情绪或关系快照」相关的短文字笔记：第一人称、语气符合角色；像 TA 随手戳在备忘里的一两句话——口语、零碎、可以没头没尾。不要写成系统说明或元描述，也不要写成工整的日记或文学小品。',
  draft_reply:
    '生成一条「尚未发送给用户的回复草稿」：第一人称、符合角色语气；正文要像手机里真实打出来又没发出的那条消息——口语化、可以不完整、可以语无伦次或临时改口，而不是一段工整的散文或独白。不要写成创作说明或旁白。',
  dream: [
    '生成一段「梦境残片」——要像 TA 刚醒来、趁还记得时草草记下的梦，**不是一篇小说**。',
    '梦的逻辑（请照着写）：',
    '- 场景毫无过渡地跳切，前后接不上（「然后忽然就在另一个地方」）；',
    '- 因果不成立、说不通；想做的事常常做不成（想喊喊不出、想跑迈不开腿、门怎么也推不开）；',
    '- 视角和身份会漂移，人或物会悄悄变成别的（「那个人是 X，可回头一看脸又成了 Y」）；',
    '- 情绪强烈却莫名（明明没什么却很怕 / 很急 / 舍不得），到一半就断、记不全。',
    '笔法：短句、现在时、多留白；可用「不知道为什么」「再后来就模糊了」这类断裂与失记的语气。',
    '严禁（这些都是「太像小说」的病灶）：工整的起承转合与清晰因果链；堆砌的文学比喻；完整连贯的情节与对话；',
    '尤其严禁「后来很多年 / 长大以后，每次…就会…」这类回望升华、替梦做总结的结尾——梦不会自我解释，也不会有漂亮的收束。',
    '不要解梦说教。',
  ].join('\n'),
  saved_item:
    '生成一条「角色收藏的文字记录」：可以是摘录感、备忘录式摘要或一句惦记；若用户提供了「收藏线索/种子」，必须与之呼应。',
  unsent_moment:
    '生成一条「未发送的朋友圈动态草稿」：纯文本、短句为主；要像社交软件里随手打的那种——口语、随意、可带语气词或省略号，而不是精雕细琢的文案或散文诗。不要配图说明或 Markdown。',
};

/**
 * 各分类的篇幅建议（替代统一的「约 800 字」上限）。
 * state / draft_reply / dream / unsent_moment 都是「短而真」的私密残片，过长会逼模型写成小说体；
 * saved_item 是摘录/收藏，保留较宽松上限。
 */
const CATEGORY_LENGTH_HINT: Record<SecretSpaceAiGenerableCategory, string> = {
  state: '长度建议：像随手戳下的状态/心情备忘，极短即可——一两句话、几十字以内；标题 title 简短。',
  draft_reply: '长度建议：像手机里真实的未发消息，通常不长，正文 content 约 300 字以内即可（可更短）；标题 title 简短。',
  dream: '长度建议：梦境残片要短而碎，正文 content 约 300 字以内即可，宁可残缺也不要写满；标题 title 简短，像随手起的梦名。',
  saved_item: '长度建议：正文 content 控制在约 800 字以内；标题 title 简短。',
  unsent_moment: '长度建议：像社交软件里的一条动态草稿，短；正文 content 约 200 字以内、短句为主；标题 title 简短。',
};

/**
 * 各分类可选的元信息说明，追加到 JSON schema 描述里。模型可选填，不写就省略。
 * 注意：source / meta / tags 都是已有字段，客户端会把这些塞进 meta 或 tags 显示。
 */
const CATEGORY_META_GUIDE: Record<SecretSpaceAiGenerableCategory, string | null> = {
  state: null,
  draft_reply: [
    'meta 字段：收件人，如「给 你」/「给 妈妈」/「给 自己」，一句话指明对象；不确定可省略。',
    'revisions 字段（可选但**强烈建议**填——这是这个分类的灵魂）：',
    '  - revisions.struck: 2–4 条「TA 起头写了又划掉」的开场白，每条 ≤80 字符。',
    '    每条强烈建议带 reason（第一人称内心活动，≤200 字符，例：「太矫情了」「这话不该我先说」「她又要笑我」）。',
    '    reason 必须是 **TA 自己**为什么划掉，不要写第三人称分析、不要写「这条草稿应该…」之类元说明。',
    '  - revisions.patches: 0–3 条夹在段间的改稿批注（如「这里改了三遍」「又删了」）；每条带可选 reason。',
    '    afterParagraphIndex 用 0 表示插在第一段后，1 表示第二段后；body 按 `\\n\\n` 分段。',
    '  - revisions.marginNotes: 0–3 条右侧空白处竖排小字（每条 ≤40 字符），如「……」「?」「不知道」「别发」。',
    '  整体语义：表现「写了又删、改了又改、最终也没发出口」的纠结感。',
    '  全部不确定就省略整个 revisions 字段（阅读器有装饰兜底，缺失不会出错）。',
  ].join('\n'),
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
/**
 * 子类型的「反重复 anchor」提示文案——dispatch 给 prompt 拼装，
 * 不同子类型描述的是同一类语义（请换不同的主题/对象/角度），但措辞按子类型语境贴一下。
 * 当 anchor block 为空（这是 TA 的第一条该子类型记录）时走兜底说明。
 */
const CONTINUITY_FALLBACK: Record<SecretSpaceAiGenerableCategory, string> = {
  dream: '（无；这是 TA 记下的第一段梦境。下次再生成时，本块会列出近期梦境主题与意象，请勿重复。）',
  draft_reply: '（无；这是 TA 写下的第一份草稿回复。下次再生成时，本块会列出近期收件人与开头，请勿重复同一对象同一主旨。）',
  saved_item: '（无；这是 TA 收藏的第一条文字。下次再生成时，本块会列出已收藏的句子/物品与出处，请勿重复。）',
  unsent_moment: '（无；这是 TA 写下又没发出的第一条朋友圈。下次再生成时，本块会列出近期开头，请勿重复同一种情绪切面。）',
  state: '（无；这是 TA 记下的第一条心绪。下次再生成时，本块会列出近期状态切面，请勿重复。）',
};

export function buildSecretSpaceGenerationPrompt(args: {
  category: SecretSpaceAiGenerableCategory;
  agent: Pick<Agent, 'id' | 'name' | 'yuan'>;
  userName?: string;
  profile: XingyeRoleProfile | null | undefined;
  recentChatBlock: string;
  loreContextText: string | null | undefined;
  /** 仅 saved_item：用户可选的种子/线索 */
  seedText?: string | null;
  /**
   * 反重复 anchor block（由 `buildXxxContinuityAnchorBlock` 生成；可空）。
   * 主要解决"梦境反复生成相同主题/意象"等问题。空 → prompt 端走 CONTINUITY_FALLBACK。
   */
  continuityAnchorBlock?: string | null;
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
  const continuityAnchor = (args.continuityAnchorBlock ?? '').trim();
  const parts: string[] = [
    '你是星野模式「秘密空间」文本生成器。只返回严格 JSON，不要 Markdown，不要解释。',
    `任务：${CATEGORY_TASK[category]}`,
    CATEGORY_LENGTH_HINT[category],
    '禁止写入 OpenHanako memory、不要把本输出当作已同步设定；不要生成通讯录或短信任务说明。',
    ...(metaGuide ? [metaGuide] : []),
    '',
    '## 跨期连续性（必读 · 反重复）',
    continuityAnchor || CONTINUITY_FALLBACK[category],
    '',
    '输出 JSON schema（仅此结构；除 title/content 外其余字段均可选，模型不确定时直接省略字段名，不要输出空字符串占位）：',
    JSON.stringify(
      category === 'dream'
        ? { title: 'string', content: 'string', tags: ['string'] }
        : category === 'saved_item'
        ? { title: 'string', content: 'string', meta: 'string', source: 'string' }
        : category === 'draft_reply'
        ? {
            title: 'string',
            content: 'string',
            meta: 'string',
            revisions: {
              struck: [{ text: 'string', reason: 'string' }],
              patches: [{ afterParagraphIndex: 0, text: 'string', reason: 'string' }],
              marginNotes: ['string'],
            },
          }
        : category === 'unsent_moment'
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
