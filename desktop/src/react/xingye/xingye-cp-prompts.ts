/**
 * 「你和 TA 的 CP」论坛板块的 prompt 构造器。
 *
 * 产品意象：用户偷看 TA 的手机，发现 TA 在潜水关注一个「嗑你俩 CP」的饭圈板块。
 *  - 板上**只有 NPC（饭圈网友）发的主题帖**：同人文 / 细节考据 / 发疯日常 / 普通讨论。
 *  - TA 不主动发主题帖，最多以一个 **CP 马甲**在帖下评论 / 澄清（要不要回、怎么回看人设 + 关系）。
 *  - 另产一批「草稿」：TA 想发没发的内容（含发送后反应彩蛋 sendReaction + 没发的独白 hesitation）。
 *  - 以及一句 followReaction：用户「替 TA 关注本板」时弹的反应彩蛋。
 *
 * 与论坛小号一致：模型只产定性正文、返回严格 JSON；ID/时间/数值/草稿绑定全在本地组装。
 * 文风遵循秘密空间私密残片偏好（贴角色、像真实饭圈残片，别工程腔也别小说旁白）。
 */

import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import { formatXingyeSpeakerContextForPrompt } from './xingye-speaker-context';
import {
  CP_COMMENTS_PER_POST,
  CP_DRAFTS_PER_BATCH_MAX,
  CP_LIMITS,
  CP_POSTS_PER_BATCH_MAX,
  CP_REPLIES_PER_COMMENT_MAX,
  type CpAltAccount,
} from './xingye-cp-types';

export interface CpPromptContext {
  agent: Pick<Agent, 'id' | 'name' | 'yuan'>;
  userName?: string;
  profile: XingyeRoleProfile | null | undefined;
  stableLoreBlock: string;
  keywordLoreBlock: string;
  recentSceneBlock: string;
  relationshipBlock: string;
}

export interface CpExistingAccountHint {
  username: string;
  themeLabel: string;
  bio: string;
}

function buildSharedSections(ctx: CpPromptContext, agentName: string, userName: string): string[] {
  const speakerContextBlock = formatXingyeSpeakerContextForPrompt({
    userName,
    agentName,
    gender: ctx.profile?.gender,
  });
  return [
    '## 这是什么',
    `这是一个**饭圈论坛板块**，主题是嗑「${userName} × ${agentName}」这对 CP（这里把这两个人当作被一圈人追的「本命 CP」）。`,
    `板块里的发帖人都是**第三方网友（NPC）**：他们不认识真人，只是凭流出的同框细节 / 对话碎片在「磕糖」。`,
    `${agentName}（即 TA）偷偷潜水关注着这个板——看着一群陌生人嗑自己和 ${userName}，TA 嘴上未必承认，心里另说。`,
    '',
    '## 文风硬约束（违反就重写）',
    '- 像**真实饭圈论坛**：口语、有网感、密集缩写 / 颜文字 / 饭圈黑话（磕到了 / 锁死 / 上头 / 考古 / 玻璃渣里找糖 / 无能狂喜…），但要贴世界观年代。',
    '- 不同 NPC 要有不同网名、不同发癫程度，别一个腔调；楼里有真实的抬杠 / 共鸣 / 跑题 / 玩梗 / 求文。',
    `- \`isAgent: true\` 的发言才是 TA 本人（用 CP 马甲）说的，语气必须贴 TA 的人设；其余都是其他网友。`,
    '- 不要出现「根据聊天记录」「用户让我」「系统」「模型」「AI」「prompt」「OpenHanako」「设定库」等任何元叙述。',
    '- NPC 不要直呼真名时显得像在点名真人；用 CP 缩写 / 昵称 / 代号（像饭圈给本命起的称呼）更自然。',
    '',
    '## 当前角色',
    JSON.stringify({ id: ctx.agent.id, name: ctx.agent.name, yuan: ctx.agent.yuan, profile: ctx.profile ?? null }, null, 2),
    '',
    speakerContextBlock,
    '',
    '## 最近的相处 / 场景（CP 粉「考据」与 TA 此刻心境的素材，不要原样照搬，要被网友加工成「糖点」）',
    ctx.recentSceneBlock?.trim() || '（无最近聊天可参考）',
    '',
    '## 当前关系状态（决定 TA 看到这些帖时的反应、回不回、嘴硬还是暗爽）',
    ctx.relationshipBlock?.trim() || '（无）',
    '',
    '## 角色设定参考（稳定）',
    ctx.stableLoreBlock?.trim() || '（无）',
    '',
    '## 角色设定参考（按当前话题命中）',
    ctx.keywordLoreBlock?.trim() || '（无）',
  ];
}

