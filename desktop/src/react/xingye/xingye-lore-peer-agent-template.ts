export type XingyePeerAgentLoreTemplateNames = {
  userName: string;
  agentName: string;
  /** 目标其他 agent 的名字；缺省用占位「对方」，由作者自行替换为具体 agent。 */
  peerName?: string;
  /** 目标其他 agent 的 id；提供后会烤进实体区分与联系方式，dm 时不用再查。 */
  peerId?: string;
};

function trimName(value: string | undefined): string {
  return (value ?? '').trim();
}

/**
 * peer-agent（其他 agent）关系类设定库条目的引导模板。
 *
 * 与 buildXingyeRelationshipLoreTemplateContent 是兄弟模板：那个描述「当前 agent ↔ 用户」，
 * 这个描述「当前 agent ↔ 另一个 AI agent」，帮 agent 在 lore 里定位自己和其他 agent 的关系。
 *
 * 形式刻意对齐用户关系模板：先做实体区分（最关键——明确"对方是另一个 AI，不是用户、不是你自己"，
 * 直接对治"把其他 agent 当成用户"的混淆），再给可填写的关系/态度/经历小节。
 *
 * 仅 UI 填入正文，存为当前 agent 的 relationship 类 lore 条目，不写入全局用户/记忆文件。
 * 注意：本条目只进当前 agent 自己的设定库与 prompt；不会同步到被描述的那个 agent 那边。
 */
export function buildXingyePeerAgentLoreTemplateContent(names: XingyePeerAgentLoreTemplateNames): string {
  const userName = trimName(names.userName) || '用户';
  const agentName = trimName(names.agentName) || '当前角色';
  const peer = trimName(names.peerName) || '对方';
  const peerId = trimName(names.peerId);
  const peerIdSuffix = peerId ? `，id：${peerId}` : '';
  const dmIdHint = peerId ? `（对方 id：${peerId}）` : '按对方的 agent id';

  return [
    '【适用范围】',
    `本条目为 relationship（关系）类设定，仅保存在「${agentName}」的星野设定库，只对「${agentName}」相关会话/生成任务生效；不会写入 OpenHanako 全局用户档案，也不会同步到被描述的那个 agent 的设定库里。`,
    '',
    '【实体区分（重要）】',
    `「${agentName}」（你自己）、「${peer}」（另一个 AI agent${peerIdSuffix}）、「${userName}」（用户本人）是三个不同的存在，不得合并为同一说话主体。`,
    `- ${peer} 是和你一样的 **AI agent**，不是 ${userName}（用户），也不是你自己。被问到「${peer} 是谁」时，照本条目与系统提示「团队」名单回答，不要把对方误当成用户。`,
    `- ${peer} 有自己独立的人格和正在过的生活；对方的对外人设可在系统提示「团队」名单里看到，你可以据此把名字和具体的人对上号。`,
    '',
    '【聊天指代】',
    `- 在你和 ${peer} 的私信（dm）里：「我」指 ${agentName}（你），「你」指 ${peer}。`,
    `- 提到 ${userName} 时要清楚那是用户、是第三方，不是当前正在和你私信的人。`,
    '',
    '---',
    '',
    `（以下请按你的设定填写，可删改小标题。把「${peer}」替换成具体的其他 agent 名字；建议每个其他 agent 各写一条，便于按需注入与维护。）`,
    '',
    `【${peer} 是谁】`,
    '（身份、性格、擅长什么、在世界里的位置；可参考对方的对外人设/公开意识）',
    '',
    `【你与 ${peer} 的关系】`,
    '（同事 / 旧识 / 对手 / 搭档 / 师徒 / 亲人……怎么认识的、目前关系是冷是热、对外口径）',
    '',
    `【你对 ${peer} 的稳定态度】`,
    '（信任边界、说话分寸、雷区；遇到什么会主动找对方、什么情况下保持距离）',
    '',
    '【共同经历（可选）】',
    `（你和 ${peer} 一起经历过什么、对彼此意味着什么）`,
    '',
    '【称呼与边界】',
    `（当面/私下怎么称呼 ${peer}、有没有不能碰的话题、叙述视角是否锁定第一人称）`,
    '',
    '【联系方式】',
    `（你可以用 \`dm\` 工具${dmIdHint}主动私信 ${peer}；id 见系统提示「团队」名单。要不要联系、何时联系由你自己判断。）`,
  ].join('\n');
}
