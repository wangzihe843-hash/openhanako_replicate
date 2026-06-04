import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import {
  FILES_FOLDER_SCATTER_GUARD,
  formatFilesFolderEntryGuide,
  formatFilesFolderGuideListing,
} from './xingye-files-folder-taxonomy';
import { formatXingyeSpeakerContextForPrompt } from './xingye-speaker-context';

/**
 * 文件管理「初始化 / 批量新增」的两阶段 prompt。
 *
 * 两阶段都遵守 AI 负载最小化：
 *  - Phase-1「规划」只看精简目录（lore 的 id/标题/分类/关键词，**无 content**）+ 文件夹名 +
 *    已有条目摘要（无 body），输出「每条 = 哪个文件夹 / 标题角度 / 选中 loreId（批量再加 chatRefs）」。
 *  - Phase-2「逐条生成」只喂被选中的 lore 全文 + 被引用的聊天片段（+ update 的单个目标 entry）。
 *
 * 单条草稿 prompt 仍在 `xingye-files-prompts.ts`，本文件不动它。
 */

/** Phase-1 规划目录里的一条（精简，不含 content）。 */
export type FilesLoreCatalogItem = {
  id: string;
  title: string;
  categoryLabel: string;
  keywords: string[];
};

/** Phase-2 逐条生成时喂进的「被选中 lore」全文。 */
export type FilesSelectedLoreItem = {
  title: string;
  categoryLabel: string;
  content: string;
};

export type FilesPlanFolderHint = { name: string; description?: string };
export type FilesPlanExistingEntry = { folderName: string; title: string; summary?: string };

/** 同时给 init / batch 规划 prompt 共用的资料柜语气约束（第一人称、反元叙述、TA 自己整理）。 */
const FILES_VOICE_CONSTRAINTS: readonly string[] = [
  '生成目标：这是当前角色自己手机里的「资料柜」条目，由 TA 自己整理出来供以后翻阅。',
  '不是日记，不是日程，不是购物清单，不是邮件草稿，不是阅读笔记，不是 user 想知道的资料。',
  '不要写成系统简报、AI 总结、外部知识查询；不要出现「根据聊天记录」「用户让我」「系统提示」「模型」「AI」「设定库」「lore」等元叙述。',
  '不要输出 user 视角或第三人称视角；只能是 agent 自己第一人称整理 / 备忘 / 记笔记的口吻。',
  '不连接任何真实文件系统、网盘、网页、电商、邮件；不要写「上传 / 下载 / 打开链接」。',
];

export function formatLoreCatalogBlock(items: FilesLoreCatalogItem[]): string {
  if (!items.length) return '（TA 的设定库暂无可整理条目）';
  return items
    .map((item) => {
      const kw = item.keywords.length ? `｜关键词：${item.keywords.slice(0, 8).join('、')}` : '';
      return `- [${item.id}] 《${item.title}》（${item.categoryLabel}）${kw}`;
    })
    .join('\n');
}

// 文件夹清单改用共享的「带分工指南」渲染——规划阶段决定 folderName 时尤其需要每个夹的边界，
// 才能避免把同一主题散进不同夹（见 xingye-files-folder-taxonomy.ts）。
function formatFolderListing(folders: FilesPlanFolderHint[]): string {
  return formatFilesFolderGuideListing(folders);
}

function formatExistingEntriesBlock(entries: FilesPlanExistingEntry[]): string {
  if (!entries.length) return '（资料柜里暂无已归档条目）';
  return entries
    .slice(0, 40)
    .map((e) => {
      const tail = e.summary ? ` — ${e.summary.slice(0, 50)}` : '';
      return `- ${e.folderName} · 《${e.title}》${tail}`;
    })
    .join('\n');
}

export function formatSelectedLoreBlock(items: FilesSelectedLoreItem[]): string {
  if (!items.length) return '（无）';
  return items
    .map((item) => `- 《${item.title}》（${item.categoryLabel}）\n${item.content.trim()}`)
    .join('\n\n');
}

