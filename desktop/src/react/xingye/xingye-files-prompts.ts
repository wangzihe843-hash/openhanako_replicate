import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import { formatXingyeSpeakerContextForPrompt } from './xingye-speaker-context';

export type FilesDraftFolderHint = {
  id?: string;
  name: string;
  description?: string;
};

/**
 * 构造「文件管理草稿」prompt：让模型扮演当前 agent，整理一条放进资料柜的文件。
 *
 * 重要约束：
 * - 第一人称（agent 自己整理资料），禁止 user 视角 / 系统总结。
 * - 不写日记、日程、购物、邮件、阅读笔记，只写资料整理。
 * - 不读取真实文件系统，模型只基于输入里的 profile / lore / recent chat / heartbeat。
 * - 任何输入块缺失时都允许为「（无）」，prompt 仍然合法。
 */
export function buildFilesDraftPrompt(args: {
  agent: Pick<Agent, 'id' | 'name' | 'yuan'>;
  userName?: string;
  profile: XingyeRoleProfile | null | undefined;
  /** 用户在弹窗里写下的整理意图（可空）。 */
  userIntent: string;
  /** 当前正在新建文件的目标文件夹（可选；缺失时模型可以从 folderOptions 中挑一个）。 */
  targetFolder: FilesDraftFolderHint | null;
  /** 当前角色已有的所有资料文件夹，供模型从中选 folderName，避免发明新分类。 */
  folderOptions: FilesDraftFolderHint[];
  recentSceneBlock: string;
  stableLoreBlock: string;
  keywordLoreBlock: string;
  relationshipBlock: string;
  heartbeatBlock: string;
}): string {
  const {
    agent,
    userName,
    profile,
    userIntent,
    targetFolder,
    folderOptions,
    recentSceneBlock,
    stableLoreBlock,
    keywordLoreBlock,
    relationshipBlock,
    heartbeatBlock,
  } = args;

  const currentUserName = userName?.trim() || '用户';
  const currentAgentName = profile?.displayName?.trim() || agent.name || '当前角色';
  const speakerContextBlock = formatXingyeSpeakerContextForPrompt({
    userName: currentUserName,
    agentName: currentAgentName,
  });

  const folderListing = folderOptions.length
    ? folderOptions
        .map((f) => `- ${f.name}${f.description ? `：${f.description}` : ''}`)
        .join('\n')
    : '（资料柜里目前还没有文件夹，请在 folderName 里给出一个 2–6 字的中文新分类名）';

  const targetFolderLine = targetFolder
    ? `${targetFolder.name}${targetFolder.description ? `（${targetFolder.description}）` : ''}`
    : '（未指定，请从下面已有文件夹中挑一个最贴切的；都不合适才能新建）';

  const parts: string[] = [
    '你是星野模式「小手机文件管理」资料草稿生成器。只返回严格 JSON，不要 Markdown，不要解释。',
    '',
    '生成目标：这是当前角色自己手机里的「资料柜」条目，由 TA 自己整理出来供以后翻阅。',
    '不是日记，不是日程，不是购物清单，不是邮件草稿，不是阅读笔记，不是 user 想知道的资料。',
    '不要写成系统简报、AI 总结、外部知识查询；不要出现「根据聊天记录」「用户让我」「系统提示」「模型」「AI」等元叙述。',
    '不要输出 user 视角或第三人称视角；只能是 agent 自己第一人称整理 / 备忘 / 记笔记的口吻。',
    '不连接任何真实文件系统、网盘、网页、电商、邮件；不要写「上传 / 下载 / 打开链接」。',
    '如果输入信息不足，可以让 body 简短说明「目前能整理到的就是这些」，但不要凭空捏造重大剧情或不存在的人物。',
    '',
    '输出 JSON schema（仅此结构，字段名必须一致）：',
    JSON.stringify(
      {
        folderName: 'string',
        title: 'string',
        body: 'string',
        summary: 'string',
        tags: ['string'],
      },
      null,
      2,
    ),
    '',
    '字段要求：',
    '- folderName 必须等同于「目标文件夹」名字；如果未指定目标文件夹，则必须从下方「资料柜里已有文件夹」里完整复制一个名字，禁止改写。',
    '- title 一行短句，2–24 字，不要书名号堆叠。',
    '- body 80–400 个汉字，分段用换行；像 TA 自己手写的备忘条目，不要写成新闻稿。',
    '- summary 可空字符串；若非空，30 字以内一句话概述。',
    '- tags 0–5 个 2–6 字的中文标签；与正文相关，不要复述 folderName。',
    '',
    speakerContextBlock,
    `- folderName 视角：把 TA 写成「我」，把 ${currentUserName} 写成「${currentUserName}」；不要写成「TA / 她 / 他」。`,
    '',
    '【目标文件夹】',
    targetFolderLine,
    '',
    '【资料柜里已有文件夹（folderName 必须从中选一个完整复制；无目标文件夹时尤其重要）】',
    folderListing,
    '',
    '当前角色（基础身份）：',
    JSON.stringify(
      {
        id: agent.id,
        name: currentAgentName,
        yuan: agent.yuan,
        profile: profile ?? null,
      },
      null,
      2,
    ),
    '',
    '【用户输入的整理意图（若有；只是提示方向，不要照抄）】',
    userIntent.trim() || '（无）',
    '',
    '【最近 OpenHanako 聊天（线索来源；勿在输出里交代信息来源）】',
    recentSceneBlock.trim() || '（无）',
    '',
    '【星野核心设定摘录（stable lore；只作角色边界与世界观参考）】',
    stableLoreBlock.trim() || '（无）',
    '',
    '【按需命中的设定库关键词条目（仅命中项）】',
    keywordLoreBlock.trim() || '（无）',
    `【当前对 ${currentUserName} 的关系状态摘要（若有；情绪 / 边界参考）】`,
    relationshipBlock.trim() || '（无）',
    '',
    '【最近一次手机首页巡检结果（若有；仅作背景参考）】',
    heartbeatBlock.trim() || '（无）',
  ];

  return parts.join('\n');
}
