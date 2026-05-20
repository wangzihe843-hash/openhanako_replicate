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
    '- reason 解释建议变化原因，不能编造对话不存在的事。',
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
      reason: '变化原因',
    }, null, 2),
    '',
    speakerContextBlock,
    '',
    '输入：',
    JSON.stringify(context, null, 2),
  ].join('\n');
}
