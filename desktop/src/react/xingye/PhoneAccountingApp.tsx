import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Agent } from '../types';
import { useStore } from '../stores';
import styles from './XingyeShell.module.css';
import {
  appendAppEntry,
  deleteAppEntry,
} from './xingye-app-entry-store';
import {
  appendAccountingDraft,
  confirmAccountingDraft,
  discardAccountingDraft,
  listAccountingDrafts,
  type AccountingDirection,
  type XingyePendingAccountingDraft,
} from './xingye-accounting-drafts';
import {
  loadLedger,
  summarizeLedger,
  type Ledger,
  type LedgerCurrencyTotals,
  type LedgerEntry,
  type LedgerFxConfig,
  type LedgerSummary,
  type LedgerUnifiedTotals,
} from './xingye-accounting-ledger';
import {
  FX_ANCHOR_CURRENCY,
  FX_CURRENCY_GROUPS,
  DEFAULT_FX_RATES,
  loadFxConfig,
  resolveFxState,
  saveFxConfig,
  type EffectiveFxState,
  type XingyeFxConfig,
} from './xingye-accounting-fx-rates';
import type { XingyeRoleProfile } from './xingye-profile-store';
import { generateAccountingDraftsWithAI } from './xingye-accounting-ai';
import { parseAmountText } from './xingye-money';
import {
  distributeOccurredAtFallback,
  loadHistoryState,
  saveHistoryState,
  planBulkRequest,
  planInitialBulkRequest,
  toYmd,
  type BulkPlan,
} from './xingye-app-history-state';
import {
  filterMonthlyDuplicates,
  filterSameDayDuplicates,
  filterSameDayCommuteSlotDuplicates,
  filterSameDayMealSlotDuplicates,
  hasMultipleJobsByProfile,
} from './xingye-accounting-dedupe';

export interface PhoneAccountingAppProps {
  ownerAgent: Agent | null;
  ownerProfile?: XingyeRoleProfile | null;
  displayName: string;
  onBack: () => void;
  /**
   * 跨模块跳转：点开来自购物/二手投影的账目行时，由父级（AgentPhonePanel）
   * 切到对应模块并预选这条 entryId。账本只是只读视图，编辑入口在源模块。
   */
  onNavigateToShopping?: (entryId: string) => void;
  onNavigateToSecondhand?: (entryId: string) => void;
}

const ACCOUNTING_APP_ID = 'accounting';

const DIRECTION_LABELS: Record<AccountingDirection, string> = {
  income: '收入',
  expense: '支出',
};

const SOURCE_LABELS: Record<LedgerEntry['source'], string> = {
  accounting: '记账',
  shopping: '购物',
  secondhand: '二手',
};

type FilterValue = 'all' | AccountingDirection;
const FILTERS: Array<{ value: FilterValue; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'income', label: '收入' },
  { value: 'expense', label: '支出' },
];

type GroupBy = 'day' | 'week' | 'month';
const GROUP_BYS: Array<{ value: GroupBy; label: string }> = [
  { value: 'day', label: '日' },
  { value: 'week', label: '周' },
  { value: 'month', label: '月' },
];

/** 档位对应的中文短语（用于按钮文案 / sourceTitle 前缀）。 */
const GROUP_BY_NOUN: Record<GroupBy, string> = { day: '天', week: '周', month: '月' };

/** 单字符西方货币符号 → 前缀写法：`¥3500` / `$2800` / `€780`。 */
const WESTERN_PREFIX_CURRENCY = /^[¥$€£￥₩₽₹]$/;

/**
 * 带 CJK 字符的货币单位 → 后缀紧贴写法：`5两银子` / `12金币` / `100信用点`。
 * 覆盖范围：基本汉字 U+4E00–9FFF（含简繁），够日常货币词用；
 * 假名 / 谚文不在范围里——日韩货币目前用的是符号（円/₩）或 ASCII（JPY/KRW），
 * 走另两条分支即可。
 */
const HAS_CJK = /[一-鿿]/;

/**
 * 把金额和货币单位拼成一个字符串。
 *
 * 三种排版规则（按中英文读法习惯各自匹配）：
 *  - 单字符西方符号（¥$€£￥₩₽₹）→ **前缀**，无空格：`¥3500` / `$2800`；
 *  - 带 CJK 字符（两银子 / 金币 / 灵石 / 信用点 / 瓶盖 …）→ **后缀紧贴**，无空格：
 *    `5两银子` / `12金币` / `100信用点`——中文里数字和量词中间不留空格，
 *    `3.5 两银子` 这种"英文风留空格"读起来割裂，所以紧贴；
 *  - 其它（拉丁字母 / 多字符符号：USD / EUR / Eddies / R$ …）→ **后缀留空格**：
 *    `12 USD` / `50 Eddies` / `100 R$`——西文记法保留空格更合习惯。
 *
 * 小数尾零归一：123.0 → "123"、123.50 → "123.5"。
 */
function formatAmountWithCurrency(amount: number | null, currency: string | null): string {
  if (amount === null) return '—';
  const num = Number.isInteger(amount)
    ? String(amount)
    : amount.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  if (!currency) return num;
  if (WESTERN_PREFIX_CURRENCY.test(currency)) return `${currency}${num}`;
  if (HAS_CJK.test(currency)) return `${num}${currency}`;
  return `${num} ${currency}`;
}

function daysAgo(iso: string): number {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.floor(ms / (24 * 3600 * 1000)));
}

function formatDayStub(d: number): string {
  if (d >= 100) return String(d);
  return String(d).padStart(2, '0');
}

/* ─────────────────────────────────────────────────────────────────────────────
   日 / 周 / 月 分组与分享文本拼接

   都是 UI 临时计算（与新闻 `buildNewsShareText` 同理），不抽到 ledger.ts —
   那是存储/读取层，与展示无关。
   - 周：ISO 周（周一-周日）；月：自然月（YYYY-MM）。
   - 同组的 entries 已经按 occurredAt 倒序（loadLedger 输出已排好），分桶时
     保留输入顺序即可。
─────────────────────────────────────────────────────────────────────────── */

const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** ISO 周：以包含周四的那一周为该年的某个 ISO 周。 */
function isoWeekParts(date: Date): { year: number; week: number; monday: Date } {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((+d - +yearStart) / 86400000 + 1) / 7);
  // 把任意一天回退到该周的周一（本地时区，用于显示标签）。
  const local = new Date(date);
  const localDay = local.getDay() || 7;
  if (localDay !== 1) local.setDate(local.getDate() - (localDay - 1));
  local.setHours(0, 0, 0, 0);
  return { year: d.getUTCFullYear(), week, monday: local };
}

