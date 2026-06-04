import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import {
  CONTACT_LORE_DEDUPE_INSTRUCTION,
  contactsHaveLoreAlias,
  formatContactLoreListingBlock,
  type XingyeContactLoreHint,
} from './xingye-contact-lore-link';
import {
  FILES_FOLDER_SCATTER_GUARD,
  formatFilesFolderEntryGuide,
  formatFilesFolderGuideListing,
} from './xingye-files-folder-taxonomy';
import { formatXingyeSpeakerContextForPrompt } from './xingye-speaker-context';

export type FilesDraftFolderHint = {
  id?: string;
  name: string;
  description?: string;
};

/**
 * 喂给 prompt 的已有条目摘要——只放最相关字段，不放 body（body 太长会撑爆上下文）。
 * id 是给 propose-draft action='update' 的 targetEntryId 用的（agent 看到 id 就能引用）。
 */
export type FilesDraftExistingEntry = {
  id: string;
  folderName: string;
  title: string;
  summary?: string;
};

/** prompt 里最多列出多少条已有 entry。 */
export const FILES_DRAFT_EXISTING_ENTRIES_PROMPT_LIMIT = 30;

function formatExistingEntriesBlock(entries: FilesDraftExistingEntry[]): string {
  if (!entries.length) return '（资料柜里暂无已归档条目）';
  return entries
    .slice(0, FILES_DRAFT_EXISTING_ENTRIES_PROMPT_LIMIT)
    .map((e) => {
      const tail = e.summary ? ` — ${e.summary.slice(0, 60)}` : '';
      return `- [${e.id}] ${e.folderName} · 《${e.title}》${tail}`;
    })
    .join('\n');
}

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
  /**
   * 已有 entries 摘要（id / folder / title / summary）。模型据此判定
   * 当前要整理的主题**是不是已经有 entry 了**：是 → 在 body 里追加补充（用户后续合并）；
   * 不是 → 才新建。本字段缺省视为「资料柜暂无已归档条目」。
   * 调用方应按时间倒序传，prompt 端只取前 FILES_DRAFT_EXISTING_ENTRIES_PROMPT_LIMIT 条。
   */
  existingEntries?: FilesDraftExistingEntry[];
  recentSceneBlock: string;
  stableLoreBlock: string;
  keywordLoreBlock: string;
  relationshipBlock: string;
  heartbeatBlock: string;
  /**
   * 通讯录候选池（仅「人际关系 / 关于 user」等关系类文件夹注入）：整理人际资料时的参考亲友，
   * 带昵称 + 印象 + 与设定库的身份对齐。由 generateFilesDraftWithAI 视目标文件夹决定是否传入。
   */
  virtualContacts?: ReadonlyArray<XingyeContactLoreHint>;
}): string {
  const {
    agent,
    userName,
    profile,
    userIntent,
    targetFolder,
    folderOptions,
    existingEntries,
    recentSceneBlock,
    stableLoreBlock,
    keywordLoreBlock,
    relationshipBlock,
    heartbeatBlock,
  } = args;
  const virtualContacts = args.virtualContacts ?? [];

  const currentUserName = userName?.trim() || '用户';
  const currentAgentName = profile?.displayName?.trim() || agent.name || '当前角色';
  const speakerContextBlock = formatXingyeSpeakerContextForPrompt({
    userName: currentUserName,
    agentName: currentAgentName,
    gender: profile?.gender,
  });

  const folderListing = formatFilesFolderGuideListing(
    folderOptions,
    '（资料柜里目前还没有文件夹，请在 folderName 里给出一个 2–6 字的中文新分类名）',
  );

  const targetFolderLine = targetFolder
    ? `${targetFolder.name}${targetFolder.description ? `（${targetFolder.description}）` : ''}`
    : '（未指定，请从下面已有文件夹中挑一个最贴切的；都不合适才能新建）';
  // 已知目标夹时，把这个夹的「放什么 / 体例」顶到正文跟前（世界观夹尤其需要归纳口吻而非小说体）。
  const targetFolderGuide = targetFolder ? formatFilesFolderEntryGuide(targetFolder.name) : '';

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
    ...(targetFolderGuide ? ['', targetFolderGuide] : []),
    '',
    '【资料柜里已有文件夹（folderName 必须从中选一个完整复制；无目标文件夹时尤其重要）；每个夹括号下注明专放什么】',
    folderListing,
    '',
    '【资料柜里已有的条目（id · 文件夹 · 标题 — 摘要；最多 30 条）】',
    formatExistingEntriesBlock(existingEntries ?? []),
    '',
    '**重要去重原则**：',
    '- 翻阅上面已有条目；如果当前要整理的内容**和某条已有 entry 是同一主题** —— 不要新建，而是在 body 里追加新的补充段落（让用户后续决定是否合并）。',
    '- 真正全新主题才新建；宁可不写也不要写一条几乎同名的新条目。',
    '- 如果你确认要新建，title 要明显区别于已有同 folder 的所有 title（不要 "师父说过的几句话" vs "师父说的几句话" 这种几乎同名）。',
    `- ${FILES_FOLDER_SCATTER_GUARD}`,
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
    '',
    ...(virtualContacts.length
      ? [
        '【通讯录里的人（整理人际关系类资料时的参考候选；昵称 / 印象均为 TA 视角，勿当作 user 视角）】',
        ...(contactsHaveLoreAlias(virtualContacts) ? [CONTACT_LORE_DEDUPE_INSTRUCTION] : []),
        formatContactLoreListingBlock(virtualContacts),
        '',
      ]
      : []),
    `【当前对 ${currentUserName} 的关系状态摘要（若有；情绪 / 边界参考）】`,
    relationshipBlock.trim() || '（无）',
    '',
    '【最近一次手机首页巡检结果（若有；仅作背景参考）】',
    heartbeatBlock.trim() || '（无）',
  ];

  return parts.join('\n');
}
