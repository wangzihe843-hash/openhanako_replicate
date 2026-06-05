/**
 * 手机原生模块（accounting / shopping / secondhand / journal）共享的「历史批量生成」状态。
 *
 * 设计要点：
 *  - 落到 `apps/{appId}/history-state.json`，按 agent 隔离；journal 的 entries.jsonl
 *    在 `journal/`（不在 `apps/journal/`），但状态文件复用 `apps/journal/history-state.json`
 *    路径，仅用于记 initializedAt 这种 marker，跟 entries 解耦没问题。
 *  - 三个语义字段：
 *    - initializedAt: 仅在「首次打开 app」自动触发的初始化批量生成成功后写入；
 *      之后即使删光 entries 也不会再触发初始化，避免反复 bootstrap 把记录灌爆。
 *    - lastBulkAt: 任何一次批量生成（init / manual）成功后都会更新；用来判断
 *      和上一次的间隔是否足够长，让 manual 批量自动转成 gap-fill。
 *    - lastCoveredDate: YYYY-MM-DD，最近一次批量覆盖到的最远「今天/昨天」边界，
 *      给下一次 gap-fill 选 dayRange 用（不需要扫 entries.jsonl 计算）。
 *      journal 当前只用 initializedAt，gap-fill 字段保留以备未来扩展。
 *
 * 与短信历史 generation state 的关键区别：
 *  - 短信是 setSmsHistoryGenerationState 落到 localStorage（前端单机），因为短信
 *    是渲染端纯前端模拟；这里的 accounting/shopping/secondhand/journal 数据已经走盘存
 *    （HANA_HOME/agents/{aid}/xingye/...），所以历史状态也跟着
 *    落盘，方便服务端工具链 / 跨机同步看到。
 */

import { postXingyeStorage } from './xingye-storage-api';
import { createAgentXingyeStorageBackend } from './xingye-storage-backend';

const backend = createAgentXingyeStorageBackend(postXingyeStorage);

/**
 * 支持「初始化 / 批量 / 补齐」流程的 appId。
 *
 * journal / trips / mail / reading_notes 只用 initializedAt（+ mail 另用 lastBulkAt 记最近一次批量）
 * 字段做 marker；planBulkRequest / planInitialBulkRequest（14 天窗口）专给 accounting/shopping/secondhand 用，
 * journal 自己有 buildJournalHistoryPrompt / generateJournalHistoryWithAI、trips 有
 * buildTripsHistoryPrompt / generateTripsHistoryWithAI、mail 有 generateMailInitDraftsWithAI、
 * reading_notes 有 buildReadingHistoryPrompt / generateReadingHistoryWithAI（一次铺 3–5 本书 + 批注，
 * 时间不设上限）走各自的批量策略，不调用这俩 planner。
 */
export const HISTORY_APP_IDS = ['accounting', 'shopping', 'secondhand', 'journal', 'trips', 'mail', 'reading_notes'] as const;
export type HistoryAppId = (typeof HISTORY_APP_IDS)[number];

export type XingyeAppHistoryState = {
  /** 首次自动初始化完成时间；未初始化 → undefined。 */
  initializedAt?: string;
  /** 最近一次「批量生成」完成时间（初始化也计入）。 */
  lastBulkAt?: string;
  /** YYYY-MM-DD；最近一次批量覆盖到的最远「最近一天」。 */
  lastCoveredDate?: string;
  /** 累计批量生成次数（含初始化），便于调试和未来限速。 */
  bulkCount?: number;
  version: 1;
};

function statePath(appId: HistoryAppId): string {
  return `apps/${appId}/history-state.json`;
}

function safeIso(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function safeYmd(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : undefined;
}

function normalize(raw: unknown): XingyeAppHistoryState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { version: 1 };
  }
  const r = raw as Record<string, unknown>;
  const out: XingyeAppHistoryState = { version: 1 };
  const initializedAt = safeIso(r.initializedAt);
  if (initializedAt) out.initializedAt = initializedAt;
  const lastBulkAt = safeIso(r.lastBulkAt);
  if (lastBulkAt) out.lastBulkAt = lastBulkAt;
  const lastCoveredDate = safeYmd(r.lastCoveredDate);
  if (lastCoveredDate) out.lastCoveredDate = lastCoveredDate;
  if (typeof r.bulkCount === 'number' && Number.isFinite(r.bulkCount) && r.bulkCount >= 0) {
    out.bulkCount = Math.floor(r.bulkCount);
  }
  return out;
}

