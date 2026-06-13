/**
 * 「秘密空间 · TA 的论坛小号」的 prompt 构造器。
 *
 * 三个入口共用一套「角色 + 设定 + 最近场景 + 关系 + 反元叙述」上下文，再各自接任务说明 + JSON schema：
 *  - buildForumBootstrapPrompt：首开生成 1 个小号 + 一批帖子（含评论/嵌套回复）。
 *  - buildForumBatchPrompt：给已有小号增量生成 1-3 个帖子，必要时提议新开一个小号。
 *  - buildForumDmPrompt：给一批「TA 互动过的人」各生成一段私信线程（双向，回多少看性格）。
 *
 * 与专访一致的取舍：模型只产定性正文，返回严格 JSON；ID/时间/数值/私信对象挑选全在本地。
 * 文风遵循秘密空间私密残片偏好：像真实论坛发言/楼中楼，不要工程腔也不要小说旁白。
 */

import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import { formatXingyeSpeakerContextForPrompt } from './xingye-speaker-context';
import {
  COMMENTS_PER_POST,
  FORUM_LIMITS,
  POSTS_PER_BATCH_MAX,
  REPLIES_PER_COMMENT_MAX,
  type ForumAccount,
} from './xingye-forum-types';
import type { ForumDmPeerCandidate } from './xingye-forum-assemble';

interface ForumPromptContext {
  agent: Pick<Agent, 'id' | 'name' | 'yuan'>;
  userName?: string;
  profile: XingyeRoleProfile | null | undefined;
  stableLoreBlock: string;
  keywordLoreBlock: string;
  recentSceneBlock: string;
  relationshipBlock: string;
}

const COMMENT_RULE = `每帖配 ${COMMENTS_PER_POST.min}-${COMMENTS_PER_POST.max} 条评论`;

function buildSharedSections(ctx: ForumPromptContext, agentName: string): string[] {
  const userName = ctx.userName?.trim() || '用户';
  const speakerContextBlock = formatXingyeSpeakerContextForPrompt({
    userName,
    agentName,
    gender: ctx.profile?.gender,
  });
  return [
    '## 这是什么',
    `这是 ${agentName}（即 TA）的一个**论坛小号**——一个匿名 / 半匿名的网络马甲。`,
    'TA 在这里说的，是平时不会当面对人说、也不会发在实名社交里的话：吐槽、emo、追的番 / 星 / 球队、',
    '在意却嘴硬的事、对某些人某些事的真实看法。这里没人知道 TA 是谁，所以 TA 比平时更松弛、更直接。',
    '',
    '## 文风硬约束（违反就重写）',
    '- 像**真实论坛发言**：口语化、有网感、可带常见网络用语和缩写，但要贴合世界观年代——',
    '  现代背景就用现代论坛口吻；玄幻 / 古代 / 架空背景则换成那个世界里「网络/坊间留言板」该有的口吻（设定库里有线索就照着来）。',
    '- **不是日记**也**不是小说旁白**：帖子正文是 TA 在公共版块发的内容，评论是一来一回的互动，私信是私下对话。',
    '- 不同人（NPC 网友）要有不同网名、不同说话习惯，别都一个腔调；楼里要有真实的抬杠 / 共鸣 / 跑题 / 玩梗。',
    '- `isAgent: true` 的发言才是 TA 本人（这个小号）说的话，语气必须贴 TA 的人设；其余都是其他网友。',
    '- 不要出现「根据聊天记录」「用户让我」「系统」「模型」「AI」「prompt」「OpenHanako」「设定库」等任何元叙述。',
    '',
    '## 当前角色',
    JSON.stringify({ id: ctx.agent.id, name: ctx.agent.name, yuan: ctx.agent.yuan, profile: ctx.profile ?? null }, null, 2),
    '',
    speakerContextBlock,
    '',
    '## 最近的相处 / 场景（拿来当 TA 此刻心境与话题的素材，不要原样照搬）',
    ctx.recentSceneBlock?.trim() || '（无最近聊天可参考）',
    '',
    '## 当前关系状态',
    ctx.relationshipBlock?.trim() || '（无）',
    '',
    '## 角色设定参考（稳定）',
    ctx.stableLoreBlock?.trim() || '（无）',
    '',
    '## 角色设定参考（按当前话题命中）',
    ctx.keywordLoreBlock?.trim() || '（无）',
  ];
}