function speakerBlockFor(
  agent: Pick<Agent, 'name'>,
  profile: XingyeRoleProfile | null | undefined,
  userName: string | undefined,
): { currentUserName: string; currentAgentName: string; block: string } {
  const currentUserName = userName?.trim() || '用户';
  const currentAgentName = profile?.displayName?.trim() || agent.name || '当前角色';
  const block = formatXingyeSpeakerContextForPrompt({
    userName: currentUserName,
    agentName: currentAgentName,
    gender: profile?.gender,
  });
  return { currentUserName, currentAgentName, block };
}

// ─────────────────────────────────────────────────────────────────────────
//  Phase 1 — 规划（一次 LLM 调用，输出清单）
// ─────────────────────────────────────────────────────────────────────────

/**
 * 初始化规划：让模型「看一眼」TA 的设定库目录，决定从哪些设定派生几条资料、各放哪个文件夹。
 * 只看目录（无 content），输出 `{ items: [{ folderName, title, focus, loreIds }] }`。
 */
export function buildFilesInitPlanPrompt(args: {
  agent: Pick<Agent, 'id' | 'name' | 'yuan'>;
  userName?: string;
  profile: XingyeRoleProfile | null | undefined;
  loreCatalogBlock: string;
  folderOptions: FilesPlanFolderHint[];
  existingEntries: FilesPlanExistingEntry[];
  maxItems: number;
  relationshipBlock: string;
  /** 通讯录候选段（含身份对齐去重提示），由 formatContactLoreSection 生成；空时为「（无）」。 */
  contactsBlock?: string;
}): string {
  const { agent, userName, profile, loreCatalogBlock, folderOptions, existingEntries, maxItems, relationshipBlock } =
    args;
  const { currentUserName, currentAgentName, block: speakerContextBlock } = speakerBlockFor(agent, profile, userName);
  const contactsBlock = (args.contactsBlock ?? '').trim();
  const showContacts = contactsBlock && contactsBlock !== '（无）';

  return [
    '你是星野模式「小手机文件管理 · 初始化规划器」。只返回严格 JSON，不要 Markdown，不要解释。',
    '',
    '任务：翻一遍下面 TA 自己的设定目录（只有标题/分类/关键词），决定 TA 该把哪些设定整理成资料柜条目、各放哪个文件夹。',
    '这一步**只做规划**，不写正文——每条只给出「放哪个文件夹 + 标题角度 + 引用了目录里哪几条设定」。',
    '',
    ...FILES_VOICE_CONSTRAINTS,
    '',
    '输出 JSON schema（仅此结构，字段名必须一致）：',
    JSON.stringify(
      { items: [{ folderName: 'string', title: 'string', focus: 'string', loreIds: ['string'] }] },
      null,
      2,
    ),
    '',
    '规则：',
    `- items 总数 ≤ ${maxItems}；别为了凑数硬编，没料就少给几条。`,
    '- folderName 必须从下方「文件夹」列表里**完整复制**一个名字，禁止改写或新建。',
    '- 按下方每个夹标注的「放 / 不放」把每条设定放进**最贴切**的那个夹：个人往事/童年/具体情节别塞进「世界观整理」（那里只收世界设定与规律），世界规则别塞进「人际关系」。',
    '- 把内容相近的设定归到同一个文件夹；一个文件夹可以有多条，也可以没有。',
    `- ${FILES_FOLDER_SCATTER_GUARD}`,
    ...(showContacts
      ? ['- 「人际关系 / 关于 user」类文件夹的条目，优先围绕下方「通讯录」里的真人来规划；若某联系人已标注与设定库《…》是同一个人，只排一条，别让通讯录与设定库各排一份雷同条目。']
      : []),
    '- loreIds 必须从目录里 [方括号] 内的 id **原样复制**，每条 1–4 个，挑真正相关的；不要编造 id。',
    '- title 一行短句（2–24 字），是这条资料的角度；focus 一句话说明这条想整理什么（给下一步写正文用）。',
    '- 翻一眼「已有条目」：已经整理过的主题就别再排，挑还没写过的设定。',
    '',
    speakerContextBlock,
    `- 视角：把 TA 写成「我」，把 ${currentUserName} 写成「${currentUserName}」。`,
    '',
    '【当前角色（基础身份）】',
    JSON.stringify({ id: agent.id, name: currentAgentName, yuan: agent.yuan, profile: profile ?? null }, null, 2),
    '',
    '【文件夹（folderName 必须从中完整复制；每个夹下注明专放什么 / 不放什么 / 体例）】',
    formatFolderListing(folderOptions),
    '',
    '【TA 的设定库目录（只有标题/分类/关键词；loreIds 从 [id] 复制）】',
    loreCatalogBlock,
    '',
    '【资料柜里已有的条目（避免重复排同一主题）】',
    formatExistingEntriesBlock(existingEntries),
    '',
    `【当前对 ${currentUserName} 的关系状态摘要（若有；情绪 / 边界参考）】`,
    relationshipBlock.trim() || '（无）',
    ...(showContacts
      ? ['', '【TA 的通讯录（规划人际类条目时参考这些真人；昵称/印象为 TA 视角，勿当作 user 视角）】', contactsBlock]
      : []),
  ].join('\n');
}

