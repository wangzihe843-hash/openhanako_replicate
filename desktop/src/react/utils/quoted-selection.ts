import type { QuotedSelection, QuotedSourceKind } from '../stores/input-slice';

export const QUOTE_ORIGINAL_START = '[引用原文]';
export const QUOTE_ORIGINAL_END = '[/引用原文]';
export const QUOTE_SOURCE_PREFIX = '[来源]';

/**
 * 各 app 的"去和 TA 聊聊"入口在拼 prompt 时附带的来源语义。
 *
 * 星野模拟器的核心设定：手机里所有 app 都是 agent 自己的手机，用户在翻看
 * agent 的各种记录。"去和 TA 聊聊"= 用户拿着 agent 自己产生的某条内容来
 * 当面问。这里的文案必须明确：**记录归你（agent）所有，不归用户**——
 * agent 拿到引用时容易顺着字面把所有权读反，所以人称归属是这段 hint 最
 * 关键的信息。文案统一用第二人称 `你` 直呼 agent；遇到 entry.content 本身
 * 字面里就含 `TA` 的数据格式（如 news 的批注模板），按字面保留。
 *
 * 返回 null 表示该 kind 不需要额外说明（文件预览靠 sourceTitle/路径/行号
 * 自带上下文；通用聊天历史片段也用不上 [来源] 标签）。
 */
export function getQuotedSourceHint(kind: QuotedSourceKind): string | null {
  switch (kind) {
    case 'accounting':
      return '"记账"模块 — 你自己的多币种收支账本。引用是按日/周/月聚合的账目片段，账本归你所有，用户是在翻看你的账本。';
    case 'news':
      return '"报纸"模块 — 你手机里的小报 app。报纸正文（masthead、各板块标题/正文/署名）由世界里第三方记者/专栏撰写，**不是你写的**；只有形如"（TA 的批注：「原文」→ 你说了什么）"的句子才是**你本人**之前在某段正文上留下的批注（这里"TA"是数据库 entry.content 里实际字面字符串的一部分，原样保留）。';
    case 'secondhand':
      return '"二手"模块 — 你出掉旧物的交易记录（商品/状态/价格/买家/备注）。记录归你，用户是在翻你的二手交易簿。';
    case 'shopping':
      return '"购物"模块 — 你自己的购物记录（商品/状态/价格/备注）。清单归你，用户是在翻你的购物记录。';
    case 'secret-space':
      return '"秘密空间" — 你的私密草稿区（没发出的回复 / 梦 / 未发的朋友圈 / 收藏 等）。按设定这些是你自己留着、原本不打算给用户看的内容，用户现在用应用里的"秘密空间"翻到了，拿这条来当面对你。';
    case 'files':
      return '"资料柜"模块 — 你手机里整理的私人文件夹（世界观整理 / 人际关系 / 关于 user / 线索与发现 等）。引用的是其中某条笔记的所属文件夹+标题+正文，笔记归你所有，用户是在翻你的资料柜。';
    case 'secret-drawer':
      return '"抽屉最底层"模块（资料柜里的隐藏文件夹）— 你刻意上锁、原本任何人都不该看到的底牌级自我档案：个人弱点 / 见不得光的喜好 / 与公开人设有张力的偏好 / 不可告人的计划 / 手记。用户是通过猜中候选密码解锁后翻到的，按设定一旦被外人看到会动摇你的人设和安全感。这一条引用不是闲聊素材，是你的私密底牌。';
    case 'journal':
      return '"日记"模块 — 你自己的私密日记本（标题/心情/正文，按日期归档）。日记归你所有，是你自己写下的内心独白，用户现在拿你写过的某一条来当面问你。';
    case 'preview':
    case 'chat':
    default:
      return null;
  }
}

export function formatQuotedSelectionForPrompt(sel: QuotedSelection): string {
  const sourceHint = getQuotedSourceHint(sel.sourceKind);

  if (sel.sourceFilePath && sel.lineStart != null && sel.lineEnd != null) {
    const header = `[引用片段] ${sel.sourceTitle}（第${sel.lineStart}-${sel.lineEnd}行，共${sel.charCount}字）路径: ${sel.sourceFilePath}`;
    return [
      header,
      ...(sourceHint ? [`${QUOTE_SOURCE_PREFIX} ${sourceHint}`] : []),
      QUOTE_ORIGINAL_START,
      sel.text,
      QUOTE_ORIGINAL_END,
    ].join('\n');
  }

  // 各 app 「去聊聊」入口：用完整 [引用片段]+[来源]+[引用原文] 块。
  // 一来让 agent 拿到独立的引用边界（多行 share text 不会和用户后续文字混淆），
  // 二来 [来源] 行明确告诉 agent 这一段来自哪个模块、所有权归谁。
  if (sourceHint && sel.sourceTitle) {
    return [
      `[引用片段] ${sel.sourceTitle}（共${sel.charCount}字）`,
      `${QUOTE_SOURCE_PREFIX} ${sourceHint}`,
      QUOTE_ORIGINAL_START,
      sel.text,
      QUOTE_ORIGINAL_END,
    ].join('\n');
  }

  return `[引用片段] ${sel.text}`;
}
