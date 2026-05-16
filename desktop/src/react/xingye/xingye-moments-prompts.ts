import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import { formatXingyeSpeakerContextForPrompt } from './xingye-speaker-context';

/**
 * 喂给 prompt 的 virtual_contact hint（朋友圈生成时模型可从此池子里挑互动者）。
 * 与 mail-prompts 的 XingyeVirtualContactHint 同形；保留独立类型以免跨模块强耦合。
 */
export type XingyeMomentVirtualContactHint = {
  id: string;
  displayName: string;
  kind?: string;
  relationshipHint?: string;
};

/**
 * 喂给 prompt 的"其他 agent"hint（roster 里除当前发帖 agent 外的其他角色）。
 */
export type XingyeMomentPeerAgentHint = {
  id: string;
  displayName: string;
  relationshipLabel?: string;
};

/**
 * 构造朋友圈草稿生成 prompt（用户在 MomentComposer 点击「AI 生成」时使用）。
 * 输出仅 JSON：`{ content, likes?, comments? }`，由调用方塞回编辑框，**不直接发帖**。
 * 与 journal-prompts 同形，差异在任务与口吻：朋友圈是公开短动态而非私人日记。
 *
 * likes/comments 仅允许引用 virtualContacts / peerAgents 池里出现的 ref；
 * user 与发帖 agent 自身不应出现在 likes/comments 中（user 互动由 UI 触发，agent 自赞无意义）。
 */
export function buildMomentDraftPrompt(args: {
  agent: Pick<Agent, 'id' | 'name' | 'yuan'>;
  userName?: string;
  profile: XingyeRoleProfile | null | undefined;
  recentSceneBlock: string;
  stableLoreBlock: string;
  keywordLoreBlock: string;
  relationshipBlock: string;
  heartbeatBlock: string;
  virtualContacts?: ReadonlyArray<XingyeMomentVirtualContactHint>;
  peerAgents?: ReadonlyArray<XingyeMomentPeerAgentHint>;
}): string {
  const {
    agent,
    profile,
    recentSceneBlock,
    stableLoreBlock,
    keywordLoreBlock,
    relationshipBlock,
    heartbeatBlock,
  } = args;
  const virtualContacts = args.virtualContacts ?? [];
  const peerAgents = args.peerAgents ?? [];
  const speakerContextBlock = formatXingyeSpeakerContextForPrompt({
    userName: args.userName,
    agentName: profile?.displayName ?? agent.name,
  });

  const virtualContactsBlock = virtualContacts.length
    ? JSON.stringify(
        virtualContacts.map((c) => ({
          ref: `vc:${c.id}`,
          displayName: c.displayName,
          kind: c.kind ?? undefined,
          relationshipHint: c.relationshipHint ?? undefined,
        })),
        null,
        2,
      )
    : '（无）';
  const peerAgentsBlock = peerAgents.length
    ? JSON.stringify(
        peerAgents.map((a) => ({
          ref: `agent:${a.id}`,
          displayName: a.displayName,
          relationshipLabel: a.relationshipLabel ?? undefined,
        })),
        null,
        2,
      )
    : '（无）';

  const parts: string[] = [
    '你是星野模式「朋友圈」短动态生成器。只返回严格 JSON，不要 Markdown，不要解释。',
    '',
    '写作身份：以当前角色身份发一条朋友圈短动态，第一人称「我」。',
    '禁止写成用户视角、读者视角或系统总结；不要出现「根据聊天记录」「用户说」「系统提示」「模型」「AI」等元叙述。',
    '不要复述或引用输入里的标签行（例如「最近场景」「关系状态」等小节标题）；直接写朋友圈口吻。',
    '可以含蓄、留白、引一两句歌词或随手感想；不要写长篇日记，不要 emoji 堆砌。',
    '不要捏造重大剧情、生死、关系决裂等输入里不存在的事件。',
    '',
    '长度：正文 content 控制在约 30–140 个汉字（朋友圈口吻为主，宁短勿滥）；不要标题，不要分段编号。',
    '',
    '同时生成围观互动 likes / comments（这是任务的一部分，不是可选润色）：',
    '- 只要下方两个「可选互动者池」**至少一个**非空（不是「（无）」），就必须给出 **至少 2 条 likes 和至少 1 条 comments**；',
    '  能挑出更多合适人选时 likes 给到 3–4 条、comments 给到 2–3 条更好。',
    '- 两个池都是「（无）」时才允许省略 likes / comments 字段（不要输出空数组占位）；这种场景很少见。',
    '- ref 必须**逐字**取自池中已列出的 ref（形如 `vc:<id>` 或 `agent:<id>`，含前缀），不要凭空捏造、不要写 displayName，不要省掉前缀。',
    '- 不要把当前角色自己、user / 莉莉丝 / 任何用户身份放进 likes 或 comments（用户的点赞评论由 UI 触发）。',
    '- likes 上限 4 条；comments 上限 3 条，每条 body 控制在 30 字以内、口语化、符合该互动者口吻；多个互动者要呼应不同身份/口气，不要复读同一句。',
    '',
    '输出 JSON schema（仅此结构，字段名必须一致；除 content 外其余字段在池非空时为必填）：',
    JSON.stringify(
      {
        content: 'string',
        likes: [{ ref: 'vc:<id> 或 agent:<id>' }],
        comments: [{ ref: 'vc:<id> 或 agent:<id>', body: 'string' }],
      },
      null,
      2,
    ),
    '',
    '示例（假设池里有 { ref: "agent:hanako", displayName: "Hanako" } 与 { ref: "vc:vc-night", displayName: "夜班搭子" }）：',
    JSON.stringify(
      {
        content: '凌晨三点的便利店，泡面味混着冷气。',
        likes: [{ ref: 'agent:hanako' }, { ref: 'vc:vc-night' }],
        comments: [{ ref: 'vc:vc-night', body: '又轮到你守夜？记得留一盒关东煮。' }],
      },
      null,
      2,
    ),
    '',
    '当前角色（基础身份）：',
    JSON.stringify(
      {
        id: agent.id,
        name: agent.name,
        yuan: agent.yuan,
        profile: profile ?? null,
      },
      null,
      2,
    ),
    '',
    speakerContextBlock,
    '',
    '【可选互动者池 · 当前角色的虚拟联系人（vc:<id>，仅本人可见）】',
    virtualContactsBlock,
    '',
    '【可选互动者池 · 其他星野角色（agent:<id>，共同好友式可见）】',
    peerAgentsBlock,
    '',
    '【最近发生的事（场景参考；勿在正文里交代信息来源）】',
    recentSceneBlock.trim() || '（无）',
    '',
    '【星野核心设定摘录（lore-memory / 常驻设定；勿逐字复述）】',
    stableLoreBlock.trim() || '（无）',
    '',
    '【按需命中的设定库关键词条目（仅命中项；勿逐字复述）】',
    keywordLoreBlock.trim() || '（无）',
    '',
    '【当前对 user 的关系状态摘要（内部参考）】',
    relationshipBlock.trim() || '（无）',
    '',
    '【最近一次手机首页巡检结果（若有；仅作情绪参考，勿照抄套话）】',
    heartbeatBlock.trim() || '（无）',
  ];

  return parts.join('\n');
}