/**
 * 批量新增规划：让模型看最近聊天 + 设定目录，决定补几条新资料、各放哪个文件夹，
 * 每条引用哪几段聊天 / 哪几条设定，是新增还是更新已有条目。
 * 输出 `{ items: [{ folderName, title, focus, loreIds, chatRefs, action, targetTitle }] }`。
 */
export function buildFilesBatchPlanPrompt(args: {
  agent: Pick<Agent, 'id' | 'name' | 'yuan'>;
  userName?: string;
  profile: XingyeRoleProfile | null | undefined;
  loreCatalogBlock: string;
  folderOptions: FilesPlanFolderHint[];
  existingEntries: FilesPlanExistingEntry[];
  recentChatBlock: string;
  recentChatCount: number;
  maxItems: number;
  relationshipBlock: string;
  /** 通讯录候选段（含身份对齐去重提示），由 formatContactLoreSection 生成；空时为「（无）」。 */
  contactsBlock?: string;
}): string {
  const {
    agent,
    userName,
    profile,
    loreCatalogBlock,
    folderOptions,
    existingEntries,
    recentChatBlock,
    recentChatCount,
    maxItems,
    relationshipBlock,
  } = args;
  const { currentUserName, currentAgentName, block: speakerContextBlock } = speakerBlockFor(agent, profile, userName);
  const contactsBlock = (args.contactsBlock ?? '').trim();
  const showContacts = contactsBlock && contactsBlock !== '（无）';

  return [
    '你是星野模式「小手机文件管理 · 批量整理规划器」。只返回严格 JSON，不要 Markdown，不要解释。',
    '',
    '任务：看一眼下面 TA 最近的聊天（已编号），决定 TA 该补整理哪几条资料柜条目、各放哪个文件夹。',
    '这一步**只做规划**，不写正文——每条只给出「放哪个文件夹 + 标题角度 + 引用哪几段聊天 / 哪几条设定 + 新增还是更新」。',
    '',
    ...FILES_VOICE_CONSTRAINTS,
    '',
    '输出 JSON schema（仅此结构，字段名必须一致）：',
    JSON.stringify(
      {
        items: [
          {
            folderName: 'string',
            title: 'string',
            focus: 'string',
            loreIds: ['string'],
            chatRefs: [0],
            action: 'add | update',
            targetTitle: 'string（仅 action=update 时给，复制已有条目标题）',
          },
        ],
      },
      null,
      2,
    ),
    '',
    '规则：',
    `- items 总数 ≤ ${maxItems}；只整理聊天里真正出现的新信息，没料就少给几条、甚至给空 items。`,
    '- folderName 必须从下方「文件夹」列表里**完整复制**一个名字，禁止改写或新建。',
    '- 按下方每个夹标注的「放 / 不放」把每条放进**最贴切**的那个夹：个人往事/具体情节别塞进「世界观整理」，世界规则别塞进「人际关系」，尚未定论的零碎线索进「线索与发现」、真假存疑的进「待确认」。',
    `- ${FILES_FOLDER_SCATTER_GUARD}`,
    `- chatRefs 是聊天编号数组（见下方 [#n]），取值范围 0..${Math.max(0, recentChatCount - 1)}，每条挑 1–6 段真正相关的。`,
    '- loreIds 可选，从目录 [id] 原样复制相关设定（让这条资料更贴角色）；没有相关设定就给空数组。',
    '- 每条至少要有 chatRefs 或 loreIds 之一，否则不要排这一条。',
    '- action：聊天补充的是**已有某条**资料的新进展 → "update" 并在 targetTitle 里复制那条已有标题；全新主题 → "add"。',
    '- title 一行短句（2–24 字）；focus 一句话说明这条想整理 / 补充什么。',
    ...(showContacts
      ? ['- 聊天里聊到的人若能对上下方「通讯录」里的联系人，就当作同一个人来整理；某联系人已标注与设定库《…》是同一个人时，只排一条，别让通讯录与设定库各排一份雷同条目。']
      : []),
    '',
    speakerContextBlock,
    `- 视角：把 TA 写成「我」，把 ${currentUserName} 写成「${currentUserName}」。`,
    '',
    '【当前角色（基础身份）】',
    JSON.stringify({ id: agent.id, name: currentAgentName, yuan: agent.yuan, profile: profile ?? null }, null, 2),
    '',
    '【文件夹（folderName 必须从中完整复制；每个夹下注明专放什么 / 不放什么 / 体例）】',
    formatFolderListing(folderOptions),
    '',
    '【最近 OpenHanako 聊天（已编号；chatRefs 引用 [#n]）】',
    recentChatBlock.trim() || '（无）',
    '',
    '【TA 的设定库目录（可选引用；loreIds 从 [id] 复制）】',
    loreCatalogBlock,
    '',
    '【资料柜里已有的条目（update 的 targetTitle 从这里复制）】',
    formatExistingEntriesBlock(existingEntries),
    '',
    `【当前对 ${currentUserName} 的关系状态摘要（若有；情绪 / 边界参考）】`,
    relationshipBlock.trim() || '（无）',
    ...(showContacts
      ? ['', '【TA 的通讯录（规划人际类条目时参考这些真人；昵称/印象为 TA 视角，勿当作 user 视角）】', contactsBlock]
      : []),
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────
//  Phase 2 — 逐条生成（每条一次 LLM 调用，只喂选中的上下文）
// ─────────────────────────────────────────────────────────────────────────

function entryAddSchemaLines(): string[] {
  return [
    '输出 JSON schema（仅此结构，字段名必须一致）：',
    JSON.stringify({ title: 'string', body: 'string', summary: 'string', tags: ['string'] }, null, 2),
    '',
    '字段要求：',
    '- title 一行短句，2–24 字，不要书名号堆叠；要明显区别于「同文件夹已有条目」里的所有标题。',
    '- body 80–400 个汉字，分段用换行；像 TA 自己手写的备忘，不要写成新闻稿。',
    '- summary 可空字符串；若非空，30 字以内一句话概述。',
    '- tags 0–5 个 2–6 字的中文标签；与正文相关，不要复述文件夹名。',
  ];
}

export function buildFilesInitEntryPrompt(args: {
  agent: Pick<Agent, 'id' | 'name' | 'yuan'>;
  userName?: string;
  profile: XingyeRoleProfile | null | undefined;
  folderName: string;
  focus: string;
  selectedLoreBlock: string;
  sameFolderExistingTitles: string[];
  /** 通讯录候选段（仅人际类文件夹注入；含身份对齐去重提示）。空 / 「（无）」时不渲染。 */
  contactsBlock?: string;
}): string {
  const { agent, userName, profile, folderName, focus, selectedLoreBlock, sameFolderExistingTitles } = args;
  const { currentUserName, currentAgentName, block: speakerContextBlock } = speakerBlockFor(agent, profile, userName);
  const contactsBlock = (args.contactsBlock ?? '').trim();
  const showContacts = contactsBlock && contactsBlock !== '（无）';
  const folderEntryGuide = formatFilesFolderEntryGuide(folderName);

  return [
    '你是星野模式「小手机文件管理」资料草稿生成器。只返回严格 JSON，不要 Markdown，不要解释。',
    '',
    ...FILES_VOICE_CONSTRAINTS,
    '只根据下方「相关设定」整理这一条；不要引入设定里没有的重大剧情或不存在的人物。',
    ...(showContacts
      ? ['如果这条写的是人际关系，写到的人请对照下方「通讯录联系人」用对昵称与印象；同一个人别和设定库分开写成两份。']
      : []),
    '',
    ...entryAddSchemaLines(),
    '',
    speakerContextBlock,
    `- 视角：把 TA 写成「我」，把 ${currentUserName} 写成「${currentUserName}」；不要写成「TA / 她 / 他」。`,
    '',
    '【当前角色（基础身份）】',
    JSON.stringify({ id: agent.id, name: currentAgentName, yuan: agent.yuan, profile: profile ?? null }, null, 2),
    '',
    `【目标文件夹】${folderName}`,
    ...(folderEntryGuide ? ['', folderEntryGuide] : []),
    '',
    `【这条要整理什么（角度）】${focus.trim() || '（自行把握）'}`,
    '',
    '【相关设定（仅据此整理）】',
    selectedLoreBlock.trim() || '（无）',
    ...(showContacts
      ? ['', '【可参考的通讯录联系人（仅当这条在写人际关系时用；昵称/印象为 TA 视角）】', contactsBlock]
      : []),
    '',
    '【同文件夹已有条目标题（避免写出几乎同名的新条目）】',
    sameFolderExistingTitles.length ? sameFolderExistingTitles.map((t) => `- 《${t}》`).join('\n') : '（无）',
  ].join('\n');
}

export function buildFilesBatchAddEntryPrompt(args: {
  agent: Pick<Agent, 'id' | 'name' | 'yuan'>;
  userName?: string;
  profile: XingyeRoleProfile | null | undefined;
  folderName: string;
  focus: string;
  selectedLoreBlock: string;
  selectedChatBlock: string;
  sameFolderExistingTitles: string[];
  /** 通讯录候选段（仅人际类文件夹注入；含身份对齐去重提示）。空 / 「（无）」时不渲染。 */
  contactsBlock?: string;
}): string {
  const { agent, userName, profile, folderName, focus, selectedLoreBlock, selectedChatBlock, sameFolderExistingTitles } =
    args;
  const { currentUserName, currentAgentName, block: speakerContextBlock } = speakerBlockFor(agent, profile, userName);
  const contactsBlock = (args.contactsBlock ?? '').trim();
  const showContacts = contactsBlock && contactsBlock !== '（无）';
  const folderEntryGuide = formatFilesFolderEntryGuide(folderName);

  return [
    '你是星野模式「小手机文件管理」资料草稿生成器。只返回严格 JSON，不要 Markdown，不要解释。',
    '',
    ...FILES_VOICE_CONSTRAINTS,
    '只根据下方「相关聊天」与「相关设定」整理这一条；不要引入它们之外的重大剧情或不存在的人物。',
    ...(showContacts
      ? ['如果这条写的是人际关系，写到的人请对照下方「通讯录联系人」用对昵称与印象；同一个人别和设定库分开写成两份。']
      : []),
    '',
    ...entryAddSchemaLines(),
    '',
    speakerContextBlock,
    `- 视角：把 TA 写成「我」，把 ${currentUserName} 写成「${currentUserName}」；不要写成「TA / 她 / 他」。`,
    '',
    '【当前角色（基础身份）】',
    JSON.stringify({ id: agent.id, name: currentAgentName, yuan: agent.yuan, profile: profile ?? null }, null, 2),
    '',
    `【目标文件夹】${folderName}`,
    ...(folderEntryGuide ? ['', folderEntryGuide] : []),
    '',
    `【这条要整理什么（角度）】${focus.trim() || '（自行把握）'}`,
    '',
    '【相关聊天片段（线索来源；勿在输出里交代信息来源）】',
    selectedChatBlock.trim() || '（无）',
    '',
    '【相关设定（角色边界与世界观参考）】',
    selectedLoreBlock.trim() || '（无）',
    ...(showContacts
      ? ['', '【可参考的通讯录联系人（仅当这条在写人际关系时用；昵称/印象为 TA 视角）】', contactsBlock]
      : []),
    '',
    '【同文件夹已有条目标题（避免写出几乎同名的新条目）】',
    sameFolderExistingTitles.length ? sameFolderExistingTitles.map((t) => `- 《${t}》`).join('\n') : '（无）',
  ].join('\n');
}

export function buildFilesBatchUpdateEntryPrompt(args: {
  agent: Pick<Agent, 'id' | 'name' | 'yuan'>;
  userName?: string;
  profile: XingyeRoleProfile | null | undefined;
  focus: string;
  selectedLoreBlock: string;
  selectedChatBlock: string;
  target: { title: string; summary?: string; body: string };
}): string {
  const { agent, userName, profile, focus, selectedLoreBlock, selectedChatBlock, target } = args;
  const { currentUserName, currentAgentName, block: speakerContextBlock } = speakerBlockFor(agent, profile, userName);

  const targetBlock = [
    '【要补充的老条目】',
    `标题：《${target.title}》`,
    ...(target.summary ? [`摘要：${target.summary}`] : []),
    '现有正文：',
    target.body.trim() || '（空白）',
  ];

  return [
    '你是星野模式「小手机文件管理」资料**补充**生成器。只返回严格 JSON，不要 Markdown，不要解释。',
    '',
    ...FILES_VOICE_CONSTRAINTS,
    '下面是 TA 已经整理过的一条资料；最近聊天里有了新进展。只产出**追加到末尾的一小段**补充，不要重写整篇、不要复述已有正文。',
    '',
    '输出 JSON schema（仅此结构，字段名必须一致）：',
    JSON.stringify({ bodyAppend: 'string', summary: 'string', tags: ['string'] }, null, 2),
    '',
    '字段要求：',
    '- bodyAppend 必填，40–200 个汉字，只写**新增**的那段（会被追加到老正文末尾），别复述老正文。',
    '- summary 可空；若给，是整条（含新进展）的 30 字以内新概述。',
    '- tags 可空；若给，是整条最终的 0–5 个标签（会整体替换老标签）。',
    '',
    speakerContextBlock,
    `- 视角：把 TA 写成「我」，把 ${currentUserName} 写成「${currentUserName}」；不要写成「TA / 她 / 他」。`,
    '',
    '【当前角色（基础身份）】',
    JSON.stringify({ id: agent.id, name: currentAgentName, yuan: agent.yuan, profile: profile ?? null }, null, 2),
    '',
    `【这次要补充什么（角度）】${focus.trim() || '（自行把握）'}`,
    '',
    ...targetBlock,
    '',
    '【相关聊天片段（新进展来源；勿在输出里交代信息来源）】',
    selectedChatBlock.trim() || '（无）',
    '',
    '【相关设定（角色边界与世界观参考）】',
    selectedLoreBlock.trim() || '（无）',
  ].join('\n');
}