function lengthRules(): string[] {
  return [
    '## 字数硬约束（超长会被系统截断成省略号，写到接近上限但别超）',
    `- 小号 username ≤ ${FORUM_LIMITS.usernameMax} 字（像真实论坛 ID，可含符号 / 数字）；bio（签名）≤ ${FORUM_LIMITS.bioMax} 字。`,
    `- themeLabel ≤ ${FORUM_LIMITS.themeLabelMax} 字（氛围短标签，如 追番 / 树洞 / 考研 / 球迷）；themeKeywords 1-${FORUM_LIMITS.themeKeywordsMax} 个，每个 ≤ ${FORUM_LIMITS.themeKeywordMax} 字。`,
    `- board（版块）≤ ${FORUM_LIMITS.boardMax} 字；帖子 title ≤ ${FORUM_LIMITS.postTitleMax} 字；body ≤ ${FORUM_LIMITS.postBodyMax} 字。`,
    `- NPC 网名（authorName）≤ ${FORUM_LIMITS.authorNameMax} 字；评论 body ≤ ${FORUM_LIMITS.commentBodyMax} 字；回复 body ≤ ${FORUM_LIMITS.replyBodyMax} 字。`,
  ];
}

const POST_RULES = [
  '## 帖子与评论硬约束',
  `- 帖子分两种 relation：`,
  '  · `authored`：TA 用这个小号**自己发的帖**。authorName 省略（系统会填成小号名）。',
  '  · `commented`：别人（NPC）发的帖，**TA 在底下评论过**。此时 authorName **必填**（NPC 帖主网名），帖子正文是那位 NPC 写的。',
  `- ${COMMENT_RULE}（包含各种互动：抬杠 / 共鸣 / 玩梗 / 跑题）。`,
  '- `authored` 帖：评论主要来自其他网友（isAgent=false），且 TA（楼主，isAgent=true）至少回其中 1-2 条，体现楼主和网友的来回。',
  '- `commented` 帖：评论里**必须**有 TA 的至少 1 条（isAgent=true，这是 TA 来这帖评论的理由）；其余是其他网友 / 帖主回复，网友之间可以互相 @（用 replies + toName）。',
  `- 每条评论可带 0-${REPLIES_PER_COMMENT_MAX} 条嵌套回复（replies），用来表现「楼中楼」对话；回复里 isAgent=true 的同样是 TA。`,
  '- isAgent=true 的评论/回复 authorName 可留空（系统会统一填成小号名）；NPC 的 authorName 各不相同、有网感。',
];

function schemaPostShape(): Record<string, unknown> {
  return {
    relation: "'authored' | 'commented'",
    board: 'string（版块名）',
    title: 'string（帖子标题）',
    body: 'string（帖子正文；authored 是 TA 写的，commented 是 NPC 帖主写的）',
    authorName: 'string（仅 commented 必填：NPC 帖主网名；authored 省略）',
    comments: [
      {
        authorName: 'string（NPC 网名；isAgent=true 时可留空）',
        isAgent: 'boolean（true=这条是 TA 这个小号发的）',
        body: 'string',
        replies: [
          {
            authorName: 'string（isAgent=true 时可留空）',
            isAgent: 'boolean',
            toName: 'string（可选，@ 谁）',
            body: 'string',
          },
        ],
      },
    ],
  };
}

export function buildForumBootstrapPrompt(ctx: ForumPromptContext): string {
  const agentName = ctx.profile?.displayName?.trim() || ctx.agent.name || '当前角色';
  const schemaExample = {
    account: {
      username: 'string（论坛用户名 / 小号名）',
      bio: 'string（个性签名）',
      themeLabel: 'string（氛围短标签）',
      themeKeywords: ['string', '...'],
    },
    posts: [schemaPostShape()],
  };
  const parts: string[] = [
    '你是星野模式「秘密空间 · TA 的论坛小号」内容生成器。只返回严格 JSON，不要 Markdown，不要解释。',
    '',
    ...buildSharedSections(ctx, agentName),
    '',
    '## 本次任务：初始化 TA 的第一个论坛小号',
    '- 先定 1 个小号：起一个像真实论坛 ID 的 username、一句个性签名 bio、一个氛围标签 themeLabel、几个内部主题关键词 themeKeywords。',
    '  这个小号应当对应 TA 内心某一块——比如 TA 真正的爱好、不敢公开的情绪出口、对某段关系的隐秘碎碎念。',
    '- 再生成 4-5 个帖子，**其中至少 1 个 relation=\'commented\'**（TA 去评论别人帖子的场景），其余为 authored。',
    '- 所有帖子都应当围绕这个小号的氛围（themeLabel），像同一个人的浏览/发帖记录。',
    ...POST_RULES,
    ...lengthRules(),
    '',
    '## 输出 JSON schema（结构必须严格一致；额外字段会被丢弃）',
    JSON.stringify(schemaExample, null, 2),
  ];
  return parts.join('\n');
}

