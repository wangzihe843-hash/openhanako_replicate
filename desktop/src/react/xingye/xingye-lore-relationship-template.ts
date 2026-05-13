export type XingyeRelationshipLoreTemplateNames = {
  userName: string;
  agentName: string;
};

function trimName(value: string): string {
  return value.trim();
}

/**
 * relationship 类设定库条目的引导模板（仅 UI 填入正文，不写入全局用户/记忆文件）。
 */
export function buildXingyeRelationshipLoreTemplateContent(names: XingyeRelationshipLoreTemplateNames): string {
  const userName = trimName(names.userName) || '用户';
  const agentName = trimName(names.agentName) || '当前角色';

  return [
    '【适用范围】',
    `本条目为 relationship（关系）类设定，仅保存在当前 agent 的星野设定库，只对「${agentName}」相关会话/生成任务生效；不会写入 OpenHanako 全局用户档案，也不会自动写入 pinned.md / memory.md / identity.md / ishiki.md。`,
    '',
    '【实体区分】',
    `「${userName}」（用户侧）与「${agentName}」（当前角色侧）不是同一个人，不得合并为同一说话主体。`,
    '',
    '【聊天指代】',
    `- 在 ${userName} 发出的用户消息里：「我」指 ${userName}；「你」指 ${agentName}。`,
    `- 在 ${agentName} 发出的角色/助手消息里：「我」指 ${agentName}；「你」指 ${userName}。`,
    '',
    '【第三者 / 路人 NPC】',
    '未经剧情或本条明确写出，不把第三方 NPC 默认当作与双方并列的「同行者」或「一起做某事的人」。',
    '供货、送货、被核查、被验收、仅被提及等角色，按情节处理为对立方/被提及者，而非默认同行。',
    '',
    '---',
    '',
    '（以下请按你的剧本填写，可删改小标题）',
    '',
    `【${userName} 在本角色世界中的身份】`,
    '（职业、处境、与世界的接口等）',
    '',
    `【${userName} 与 ${agentName} 的关系】`,
    '（契约、私人关系、对外口径等）',
    '',
    `【${agentName} 对 ${userName} 的稳定态度】`,
    '（信任边界、语气分寸、雷区等）',
    '',
    '【共同经历（可选）】',
    '（发生过什么、对彼此意味着什么）',
    '',
    '【称谓与视角边界】',
    '（当面/私下如何称呼、叙述视角是否锁定在第一人称等）',
  ].join('\n');
}