export async function loadHistoryState(
  agentId: string,
  appId: HistoryAppId,
): Promise<XingyeAppHistoryState> {
  const aid = String(agentId ?? '').trim();
  if (!aid) return { version: 1 };
  // 不要把后端读取异常吞成 {version:1}：缺文件时 backend.readJson 返回 null
  // （normalize(null) → {version:1}，确为「未初始化」），但传输/服务端错误（含文件
  // 存在却损坏）必须抛出。否则一次瞬时读失败会被各 app 的首启 bootstrap 误判成
  // 「从未初始化」、在真实数据上重灌历史；saveHistoryState 也会因读到假的 {version:1}
  // 而把磁盘上已有的 initializedAt 抹掉，导致下次再次重灌。调用方（bootstrap /
  // runBulkGeneration / saveHistoryState）都在 try/catch 内，抛出 = 安全地「这次不动」。
  const raw = await backend.readJson<unknown>(aid, statePath(appId));
  return normalize(raw);
}

export async function saveHistoryState(
  agentId: string,
  appId: HistoryAppId,
  patch: Partial<Omit<XingyeAppHistoryState, 'version'>>,
): Promise<XingyeAppHistoryState> {
  const aid = String(agentId ?? '').trim();
  if (!aid) throw new Error('saveHistoryState: agentId is required');
  const current = await loadHistoryState(aid, appId);
  const next: XingyeAppHistoryState = { ...current, ...patch, version: 1 };
  await backend.writeJson(aid, statePath(appId), next);
  return next;
}

/** 把 ISO / Date 收敛成 YYYY-MM-DD（本地时区）。供 lastCoveredDate / dayRange 用。 */
export function toYmd(value: string | Date): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  if (!Number.isFinite(d.getTime())) return new Date(0).toISOString().slice(0, 10);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function daysBetweenYmd(fromYmd: string, toYmd: string): number {
  const a = Date.parse(`${fromYmd}T00:00:00`);
  const b = Date.parse(`${toYmd}T00:00:00`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / (24 * 3600 * 1000));
}

/** 简单的批量决策。被三个 Phone*App 共用。 */
export type BulkPlanMode = 'recent' | 'gap_fill';

export type BulkPlan = {
  mode: BulkPlanMode;
  /** 期望生成几条。 */
  count: number;
  /** dayRange 含义：occurredAt 至少落在 [now - endDays, now - startDays] 范围。 */
  startDays: number;
  endDays: number;
  /** 一句给 prompt 用的描述，例如「过去 3 天」或「5/15 到今天的空白」。 */
  hintText: string;
};

const GAP_FILL_THRESHOLD_DAYS = 3;

/**
 * 计算批量新增的请求计划。
 *
 * 决策逻辑：
 *  - 没历史 → 当作 recent，3 天 4 条；
 *  - 距离上次批量 ≤ 3 天 → recent，3 天 4 条；
 *  - 距离上次批量 > 3 天 → gap_fill，覆盖从 lastBulkAt 到今天，
 *    条数按 gap 天数 *0.6 截断到 [4, 8]。
 */
export function planBulkRequest(state: XingyeAppHistoryState): BulkPlan {
  const now = new Date();
  const todayYmd = toYmd(now);
  const lastYmd = state.lastCoveredDate
    || (state.lastBulkAt ? toYmd(state.lastBulkAt) : '');
  if (!lastYmd) {
    return {
      mode: 'recent',
      count: 4,
      startDays: 0,
      endDays: 3,
      hintText: '过去 3 天内（含今天）',
    };
  }
  const gap = daysBetweenYmd(lastYmd, todayYmd);
  if (gap <= GAP_FILL_THRESHOLD_DAYS) {
    return {
      mode: 'recent',
      count: 4,
      startDays: 0,
      endDays: Math.max(3, gap),
      hintText: `过去 ${Math.max(3, gap)} 天内（含今天）`,
    };
  }
  const count = Math.min(8, Math.max(4, Math.round(gap * 0.6)));
  return {
    mode: 'gap_fill',
    count,
    startDays: 0,
    endDays: Math.min(gap, 30),
    hintText: `${lastYmd} 到今天（${todayYmd}）之间的空白，约 ${gap} 天`,
  };
}

/** 初始化批量的固定计划（首次打开 app 用）。6–10 条，过去 14 天。 */
export function planInitialBulkRequest(): BulkPlan {
  return {
    mode: 'recent',
    count: 8,
    startDays: 0,
    endDays: 14,
    hintText: '过去 14 天里 TA 真实可能发生过的日常',
  };
}

export const HISTORY_GAP_FILL_THRESHOLD_DAYS = GAP_FILL_THRESHOLD_DAYS;

/**
 * 把中文数字字符串（"一""二""三十""二十五""两""几"等）解析为整数。
 * 不能解析 → NaN。
 */
function parseChineseNumeral(text: string): number {
  if (!text) return Number.NaN;
  if (/^\d+$/.test(text)) return Number(text);
  const digit: Record<string, number> = {
    零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  };
  if (text.length === 1 && digit[text] !== undefined) return digit[text];
  if (text === '十') return 10;
  // 十X / X十 / X十Y
  const tenOnlyHead = /^十([零一二两三四五六七八九])$/.exec(text);
  if (tenOnlyHead) return 10 + digit[tenOnlyHead[1]];
  const ten = /^([一二两三四五六七八九])十([零一二两三四五六七八九])?$/.exec(text);
  if (ten) {
    const tens = digit[ten[1]] * 10;
    const ones = ten[2] ? digit[ten[2]] : 0;
    return tens + ones;
  }
  if (text === '几' || text === '若干') return 3;
  return Number.NaN;
}