function bucketKeyOfDate(date: Date, groupBy: GroupBy): string {
  if (groupBy === 'day') {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }
  if (groupBy === 'week') {
    const { year, week } = isoWeekParts(date);
    return `${year}-W${pad2(week)}`;
  }
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

function bucketLabelOfDate(date: Date, groupBy: GroupBy): string {
  if (groupBy === 'day') {
    return `${date.getMonth() + 1} 月 ${date.getDate()} 日 周${WEEKDAY_LABELS[date.getDay()]}`;
  }
  if (groupBy === 'week') {
    const { monday } = isoWeekParts(date);
    const sunday = new Date(monday);
    sunday.setDate(sunday.getDate() + 6);
    return `${monday.getMonth() + 1}/${monday.getDate()}（周一）- ${sunday.getMonth() + 1}/${sunday.getDate()}（周日）`;
  }
  return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月`;
}

type LedgerGroup = {
  key: string;
  label: string;
  entries: LedgerEntry[];
};

function groupLedgerEntries(entries: LedgerEntry[], groupBy: GroupBy): LedgerGroup[] {
  const groups = new Map<string, LedgerGroup>();
  for (const e of entries) {
    const d = new Date(e.occurredAt);
    if (Number.isNaN(d.getTime())) continue;
    const key = bucketKeyOfDate(d, groupBy);
    let g = groups.get(key);
    if (!g) {
      g = { key, label: bucketLabelOfDate(d, groupBy), entries: [] };
      groups.set(key, g);
    }
    g.entries.push(e);
  }
  return [...groups.values()];
}

/** 周档用：同币种内按类目聚合（保持收入/支出独立）。 */
type CategoryAgg = {
  currency: string;
  direction: AccountingDirection;
  category: string;
  count: number;
  sum: number;
  sampleTitles: string[];
};

function aggregateByCategory(entries: LedgerEntry[]): CategoryAgg[] {
  const map = new Map<string, CategoryAgg>();
  for (const e of entries) {
    if (!e.realized || e.amount === null) continue;
    const currency = e.currency ?? '';
    const category = e.category ?? '未分类';
    const k = `${currency}::${e.direction}::${category}`;
    let agg = map.get(k);
    if (!agg) {
      agg = { currency, direction: e.direction, category, count: 0, sum: 0, sampleTitles: [] };
      map.set(k, agg);
    }
    agg.count += 1;
    agg.sum += e.amount;
    if (agg.sampleTitles.length < 3) agg.sampleTitles.push(e.title);
  }
  const list = [...map.values()];
  list.sort((a, b) => b.sum - a.sum);
  return list;
}

function formatSignedNet(net: number, currency: string | null): string {
  const sign = net > 0 ? '+' : net < 0 ? '-' : '';
  const text = formatAmountWithCurrency(Math.abs(net), currency);
  if (text === '—') return '—';
  return `${sign}${text}`;
}

/** 「日 / 周 / 月」三档分别拼分享文本。 */
function buildLedgerShareText(group: LedgerGroup, groupBy: GroupBy, ta: string): string {
  const lines: string[] = [];
  const allRealized = group.entries.filter((e) => e.realized && e.amount !== null);
  const unrealizedCount = group.entries.length - allRealized.length;
  const summary = summarizeLedger(group.entries);

  if (groupBy === 'day') {
    lines.push(`${group.label} · ${ta} 的账本（${group.entries.length} 笔）`);
    const incomes = allRealized.filter((e) => e.direction === 'income');
    const expenses = allRealized.filter((e) => e.direction === 'expense');
    if (incomes.length) {
      lines.push('');
      lines.push('— 收入');
      for (const e of incomes) {
        const amt = formatAmountWithCurrency(e.amount, e.currency);
        const parts = [amt, e.title];
        if (e.category) parts.push(e.category);
        if (e.counterparty) parts.push(e.counterparty);
        lines.push(`  ${parts.join(' · ')}`);
      }
    }
    if (expenses.length) {
      lines.push('');
      lines.push('— 支出');
      for (const e of expenses) {
        const amt = formatAmountWithCurrency(e.amount, e.currency);
        const parts = [amt, e.title];
        if (e.category) parts.push(e.category);
        if (e.counterparty) parts.push(e.counterparty);
        lines.push(`  ${parts.join(' · ')}`);
      }
    }
    if (summary.byCurrency.length) {
      lines.push('');
      lines.push('合计：');
      for (const b of summary.byCurrency) {
        const cur = b.currency || '未标注币种';
        lines.push(
          `  ${cur}：收 ${formatAmountWithCurrency(b.income, b.currency || null)} / 支 ${formatAmountWithCurrency(b.expense, b.currency || null)} / 净 ${formatSignedNet(b.net, b.currency || null)}`,
        );
      }
    }
    if (unrealizedCount > 0) {
      lines.push('');
      lines.push(`另有 ${unrealizedCount} 笔未实现（计划中，不计入合计）`);
    }
    return lines.join('\n').trim();
  }

  if (groupBy === 'week') {
    lines.push(`${group.label} · ${ta} 的账本（${group.entries.length} 笔）`);
    if (summary.byCurrency.length === 0) {
      lines.push('');
      lines.push('（本周没有已实现的现金流）');
    }
    for (const b of summary.byCurrency) {
      const cur = b.currency || '未标注币种';
      lines.push('');
      lines.push(`【${cur}】`);
      const aggs = aggregateByCategory(group.entries).filter((a) => (a.currency || '') === (b.currency || ''));
      const incomeAggs = aggs.filter((a) => a.direction === 'income');
      const expenseAggs = aggs.filter((a) => a.direction === 'expense');
      if (incomeAggs.length) {
        lines.push(`收入 ${formatAmountWithCurrency(b.income, b.currency || null)}`);
        for (const a of incomeAggs) {
          const sample = a.sampleTitles.slice(0, 2).join(' / ');
          lines.push(
            `  · ${a.category} ${formatAmountWithCurrency(a.sum, a.currency || null)}（${a.count} 笔${sample ? ' · ' + sample : ''}）`,
          );
        }
      }
      if (expenseAggs.length) {
        lines.push(`支出 ${formatAmountWithCurrency(b.expense, b.currency || null)}`);
        for (const a of expenseAggs) {
          const sample = a.sampleTitles.slice(0, 2).join(' / ');
          lines.push(
            `  · ${a.category} ${formatAmountWithCurrency(a.sum, a.currency || null)}（${a.count} 笔${sample ? ' · ' + sample : ''}）`,
          );
        }
      }
      lines.push(`净 ${formatSignedNet(b.net, b.currency || null)}`);
    }
    if (unrealizedCount > 0) {
      lines.push('');
      lines.push(`另有 ${unrealizedCount} 笔未实现（计划中，不计入合计）`);
    }
    return lines.join('\n').trim();
  }

  // month
  lines.push(`${group.label} · ${ta} 的账本`);
  if (summary.byCurrency.length === 0) {
    lines.push('');
    lines.push('（本月没有已实现的现金流）');
  }
  for (const b of summary.byCurrency) {
    const cur = b.currency || '未标注币种';
    lines.push('');
    lines.push(
      `【${cur}】收 ${formatAmountWithCurrency(b.income, b.currency || null)} / 支 ${formatAmountWithCurrency(b.expense, b.currency || null)} / 净 ${formatSignedNet(b.net, b.currency || null)}（${b.realizedCount} 笔）`,
    );
    const aggs = aggregateByCategory(group.entries).filter((a) => (a.currency || '') === (b.currency || ''));
    const topExpense = aggs.filter((a) => a.direction === 'expense').slice(0, 3);
    const topIncome = aggs.filter((a) => a.direction === 'income').slice(0, 3);
    if (topExpense.length) {
      lines.push(
        `  · Top 支出：${topExpense.map((a) => `${a.category} ${formatAmountWithCurrency(a.sum, a.currency || null)}`).join('、')}`,
      );
    }
    if (topIncome.length) {
      lines.push(
        `  · Top 收入：${topIncome.map((a) => `${a.category} ${formatAmountWithCurrency(a.sum, a.currency || null)}`).join('、')}`,
      );
    }
  }
  if (unrealizedCount > 0) {
    lines.push('');
    lines.push(`另有 ${unrealizedCount} 笔未实现（计划中，不计入）`);
  }
  return lines.join('\n').trim();
}

type ComposeDraft = {
  title: string;
  direction: AccountingDirection;
  amountText: string;
  currency: string;
  category: string;
  counterparty: string;
  occurredAtText: string;
  reason: string;
  content: string;
};

function emptyCompose(): ComposeDraft {
  return {
    title: '',
    direction: 'expense',
    amountText: '',
    currency: '',
    category: '',
    counterparty: '',
    occurredAtText: '',
    reason: '',
    content: '',
  };
}

type DraftEdit = {
  title: string;
  direction: AccountingDirection;
  amountText: string;
  currency: string;
  category: string;
  counterparty: string;
  content: string;
};

// 两类去重（filterMonthlyDuplicates / filterSameDayDuplicates）已抽到
// xingye-accounting-dedupe.ts，纯函数好单测。

export function PhoneAccountingApp({
  ownerAgent,
  ownerProfile,
  displayName,
  onBack,
  onNavigateToShopping,
  onNavigateToSecondhand,
}: PhoneAccountingAppProps) {
  const ownerAgentId = ownerAgent?.id ?? '';
  const [ledger, setLedger] = useState<Ledger>({ entries: [], summary: { byCurrency: [], missingAmountCount: 0 } });
  const [pendingDrafts, setPendingDrafts] = useState<XingyePendingAccountingDraft[]>([]);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterValue>('all');
  const [groupBy, setGroupBy] = useState<GroupBy>('day');
  /**
   * 「去和 TA 聊聊」入口的轻量确认提示。Key = group.key（日 / 周 / 月 桶 id）。
   * 4s 自动复位。走 stagedChatQuote 槽：见 memory `feedback_share_to_chat_no_navigation`。
   */
  const [sharedToChatKey, setSharedToChatKey] = useState<string | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [compose, setCompose] = useState<ComposeDraft>(() => emptyCompose());
  /** 点开账本行的详情视图。只有 source='accounting' 的原生条目会进这里；
   *  shopping / secondhand 的行点击走 onNavigateTo* 跳转到源模块。 */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [userIntent, setUserIntent] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [draftEdits, setDraftEdits] = useState<Record<string, DraftEdit>>({});
  const [draftBusyId, setDraftBusyId] = useState<string | null>(null);
  const [draftBusyKind, setDraftBusyKind] = useState<'plain' | 'discard' | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);

  /**
   * 「批量历史生成」状态：
   *  - bulkBusy + bulkBusyKind 控制按钮 spinner / disabled；
   *  - bulkNotice 展示成功消息，bulkError 展示失败消息（轻量提示，不打断 UI）；
   *  - initialBootstrapTriedRef 让首次打开 app 时的"如果空且未初始化就自动初始化"
   *    只在 ownerAgentId 切换后跑一次，不会在 reload 触发的多次 effect 里重复触发。
   */
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkBusyKind, setBulkBusyKind] = useState<'initial' | 'manual' | null>(null);
  const [bulkNotice, setBulkNotice] = useState<string | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const initialBootstrapTriedRef = useRef<string | null>(null);

  /**
   * 「汇率折算」配置——把不同币种的收入/支出合并到一种主显示货币。
   *  - fxConfig：持久化的原始用户表（可能为空 = 全用默认）；
   *  - fxState：每次根据 fxConfig + 账本最常用币种 + lore 推断出来的有效配置，
   *    传给 summarizeLedger / 各档位卡用。
   *  - fxEditorOpen：「汇率设置」面板展开/折叠。
   */
  const [fxConfig, setFxConfig] = useState<XingyeFxConfig>({
    version: 1,
    displayCurrency: '',
    rates: {},
  });
  const [fxEditorOpen, setFxEditorOpen] = useState(false);
  const [fxSaving, setFxSaving] = useState(false);
  /**
   * 防跨角色脏写：切角色时 ownerAgentId 变化会触发新一轮 reload，但上一个角色还在飞的
   * 读取可能后落地、用旧数据覆盖新角色。每次 reload 自增请求序号，落 setState 前校验仍是
   * 最新一轮（与 PhoneSecondhandApp / PhoneMailApp 同语义）。
   */
  const reloadSeqRef = useRef(0);

  const reload = useCallback(async () => {
    const seq = ++reloadSeqRef.current;
    if (!ownerAgentId) {
      setLedger({ entries: [], summary: { byCurrency: [], missingAmountCount: 0 } });
      setPendingDrafts([]);
      setDraftEdits({});
      setFxConfig({ version: 1, displayCurrency: '', rates: {} });
      return;
    }
    setLoading(true);
    setListError(null);
    try {
      const [lg, drafts, fx] = await Promise.all([
        loadLedger(ownerAgentId),
        listAccountingDrafts(ownerAgentId),
        loadFxConfig(ownerAgentId),
      ]);
      if (seq !== reloadSeqRef.current) return; // 被更晚一轮 reload 取代，丢弃本次结果
      setLedger(lg);
      setPendingDrafts(drafts);
      setFxConfig(fx);
    } catch (err) {
      if (seq !== reloadSeqRef.current) return;
      setListError(err instanceof Error ? err.message : String(err));
    } finally {
      if (seq === reloadSeqRef.current) setLoading(false);
    }
  }, [ownerAgentId]);

  useEffect(() => {
    setComposeOpen(false);
    setSelectedId(null);
    setSaveError(null);
    setListError(null);
    setBulkNotice(null);
    setBulkError(null);
    initialBootstrapTriedRef.current = null;
  }, [ownerAgentId]);

  useEffect(() => {
    void reload();
    // cleanup：作废本轮 reload，让切角色后旧角色的在飞读取无法再 setState（与上面的请求号双保险）。
    return () => {
      reloadSeqRef.current += 1;
    };
  }, [reload]);

  /**
   * 历史批量生成的核心实现。两个调用方：
   *  - 「初始化批量生成」(kind='initial')：写入 entries.jsonl，标记 initializedAt + lastBulkAt；
   *  - 「批量新增」(kind='manual')：写入 drafts.jsonl 走待确认流程，标记 lastBulkAt + lastCoveredDate。
   *
   * 任何一种成功后都更新 history-state.json，让下次能正确判断 init 是否需要触发 / gap-fill 范围。
   */
  const runBulkGeneration = useCallback(
    async (kind: 'initial' | 'manual') => {
      if (!ownerAgent || !ownerAgentId) return;
      const plan: BulkPlan = kind === 'initial'
        ? planInitialBulkRequest()
        // 手动「批量新增」是非破坏性的（只产草稿待确认）：状态读失败时退化成「无历史」
        // 计划即可，不必中断；破坏性的首启初始化路径不走这里。
        : planBulkRequest(await loadHistoryState(ownerAgentId, 'accounting').catch(() => ({ version: 1 as const })));
      setBulkBusy(true);
      setBulkBusyKind(kind);
      setBulkError(null);
      setBulkNotice(null);
      try {
        const rawDrafts = await generateAccountingDraftsWithAI({
          agent: ownerAgent,
          ownerProfile: ownerProfile ?? null,
          desiredCount: plan.count,
          historyMode: {
            kind: kind === 'initial' ? 'initial' : plan.mode === 'gap_fill' ? 'gap_fill' : 'recent',
            dayRangeHint: plan.hintText,
            startDays: plan.startDays,
            endDays: plan.endDays,
          },
        });
        // LLM 经常忽略 occurredAtHint 字段或给不可解析的模糊表达，导致大半条目
        // 没拿到日期，落库后行卡清一色「00 天前」。这里按 index 散布到 [1, endDays]，
        // 只填模型没给的空槽，保留模型成功解析的真实判断。
        const distributed = distributeOccurredAtFallback(rawDrafts, plan.endDays);
        // 四层硬去重，落库前的最后兜底（prompt 已经提示过模型，但偶尔会忽视）：
        //  1) 月度类目（房租 / 水电 / 通讯 / 保险 / 工资）一个月最多 1 条；
        //  2) 同一天同质条目（同 title 或 同 (category+counterparty+amount)），
        //     挡住 AI 反复批量时各自生成"一天两顿同样的午饭"；
        //  3) 同一天同餐次 slot（早 / 午 / 晚 三餐每天最多一笔），
        //     挡住 title 不同但本质同餐的情况——"巷口面摊午饭" + "卤肉饭午饭"
        //     在 (1)(2) 都过得了，但餐次都是 lunch，要丢一个。
        //     咖啡 / 下午茶 / 宵夜不在 slot 内，各自自由。
        //  4) 同一天通勤 slot（去班 / 下班 各 1 次），
        //     挡住"打车去上班 ¥35 + 骑共享单车去上班 ¥3 + 地铁去上班 ¥6"这种
        //     同一天三种交通方式都"去上班"的 AI 副本。
        //     例外：profile 里出现"兼职 / 倒班 / 跑单 / 外卖员"等关键词时
        //     跳过去重——这些 agent 一天确实会通勤多次。
        const skipCommute = hasMultipleJobsByProfile(ownerProfile);
        const afterMonthly = filterMonthlyDuplicates(distributed, ledger.entries);
        const afterSameDay = filterSameDayDuplicates(afterMonthly, ledger.entries);
        const afterMealSlot = filterSameDayMealSlotDuplicates(afterSameDay, ledger.entries);
        const drafts = filterSameDayCommuteSlotDuplicates(
          afterMealSlot,
          ledger.entries,
          { skipDedupe: skipCommute },
        );
        const droppedDupCount = distributed.length - drafts.length;
        if (drafts.length === 0) {
          throw new Error(
            droppedDupCount > 0
              ? `${droppedDupCount} 条草稿都是已有条目的重复（月度账单撞月、同质条目、同餐次重复，或一天多次通勤），已全部丢弃；可隔一会再试或换一种意图。`
              : '模型未生成任何可用条目',
          );
        }
        if (kind === 'initial') {
          // 初始化：直接落 entries.jsonl，避免用户面对一堆待确认卡片。
          for (const d of drafts) {
            const metadata: Record<string, unknown> = {
              direction: d.direction,
              amount: d.amount,
              title: d.title,
            };
            if (d.currency) metadata.currency = d.currency;
            if (d.category) metadata.category = d.category;
            if (d.counterparty) metadata.counterparty = d.counterparty;
            if (d.occurredAt) metadata.occurredAt = d.occurredAt;
            if (d.reason) metadata.reason = d.reason;
            await appendAppEntry(ownerAgentId, ACCOUNTING_APP_ID, {
              title: d.title,
              content: d.content,
              metadata,
              source: 'xingye-accounting-init-history',
              // 让 entry.createdAt 回到 occurredAt 那一天，行卡「X 天前」才不会全是 00。
              createdAt: d.occurredAt,
            });
          }
        } else {
          // 批量新增：照旧落草稿，让用户检查后再 confirm。
          for (const d of drafts) {
            await appendAccountingDraft(ownerAgentId, {
              title: d.title,
              direction: d.direction,
              amount: d.amount,
              currency: d.currency,
              category: d.category,
              counterparty: d.counterparty,
              occurredAt: d.occurredAt,
              reason: d.reason,
              content: d.content,
              source: 'xingye-accounting-bulk',
            });
          }
        }
        const now = new Date();
        await saveHistoryState(ownerAgentId, 'accounting', {
          ...(kind === 'initial' ? { initializedAt: now.toISOString() } : {}),
          lastBulkAt: now.toISOString(),
          lastCoveredDate: toYmd(now),
        });
        const dropSuffix = droppedDupCount > 0
          ? `（另丢弃 ${droppedDupCount} 条与已有月度账单撞月的草稿）`
          : '';
        setBulkNotice(
          kind === 'initial'
            ? `已为 TA 生成 ${drafts.length} 条过去 ${plan.endDays} 天的账目历史${dropSuffix}`
            : `已生成 ${drafts.length} 条草稿，请在待确认区检查（${plan.hintText}）${dropSuffix}`,
        );
        await reload();
      } catch (err) {
        setBulkError(err instanceof Error ? err.message : String(err));
      } finally {
        setBulkBusy(false);
        setBulkBusyKind(null);
      }
    },
    [ownerAgent, ownerAgentId, ownerProfile, reload, ledger.entries],
  );

  /**
   * 首次打开 app 时的自动初始化：
   *  - entries 为空 + history-state 没 initializedAt → 跑初始化；
   *  - 任何一条不满足 → 跳过（不会"删光后又自动重灌"）。
   */
  useEffect(() => {
    if (!ownerAgent || !ownerAgentId) return;
    if (loading) return;
    // 本轮 reload 失败时 ledger.entries 为空是「读失败」而非「真的空」，绝不能拿来当
    // 初始化依据——否则一次瞬时读空会在真实账本上重灌历史。
    if (listError) return;
    if (initialBootstrapTriedRef.current === ownerAgentId) return;
    if (ledger.entries.length > 0 || pendingDrafts.length > 0) {
      initialBootstrapTriedRef.current = ownerAgentId;
      return;
    }
    initialBootstrapTriedRef.current = ownerAgentId;
    (async () => {
      try {
        const state = await loadHistoryState(ownerAgentId, 'accounting');
        if (state.initializedAt) return;
        // 二次确认（对齐 journal / trips / reading_notes）：首挂载时 ledger.entries=0
        // 不能当真，直接落盘再问一次。读失败会抛出（loadLedger / listAccountingDrafts
        // 不吞错）→ 被外层 catch 接住、不初始化，杜绝瞬时读空触发重灌；也覆盖老用户
        // （加这功能前已有账目但没 initializedAt marker）：有内容只补 marker、不真生成。
        const [freshLedger, freshDrafts] = await Promise.all([
          loadLedger(ownerAgentId),
          listAccountingDrafts(ownerAgentId),
        ]);
        if (freshLedger.entries.length > 0 || freshDrafts.length > 0) {
          await saveHistoryState(ownerAgentId, 'accounting', {
            initializedAt: new Date().toISOString(),
          });
          return;
        }
        await runBulkGeneration('initial');
      } catch (err) {
        console.warn('[PhoneAccountingApp] init bootstrap failed:', err);
      }
    })();
  }, [ownerAgent, ownerAgentId, loading, listError, ledger.entries.length, pendingDrafts.length, runBulkGeneration]);

  /**
   * 账本行筛选：只展示「已实现的真实现金流」——
   *  - 购物：仅 status ∈ {ordered, received} 的行（"想买/犹豫/已退/收藏"是计划不是账，去购物模块看）；
   *  - 二手：仅 status='sold' 的行（"想卖/挂出/在谈/留下/撤下"都没成交）；
   *  - 记账原生：恒已实现。
   * 这样列表数量、X 笔计数、总收入/总支出三者完全一致，不会让用户以为「想买的¥1280」也被算了。
   * loadLedger 仍返回全部行（含未实现），过滤只在 UI 层做，源模块自己的视图不受影响。
   */
  const visibleEntries = useMemo(() => {
    const realized = ledger.entries.filter((e) => e.realized);
    if (filter === 'all') return realized;
    return realized.filter((e) => e.direction === filter);
  }, [ledger.entries, filter]);

  /** 当前选中详情的账本行（仅 source='accounting' 才会进详情视图）。 */
  const selectedEntry = useMemo(
    () => (selectedId ? ledger.entries.find((e) => e.id === selectedId && e.source === 'accounting') ?? null : null),
    [ledger.entries, selectedId],
  );

  /** 把 income/expense 过滤后的 entries 按当前档位分组（日 / 周 / 月）。 */
  const groupedEntries = useMemo<LedgerGroup[]>(
    () => groupLedgerEntries(visibleEntries, groupBy),
    [visibleEntries, groupBy],
  );

  /**
   * 解析有效汇率状态：用户保存的 displayCurrency 优先，否则用账本里出现最多的
   * 币种，再否则从 profile 文本里嗅探世界观，最后兜底 ¥。fxConfig 为空时这套
   * 兜底链能给到合理默认，所以首次打开就能直接展示主货币汇总。
   */
  const fxState: EffectiveFxState = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const e of ledger.entries) {
      if (!e.realized || e.amount === null) continue;
      const ccy = e.currency ?? '';
      if (!ccy) continue;
      counts[ccy] = (counts[ccy] ?? 0) + 1;
    }
    return resolveFxState({
      config: fxConfig,
      ledgerCurrencyCounts: counts,
      profile: ownerProfile ?? null,
    });
  }, [ledger.entries, fxConfig, ownerProfile]);

  /** 传给 summarizeLedger 的折算参数。memo 让 group 卡的 summary 也能稳定。 */
  const ledgerFxConfig: LedgerFxConfig = useMemo(
    () => ({
      displayCurrency: fxState.displayCurrency,
      rates: fxState.effectiveRates,
    }),
    [fxState],
  );

  /** 重算总账汇总（带折算）。loadLedger 返回的 summary 没用折算，这里替换。 */
  const ledgerSummary: LedgerSummary = useMemo(
    () => summarizeLedger(ledger.entries, ledgerFxConfig),
    [ledger.entries, ledgerFxConfig],
  );

  useEffect(() => {
    if (!sharedToChatKey) return undefined;
    const timer = setTimeout(() => setSharedToChatKey(null), 4000);
    return () => clearTimeout(timer);
  }, [sharedToChatKey]);

  const handleShareLedgerGroupToChat = useCallback(
    (group: LedgerGroup) => {
      const taName = displayName || ownerAgent?.name || 'TA';
      const text = buildLedgerShareText(group, groupBy, taName);
      if (!text) return;
      useStore.getState().stageChatQuote({
        text,
        sourceTitle: `记账 · ${group.label}`,
        sourceKind: 'accounting',
        charCount: text.length,
        updatedAt: Date.now(),
      });
      setSharedToChatKey(`${groupBy}::${group.key}`);
    },
    [groupBy, displayName, ownerAgent],
  );

  const draftWorkingValue = useCallback(
    (d: XingyePendingAccountingDraft): DraftEdit => {
      const edit = draftEdits[d.id];
      if (edit) return edit;
      return {
        title: d.title,
        direction: d.direction,
        amountText: String(d.amount),
        currency: d.currency ?? '',
        category: d.category ?? '',
        counterparty: d.counterparty ?? '',
        content: d.content ?? '',
      };
    },
    [draftEdits],
  );

  const handleDraftFieldChange = (draftId: string, patch: Partial<DraftEdit>) => {
    setDraftEdits((prev) => {
      const d = pendingDrafts.find((entry) => entry.id === draftId);
      if (!d) return prev;
      const base = prev[draftId] ?? {
        title: d.title,
        direction: d.direction,
        amountText: String(d.amount),
        currency: d.currency ?? '',
        category: d.category ?? '',
        counterparty: d.counterparty ?? '',
        content: d.content ?? '',
      };
      return { ...prev, [draftId]: { ...base, ...patch } };
    });
  };

  const handleConfirmDraft = async (d: XingyePendingAccountingDraft) => {
    if (!ownerAgentId) return;
    setDraftBusyId(d.id);
    setDraftBusyKind('plain');
    setDraftError(null);
    try {
      const working = draftWorkingValue(d);
      const parsedAmount = parseAmountText(working.amountText);
      if (parsedAmount === undefined) {
        throw new Error('请填写有效的非负金额。');
      }
      await confirmAccountingDraft(ownerAgentId, d.id, {
        title: working.title.trim() || d.title,
        direction: working.direction,
        amount: parsedAmount,
        currency: working.currency.trim() ? working.currency : null,
        category: working.category.trim() ? working.category : null,
        counterparty: working.counterparty.trim() ? working.counterparty : null,
        content: working.content.trim() ? working.content : null,
      });
      setPendingDrafts((prev) => prev.filter((p) => p.id !== d.id));
      setDraftEdits((prev) => {
        if (!(d.id in prev)) return prev;
        const { [d.id]: _omitted, ...rest } = prev;
        return rest;
      });
      await reload();
    } catch (err) {
      setDraftError(err instanceof Error ? err.message : String(err));
    } finally {
      setDraftBusyId(null);
      setDraftBusyKind(null);
    }
  };

  const handleDiscardDraft = async (d: XingyePendingAccountingDraft) => {
    if (!ownerAgentId) return;
    if (!window.confirm('确定丢弃这条待确认记账草稿？此操作不可恢复，但角色可重新提议。')) {
      return;
    }
    setDraftBusyId(d.id);
    setDraftBusyKind('discard');
    setDraftError(null);
    try {
      const ok = await discardAccountingDraft(ownerAgentId, d.id);
      if (ok) {
        setPendingDrafts((prev) => prev.filter((p) => p.id !== d.id));
        setDraftEdits((prev) => {
          if (!(d.id in prev)) return prev;
          const { [d.id]: _omitted, ...rest } = prev;
          return rest;
        });
      } else {
        await reload();
      }
    } catch (err) {
      setDraftError(err instanceof Error ? err.message : String(err));
    } finally {
      setDraftBusyId(null);
      setDraftBusyKind(null);
    }
  };

  const handleGenerateWithAI = async () => {
    if (!ownerAgent || !ownerAgentId) return;
    setAiBusy(true);
    setAiError(null);
    try {
      const results = await generateAccountingDraftsWithAI({
        agent: ownerAgent,
        ownerProfile: ownerProfile ?? null,
        userIntent: userIntent.trim(),
        desiredCount: 3,
      });
      for (const r of results) {
        await appendAccountingDraft(ownerAgentId, {
          title: r.title,
          direction: r.direction,
          amount: r.amount,
          currency: r.currency,
          category: r.category,
          counterparty: r.counterparty,
          occurredAt: r.occurredAt,
          reason: r.reason,
          content: r.content,
          source: 'xingye-accounting-ai',
        });
      }
      setUserIntent('');
      await reload();
    } catch (err) {
      setAiError(err instanceof Error ? err.message : String(err));
    } finally {
      setAiBusy(false);
    }
  };

  const openCompose = () => {
    setCompose(emptyCompose());
    setSaveError(null);
    setComposeOpen(true);
  };

  const closeCompose = () => {
    setComposeOpen(false);
    setSaveError(null);
  };

  const updateCompose = (patch: Partial<ComposeDraft>) => {
    setCompose((prev) => ({ ...prev, ...patch }));
  };

  /**
   * 手动新增：复用 propose-draft 流程——写一条草稿，让用户在「待确认」区
   * 检查后再 confirm 进 entries。这样无论是 AI 还是手填都走同一条统一路径，
   * 也方便用户在按下保存后还能改。
   */
  const saveManualDraft = async () => {
    if (!ownerAgentId) return;
    const title = compose.title.trim();
    if (!title) {
      setSaveError('请填写摘要。');
      return;
    }
    const parsedAmount = parseAmountText(compose.amountText);
    if (parsedAmount === undefined) {
      setSaveError('请填写有效的非负金额。');
      return;
    }
    setSaveBusy(true);
    setSaveError(null);
    try {
      await appendAccountingDraft(ownerAgentId, {
        title,
        direction: compose.direction,
        amount: parsedAmount,
        currency: compose.currency.trim() ? compose.currency : undefined,
        category: compose.category.trim() ? compose.category : undefined,
        counterparty: compose.counterparty.trim() ? compose.counterparty : undefined,
        occurredAt: compose.occurredAtText.trim()
          ? (() => {
              const p = Date.parse(compose.occurredAtText);
              return Number.isFinite(p) ? new Date(p).toISOString() : undefined;
            })()
          : undefined,
        reason: compose.reason.trim() ? compose.reason : undefined,
        content: compose.content.trim() ? compose.content : undefined,
        source: 'xingye-accounting-manual',
      });
      setComposeOpen(false);
      setCompose(emptyCompose());
      await reload();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaveBusy(false);
    }
  };

  /**
   * 点开一行：
   *  - accounting 原生 → 在账本内展开 LedgerDetailView；
   *  - shopping → 调 onNavigateToShopping，由父级切到购物模块并预选这条；
   *  - secondhand → 同理走 onNavigateToSecondhand。
   * 没接跳转回调时（父级没传），退化为仅展开 accounting 原生行，
   * 购物/二手行点击不响应（避免假死链接）。
   */
  const handleRowClick = useCallback(
    (entry: LedgerEntry) => {
      if (entry.source === 'accounting') {
        setSelectedId(entry.id);
        return;
      }
      if (entry.source === 'shopping' && onNavigateToShopping) {
        onNavigateToShopping(entry.id);
        return;
      }
      if (entry.source === 'secondhand' && onNavigateToSecondhand) {
        onNavigateToSecondhand(entry.id);
      }
    },
    [onNavigateToShopping, onNavigateToSecondhand],
  );

  /**
   * 列表里删除一条已生成的账目。只能删 source='accounting' 的原生条目；
   * 购物/二手投影来的行在自家模块里删（这是「每笔交易只有一个家」的不变量，
   * 见 xingye-accounting-ledger.ts 顶部注释）。
   */
  const handleDeleteEntry = async (entry: LedgerEntry) => {
    if (!ownerAgentId) return;
    if (entry.source !== 'accounting') {
      window.alert(`这条记录来自${SOURCE_LABELS[entry.source]}模块，请在${SOURCE_LABELS[entry.source]}里删除。`);
      return;
    }
    if (!window.confirm('确定删除这条记账记录？此操作不可恢复。')) return;
    try {
      const ok = await deleteAppEntry(ownerAgentId, ACCOUNTING_APP_ID, entry.id);
      if (ok) {
        if (selectedId === entry.id) setSelectedId(null);
        await reload();
      }
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
    }
  };

  if (!ownerAgentId) {
    return (
      <div className={`${styles.phoneShell} ${styles.xyPalette}`} aria-label="记账">
        <div className={styles.phoneStatusBar}>
          <button type="button" className={styles.phoneBackButton} onClick={onBack}>
            返回首页
          </button>
          <span>记账</span>
        </div>
        <div className={styles.phoneBody}>
          <section className={styles.phoneAppCard}>
            <h3 className={styles.phoneAppTitle}>记账不可用</h3>
            <p className={styles.phoneAppHint}>请选择有效角色后再打开记账。</p>
          </section>
        </div>
      </div>
    );
  }

  const ta = displayName || ownerAgent?.name || 'TA';

  return (
    <div className={`${styles.phoneShell} ${styles.xyPalette}`} aria-label="记账">
      <div className={styles.phoneStatusBar}>
        <button
          type="button"
          className={styles.phoneBackButton}
          onClick={
            composeOpen
              ? closeCompose
              : selectedEntry
                ? () => setSelectedId(null)
                : onBack
          }
        >
          {composeOpen ? '取消' : selectedEntry ? '返回账本' : '返回首页'}
        </button>
        <span>记账</span>
      </div>

      <div className={styles.xyBody}>
        {listError ? (
          <p className={styles.phoneAppHint} role="alert" style={{ padding: '8px 18px' }}>
            加载失败：{listError}
          </p>
        ) : null}
        {loading && ledger.entries.length === 0 && !composeOpen ? (
          <p className={styles.phoneAppHint} style={{ padding: '8px 18px' }}>加载中…</p>
        ) : null}

        {composeOpen ? (
          <ComposeEditor
            compose={compose}
            updateCompose={updateCompose}
            onSave={saveManualDraft}
            saveBusy={saveBusy}
            saveError={saveError}
          />
        ) : selectedEntry ? (
          <LedgerDetailView
            entry={selectedEntry}
            ta={ta}
            onDelete={() => void handleDeleteEntry(selectedEntry)}
          />
        ) : (
          <div className={styles.xyScroll}>
            <header className={styles.xyShopHero}>
              <p className={styles.xyShopKicker}>LEDGER NOTES</p>
              <h2 className={styles.xyShopTitle}>{ta} 的账本</h2>
              <p className={styles.xyShopSub}>
                工资、房租、餐饮、人情……购物 / 二手之外的现金流。多币种自动折算到主货币显示，
                速率可在「汇率设置」里调。
              </p>
            </header>

            {/* 统一汇总卡：主货币顶行 + 原币种小字副行 */}
            {ledgerSummary.byCurrency.length > 0 ? (
              <section className={styles.xyDraftSection} aria-label="账本汇总">
                <p className={styles.xyDraftHeader}>
                  账本汇总
                  {ledgerSummary.missingAmountCount > 0
                    ? ` · ${ledgerSummary.missingAmountCount} 笔待补金额`
                    : ''}
                </p>
                <UnifiedTotalsCard
                  unified={ledgerSummary.unified}
                  byCurrency={ledgerSummary.byCurrency}
                  onOpenFxEditor={() => setFxEditorOpen((v) => !v)}
                  fxEditorOpen={fxEditorOpen}
                />
                {fxEditorOpen ? (
                  <FxRateEditor
                    fxConfig={fxConfig}
                    fxState={fxState}
                    ledgerCurrencies={ledgerSummary.byCurrency.map((b) => b.currency)}
                    busy={fxSaving}
                    onSave={async (patch) => {
                      if (!ownerAgentId) return;
                      setFxSaving(true);
                      try {
                        const next = await saveFxConfig(ownerAgentId, patch);
                        setFxConfig(next);
                      } catch (err) {
                        console.warn('[PhoneAccountingApp] saveFxConfig failed:', err);
                      } finally {
                        setFxSaving(false);
                      }
                    }}
                  />
                ) : null}
              </section>
            ) : null}

            {/* AI 生成入口 */}
            <section className={styles.xyDraftSection} aria-label="让 TA 自己记账">
              <p className={styles.xyDraftHeader}>让 {ta} 自己记一笔</p>
              <label className={styles.xyEditorField} style={{ padding: 0 }}>
                <span>记账意图（可选）</span>
                <textarea
                  rows={2}
                  value={userIntent}
                  placeholder="可选：想让 TA 记什么方向的账，比如『这周的开销』『这个月的收入』"
                  onChange={(e) => setUserIntent(e.target.value)}
                  data-testid="phone-accounting-intent-input"
                />
              </label>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className={styles.xyBtnGhost}
                  onClick={() => void handleGenerateWithAI()}
                  disabled={aiBusy || bulkBusy || !ownerAgent}
                  data-testid="phone-accounting-ai-button"
                  style={{ flex: '0 0 auto', alignSelf: 'flex-start' }}
                >
                  {aiBusy ? '生成中…' : '让 TA 记 1–3 笔账'}
                </button>
                <button
                  type="button"
                  className={styles.xyBtnGhost}
                  onClick={() => void runBulkGeneration('manual')}
                  disabled={aiBusy || bulkBusy || !ownerAgent}
                  data-testid="phone-accounting-bulk-button"
                  style={{ flex: '0 0 auto', alignSelf: 'flex-start' }}
                  title="批量生成最近几天的账目，自动补齐上次到今天的空白"
                >
                  {bulkBusy && bulkBusyKind === 'manual' ? '批量生成中…' : '批量新增'}
                </button>
              </div>
              {aiError ? (
                <p className={styles.xyEditorError} role="alert">{aiError}</p>
              ) : null}
              {bulkBusy && bulkBusyKind === 'initial' ? (
                <p className={styles.phoneAppHint}>正在为 TA 初始化过去 14 天的账目历史…</p>
              ) : null}
              {bulkNotice ? (
                <p className={styles.phoneAppHint}>{bulkNotice}</p>
              ) : null}
              {bulkError ? (
                <p className={styles.xyEditorError} role="alert">批量生成失败：{bulkError}</p>
              ) : null}
            </section>

            {/* 待确认草稿 */}
            {pendingDrafts.length > 0 ? (
              <section
                className={styles.xyDraftSection}
                aria-label="待确认记账草稿"
                data-testid="phone-accounting-pending-drafts"
              >
                <p className={styles.xyDraftHeader}>待确认草稿 · 来自 AI 或手动新增</p>
                {draftError ? (
                  <p className={styles.xyDraftError} role="alert">{draftError}</p>
                ) : null}
                {pendingDrafts.map((d) => {
                  const working = draftWorkingValue(d);
                  const busy = draftBusyId === d.id;
                  return (
                    <div
                      key={d.id}
                      className={styles.xyDraftCard}
                      data-testid={`phone-accounting-draft-${d.id}`}
                    >
                      <input
                        type="text"
                        className={styles.xyDraftInput}
                        value={working.title}
                        onChange={(e) => handleDraftFieldChange(d.id, { title: e.target.value })}
                        placeholder="摘要"
                        aria-label="待确认记账草稿摘要"
                        data-testid={`phone-accounting-draft-title-${d.id}`}
                        disabled={busy}
                      />
                      <div className={styles.xyDraftRow}>
                        <select
                          className={styles.xyDraftSelect}
                          value={working.direction}
                          onChange={(e) =>
                            handleDraftFieldChange(d.id, { direction: e.target.value as AccountingDirection })
                          }
                          disabled={busy}
                          aria-label="待确认记账草稿方向"
                          data-testid={`phone-accounting-draft-direction-${d.id}`}
                        >
                          <option value="income">收入</option>
                          <option value="expense">支出</option>
                        </select>
                        <input
                          type="text"
                          inputMode="decimal"
                          className={styles.xyDraftInput}
                          value={working.amountText}
                          onChange={(e) => handleDraftFieldChange(d.id, { amountText: e.target.value })}
                          placeholder="金额"
                          aria-label="待确认记账草稿金额"
                          data-testid={`phone-accounting-draft-amount-${d.id}`}
                          disabled={busy}
                        />
                        <input
                          type="text"
                          className={styles.xyDraftInput}
                          value={working.currency}
                          onChange={(e) => handleDraftFieldChange(d.id, { currency: e.target.value })}
                          placeholder="货币（¥ / 两银子 / 信用点）"
                          aria-label="待确认记账草稿货币"
                          data-testid={`phone-accounting-draft-currency-${d.id}`}
                          disabled={busy}
                        />
                      </div>
                      <div className={styles.xyDraftRow}>
                        <input
                          type="text"
                          className={styles.xyDraftInput}
                          value={working.category}
                          onChange={(e) => handleDraftFieldChange(d.id, { category: e.target.value })}
                          placeholder="分类（可选，如『工资 / 房租 / 餐饮』）"
                          aria-label="待确认记账草稿分类"
                          disabled={busy}
                        />
                        <input
                          type="text"
                          className={styles.xyDraftInput}
                          value={working.counterparty}
                          onChange={(e) => handleDraftFieldChange(d.id, { counterparty: e.target.value })}
                          placeholder={
                            working.direction === 'income'
                              ? '付款方（可选，如『东家』）'
                              : '收款方（可选，如『房东』）'
                          }
                          aria-label="待确认记账草稿对手方"
                          disabled={busy}
                        />
                      </div>
                      <textarea
                        className={styles.xyDraftTextarea}
                        value={working.content}
                        onChange={(e) => handleDraftFieldChange(d.id, { content: e.target.value })}
                        rows={2}
                        placeholder="备注（可选）"
                        aria-label="待确认记账草稿备注"
                        disabled={busy}
                      />
                      {d.reason ? (
                        <p className={styles.xyDraftReason}>理由：{d.reason}</p>
                      ) : null}
                      {d.occurredAt ? (
                        <p className={styles.xyDraftReason}>
                          时间：{formatDayStub(daysAgo(d.occurredAt))} 天前
                        </p>
                      ) : null}
                      <div className={styles.xyDraftActions}>
                        <button
                          type="button"
                          className={styles.xyDraftConfirm}
                          onClick={() => void handleConfirmDraft(d)}
                          disabled={busy}
                          data-testid={`phone-accounting-draft-confirm-${d.id}`}
                        >
                          {busy && draftBusyKind === 'plain' ? '处理中…' : '确认生成'}
                        </button>
                        <button
                          type="button"
                          className={styles.xyDraftDiscard}
                          onClick={() => void handleDiscardDraft(d)}
                          disabled={busy}
                          data-testid={`phone-accounting-draft-discard-${d.id}`}
                        >
                          丢弃
                        </button>
                      </div>
                    </div>
                  );
                })}
              </section>
            ) : null}

            {/* 时间档位：日 / 周 / 月 */}
            <div className={styles.xySegWrap}>
              <div className={styles.xySeg} role="tablist" aria-label="账本档位">
                {GROUP_BYS.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    aria-pressed={groupBy === item.value}
                    onClick={() => setGroupBy(item.value)}
                    data-testid={`phone-accounting-groupby-${item.value}`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            {/* 收入 / 支出筛选 */}
            <div className={styles.xySegWrap}>
              <div className={styles.xySeg} role="tablist" aria-label="账本筛选">
                {FILTERS.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    aria-pressed={filter === item.value}
                    onClick={() => setFilter(item.value)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            {visibleEntries.length === 0 && !loading ? (
              <p
                className={styles.phoneAppHint}
                data-testid="phone-accounting-empty"
                style={{ padding: '24px 18px', textAlign: 'center' }}
              >
                还没有账目。
              </p>
            ) : null}

            {/* 账本按档位分组 */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {groupedEntries.map((g) => (
                <LedgerGroupCard
                  key={`${groupBy}::${g.key}`}
                  group={g}
                  groupBy={groupBy}
                  ta={ta}
                  fxConfig={ledgerFxConfig}
                  onRowClick={handleRowClick}
                  onShare={() => handleShareLedgerGroupToChat(g)}
                  sharedNotice={sharedToChatKey === `${groupBy}::${g.key}`}
                />
              ))}
            </div>

            <button
              type="button"
              className={styles.xyFab}
              onClick={openCompose}
              aria-label="新增记账"
            >
              新增记账
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 顶部统一汇总卡：
 *  - 第一行：主货币的 收/支/净（最显眼，最大字号）；
 *  - 第二行：若账本里**只有一种币种**则不再赘述；多币种时以小字列出每种的
 *    原币种总额 + 折算到主货币的对照（"$80 ≈ ¥576 · 两银子 3.5 ≈ ¥875"）；
 *  - unconvertible[]：缺速率的币种，红色提示用户去汇率表补一下。
 *  - 右上「汇率」按钮：展开 / 折叠 FxRateEditor。
 */
function UnifiedTotalsCard({
  unified,
  byCurrency,
  onOpenFxEditor,
  fxEditorOpen,
}: {
  unified: LedgerUnifiedTotals | undefined;
  byCurrency: LedgerCurrencyTotals[];
  onOpenFxEditor: () => void;
  fxEditorOpen: boolean;
}) {
  // unified 没有（理论上不会发生，因为我们总传 fxConfig）→ 退化到老版多卡显示。
  if (!unified) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {byCurrency.map((b, idx) => (
          <div key={b.currency || `__empty_${idx}`} className={styles.xyDraftCard}>
            <div className={styles.xyDraftRow} style={{ alignItems: 'baseline', gap: 18 }}>
              <strong style={{ fontSize: 15 }}>{b.currency || '未标注币种'}</strong>
              <span>收入 <b>{formatAmountWithCurrency(b.income, b.currency || null)}</b></span>
              <span>支出 <b>{formatAmountWithCurrency(b.expense, b.currency || null)}</b></span>
              <span>净 <b>{formatAmountWithCurrency(b.net, b.currency || null)}</b></span>
              <span style={{ marginLeft: 'auto', opacity: 0.6 }}>{b.realizedCount} 笔</span>
            </div>
          </div>
        ))}
      </div>
    );
  }

  const onlyOneCurrency =
    byCurrency.length === 1 && byCurrency[0].currency === unified.displayCurrency;
  const hasUnconvertible = unified.unconvertible.length > 0;

  return (
    <div className={styles.xyDraftCard} aria-label="账本汇总">
      <div
        className={styles.xyDraftRow}
        style={{ alignItems: 'baseline', gap: 14, flexWrap: 'wrap' }}
      >
        <strong style={{ fontSize: 15 }}>{unified.displayCurrency || FX_ANCHOR_CURRENCY}</strong>
        <span>
          收入 <b>{formatAmountWithCurrency(unified.income, unified.displayCurrency || null)}</b>
        </span>
        <span>
          支出 <b>{formatAmountWithCurrency(unified.expense, unified.displayCurrency || null)}</b>
        </span>
        <span>
          净 <b>{formatSignedNet(unified.net, unified.displayCurrency || null)}</b>
        </span>
        <span style={{ marginLeft: 'auto', opacity: 0.6 }}>{unified.realizedCount} 笔</span>
        <button
          type="button"
          className={styles.xyBtnGhost}
          onClick={onOpenFxEditor}
          aria-expanded={fxEditorOpen}
          data-testid="phone-accounting-fx-toggle"
          style={{ fontSize: 12, padding: '4px 10px' }}
          title="设置主显示货币和各币种折算速率"
        >
          {fxEditorOpen ? '收起汇率' : '汇率设置'}
        </button>
      </div>

      {/* 副行：列出每个原币种的原始金额 + 折算后；只有一种币种且就是 displayCurrency 时省略 */}
      {!onlyOneCurrency && byCurrency.length > 0 ? (
        <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 3 }}>
          <p className={styles.phoneAppHint} style={{ margin: 0, fontSize: 11, opacity: 0.7 }}>
            含：
          </p>
          {byCurrency.map((b, idx) => {
            const isConvertible = !unified.unconvertible.some(
              (u) => u.currency === b.currency,
            );
            return (
              <p
                key={b.currency || `__sub_${idx}`}
                className={styles.phoneAppHint}
                style={{ margin: 0, fontSize: 11, paddingLeft: 8 }}
              >
                · {b.currency || '未标注币种'}：收{' '}
                {formatAmountWithCurrency(b.income, b.currency || null)} · 支{' '}
                {formatAmountWithCurrency(b.expense, b.currency || null)}
                {!isConvertible ? (
                  <span style={{ color: '#b04040', marginLeft: 6 }}>· 缺速率，未计入合计</span>
                ) : null}
              </p>
            );
          })}
        </div>
      ) : null}

      {hasUnconvertible ? (
        <p
          className={styles.phoneAppHint}
          style={{ margin: '6px 0 0', fontSize: 11, color: '#b04040' }}
        >
          有 {unified.unconvertible.length} 种币种没设速率，未并入合计——可在「汇率设置」里补上。
        </p>
      ) : null}
    </div>
  );
}

/**
 * 日 / 周 / 月卡顶部的小汇总行：主货币一行 + 多币种时副行列原币种。
 * 不带「汇率设置」按钮（统一只在顶部出现一处），免得每张卡都重复一遍。
 */
function GroupTotalsLine({
  unified,
  byCurrency,
}: {
  unified: LedgerUnifiedTotals | undefined;
  byCurrency: LedgerCurrencyTotals[];
}) {
  if (!unified) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {byCurrency.map((b, idx) => (
          <p key={b.currency || `__c_${idx}`} className={styles.phoneAppHint} style={{ margin: 0 }}>
            <strong>{b.currency || '未标注币种'}</strong>
            {'　'}收 {formatAmountWithCurrency(b.income, b.currency || null)}
            {' / 支 '}{formatAmountWithCurrency(b.expense, b.currency || null)}
            {' / 净 '}{formatSignedNet(b.net, b.currency || null)}
            {'　('}{b.realizedCount} 笔已实现{')'}
          </p>
        ))}
      </div>
    );
  }
  const onlyOneCurrency =
    byCurrency.length === 1 && byCurrency[0].currency === unified.displayCurrency;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <p className={styles.phoneAppHint} style={{ margin: 0 }}>
        <strong>{unified.displayCurrency || FX_ANCHOR_CURRENCY}</strong>
        {'　'}收 {formatAmountWithCurrency(unified.income, unified.displayCurrency || null)}
        {' / 支 '}{formatAmountWithCurrency(unified.expense, unified.displayCurrency || null)}
        {' / 净 '}{formatSignedNet(unified.net, unified.displayCurrency || null)}
        {'　('}{unified.realizedCount} 笔已实现{')'}
      </p>
      {!onlyOneCurrency ? (
        <p
          className={styles.phoneAppHint}
          style={{ margin: 0, fontSize: 11, opacity: 0.7, paddingLeft: 8 }}
        >
          含：
          {byCurrency
            .map((b) => `${b.currency || '未标注'} ${formatAmountWithCurrency(b.net, b.currency || null)}`)
            .join(' · ')}
        </p>
      ) : null}
    </div>
  );
}

/**
 * 汇率编辑器：
 *  - 顶部选「主显示货币」（input，可填表中任意币种，回车保存）；
 *  - 中部列「账本里实际出现过的币种 + 默认表里的常见币种」，每行允许填速率
 *    （= 1 单位该币种 ÷ X ¥），空 = 用默认值；
 *  - 底部「保存」「重置为默认」。
 * 不强求 UI 多炫；这是个偏 power-user 的小工具。
 */
function FxRateEditor({
  fxConfig,
  fxState,
  ledgerCurrencies,
  busy,
  onSave,
}: {
  fxConfig: XingyeFxConfig;
  fxState: EffectiveFxState;
  ledgerCurrencies: string[];
  busy: boolean;
  onSave: (patch: Partial<Omit<XingyeFxConfig, 'version'>>) => Promise<void>;
}) {
  const [displayDraft, setDisplayDraft] = useState(fxState.displayCurrency || FX_ANCHOR_CURRENCY);
  const [rateDrafts, setRateDrafts] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(fxConfig.rates)) {
      out[k] = String(v);
    }
    return out;
  });

  // 列出哪些币种行：账本里出现过的 ∪ 默认表里的"常见币种组" ∪ 用户已自定义的。
  const visibleCurrencies = useMemo(() => {
    const set = new Set<string>();
    for (const c of ledgerCurrencies) {
      if (c) set.add(c);
    }
    for (const group of FX_CURRENCY_GROUPS) {
      for (const c of group.currencies) set.add(c);
    }
    for (const c of Object.keys(fxConfig.rates)) set.add(c);
    set.delete(FX_ANCHOR_CURRENCY); // 锚位不可改
    return [...set];
  }, [ledgerCurrencies, fxConfig.rates]);

  const handleSave = async () => {
    const cleanedRates: Record<string, number> = {};
    for (const [ccy, raw] of Object.entries(rateDrafts)) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const n = Number(trimmed);
      if (!Number.isFinite(n) || n <= 0) continue;
      cleanedRates[ccy] = n;
    }
    await onSave({
      displayCurrency: displayDraft.trim(),
      rates: cleanedRates,
    });
  };

  const handleReset = async () => {
    setDisplayDraft('');
    setRateDrafts({});
    await onSave({ displayCurrency: '', rates: {} });
  };

  return (
    <div
      className={styles.xyDraftCard}
      aria-label="汇率设置"
      data-testid="phone-accounting-fx-editor"
      style={{ marginTop: 8 }}
    >
      <p style={{ margin: 0, fontWeight: 600 }}>汇率设置</p>
      <p className={styles.phoneAppHint} style={{ margin: '4px 0 8px', fontSize: 11 }}>
        速率全部锚定 ¥（1 单位该币种 = X ¥）。留空 = 用默认值。
      </p>

      <label className={styles.xyEditorField} style={{ padding: 0 }}>
        <span>主显示货币</span>
        <input
          type="text"
          value={displayDraft}
          placeholder={`${FX_ANCHOR_CURRENCY}（默认）`}
          onChange={(e) => setDisplayDraft(e.target.value)}
          data-testid="phone-accounting-fx-display-currency"
          disabled={busy}
        />
      </label>

      <div style={{ marginTop: 10, maxHeight: 280, overflowY: 'auto', paddingRight: 4 }}>
        <p className={styles.phoneAppHint} style={{ margin: '0 0 4px', fontSize: 11 }}>
          各币种速率（= 多少 ¥）
        </p>
        {visibleCurrencies.map((ccy) => {
          const defaultRate = DEFAULT_FX_RATES[ccy];
          const placeholder = defaultRate !== undefined ? `默认 ${defaultRate}` : '请输入';
          return (
            <div
              key={ccy}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }}
            >
              <span style={{ width: 92, fontSize: 12 }}>{ccy}</span>
              <span style={{ fontSize: 11, opacity: 0.6 }}>1 单位 =</span>
              <input
                type="text"
                inputMode="decimal"
                value={rateDrafts[ccy] ?? ''}
                placeholder={placeholder}
                onChange={(e) =>
                  setRateDrafts((prev) => ({ ...prev, [ccy]: e.target.value }))
                }
                disabled={busy}
                style={{ flex: 1, padding: '2px 6px', fontSize: 12 }}
                data-testid={`phone-accounting-fx-rate-${ccy}`}
              />
              <span style={{ fontSize: 11, opacity: 0.6 }}>¥</span>
            </div>
          );
        })}
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button
          type="button"
          className={styles.xyBtnGhost}
          onClick={() => void handleSave()}
          disabled={busy}
          data-testid="phone-accounting-fx-save"
        >
          {busy ? '保存中…' : '保存'}
        </button>
        <button
          type="button"
          className={styles.xyBtnGhost}
          onClick={() => void handleReset()}
          disabled={busy}
          data-testid="phone-accounting-fx-reset"
          title="清空自定义，恢复默认表"
        >
          重置为默认
        </button>
      </div>
    </div>
  );
}

function LedgerRow({ entry, onClick }: { entry: LedgerEntry; onClick: () => void }) {
  const amountLine = formatAmountWithCurrency(entry.amount, entry.currency);
  const days = daysAgo(entry.occurredAt);
  const directionTone =
    entry.direction === 'income' ? styles.xyChipTintSage : styles.xyChipTintTerracotta;
  const sourceTone =
    entry.source === 'accounting'
      ? styles.xyChipTintPlum
      : entry.source === 'shopping'
        ? styles.xyChipTintOchre
        : styles.xyChipTintSage;
  /**
   * 整行做成 <button>：accounting 行打开内详情面板；shopping/secondhand 行
   * 跳到源模块（删除/编辑入口都在源模块里，这里不再单独提供删除按钮，
   * 避免和源模块出现两套删除路径）。
   */
  return (
    <button
      type="button"
      className={styles.xyRowCard}
      onClick={onClick}
      style={{ textAlign: 'left' }}
      data-testid={`phone-accounting-row-${entry.source}-${entry.id}`}
    >
      <aside className={styles.xyRowCardStub}>
        <span className={styles.xyRowCardDay}>{formatDayStub(days)}</span>
        <span className={styles.xyRowCardDayUnit}>天前</span>
      </aside>
      <div className={styles.xyRowCardBody}>
        <div className={styles.xyRowCardTop}>
          <span className={`${styles.xyChip} ${directionTone}`}>
            {DIRECTION_LABELS[entry.direction]}
          </span>
          <span className={`${styles.xyChip} ${sourceTone}`}>
            {SOURCE_LABELS[entry.source]}
          </span>
          {entry.category ? (
            <span className={`${styles.xyChip} ${styles.xyChipTintSlate}`}>
              {entry.category}
            </span>
          ) : null}
        </div>
        <h3 className={styles.xyRowCardName}>{entry.title}</h3>
        {entry.note ? (
          <p className={styles.xyRowCardReason}>{entry.note}</p>
        ) : null}
        <div className={styles.xyRowCardFoot}>
          <span className={styles.xyRowCardPrice}>{amountLine}</span>
          {entry.counterparty ? (
            <span className={styles.xyRowCardDelta}>· {entry.counterparty}</span>
          ) : null}
        </div>
      </div>
    </button>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   档位分组卡：日 / 周 / 月 三档共用容器，主体按档位分别渲染。
   - day：组内每笔展开（沿用 LedgerRow，保留 accounting 删除入口）。
   - week：按类目聚合（同币种内），多币种各一段。
   - month：每币种一行总览 + Top 类目，不展开个例。
─────────────────────────────────────────────────────────────────────────── */
function LedgerGroupCard({
  group,
  groupBy,
  ta,
  fxConfig,
  onRowClick,
  onShare,
  sharedNotice,
}: {
  group: LedgerGroup;
  groupBy: GroupBy;
  ta: string;
  /** 折算到主货币用；从 PhoneAccountingApp 顶层传下来，保证日/周/月卡口径一致。 */
  fxConfig: LedgerFxConfig;
  onRowClick: (entry: LedgerEntry) => void;
  onShare: () => void;
  sharedNotice: boolean;
}) {
  const summary: LedgerSummary = summarizeLedger(group.entries, fxConfig);
  const noun = GROUP_BY_NOUN[groupBy];
  return (
    <section
      className={styles.xyDraftSection}
      aria-label={`${group.label} 账目`}
      data-testid={`phone-accounting-group-${groupBy}-${group.key}`}
    >
      <p className={styles.xyDraftHeader}>
        {group.label} · {group.entries.length} 笔
      </p>

      {/* 头部主货币汇总 + 原币种小字副行 */}
      {summary.byCurrency.length > 0 ? (
        <GroupTotalsLine
          unified={summary.unified}
          byCurrency={summary.byCurrency}
        />
      ) : (
        <p className={styles.phoneAppHint} style={{ margin: 0 }}>本{noun}没有已实现的现金流</p>
      )}

      {/* 主体：按档位三种渲染 */}
      {groupBy === 'day' ? (
        <div className={styles.xyShopList} style={{ marginTop: 8 }}>
          {group.entries.map((e) => (
            <LedgerRow key={`${e.source}::${e.id}`} entry={e} onClick={() => onRowClick(e)} />
          ))}
        </div>
      ) : groupBy === 'week' ? (
        <LedgerWeekBody group={group} />
      ) : (
        <LedgerMonthBody group={group} />
      )}

      {/* 「去和 TA 聊聊」按钮 + 4s 提示 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 10 }}>
        <button
          type="button"
          className={styles.xyBtnGhost}
          onClick={onShare}
          data-testid={`phone-accounting-share-to-chat-${groupBy}-${group.key}`}
          title={`把这${noun}的账带到和 ${ta} 的聊天里`}
          style={{ alignSelf: 'flex-start' }}
        >
          去和 {ta} 聊聊这{noun}
        </button>
        {sharedNotice ? (
          <p
            className={styles.phoneAppHint}
            role="status"
            data-testid={`phone-accounting-share-to-chat-notice-${groupBy}-${group.key}`}
            style={{ margin: 0 }}
          >
            已放进聊天输入框引用 —— 打开任意对话即可发出
          </p>
        ) : null}
      </div>
    </section>
  );
}

/** 周档主体：同币种内按类目聚合，分收入/支出列出。 */
function LedgerWeekBody({ group }: { group: LedgerGroup }) {
  const aggs = useMemo(() => aggregateByCategory(group.entries), [group.entries]);
  if (aggs.length === 0) return null;
  // 按币种分组，每币种一段。
  const currencies = Array.from(new Set(aggs.map((a) => a.currency)));
  // 单币种场景下：卡片头上方的「<¥> 收 X / 支 Y / 净 Z」摘要行已经标了币种，
  // 卡片内再单独显示一个孤零零的 ¥ 是冗余视觉噪音。只有多币种时才显示这个分段头。
  const showCurrencyHeader = currencies.length > 1;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 8 }}>
      {currencies.map((currency) => {
        const incomeAggs = aggs.filter((a) => a.currency === currency && a.direction === 'income');
        const expenseAggs = aggs.filter((a) => a.currency === currency && a.direction === 'expense');
        const curLabel = currency || '未标注币种';
        return (
          <div key={currency || '__empty'} className={styles.xyDraftCard}>
            {showCurrencyHeader ? (
              <p style={{ margin: 0, fontWeight: 600 }}>{curLabel}</p>
            ) : null}
            {incomeAggs.length ? (
              <div style={{ marginTop: 6 }}>
                <p style={{ margin: 0, opacity: 0.7, fontSize: 12 }}>收入</p>
                {incomeAggs.map((a) => (
                  <p
                    key={`i-${a.category}`}
                    className={styles.phoneAppHint}
                    style={{ margin: '2px 0' }}
                  >
                    · {a.category} <b>{formatAmountWithCurrency(a.sum, a.currency || null)}</b>
                    {'（'}{a.count} 笔
                    {a.sampleTitles.length > 0 ? ` · ${a.sampleTitles.slice(0, 2).join(' / ')}` : ''}
                    {'）'}
                  </p>
                ))}
              </div>
            ) : null}
            {expenseAggs.length ? (
              <div style={{ marginTop: 6 }}>
                <p style={{ margin: 0, opacity: 0.7, fontSize: 12 }}>支出</p>
                {expenseAggs.map((a) => (
                  <p
                    key={`e-${a.category}`}
                    className={styles.phoneAppHint}
                    style={{ margin: '2px 0' }}
                  >
                    · {a.category} <b>{formatAmountWithCurrency(a.sum, a.currency || null)}</b>
                    {'（'}{a.count} 笔
                    {a.sampleTitles.length > 0 ? ` · ${a.sampleTitles.slice(0, 2).join(' / ')}` : ''}
                    {'）'}
                  </p>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** 月档主体：每币种一行 Top 类目，不展开个例。 */
function LedgerMonthBody({ group }: { group: LedgerGroup }) {
  const aggs = useMemo(() => aggregateByCategory(group.entries), [group.entries]);
  if (aggs.length === 0) return null;
  const currencies = Array.from(new Set(aggs.map((a) => a.currency)));
  // 同 LedgerWeekBody：单币种时不显示孤零零的 ¥ 分段头，避免视觉噪音。
  const showCurrencyHeader = currencies.length > 1;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
      {currencies.map((currency) => {
        const topExpense = aggs
          .filter((a) => a.currency === currency && a.direction === 'expense')
          .slice(0, 3);
        const topIncome = aggs
          .filter((a) => a.currency === currency && a.direction === 'income')
          .slice(0, 3);
        const curLabel = currency || '未标注币种';
        return (
          <div key={currency || '__empty'} className={styles.xyDraftCard}>
            {showCurrencyHeader ? (
              <p style={{ margin: 0, fontWeight: 600 }}>{curLabel}</p>
            ) : null}
            {topExpense.length ? (
              <p className={styles.phoneAppHint} style={{ margin: '4px 0 0' }}>
                Top 支出：
                {topExpense
                  .map((a) => `${a.category} ${formatAmountWithCurrency(a.sum, a.currency || null)}`)
                  .join('、')}
              </p>
            ) : null}
            {topIncome.length ? (
              <p className={styles.phoneAppHint} style={{ margin: '4px 0 0' }}>
                Top 收入：
                {topIncome
                  .map((a) => `${a.category} ${formatAmountWithCurrency(a.sum, a.currency || null)}`)
                  .join('、')}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * 账本原生条目详情视图。只有 source='accounting' 的行会进这里——
 * shopping / secondhand 的行从父级 handleRowClick 跳到源模块，
 * 因为编辑/状态切换/删除入口都在源模块里，账本只是个只读投影。
 *
 * 字段排版：金额放在最大字号；分类/对手方/发生时间/原因/备注按"有就显示"。
 */
function LedgerDetailView({
  entry,
  ta,
  onDelete,
}: {
  entry: LedgerEntry;
  ta: string;
  onDelete: () => void;
}) {
  const days = daysAgo(entry.occurredAt);
  const amountLine = formatAmountWithCurrency(entry.amount, entry.currency);
  const directionTone =
    entry.direction === 'income' ? styles.xyChipSolidSage : styles.xyChipSolidTerracotta;
  const coverTone = entry.direction === 'income' ? styles.xyToneCool : styles.xyToneWarm;
  return (
    <div className={`${styles.xyDetail} ${styles.xyScroll}`}>
      <div className={`${styles.xyDetailCover} ${coverTone}`}>
        <div className={styles.xyDetailCoverTop}>
          <span className={styles.xyDetailCoverCat}>{entry.category ?? '未分类'}</span>
          <span className={styles.xyDetailCoverSeller}>{entry.counterparty ?? ta}</span>
        </div>
        <h1 className={styles.xyDetailCoverName}>{entry.title}</h1>
        <div className={styles.xyDetailCoverFoot}>
          <span className={`${styles.xyChip} ${directionTone}`}>
            {DIRECTION_LABELS[entry.direction]}
          </span>
          {entry.currency ? (
            <span className={`${styles.xyChip} ${styles.xyChipTintSlate}`}>{entry.currency}</span>
          ) : null}
        </div>
      </div>

      <div className={styles.xyDetailBody}>
        <p className={styles.xyDetailMeta}>{formatDayStub(days)} 天前</p>

        <div className={styles.xyDetailPriceRow}>
          <span
            className={styles.xyDetailPrice}
            data-testid={`phone-accounting-detail-amount-${entry.id}`}
          >
            {amountLine}
          </span>
        </div>

        {entry.counterparty ? (
          <div className={styles.xyDetailSection}>
            <p className={styles.xyDetailSecTitle}>
              {entry.direction === 'income' ? '付款方' : '收款方'}
            </p>
            <p className={styles.xyDetailMeta}>{entry.counterparty}</p>
          </div>
        ) : null}

        {entry.note ? (
          <div className={styles.xyDetailNote}>
            <p className={styles.xyDetailNoteKicker}>— 记下的话</p>
            <p className={styles.xyDetailNoteText}>{entry.note}</p>
          </div>
        ) : null}

        <div className={styles.xyDetailActions}>
          <button
            type="button"
            className={`${styles.xyBtnGhost} ${styles.xyBtnGhostDanger}`}
            onClick={onDelete}
            data-testid={`phone-accounting-detail-delete-${entry.id}`}
          >
            删除这条记录
          </button>
        </div>
      </div>
    </div>
  );
}

function ComposeEditor({
  compose,
  updateCompose,
  onSave,
  saveBusy,
  saveError,
}: {
  compose: ComposeDraft;
  updateCompose: (patch: Partial<ComposeDraft>) => void;
  onSave: () => void;
  saveBusy: boolean;
  saveError: string | null;
}) {
  return (
    <section className={styles.xyEditorWrap} aria-label="新增记账" style={{ overflowY: 'auto' }}>
      <header className={styles.xyShopHero} style={{ padding: 0 }}>
        <p className={styles.xyShopKicker}>NEW LEDGER ENTRY</p>
        <h2 className={styles.xyShopTitle}>新增记账</h2>
        <p className={styles.xyShopSub}>保存后会先进入「待确认」区，由你或角色再次确认。</p>
      </header>
      <label className={styles.xyEditorField}>
        <span>摘要</span>
        <input
          value={compose.title}
          placeholder="如『五月薪俸』『这个月房租』『午饭』"
          onChange={(e) => updateCompose({ title: e.target.value })}
        />
      </label>
      <label className={styles.xyEditorField}>
        <span>方向</span>
        <select
          value={compose.direction}
          onChange={(e) => updateCompose({ direction: e.target.value as AccountingDirection })}
        >
          <option value="income">收入</option>
          <option value="expense">支出</option>
        </select>
      </label>
      <div style={{ display: 'flex', gap: 12 }}>
        <label className={styles.xyEditorField} style={{ flex: 1.6 }}>
          <span>金额</span>
          <input
            inputMode="decimal"
            value={compose.amountText}
            placeholder="纯数字，如 3500"
            onChange={(e) => updateCompose({ amountText: e.target.value })}
          />
        </label>
        <label className={styles.xyEditorField} style={{ flex: 1 }}>
          <span>货币</span>
          <input
            value={compose.currency}
            placeholder="¥ / 两银子 / 信用点"
            onChange={(e) => updateCompose({ currency: e.target.value })}
          />
        </label>
      </div>
      <label className={styles.xyEditorField}>
        <span>分类</span>
        <input
          value={compose.category}
          placeholder="如『工资 / 房租 / 餐饮 / 人情』"
          onChange={(e) => updateCompose({ category: e.target.value })}
        />
      </label>
      <label className={styles.xyEditorField}>
        <span>{compose.direction === 'income' ? '付款方' : '收款方'}</span>
        <input
          value={compose.counterparty}
          placeholder={compose.direction === 'income' ? '如『东家』『杂志社』' : '如『房东』『巷口面摊』'}
          onChange={(e) => updateCompose({ counterparty: e.target.value })}
        />
      </label>
      <label className={styles.xyEditorField}>
        <span>发生时间</span>
        <input
          value={compose.occurredAtText}
          placeholder="可选，YYYY-MM-DD 或留空（默认今天）"
          onChange={(e) => updateCompose({ occurredAtText: e.target.value })}
        />
      </label>
      <label className={styles.xyEditorField}>
        <span>原因</span>
        <input
          value={compose.reason}
          placeholder="可选，记下当时的理由"
          onChange={(e) => updateCompose({ reason: e.target.value })}
        />
      </label>
      <label className={styles.xyEditorField}>
        <span>备注</span>
        <textarea
          rows={4}
          value={compose.content}
          onChange={(e) => updateCompose({ content: e.target.value })}
        />
      </label>
      {saveError ? (
        <p className={styles.xyEditorError} role="alert">{saveError}</p>
      ) : null}
      <div className={styles.xyEditorActions}>
        <button
          type="button"
          className={styles.xyEditorPrimary}
          onClick={onSave}
          disabled={saveBusy}
        >
          {saveBusy ? '保存中…' : '保存为草稿'}
        </button>
      </div>
    </section>
  );
}