const GENRE_RULES = [
  '## 帖子体裁（genre，每条 NPC 帖四选一，整批要混搭别全一种）',
  '- `fic` 同人文：一段把 CP 写成甜 / 虐的短打 / 小剧场 / 微小说，标题像投稿（带点梗 / 预警）。正文是节选片段。',
  '- `analysis` 考据：考据党从「一个同框细节 / 一句话 / 一个动作」推「郎有情妾有意」，证据流、玻璃渣里找糖、理性发癫。',
  '- `squee` 发疯：无能狂喜 / 在线发癫 / 磕到了刷屏体，短、情绪炸裂、颜文字缩写密集。',
  '- `discuss` 普通讨论：求文 / 锁三 / 考古 / 安利 / 吵 CP 立场之类的同好讨论。',
];

function postRules(): string[] {
  return [
    '## 帖子与评论硬约束',
    '- 所有主题帖都是 **NPC（饭圈网友）** 发的，authorName 必填（NPC 网名，要有饭圈感：嗑学家 / 二创bot / 腿部挂件 / 考据组组长…）。',
    `- 每帖配 ${CP_COMMENTS_PER_POST.min}-${CP_COMMENTS_PER_POST.max} 条评论（抬杠 / 共鸣 / 玩梗 / 求文 / 跑题），评论间可互相 @（replies + toName）。`,
    `- 每条评论可带 0-${CP_REPLIES_PER_COMMENT_MAX} 条嵌套回复（楼中楼）。`,
    '- **TA 的下场（isAgent=true）必须稀少而克制**：大多数帖 TA 只是潜水（评论里没有任何 isAgent）。',
    '  只有少数帖 TA 才忍不住用 CP 马甲冒泡，且**回什么严格由人设 + 关系决定**：',
    '  · 高冷 / 否认型 → 顶多冷冷澄清一句「别瞎磕」，或干脆全程不回。',
    '  · 别扭 / 嘴硬型 → 嘴上否认心里在意（口是心非）。',
    '  · 关系亲近 / 已破防 → 罕见地配合、玩梗甚至暗爽下场。',
    '- isAgent=true 的评论 / 回复 authorName 可留空（系统会统一填成 CP 马甲名）；NPC 网名各不相同。',
  ];
}

function draftRules(): string[] {
  return [
    `## 草稿硬约束（drafts，0-${CP_DRAFTS_PER_BATCH_MAX} 条；这是 TA「想发但没点发送」的东西，取决于性格 + 关系）`,
    '- 每条草稿是 TA 在这个板里差点发出去的内容：可能是想匿名投的一段同人、一句想澄清又删掉的回复、一句想下场发疯又怂了的话。',
    '- `kind: "post"`：一条想发的**主题帖**草稿，需 genre / board / title / body。',
    '- `kind: "reply"`：对**某条本次 NPC 帖**的回复草稿，需 targetPostTitle（严格等于上面 posts 里的某个 title）+ body。',
    '- `sendReaction`：用户**替 TA 点了发送**后，TA 的即时反应（第一人称、像被当场抓包，短、贴人设；可慌 / 可凶 / 可嘴硬 / 可破罐破摔）。',
    '- `hesitation`：一句「为什么写了又没发」的角色口吻独白（贴心意的悄悄话，不是「最近聊天提到 X」这种数据溯源式说明）。',
    '- 草稿数量与尺度看人设：越克制 / 别扭的人，草稿越少越纠结；越破防的人，草稿越多越大胆。',
  ];
}