export function buildForumBatchPrompt(
  ctx: ForumPromptContext & {
    activeAccount: ForumAccount;
    existingAccounts: ForumAccount[];
    dedupeAnchorBlock: string;
    /** 用户是否明确要求新开一个小号（个人中心「建号」按钮）。 */
    forceNewAccount?: boolean;
  },
): string {
  const agentName = ctx.profile?.displayName?.trim() || ctx.agent.name || '当前角色';
  const schemaExample = {
    posts: [schemaPostShape()],
    newAccount: {
      username: 'string',
      bio: 'string',
      themeLabel: 'string',
      themeKeywords: ['string'],
    },
  };
  const accountLine = `当前小号：@${ctx.activeAccount.username}（${ctx.activeAccount.themeLabel}）—— ${ctx.activeAccount.bio}`;
  const parts: string[] = [
    '你是星野模式「秘密空间 · TA 的论坛小号」内容生成器。只返回严格 JSON，不要 Markdown，不要解释。',
    '',
    ...buildSharedSections(ctx, agentName),
    '',
    '## 本次任务：增量更新 TA 的论坛动态',
    accountLine,
    `- 给上面这个小号生成 1-${POSTS_PER_BATCH_MAX} 个**新**帖子（authored / commented 混合，最好至少有一条是 TA 去评论别人的）。`,
    '- 必须跟下方「近期帖子」锚点里的标题 / 版块组合**明显不同**，换新话题、新切口，别炒冷饭。',
    ctx.forceNewAccount
      ? '- **本次用户明确要求新开一个小号**：请在 newAccount 里给出一个与已有小号氛围不同的新号（新的爱好 / 情绪出口 / 关注点），并让本次生成的帖子归属这个新号。'
      : '- 关于新开小号：**默认 newAccount 设为 null**。只有当你想写的帖子主题明显不属于任何已有小号的氛围时，才提议一个 newAccount（让这批帖子属于新号）。不要动不动就开新号。',
    ...POST_RULES,
    ...lengthRules(),
    '',
    '## 反重复锚点（只给标题/标签，请勿与之重复）',
    ctx.dedupeAnchorBlock?.trim() || '（暂无历史帖子）',
    '',
    '## 输出 JSON schema（newAccount 不需要时填 null）',
    JSON.stringify(schemaExample, null, 2),
  ];
  return parts.join('\n');
}

export function buildForumDmPrompt(
  ctx: ForumPromptContext & {
    account: ForumAccount;
    peers: ForumDmPeerCandidate[];
  },
): string {
  const agentName = ctx.profile?.displayName?.trim() || ctx.agent.name || '当前角色';
  const peerLines = ctx.peers.map((p) => {
    const why =
      p.originKind === 'commented_post_author'
        ? `TA 在对方发的帖「${p.originPostTitle}」底下评论过`
        : `对方在「${p.originPostTitle}」里跟 TA 在评论区有过来回`;
    return `  · ${p.peerName}（${why}）`;
  });
  const schemaExample = {
    threads: [
      {
        peerName: 'string（必须用下方给定的名字之一）',
        messages: [{ sender: "'peer' | 'agent'", body: 'string' }],
      },
    ],
  };
  const parts: string[] = [
    '你是星野模式「秘密空间 · TA 的论坛小号 · 私信」内容生成器。只返回严格 JSON，不要 Markdown，不要解释。',
    '',
    ...buildSharedSections(ctx, agentName),
    '',
    '## 本次任务：生成 TA 这个小号收到的私信',
    `当前小号：@${ctx.account.username}（${ctx.account.themeLabel}）`,
    '下面这些人因为在论坛上跟 TA 有过互动，私信了 TA。给**每个人各生成一段私信线程**：',
    ...peerLines,
    '',
    '## 私信硬约束',
    '- peerName 必须严格使用上面给定的名字，不要改名、不要新增对象。',
    `- 每个线程 2-6 条消息，单条 body ≤ ${FORUM_LIMITS.dmBodyMax} 字。`,
    '- **由对方（sender=\'peer\'）先发起**，话题承接他们在论坛上的那次互动（顺着帖子/评论的语境聊下去）。',
    '- 私信口吻比公开评论更私人、更随意。',
    '- **TA（sender=\'agent\'）回不回、回多少、热络还是冷淡，严格由 TA 的人设决定**：',
    '  · 高冷 / 寡言 / 社恐型 → 可能只回一两句很短的，甚至只给对方的消息、TA 全程不接（线程里就没有 agent 消息，或只在最后冷淡收一句）。',
    '  · 热络 / 自来熟型 → 正常你来我往，能聊起来。',
    '  · 别扭 / 嘴硬型 → 嘴上敷衍但其实有回。',
    '  千万别千篇一律——让每个线程的「TA 回应密度」都符合 TA 这个人。',
    '',
    '## 输出 JSON schema',
    JSON.stringify(schemaExample, null, 2),
  ];
  return parts.join('\n');
}