/**
 * 解析中文时间感字符串（"昨天" / "三天前" / "上周二" / "前几天" / "2026-05-12"）→ ISO 字符串。
 * 解析不出来 → undefined。供 accounting/shopping/secondhand 共用。
 */
export function parseChineseTimeHint(hint: string | undefined): string | undefined {
  if (!hint) return undefined;
  const text = hint.trim();
  if (!text) return undefined;

  const direct = Date.parse(text);
  if (Number.isFinite(direct)) return new Date(direct).toISOString();

  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const offset = (days: number): string => {
    const d = new Date(startOfDay);
    d.setDate(d.getDate() - days);
    return d.toISOString();
  };

  if (/今天|今日|今晚|刚才|刚刚|方才/.test(text)) return offset(0);
  if (/大前天/.test(text)) return offset(3);
  if (/前天/.test(text)) return offset(2);
  if (/昨天|昨日|昨晚|昨夜/.test(text)) return offset(1);

  // 「N 天前 / N 日前」—— 阿拉伯或中文数字
  const daysAgo = /^([\d零〇一二两三四五六七八九十]{1,4})\s*[天日]前$/.exec(text);
  if (daysAgo) {
    const n = parseChineseNumeral(daysAgo[1]);
    if (Number.isFinite(n) && n >= 0 && n <= 365) return offset(n);
  }
  // 「N 周前 / N 星期前」
  const weeksAgo = /^([\d零〇一二两三四五六七八九十]{1,3})\s*(?:周|星期)前$/.exec(text);
  if (weeksAgo) {
    const n = parseChineseNumeral(weeksAgo[1]);
    if (Number.isFinite(n) && n >= 0 && n <= 52) return offset(n * 7);
  }
  // 「N 个月前」
  const monthsAgo = /^([\d零〇一二两三四五六七八九十]{1,3})\s*个?\s*月前$/.exec(text);
  if (monthsAgo) {
    const n = parseChineseNumeral(monthsAgo[1]);
    if (Number.isFinite(n) && n >= 0 && n <= 24) {
      const d = new Date(startOfDay);
      d.setMonth(d.getMonth() - n);
      return d.toISOString();
    }
  }

  // 模糊词 → 启发式映射
  if (/前几天|这几天|这几日|近来|最近几天/.test(text)) return offset(3);
  if (/上周末|上个周末/.test(text)) return offset(7);
  if (/上周|上礼拜|上星期/.test(text)) return offset(7);
  if (/上上周|上上礼拜|上上星期/.test(text)) return offset(14);
  if (/这周|本周|这礼拜|本礼拜/.test(text)) return offset(2);
  if (/月初/.test(text)) {
    const d = new Date(startOfDay);
    d.setDate(1);
    return d.toISOString();
  }
  if (/月中/.test(text)) {
    const d = new Date(startOfDay);
    d.setDate(15);
    return d.toISOString();
  }
  if (/月末|月底/.test(text)) return offset(2);
  if (/上个月/.test(text)) return offset(30);

  return undefined;
}

/**
 * 确定性的"过去 N 天散布"兜底。
 *
 * 现实里 LLM 经常忽略 occurredAtHint 字段，或给「三天前」「上周」这类不可解析
 * 中文模糊表达，导致大半条目的 occurredAt 都是 undefined。此函数在 normalize
 * 之后把剩下的 undefined 槽位按 index 均匀分散到过去 [1, endDays] 范围内，
 * 保证行卡的「X 天前」呈现真实的历史感而不是清一色 "00"。
 *
 * 不动模型成功解析出的条目（保留 LLM 的真实时序判断），只填空槽。
 */
export function distributeOccurredAtFallback<T extends { occurredAt?: string }>(
  drafts: T[],
  endDays: number,
): T[] {
  if (!drafts.length) return drafts;
  const span = Math.max(1, Math.floor(endDays));
  const now = new Date();
  const todayMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  // 避开「今天 (0 天前)」——历史批量本意就是回填过去的日期，0 没意义
  return drafts.map((d, i) => {
    if (d.occurredAt) return d;
    // 把 i 在 [0, drafts.length-1] 范围映射到 [1, span]，让最早 (i=0) 最远、最晚 (i=last) 最近
    const total = Math.max(1, drafts.length);
    const offsetDays = Math.max(1, Math.round(span - (i / total) * (span - 1)));
    const past = new Date(todayMs - offsetDays * 24 * 3600 * 1000);
    return { ...d, occurredAt: past.toISOString() };
  });
}