function lengthRules(): string[] {
  return [
    '## 字数硬约束（超长会被系统截断成省略号，写到接近上限但别超）',
    `- CP 马甲 username ≤ ${CP_LIMITS.altUsernameMax} 字；bio ≤ ${CP_LIMITS.altBioMax} 字；themeLabel ≤ ${CP_LIMITS.altThemeLabelMax} 字。`,
    `- board ≤ ${CP_LIMITS.boardMax} 字；帖子 title ≤ ${CP_LIMITS.postTitleMax} 字；body ≤ ${CP_LIMITS.postBodyMax} 字。`,
    `- NPC 网名 ≤ ${CP_LIMITS.authorNameMax} 字；评论 / 回复 body ≤ ${CP_LIMITS.commentBodyMax} 字。`,
    `- 草稿 body ≤ ${CP_LIMITS.draftBodyMax} 字；sendReaction ≤ ${CP_LIMITS.reactionMax} 字；hesitation ≤ ${CP_LIMITS.hesitationMax} 字；followReaction ≤ ${CP_LIMITS.reactionMax} 字。`,
  ];
}

function schemaShape(): Record<string, unknown> {
  return {
    cpName: 'string（这对 CP 的圈名，4 字诗化/谐音为主）',
    alt: {
      pickUsername: 'string | null（选中的现有小号名；没有合适的就填 null）',
      newAlt: { username: 'string', bio: 'string', themeLabel: 'string' },
    },
    posts: [
      {
        genre: "'fic' | 'analysis' | 'squee' | 'discuss'",
        board: 'string（版块名）',
        title: 'string',
        body: 'string（NPC 写的正文 / 同人节选 / 考据 / 发疯）',
        authorName: 'string（NPC 网名，必填）',
        comments: [
          {
            authorName: 'string（NPC 网名；isAgent=true 时可留空）',
            isAgent: 'boolean（true=这条是 TA 用 CP 马甲发的，要稀少）',
            body: 'string',
            replies: [
              { authorName: 'string', isAgent: 'boolean', toName: 'string（可选，@谁）', body: 'string' },
            ],
          },
        ],
      },
    ],
    drafts: [
      {
        kind: "'post' | 'reply'",
        genre: "'fic' | 'analysis' | 'squee' | 'discuss'（kind=post 时）",
        board: 'string（kind=post 时）',
        title: 'string（kind=post 时）',
        body: 'string',
        targetPostTitle: 'string（kind=reply 必填：严格等于上面某条 post 的 title）',
        sendReaction: 'string（替 TA 发送后 TA 的反应）',
        hesitation: 'string（为什么写了又没发）',
      },
    ],
    followReaction: 'string（用户替 TA 关注本板时，TA 的反应彩蛋）',
  };
}

function buildNamingSection(lockedCpName: string | null, userName: string, agentName: string): string[] {
  if (lockedCpName) {
    return [
      '## CP 名（已固定，别改）',
      `这对 CP 的圈名叫《${lockedCpName}》。本批所有 NPC 帖 / 评论提到你俩时，用《${lockedCpName}》或它的缩写称呼，别另起名。`,
      `cpName 字段回 "${lockedCpName}"。`,
    ];
  }
  return [
    '## 给这对 CP 起个圈名（cpName）',
    `按真实饭圈套路给「${userName} × ${agentName}」起一个 CP 名（中文）：`,
    '- **优先 4 个字**：把两人名字里的字嵌进一个像成语 / 诗句 / 谐音的短语（经典范例：「博君一肖」= 一博 + 肖战，谐音「博君一笑」；「佳偶天成」式）。',
    '- 也可各取一字直接拼成 2 字缩写（如 名字含「博」「肖」→「博肖」）。',
    '- 要顺口、有梗、像粉丝真的会天天挂在嘴边的名字；**别直白写成「X 和 Y 的 CP」「XY 配对」**这种工程腔。',
    '- 起好后，本批 NPC 帖 / 评论提到你俩时，就用这个 CP 名或它的缩写来称呼（饭圈不直呼真名）。',
  ];
}

