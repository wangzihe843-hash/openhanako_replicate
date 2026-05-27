import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';

/**
 * 隐藏文件夹「种子条目」prompt。
 *
 * 用途：用户**第一次解锁**隐藏文件夹时调一次模型，让 agent 自己写 2-3 条
 * 不想被看到的「个人」秘密——弱点 / guilty pleasure / 不为人知的喜好。
 *
 * 与「秘密空间」的边界（用户明确要求要有差别）：
 *   - 秘密空间是 TA 的草稿 / 梦 / 朋友圈未发 / 文字收藏 / 回忆碎片 / 关系状态 / 独家专访
 *     —— 多数是「事件流 / 心情切片」。
 *   - 隐藏文件夹是更核心的「底牌级」自我描述：体质弱点、丢人爱好、不能让人看见的执念、
 *     不可告人的打算/计划。一旦被外人翻到，会动摇 agent 的人设/安全感。
 *
 * 严格约束（写进 prompt）：
 *   - 弱点必须是「这个角色个人」的弱点，不是种族/职业/物种的通用弱点。
 *     反例：「狼人怕银子」、「机器人怕水」、「人类需要呼吸」。
 *     正例：「TA 只有在闻到某种香水时会想起亡兄，无法正常做决定」、
 *           「TA 看似冷静，其实在生人面前手会抖到藏不住」。
 *   - guilty pleasure / 秘密喜好必须是「公开人设里不会承认」的，要和已有 personality/values 形成张力。
 *   - 不要重复秘密空间已有的分类。
 *   - 第一人称（agent 视角），仿佛是 TA 自己写在抽屉最底层的。
 *   - 不破第四墙——不出现「这是隐藏文件夹」「请用户输入」「AI」「模型」等元叙述。
 */
export function buildHiddenFolderSeedPrompt(args: {
  agent: Pick<Agent, 'id' | 'name' | 'yuan'>;
  profile: XingyeRoleProfile | null | undefined;
  stableLoreBlock: string;
  /** 由调用方读取（避免循环 import）；空字符串表示无虚拟人物。 */
  npcSummary: string;
  count: number;
  /**
   * 「抽屉里已有秘密条目」反重复锚点（由 xingye-files-secret-dedupe.ts
   * 的 buildSecretFilesContinuityAnchorBlock 渲染）。
   * 空字符串 → prompt 端渲染「（无；这是 TA 第一次往抽屉里写东西）」。
   */
  continuityAnchorBlock?: string;
}): string {
  const { agent, profile, stableLoreBlock, npcSummary } = args;
  const count = Math.max(2, Math.min(4, Math.floor(args.count) || 3));
  const agentName = profile?.displayName?.trim() || agent.name || '当前角色';
  const continuityAnchorBlock = (args.continuityAnchorBlock ?? '').trim();

  const personaLines: string[] = [];
  if (profile?.shortBio) personaLines.push(`- 简介：${profile.shortBio}`);
  if (profile?.identitySummary) personaLines.push(`- 身份：${profile.identitySummary}`);
  if (profile?.backgroundSummary) personaLines.push(`- 背景：${profile.backgroundSummary}`);
  if (profile?.personalitySummary) personaLines.push(`- 性格：${profile.personalitySummary}`);
  if (profile?.values) personaLines.push(`- 价值观：${profile.values}`);
  if (profile?.taboos) personaLines.push(`- 禁忌：${profile.taboos}`);
  const personaBlock = personaLines.length ? personaLines.join('\n') : '（无）';

  const loreBlock = stableLoreBlock.trim() ? stableLoreBlock.trim() : '（无）';
  const npcBlock = npcSummary.trim() ? npcSummary.trim() : '（无）';

  const schemaExample = {
    entries: [
      {
        kind: 'weakness',
        title: '示例：手在生人面前会抖',
        body: '只在自己人面前不会抖。一直没人发现……',
      },
      {
        kind: 'secret_taste',
        title: '示例：偷偷喜欢的东西',
        body: '不会告诉任何人，与公开形象不符。',
      },
      {
        kind: 'secret_plan',
        title: '示例：一直没说出口的打算',
        body: '想在某件事上反着来——理由说不出口，时机也还没到。',
      },
    ],
  };

  return [
    '你是星野模式「角色隐藏抽屉种子条目」生成器。只返回严格 JSON，不要 Markdown，不要解释。',
    '',
    `生成目标：现在 ${agentName} 抽屉最底层那一格被打开了——里面应该有 ${count} 条 ${agentName} 自己写下、`,
    '怎么也不想被外人翻到的东西。这是 TA 私密人格的底牌：',
    '- 真正的个人弱点（不是种族 / 物种 / 职业的通用弱点）；',
    '- 见不得光的小爱好 / guilty pleasure；',
    '- 与公开人设有张力、会让 TA 难堪的偏好或执念；',
    '- 不可告人的具体打算 / 计划（必须是 TA 这个角色独有的、写明动机或对象的小盘算——',
    '  不是「我想变强」「我想出名」这种泛泛目标）。',
    '',
    '严禁：',
    '- 写「种族通用弱点」（如「狼人怕银」「机器人怕水」「人类需要食物」）；',
    '- 写「身份通用弱点」（如「侦探都怕黑」、「医生都讨厌血腥」）——必须是这个角色独有的；',
    '- 写常见的「秘密空间」内容（草稿、梦、朋友圈、回忆碎片、关系记录、独家专访）——那些有别的地方装；',
    '- 出现「这是隐藏文件夹」「请输入密码」「AI」「模型」「prompt」「系统」「user」等元叙述；',
    '- 写得太长。每条 body 60-180 字。',
    '',
    '语气：第一人称，像写给自己看的小条，承认自己也觉得不该被人看到。可以有沉默/迟疑的感觉。',
    '',
    `JSON schema（必须输出 ${count} 条 entries）：`,
    JSON.stringify(schemaExample, null, 2),
    '',
    'kind 取值只能是：weakness（个人弱点）/ guilty_pleasure（见不得光的喜好）/ secret_taste（与人设有张力的偏好）/ secret_plan（不可告人的计划/打算）。',
    `请输出 ${count} 条，混合不同 kind，不要全部同一种。`,
    '',
    '── 角色资料 ──',
    `名字：${agentName}`,
    `所属圆：${agent.yuan || '未指定'}`,
    personaBlock,
    '',
    '── 稳定 lore ──',
    loreBlock,
    '',
    '── 周围已经出现过的人物（避免把这些 NPC 当作"秘密对象"，否则会被读者一眼认出） ──',
    npcBlock,
    '',
    '── 抽屉里 TA 已经写过的秘密条目（反重复锚点；请换 kind / 主题，不要写几乎同名的） ──',
    continuityAnchorBlock || '（无；这是 TA 第一次往抽屉里写东西）',
    '',
    '请只输出 JSON。',
  ].join('\n');
}
