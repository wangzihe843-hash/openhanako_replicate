/**
 * 角色关系状态（mood / stateSummary / lastReason）的反套路 anchor。
 *
 * 与 moments / files / accounting 的去重定位不同：state 通常是**单条更新**——
 * AI 给出一个 patch、用户接受后 saveRelationshipState 一次。**没有"批量产生 N 条" 的
 * 场景**，所以本模块不做后置 filter（写之前过一遍意义不大），只负责构造前置 anchor，
 * 让 LLM 在生成新一轮 stateSummary / lastReason 时**看到自己最近写过哪几次套话**，
 * 主动换不同切口、避免每次都是「心情不错，最近聊得很多」。
 *
 * 数据源：state.previousStates（xingye-state-store 已经在 updateRelationshipState 里
 * 把每次旧 state 压栈，上限 MAX_PREVIOUS_STATES=8）。这是天然的状态历史，不用再去
 * event-log / heartbeat 里挖。
 *
 * 纯函数、无 React / fs 依赖；构造好的 anchor block 由调用方塞进 state prompt。
 */

import type {
  XingyeRelationshipState,
  XingyeRelationshipStateHistoryItem,
} from './xingye-state-store';

/** 取最近 N 次旧 state 做 anchor。5 次≈过去几天/几周的 mood 走向，够看出套路。 */
export const STATE_ANCHOR_HISTORY_LIMIT = 5;
/** 每行 stateSummary / lastReason 的截断字数——anchor 只给信号，不灌全文。 */
export const STATE_ANCHOR_FIELD_HEAD_CHARS = 60;

function truncate(text: string | undefined, max: number): string {
  if (typeof text !== 'string') return '';
  const t = text.trim();
  if (!t) return '';
  const chars = Array.from(t);
  if (chars.length <= max) return chars.join('');
  return `${chars.slice(0, max).join('')}…`;
}

function ymd(iso: string | undefined): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 把一条历史 state 压成「[日期] mood｜summary｜reason」一行。任一字段空就省略。
 * 全空返回空串（上层会过滤掉）。
 */
function historyLine(item: XingyeRelationshipStateHistoryItem | XingyeRelationshipState): string {
  const date = ymd(item.updatedAt) || '日期未知';
  const mood = truncate(item.mood, 12);
  const summary = truncate(item.stateSummary, STATE_ANCHOR_FIELD_HEAD_CHARS);
  const reason = truncate(item.lastReason, STATE_ANCHOR_FIELD_HEAD_CHARS);
  const parts: string[] = [];
  if (mood) parts.push(`mood=${mood}`);
  if (summary) parts.push(`summary=${summary}`);
  if (reason) parts.push(`reason=${reason}`);
  if (!parts.length) return '';
  return `  · [${date}] ${parts.join(' ｜ ')}`;
}

/**
 * State 反套路 anchor block。
 *
 * 入参可以是：
 *   - 完整的 XingyeRelationshipState（带 previousStates，最常见）；
 *   - 直接的 history 数组（previousStates 自身或测试用例构造的列表）。
 *
 * 输出格式：
 *   - 近期 N 次 state 摘录 + 一行硬要求（请换不同角度描述心绪 / 不要复用相同套话）；
 *   - history 全空 / 都不可用 → 返回空串。上层在 prompt 里会展示成「（无；这是首次刷新）」。
 *
 * 与 news / interview anchor 同形：本地确定性产生，喂给模型做语境，模型自己**不**回写
 * anchor 字段（与备忘录的「LLM 只回定性核心」原则一致）。
 */
export function buildStateContinuityAnchorBlock(
  source:
    | XingyeRelationshipState
    | ReadonlyArray<XingyeRelationshipStateHistoryItem>
    | null
    | undefined,
  options: { limit?: number } = {},
): string {
  const limit = Math.max(1, options.limit ?? STATE_ANCHOR_HISTORY_LIMIT);
  let history: ReadonlyArray<XingyeRelationshipStateHistoryItem | XingyeRelationshipState>;
  if (!source) {
    history = [];
  } else if (Array.isArray(source)) {
    history = source as ReadonlyArray<XingyeRelationshipStateHistoryItem>;
  } else {
    const state = source as XingyeRelationshipState;
    history = state.previousStates ?? [];
  }
  if (!history.length) return '';

  const sorted = [...history]
    .filter((item) => !!item && typeof item === 'object')
    .sort((a, b) => {
      const ta = Date.parse(a.updatedAt || '');
      const tb = Date.parse(b.updatedAt || '');
      if (!Number.isFinite(ta) && !Number.isFinite(tb)) return 0;
      if (!Number.isFinite(ta)) return 1;
      if (!Number.isFinite(tb)) return -1;
      return tb - ta;
    })
    .slice(0, limit);

  const lines: string[] = [];
  lines.push('- 近期几次状态摘录（请换不同角度描述心绪，不要复用相同套话 / 同义改写）：');
  for (const item of sorted) {
    const line = historyLine(item);
    if (line) lines.push(line);
  }
  if (lines.length <= 1) return '';
  lines.push('  注意：mood / stateSummary / reason 都要避开历史中已经写过的同义版本；可以保留语义但换比喻 / 切口 / 落点。');
  return lines.join('\n');
}
