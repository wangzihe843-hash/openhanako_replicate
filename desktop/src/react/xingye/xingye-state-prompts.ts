import type { Agent } from '../types';
import type { XingyeRoleProfileDisplay } from './xingye-profile-store';
import type { XingyeRelationshipState } from './xingye-state-store';
import { formatXingyeSpeakerContextForPrompt } from './xingye-speaker-context';

export type XingyeRelationshipStateTrigger =
  | 'manual_refresh'
  | 'debug'
  | 'after_chat_summary'
  | 'after_diary'
  | 'after_context_compression';

export interface BuildRelationshipStatePromptArgs {
  agent: Pick<Agent, 'id' | 'name' | 'yuan'>;
  userName?: string;
  profile: Partial<XingyeRoleProfileDisplay> | null | undefined;
  state: XingyeRelationshipState;
  recentChatSummary?: string;
  sourceNotes?: string[];
  /** 由 xingye-state-ai 内构造；可选覆盖（测试用） */
  loreContextText?: string;
  /**
   * 反套路 anchor block（由 xingye-state-dedupe.buildStateContinuityAnchorBlock 本地构造，
   * 列出最近 ~5 次的 mood / stateSummary / lastReason）。喂给模型让它换不同角度描述心绪，
   * 避免每次都「心情不错，最近聊得很多」之类的复读。模型**不**回写本字段；返回 schema
   * 不变（仅生成新 patch）。缺省 / 空串 → prompt 里展示「（无；这是首次刷新）」占位。
   */
  continuityAnchorBlock?: string;
  trigger: XingyeRelationshipStateTrigger;
}

export function buildRelationshipStatePrompt(args: BuildRelationshipStatePromptArgs): string {
  const profile = args.profile ?? {};
  const speakerContextBlock = formatXingyeSpeakerContextForPrompt({
    userName: args.userName,
    agentName: profile.displayName ?? args.agent.name,
    gender: profile.gender,
  });
  const context = {
    trigger: args.trigger,
    targetRule: 'Only update the current agent attitude and internal state toward user("__user__").',
    agent: {
      id: args.agent.id,
      name: args.agent.name,
      yuan: args.agent.yuan,
    },
    xingyeRoleProfile: {
      displayName: profile.displayName,
      shortBio: profile.shortBio,
      relationshipLabel: profile.relationshipLabel,
      identitySummary: profile.identitySummary,
      backgroundSummary: profile.backgroundSummary,
      personalitySummary: profile.personalitySummary,
      behaviorLogic: profile.behaviorLogic,
      values: profile.values,
      taboos: profile.taboos,
      relationshipMode: profile.relationshipMode,
      speakingStyle: profile.speakingStyle,
    },
    currentRelationshipState: args.state,
    recentOpenHanakoChat: args.recentChatSummary?.trim() || '(no safe recent chat summary was provided)',
    speakerContext: speakerContextBlock,
    xingyeLoreContext: args.loreContextText?.trim() || '(no matching canonical lore was provided)',
    sourceNotes: args.sourceNotes ?? [],
  };

  return [
    '你是“星野模式”的 TA 当前状态更新器。请只返回 JSON，不要 Markdown，不要解释。',
    '',
    '状态系统只表示：当前 agent 对 user("__user__") 的态度，以及当前 agent 自己的心情/精神状态。',
    '禁止生成 agent-agent、agent-NPC、通讯录联系人、短信联系人、群聊成员、黑名单、阵营或标签关系。',
    '禁止写入或假设 OpenHanako memory。不要编造没有出现在输入里的重大事件。',
    '设定库（xingyeLoreContext）内容只作为当前状态判断参考；不得写入 OpenHanako memory；不得编造输入中没有的重大事件。',
    '判断 user 与 agent 的语义时必须遵守下方 speaker context，不要把 NPC 当成 user 或 agent。',
    '',
    '请生成“建议变化”，不是最终状态。前端会先展示建议，用户接受后才写入 localStorage。',
    '',
    '变化幅度必须保守：',
    '- affectionDelta 通常 -5 到 +5，除非输入明确包含重大事件。',
    '- trustDelta 通常 -5 到 +5。',
    '- loyaltyDelta 通常 -3 到 +5。',
    '- jealousyDelta 通常 -3 到 +8。',
    '- corruptionDelta 通常 -2 到 +5。',
    '- 上下文不足时返回 0 或很小变化。',
    '- mood 必须短，例如：平静、警惕、疲惫、安心、不安、吃醋、愉快、克制、失落。',
    '- stateSummary 是当前状态摘要，短句即可，不要写成长篇小说。',
    '- reason 是 TA 写给自己的一句心里话，不是系统说明：用第一人称、贴角色口吻，轻声说清「为什么我这会儿对你的心绪，变成了现在这样」，像一片真实的私密残片，带点温度与心意，可以含蓄、可以笨拙，但要有 TA 的味道。',
    '  · 不要写成「上下文不足 / 建议保守 / 互动稳定 / 变化幅度较小」这类系统口吻，也不要写成数据溯源（「最近聊天反复出现…」「user 提到了 X」「源自某段对话」都不要）；更不要写成工整的文学小品。',
    '  · 仍要以输入里真实发生过的对话为依据，不能编造没出现过的事。',
    '  · 例：「你今天那句『早点睡』，我反复看了好几遍才舍得退出去」「你没像往常那样秒回我，我有点慌，又不肯承认在等」「你竟然还记得我随口提过的那件小事——这一下我有点说不出话」。',
    '',
    '返回 JSON schema：',
    JSON.stringify({
      affectionDelta: 0,
      trustDelta: 0,
      loyaltyDelta: 0,
      jealousyDelta: 0,
      corruptionDelta: 0,
      mood: '平静',
      stateSummary: '当前状态摘要',
      reason: 'TA 第一人称的一句心里话：为什么这会儿对你的心绪变成了这样',
    }, null, 2),
    '',
    speakerContextBlock,
    '',
    '【反套路锚点（仅供你换角度描述心绪；勿在 stateSummary / reason 里复述本块文字）】',
    (args.continuityAnchorBlock ?? '').trim() || '（无；这是首次刷新——尚无历史可参考）',
    '',
    '输入：',
    JSON.stringify(context, null, 2),
  ].join('\n');
}