export function buildCpBoardPrompt(
  ctx: CpPromptContext & {
    existingAccounts: CpExistingAccountHint[];
    lockedAlt: CpAltAccount | null;
    lockedCpName: string | null;
    dedupeAnchorBlock: string;
    followed: boolean;
  },
): string {
  const agentName = ctx.profile?.displayName?.trim() || ctx.agent.name || '当前角色';
  const userName = ctx.userName?.trim() || '用户';

  const altSection: string[] = [];
  if (ctx.lockedAlt) {
    altSection.push(
      '## TA 在本板的身份（已固定，别再换）',
      `TA 用 CP 马甲 @${ctx.lockedAlt.username}（${ctx.lockedAlt.themeLabel}）潜水 / 偶尔冒泡。所有 isAgent=true 的发言与草稿都属于这个马甲。`,
      `alt 字段回 { "pickUsername": "${ctx.lockedAlt.username}", "newAlt": null } 即可。`,
    );
  } else if (ctx.existingAccounts.length) {
    altSection.push(
      '## 选择 TA 在本板的潜水马甲（二选一）',
      '- 如果下面已有的某个小号气质适合用来潜水嗑 CP，就在 alt.pickUsername 填它的名字（最贴主题的那一个）。',
      '- 如果都不搭，alt.pickUsername 填 null，并在 alt.newAlt 里新造一个 CP 专用潜水马甲（一个像「只是路过磕一口」的匿名小号）。',
      'TA 现有的小号：',
      ...ctx.existingAccounts.map((a) => `  · @${a.username}（${a.themeLabel}）—— ${a.bio}`),
    );
  } else {
    altSection.push(
      '## 新造 TA 在本板的潜水马甲',
      'TA 还没有可用的小号。alt.pickUsername 填 null，并在 alt.newAlt 里造一个 CP 专用潜水马甲（匿名、低调、像「只是来磕一口糖」的围观号）。',
    );
  }

  const parts: string[] = [
    '你是星野模式「你和 TA 的 CP · 饭圈板块」内容生成器。只返回严格 JSON，不要 Markdown，不要解释。',
    '',
    ...buildSharedSections(ctx, agentName, userName),
    '',
    '## 本次任务：刷新这个 CP 板的新内容',
    `- 生成 1-${CP_POSTS_PER_BATCH_MAX} 条**新的 NPC 主题帖**（体裁混搭），围绕「${userName} × ${agentName}」这对 CP。`,
    '- 必须跟下方「反重复锚点」里的标题 / 版块组合明显不同，换新切口、新糖点，别炒冷饭。',
    `- 再给 0-${CP_DRAFTS_PER_BATCH_MAX} 条 TA「想发没发」的草稿，以及一句 followReaction。`,
    ctx.followed
      ? '- 用户此前已替 TA 关注过本板；followReaction 仍照常生成（兜底用，不展示也无妨）。'
      : '- 用户尚未替 TA 关注本板；followReaction 是「被替 TA 点关注」时弹的反应。',
    '',
    ...buildNamingSection(ctx.lockedCpName, userName, agentName),
    '',
    ...altSection,
    '',
    ...GENRE_RULES,
    ...postRules(),
    ...draftRules(),
    ...lengthRules(),
    '',
    '## 反重复锚点（只给体裁/版块/标题，请勿与之重复）',
    ctx.dedupeAnchorBlock?.trim() || '（暂无历史帖子）',
    '',
    '## 输出 JSON schema（结构必须严格一致；额外字段会被丢弃）',
    JSON.stringify(schemaShape(), null, 2),
  ];
  return parts.join('\n');
}
