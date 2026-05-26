import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Agent } from '../types';
import styles from './XingyeShell.module.css';
import {
  appendAppEntry,
  deleteAppEntry,
  listAppEntries,
  updateAppEntry,
  type AppEntry,
} from './xingye-app-entry-store';
import {
  appendSecondhandDraft,
  confirmSecondhandDraft,
  discardSecondhandDraft,
  listSecondhandDrafts,
  type SecondhandDraftStatus,
  type XingyePendingSecondhandDraft,
} from './xingye-secondhand-drafts';
import type { XingyeRoleProfile } from './xingye-profile-store';
import {
  generateSecondhandDraftWithAI,
  generateSecondhandHistoryWithAI,
  generateSecondhandPolishWithAI,
} from './xingye-secondhand-ai';
import { normalizeAmount, normalizeCurrency, parseAmountText } from './xingye-money';
import {
  distributeOccurredAtFallback,
  loadHistoryState,
  saveHistoryState,
  planBulkRequest,
  planInitialBulkRequest,
  toYmd,
  type BulkPlan,
} from './xingye-app-history-state';

export interface PhoneSecondhandAppProps {
  ownerAgent: Agent | null;
  ownerProfile?: XingyeRoleProfile | null;
  displayName: string;
  onBack: () => void;
}

export type SecondhandEntryStatus =
  | 'to_sell'
  | 'listed'
  | 'sold'
  | 'negotiating'
  | 'kept'
  | 'delisted';

export type SecondhandEntryMetadata = {
  status: SecondhandEntryStatus;
  platformStyle?: 'amazon' | 'taobao' | 'xianyu' | 'generic';
  itemName: string;
  category?: string;
  reason?: string;
  /**
   * TA 想象里这件东西能卖出的价格感（如「¥1,280」「二两银子」）。
   * 列表卡和详情 detail-price-row 显示。镜像购物的 imaginedPrice。
   */
  askingPrice?: string;
  /**
   * 买家 / 接手人口吻（如「巷口的旧书客」「楼下收旧货的」）。
   * 列表卡 mono 行和详情封面右上角显示，给清单加氛围。
   * AI 生成时给短小的虚构买家口吻；用户手填可空。
   */
  buyer?: string;
  /**
   * 卖出落差短语（如「比当初买价低 ¥220」「卖不上价」「省了半两」）。
   * 与 askingPrice 共用同一货币体系（现代 ¥/$、古代两银子、西幻金币、未来信用点 …）。
   * 列表 row-card-foot 和详情 detail-price-row 的次要小字。
   */
  delta?: string;
  /**
   * 记账用数值金额。`askingPrice` 是给人看的氛围文本，`amount` 是给记账模块按
   * 币种求和用的纯数值，与 `currency` 搭配。两者独立，可只填其一。
   */
  amount?: number;
  /** `amount` 的货币单位（¥ / $ / 两银子 / 金币 / 信用点 …）。 */
  currency?: string;
  tags?: string[];
};

type SecondhandEntry = AppEntry & {
  appId: 'secondhand';
  metadata: SecondhandEntryMetadata;
};

type SecondhandDraft = {
  itemName: string;
  status: SecondhandEntryStatus;
  platformStyle: NonNullable<SecondhandEntryMetadata['platformStyle']>;
  category: string;
  askingPrice: string;
  amountText: string;
  currency: string;
  delta: string;
  buyer: string;
  reason: string;
  tagsText: string;
  content: string;
};

const SECONDHAND_APP_ID = 'secondhand';

const STATUS_LABELS: Record<SecondhandEntryStatus, string> = {
  to_sell: '想卖',
  listed: '已挂出',
  sold: '已售出',
  negotiating: '在谈',
  kept: '留下',
  delisted: '撤下',
};

/**
 * 6 种 status → 5 色 tone（terracotta/sage/ochre/plum/slate）。
 * 镜像 PhoneShoppingApp 的配色表。
 */
type ChipTone = 'terracotta' | 'sage' | 'ochre' | 'plum' | 'slate';

const STATUS_TONES: Record<SecondhandEntryStatus, ChipTone> = {
  to_sell: 'ochre',
  listed: 'terracotta',
  sold: 'sage',
  negotiating: 'slate',
  kept: 'plum',
  delisted: 'slate',
};

const TONE_TINT_CLASS: Record<ChipTone, string> = {
  terracotta: styles.xyChipTintTerracotta,
  sage: styles.xyChipTintSage,
  ochre: styles.xyChipTintOchre,
  plum: styles.xyChipTintPlum,
  slate: styles.xyChipTintSlate,
};

const TONE_SOLID_CLASS: Record<ChipTone, string> = {
  terracotta: styles.xyChipSolidTerracotta,
  sage: styles.xyChipSolidSage,
  ochre: styles.xyChipSolidOchre,
  plum: styles.xyChipSolidPlum,
  slate: styles.xyChipSolidSlate,
};

const FILTERS: Array<{ value: 'all' | SecondhandEntryStatus; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'to_sell', label: '想卖' },
  { value: 'listed', label: '已挂出' },
  { value: 'negotiating', label: '在谈' },
  { value: 'sold', label: '已售出' },
  { value: 'kept', label: '留下' },
  { value: 'delisted', label: '撤下' },
];

const PLATFORM_STYLE_LABELS: Record<NonNullable<SecondhandEntryMetadata['platformStyle']>, string> = {
  generic: '普通记录',
  amazon: '清单感',
  taobao: '交易感',
  xianyu: '闲置感',
};

/**
 * `platformStyle` → 详情封面色调。镜像 PhoneShoppingApp。
 */
const PLATFORM_COVER_TONE: Record<NonNullable<SecondhandEntryMetadata['platformStyle']>, string> = {
  amazon: styles.xyToneGold,
  taobao: styles.xyToneWarm,
  xianyu: styles.xyToneCool,
  generic: styles.xyTonePlum,
};

/**
 * 状态主线时间线（to_sell → listed → sold）。
 * negotiating / kept / delisted 不在主线上，单独渲染状态卡片（detail-branch-card）。
 */
const TIMELINE_MAINLINE: Array<{ key: SecondhandEntryStatus; label: string }> = [
  { key: 'to_sell', label: '想卖' },
  { key: 'listed', label: '已挂出' },
  { key: 'sold', label: '已售出' },
];

function isOnMainline(status: SecondhandEntryStatus): boolean {
  return TIMELINE_MAINLINE.some((m) => m.key === status);
}

function emptyDraft(): SecondhandDraft {
  return {
    itemName: '',
    status: 'to_sell',
    platformStyle: 'generic',
    category: '',
    askingPrice: '',
    amountText: '',
    currency: '',
    delta: '',
    buyer: '',
    reason: '',
    tagsText: '',
    content: '',
  };
}

function isSecondhandStatus(value: unknown): value is SecondhandEntryStatus {
  return (
    value === 'to_sell' ||
    value === 'listed' ||
    value === 'sold' ||
    value === 'negotiating' ||
    value === 'kept' ||
    value === 'delisted'
  );
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((tag) => (typeof tag === 'string' ? tag.trim() : ''))
    .filter(Boolean)
    .slice(0, 8);
}

function normalizeSecondhandEntry(entry: AppEntry): SecondhandEntry {
  const meta = entry.metadata ?? {};
  const itemName = typeof meta.itemName === 'string' && meta.itemName.trim() ? meta.itemName.trim() : entry.title;
  const platformStyle =
    meta.platformStyle === 'amazon' ||
    meta.platformStyle === 'taobao' ||
    meta.platformStyle === 'xianyu' ||
    meta.platformStyle === 'generic'
      ? meta.platformStyle
      : 'generic';
  return {
    ...entry,
    appId: 'secondhand',
    metadata: {
      status: isSecondhandStatus(meta.status) ? meta.status : 'to_sell',
      platformStyle,
      itemName,
      category: typeof meta.category === 'string' && meta.category.trim() ? meta.category.trim() : undefined,
      reason: typeof meta.reason === 'string' && meta.reason.trim() ? meta.reason.trim() : undefined,
      askingPrice:
        typeof meta.askingPrice === 'string' && meta.askingPrice.trim()
          ? meta.askingPrice.trim()
          : undefined,
      buyer:
        typeof meta.buyer === 'string' && meta.buyer.trim() ? meta.buyer.trim() : undefined,
      delta:
        typeof meta.delta === 'string' && meta.delta.trim() ? meta.delta.trim() : undefined,
      amount: normalizeAmount(meta.amount),
      currency: normalizeCurrency(meta.currency),
      tags: normalizeTags(meta.tags),
    },
  };
}

function draftFromEntry(entry: SecondhandEntry): SecondhandDraft {
  return {
    itemName: entry.metadata.itemName || entry.title,
    status: entry.metadata.status,
    platformStyle: entry.metadata.platformStyle ?? 'generic',
    category: entry.metadata.category ?? '',
    askingPrice: entry.metadata.askingPrice ?? '',
    amountText: entry.metadata.amount != null ? String(entry.metadata.amount) : '',
    currency: entry.metadata.currency ?? '',
    delta: entry.metadata.delta ?? '',
    buyer: entry.metadata.buyer ?? '',
    reason: entry.metadata.reason ?? '',
    tagsText: (entry.metadata.tags ?? []).join(', '),
    content: entry.content,
  };
}

function buildInputFromDraft(draft: SecondhandDraft) {
  const itemName = draft.itemName.trim();
  const tags = draft.tagsText
    .split(/[,，]/)
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 8);
  const metadata: SecondhandEntryMetadata = {
    status: draft.status,
    platformStyle: draft.platformStyle,
    itemName,
  };
  const category = draft.category.trim();
  const askingPrice = draft.askingPrice.trim();
  const amount = parseAmountText(draft.amountText);
  const currency = normalizeCurrency(draft.currency);
  const delta = draft.delta.trim();
  const buyer = draft.buyer.trim();
  const reason = draft.reason.trim();
  if (category) metadata.category = category;
  if (askingPrice) metadata.askingPrice = askingPrice;
  if (amount !== undefined) metadata.amount = amount;
  if (currency) metadata.currency = currency;
  if (delta) metadata.delta = delta;
  if (buyer) metadata.buyer = buyer;
  if (reason) metadata.reason = reason;
  if (tags.length > 0) metadata.tags = tags;
  /**
   * 不返回 source 字段：让 appendAppEntry 走 'manual' 兜底（新建路径）、让
   * updateAppEntry 看到 undefined 保留原 entry.source（编辑路径）。
   * 老实现硬写 source: 'manual'，会把 xingye-heartbeat-confirmed 等来源溯源洗掉。
   */
  return {
    title: itemName,
    content: draft.content.trim(),
    metadata,
  };
}

/**
 * 取「X 天前」的整数差值。
 * - 0 → 当天，UI 上显示 "00 / 天前"，节奏一致（不要写「今天」）
 * - 三位数也不截断
 */
function daysAgo(iso: string): number {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.floor(ms / (24 * 3600 * 1000)));
}

/** 02 / 12 / 1234（>=100 不补零） */
function formatDayStub(d: number): string {
  if (d >= 100) return String(d);
  return String(d).padStart(2, '0');
}

/**
 * ¥/$/€/£/￥ 这类单符号西方货币按习惯前缀（`¥99`、`$5`）；
 * "两银子"/"信用点"/"金币" 等多字单位按后缀（`99 两银子`）。
 */
const WESTERN_PREFIX_CURRENCY = /^[¥$€£￥]$/;

/**
 * 把 amount + currency 拼成主价位短文本，例如 `¥120` / `2 两银子`。
 * 整数省小数点；非整数最多两位小数并去掉末尾 0。amount 为 undefined → null（不渲染）。
 */
function formatAmountWithCurrency(
  amount: number | undefined,
  currency: string | undefined,
): string | null {
  if (amount === undefined) return null;
  const num = Number.isInteger(amount)
    ? String(amount)
    : amount.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  if (!currency) return num;
  if (WESTERN_PREFIX_CURRENCY.test(currency)) return `${currency}${num}`;
  return `${num} ${currency}`;
}

/** 详情页 meta 行的动词：「记于 / 挂出于 / 售出于 X 天前」 */
function metaVerb(status: SecondhandEntryStatus): string {
  if (status === 'listed') return '挂出于';
  if (status === 'sold') return '售出于';
  return '记于';
}

function StatusChip({ status, solid }: { status: SecondhandEntryStatus; solid?: boolean }) {
  const tone = STATUS_TONES[status];
  const variantCls = solid ? TONE_SOLID_CLASS[tone] : TONE_TINT_CLASS[tone];
  return <span className={`${styles.xyChip} ${variantCls}`}>{STATUS_LABELS[status]}</span>;
}

export function PhoneSecondhandApp({ ownerAgent, ownerProfile, displayName, onBack }: PhoneSecondhandAppProps) {
  const ownerAgentId = ownerAgent?.id ?? '';
  const [entries, setEntries] = useState<SecondhandEntry[]>([]);
  const [pendingDrafts, setPendingDrafts] = useState<XingyePendingSecondhandDraft[]>([]);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | SecondhandEntryStatus>('all');
  const [composeOpen, setComposeOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<SecondhandDraft>(() => emptyDraft());
  const [userIntent, setUserIntent] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  /**
   * 「待确认草稿」行内编辑缓冲。Key = draft.id。
   * 用户在小手机里改了字、还没按「确认生成」前先在内存里保留改动；
   * 离开页面再回来时回退到 drafts.jsonl 的最新内容（草稿本身已落盘，不会丢）。
   */
  const [draftEdits, setDraftEdits] = useState<
    Record<string, {
      itemName: string;
      status: SecondhandDraftStatus;
      content: string;
      category: string;
      askingPrice: string;
      amountText: string;
      currency: string;
    }>
  >({});
  const [draftBusyId, setDraftBusyId] = useState<string | null>(null);
  /**
   * 草稿卡 busy 区分：'plain' = 直通车「确认生成」；'polish' = 二段式「确认并润色价格」；
   * 'discard' = 丢弃；null = 空闲。让两个按钮的"处理中…"文案各显示在自己头上。
   */
  const [draftBusyKind, setDraftBusyKind] = useState<'plain' | 'polish' | 'discard' | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);

  /**
   * 「批量历史生成」状态：见 PhoneAccountingApp 同名注释。
   */
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkBusyKind, setBulkBusyKind] = useState<'initial' | 'manual' | null>(null);
  const [bulkNotice, setBulkNotice] = useState<string | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const initialBootstrapTriedRef = useRef<string | null>(null);

  const reloadEntries = useCallback(async () => {
    if (!ownerAgentId) {
      setEntries([]);
      setPendingDrafts([]);
      setDraftEdits({});
      return;
    }
    setLoading(true);
    setListError(null);
    try {
      const [rows, drafts] = await Promise.all([
        listAppEntries(ownerAgentId, SECONDHAND_APP_ID),
        listSecondhandDrafts(ownerAgentId),
      ]);
      setEntries(rows.map(normalizeSecondhandEntry).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)));
      setPendingDrafts(drafts);
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [ownerAgentId]);

  const draftWorkingValue = useCallback(
    (d: XingyePendingSecondhandDraft) => {
      const edit = draftEdits[d.id];
      if (edit) return edit;
      return {
        itemName: d.itemName,
        status: d.status,
        content: d.content ?? '',
        category: d.category ?? '',
        askingPrice: d.askingPrice ?? '',
        amountText: d.amount != null ? String(d.amount) : '',
        currency: d.currency ?? '',
      };
    },
    [draftEdits],
  );

  const handleDraftFieldChange = (
    draftId: string,
    patch: Partial<{
      itemName: string;
      status: SecondhandDraftStatus;
      content: string;
      category: string;
      askingPrice: string;
      amountText: string;
      currency: string;
    }>,
  ) => {
    setDraftEdits((prev) => {
      const d = pendingDrafts.find((entry) => entry.id === draftId);
      if (!d) return prev;
      const base = prev[draftId] ?? {
        itemName: d.itemName,
        status: d.status,
        content: d.content ?? '',
        category: d.category ?? '',
        askingPrice: d.askingPrice ?? '',
        amountText: d.amount != null ? String(d.amount) : '',
        currency: d.currency ?? '',
      };
      return { ...prev, [draftId]: { ...base, ...patch } };
    });
  };

  /**
   * 直通车：用 working（草稿字段 ± 用户在卡片上的临时编辑）直接确认进 entries。
   * delta / buyer 此路径上没编辑入口，沿用 draft 原值（confirmSecondhandDraft 内部把 undefined 当"沿用"）。
   */
  const handleConfirmDraft = async (d: XingyePendingSecondhandDraft) => {
    if (!ownerAgentId) return;
    setDraftBusyId(d.id);
    setDraftBusyKind('plain');
    setDraftError(null);
    try {
      const working = draftWorkingValue(d);
      const parsedAmount = parseAmountText(working.amountText);
      const entry = await confirmSecondhandDraft(ownerAgentId, d.id, {
        itemName: working.itemName,
        status: working.status,
        content: working.content.trim() ? working.content : null,
        category: working.category.trim() ? working.category : null,
        askingPrice: working.askingPrice.trim() ? working.askingPrice : null,
        amount: working.amountText.trim() ? (parsedAmount ?? null) : null,
        currency: working.currency.trim() ? working.currency : null,
      });
      const normalized = normalizeSecondhandEntry(entry);
      setEntries((prev) =>
        [normalized, ...prev.filter((p) => p.id !== normalized.id)].sort(
          (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
        ),
      );
      setPendingDrafts((prev) => prev.filter((p) => p.id !== d.id));
      setDraftEdits((prev) => {
        if (!(d.id in prev)) return prev;
        const { [d.id]: _omitted, ...rest } = prev;
        return rest;
      });
    } catch (err) {
      setDraftError(err instanceof Error ? err.message : String(err));
    } finally {
      setDraftBusyId(null);
      setDraftBusyKind(null);
    }
  };

  /**
   * 二段式：先调 generateSecondhandPolishWithAI 只重写 askingPrice / delta / buyer，
   * 再用润色后的三字段（覆盖 draft 原值）连同 working 的其它字段一起 confirm 进 entries。
   * itemName / content / status / category / reason / tags 永远 verbatim 锁——
   * polish prompt 不输出它们，即使模型乱写也只影响这三个字段，正文不会被污染。
   *
   * 任一步失败：保留 draft 不消失，把错误展示到 draftError，让用户决定走「确认生成」直通车还是重试。
   */
  const handleConfirmDraftWithPolish = async (d: XingyePendingSecondhandDraft) => {
    if (!ownerAgentId || !ownerAgent) return;
    setDraftBusyId(d.id);
    setDraftBusyKind('polish');
    setDraftError(null);
    try {
      const working = draftWorkingValue(d);
      const polish = await generateSecondhandPolishWithAI({
        agent: ownerAgent,
        ownerProfile: ownerProfile ?? null,
        draft: {
          itemName: working.itemName,
          status: working.status,
          category: working.category,
          content: working.content,
          reason: d.reason,
          tags: d.tags,
          askingPrice: working.askingPrice,
          delta: d.delta,
          buyer: d.buyer,
        },
      });
      // 优先沿用用户在草稿卡上手填的 amount/currency；用户没填时才用 polish 后的
      // askingPrice 本地解析结果（在 normalizeSecondhandPolishResult 里完成），避免覆盖
      // 用户手动改过的金额。
      const parsedAmount = parseAmountText(working.amountText);
      const fallbackAmount = polish.amount;
      const fallbackCurrency = polish.currency;
      const entry = await confirmSecondhandDraft(ownerAgentId, d.id, {
        itemName: working.itemName,
        status: working.status,
        content: working.content.trim() ? working.content : null,
        category: working.category.trim() ? working.category : null,
        askingPrice: polish.askingPrice ?? (working.askingPrice.trim() ? working.askingPrice : null),
        delta: polish.delta ?? undefined,
        buyer: polish.buyer ?? undefined,
        amount: working.amountText.trim()
          ? (parsedAmount ?? null)
          : (fallbackAmount ?? null),
        currency: working.currency.trim()
          ? working.currency
          : (fallbackCurrency ?? null),
      });
      const normalized = normalizeSecondhandEntry(entry);
      setEntries((prev) =>
        [normalized, ...prev.filter((p) => p.id !== normalized.id)].sort(
          (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
        ),
      );
      setPendingDrafts((prev) => prev.filter((p) => p.id !== d.id));
      setDraftEdits((prev) => {
        if (!(d.id in prev)) return prev;
        const { [d.id]: _omitted, ...rest } = prev;
        return rest;
      });
    } catch (err) {
      setDraftError(err instanceof Error ? err.message : String(err));
    } finally {
      setDraftBusyId(null);
      setDraftBusyKind(null);
    }
  };

  const handleDiscardDraft = async (d: XingyePendingSecondhandDraft) => {
    if (!ownerAgentId) return;
    if (!window.confirm('确定丢弃这条待确认二手草稿？此操作不可恢复，但角色可在下次巡检里重新提议。')) {
      return;
    }
    setDraftBusyId(d.id);
    setDraftBusyKind('discard');
    setDraftError(null);
    try {
      const ok = await discardSecondhandDraft(ownerAgentId, d.id);
      if (ok) {
        setPendingDrafts((prev) => prev.filter((p) => p.id !== d.id));
        setDraftEdits((prev) => {
          if (!(d.id in prev)) return prev;
          const { [d.id]: _omitted, ...rest } = prev;
          return rest;
        });
      } else {
        await reloadEntries();
      }
    } catch (err) {
      setDraftError(err instanceof Error ? err.message : String(err));
    } finally {
      setDraftBusyId(null);
      setDraftBusyKind(null);
    }
  };

  useEffect(() => {
    setSelectedId(null);
    setComposeOpen(false);
    setEditing(false);
    setSaveError(null);
    setListError(null);
    setBulkNotice(null);
    setBulkError(null);
    initialBootstrapTriedRef.current = null;
  }, [ownerAgentId]);

  useEffect(() => {
    void reloadEntries();
  }, [reloadEntries]);

  /**
   * 二手「历史批量生成」：与 PhoneShoppingApp 镜像（动词换成卖）。
   */
  const runBulkGeneration = useCallback(
    async (kind: 'initial' | 'manual') => {
      if (!ownerAgent || !ownerAgentId) return;
      const plan: BulkPlan = kind === 'initial'
        ? planInitialBulkRequest()
        : planBulkRequest(await loadHistoryState(ownerAgentId, 'secondhand'));
      setBulkBusy(true);
      setBulkBusyKind(kind);
      setBulkError(null);
      setBulkNotice(null);
      try {
        const rawDrafts = await generateSecondhandHistoryWithAI({
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
        // 见 PhoneAccountingApp 同名注释：填上模型没给的 occurredAt 空槽。
        const drafts = distributeOccurredAtFallback(rawDrafts, plan.endDays);
        if (drafts.length === 0) {
          throw new Error('模型未生成任何可用条目');
        }
        if (kind === 'initial') {
          for (const d of drafts) {
            const metadata: Record<string, unknown> = {
              status: d.status,
              platformStyle: d.platformStyle,
              itemName: d.itemName,
            };
            if (d.category) metadata.category = d.category;
            if (d.askingPrice) metadata.askingPrice = d.askingPrice;
            if (d.delta) metadata.delta = d.delta;
            if (d.buyer) metadata.buyer = d.buyer;
            if (d.amount !== undefined) metadata.amount = d.amount;
            if (d.currency) metadata.currency = d.currency;
            if (d.reason) metadata.reason = d.reason;
            if (d.tags && d.tags.length > 0) metadata.tags = d.tags;
            if (d.occurredAt) metadata.occurredAt = d.occurredAt;
            await appendAppEntry(ownerAgentId, SECONDHAND_APP_ID, {
              title: d.itemName,
              content: d.content,
              metadata,
              source: 'xingye-secondhand-init-history',
              createdAt: d.occurredAt,
            });
          }
        } else {
          for (const d of drafts) {
            await appendSecondhandDraft(ownerAgentId, {
              itemName: d.itemName,
              status: d.status,
              platformStyle: d.platformStyle,
              category: d.category,
              askingPrice: d.askingPrice,
              delta: d.delta,
              buyer: d.buyer,
              amount: d.amount,
              currency: d.currency,
              reason: d.reason,
              content: d.content,
              tags: d.tags,
              occurredAt: d.occurredAt,
              source: 'xingye-secondhand-bulk',
            });
          }
        }
        const now = new Date();
        await saveHistoryState(ownerAgentId, 'secondhand', {
          ...(kind === 'initial' ? { initializedAt: now.toISOString() } : {}),
          lastBulkAt: now.toISOString(),
          lastCoveredDate: toYmd(now),
        });
        setBulkNotice(
          kind === 'initial'
            ? `已为 TA 生成 ${drafts.length} 条过去 ${plan.endDays} 天的二手清单历史`
            : `已生成 ${drafts.length} 条草稿，请在待确认区检查（${plan.hintText}）`,
        );
        await reloadEntries();
      } catch (err) {
        setBulkError(err instanceof Error ? err.message : String(err));
      } finally {
        setBulkBusy(false);
        setBulkBusyKind(null);
      }
    },
    [ownerAgent, ownerAgentId, ownerProfile, reloadEntries],
  );

  useEffect(() => {
    if (!ownerAgent || !ownerAgentId) return;
    if (loading) return;
    if (initialBootstrapTriedRef.current === ownerAgentId) return;
    if (entries.length > 0) {
      initialBootstrapTriedRef.current = ownerAgentId;
      return;
    }
    initialBootstrapTriedRef.current = ownerAgentId;
    (async () => {
      try {
        const state = await loadHistoryState(ownerAgentId, 'secondhand');
        if (state.initializedAt) return;
        await runBulkGeneration('initial');
      } catch (err) {
        console.warn('[PhoneSecondhandApp] init bootstrap failed:', err);
      }
    })();
  }, [ownerAgent, ownerAgentId, loading, entries.length, runBulkGeneration]);

  const selected = useMemo(
    () => (selectedId ? entries.find((entry) => entry.id === selectedId) ?? null : null),
    [entries, selectedId],
  );

  const visibleEntries = useMemo(() => {
    if (filter === 'all') return entries;
    return entries.filter((entry) => entry.metadata.status === filter);
  }, [entries, filter]);

  /**
   * hero 区上 4 个统计数字。按 sold → listed → negotiating → to_sell → kept → delisted
   * 的优先级取「有数」的前 4 个状态。
   */
  const heroStats = useMemo(() => {
    const counts: Record<SecondhandEntryStatus, number> = {
      sold: 0, listed: 0, negotiating: 0, to_sell: 0, kept: 0, delisted: 0,
    };
    for (const e of entries) counts[e.metadata.status]++;
    const priority: SecondhandEntryStatus[] = ['sold', 'listed', 'negotiating', 'to_sell', 'kept', 'delisted'];
    return priority.filter((s) => counts[s] > 0).slice(0, 4).map((s) => ({
      status: s,
      label: STATUS_LABELS[s],
      count: counts[s],
    }));
  }, [entries]);

  const updateDraft = (patch: Partial<SecondhandDraft>) => {
    setDraft((prev) => ({ ...prev, ...patch }));
  };

  const openCompose = () => {
    setDraft(emptyDraft());
    setUserIntent('');
    setSaveError(null);
    setAiError(null);
    setComposeOpen(true);
    setEditing(false);
  };

  const openEdit = () => {
    if (!selected) return;
    setDraft(draftFromEntry(selected));
    setUserIntent('');
    setSaveError(null);
    setAiError(null);
    setComposeOpen(false);
    setEditing(true);
  };

  const handleGenerateDraft = async () => {
    if (!ownerAgent) return;
    setAiBusy(true);
    setAiError(null);
    try {
      const result = await generateSecondhandDraftWithAI({
        agent: ownerAgent,
        ownerProfile: ownerProfile ?? null,
        userIntent: userIntent.trim(),
      });
      setDraft({
        itemName: result.itemName,
        status: result.status,
        platformStyle: result.platformStyle,
        category: result.category ?? '',
        askingPrice: result.askingPrice ?? '',
        // amount + currency 由 parseImaginedPriceToMoney 从 askingPrice 本地确定性解析
        // （见 normalizeSecondhandDraftResult）。解析不出来（fallback 写法）→ 留空，由用户决定。
        amountText: result.amount != null ? String(result.amount) : '',
        currency: result.currency ?? '',
        delta: result.delta ?? '',
        buyer: result.buyer ?? '',
        reason: result.reason ?? '',
        tagsText: (result.tags ?? []).join(', '),
        content: result.content,
      });
    } catch (err) {
      setAiError(err instanceof Error ? err.message : String(err));
    } finally {
      setAiBusy(false);
    }
  };

  const saveDraft = async () => {
    if (!ownerAgentId) return;
    if (!draft.itemName.trim()) {
      setSaveError('请先写下物品名。');
      return;
    }
    setSaveBusy(true);
    setSaveError(null);
    try {
      const input = buildInputFromDraft(draft);
      if (editing && selected) {
        const updated = await updateAppEntry(ownerAgentId, SECONDHAND_APP_ID, selected.id, input);
        if (updated) {
          const normalized = normalizeSecondhandEntry(updated);
          setEntries((prev) =>
            prev.map((entry) => (entry.id === normalized.id ? normalized : entry)).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
          );
          setSelectedId(normalized.id);
        } else {
          await reloadEntries();
        }
        setEditing(false);
      } else {
        const row = normalizeSecondhandEntry(await appendAppEntry(ownerAgentId, SECONDHAND_APP_ID, input));
        setEntries((prev) => [row, ...prev.filter((entry) => entry.id !== row.id)]);
        setSelectedId(row.id);
        setComposeOpen(false);
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaveBusy(false);
    }
  };

  const handleDeleteSelected = async () => {
    if (!selected || !ownerAgentId) return;
    if (!window.confirm('确定删除这条二手记录？此操作不可恢复。')) return;
    setDeleteBusy(true);
    try {
      const ok = await deleteAppEntry(ownerAgentId, SECONDHAND_APP_ID, selected.id);
      if (ok) {
        setEntries((prev) => prev.filter((entry) => entry.id !== selected.id));
        setSelectedId(null);
        setEditing(false);
      } else {
        await reloadEntries();
      }
    } finally {
      setDeleteBusy(false);
    }
  };

  const closeEditor = () => {
    setComposeOpen(false);
    setEditing(false);
    setSaveError(null);
  };

  if (!ownerAgentId) {
    return (
      <div className={`${styles.phoneShell} ${styles.xyPalette}`} aria-label="二手记录">
        <div className={styles.phoneStatusBar}>
          <button type="button" className={styles.phoneBackButton} onClick={onBack}>
            返回首页
          </button>
          <span>二手</span>
        </div>
        <div className={styles.phoneBody}>
          <section className={styles.phoneAppCard}>
            <h3 className={styles.phoneAppTitle}>二手记录不可用</h3>
            <p className={styles.phoneAppHint}>请选择有效角色后再打开二手记录。</p>
          </section>
        </div>
      </div>
    );
  }

  const editorOpen = composeOpen || editing;
  const editorTitle = editing ? '编辑二手记录' : '新增二手记录';
  const ta = displayName || ownerAgent?.name || 'TA';

  return (
    <div className={`${styles.phoneShell} ${styles.xyPalette}`} aria-label="二手记录">
      <div className={styles.phoneStatusBar}>
        {selected && !editorOpen ? (
          <button type="button" className={styles.phoneBackButton} onClick={() => setSelectedId(null)}>
            返回列表
          </button>
        ) : (
          <button type="button" className={styles.phoneBackButton} onClick={editorOpen ? closeEditor : onBack}>
            {editorOpen ? '取消' : '返回首页'}
          </button>
        )}
        <span>二手</span>
      </div>

      <div className={styles.xyBody}>
        {listError ? (
          <p className={styles.phoneAppHint} role="alert" style={{ padding: '8px 18px' }}>
            加载失败：{listError}
          </p>
        ) : null}
        {loading && entries.length === 0 && !editorOpen && !selected ? (
          <p className={styles.phoneAppHint} style={{ padding: '8px 18px' }}>加载中…</p>
        ) : null}

        {editorOpen ? (
          <section
            className={styles.xyEditorWrap}
            aria-label={editorTitle}
            style={{ overflowY: 'auto' }}
          >
            <header className={styles.xyShopHero} style={{ padding: 0 }}>
              <p className={styles.xyShopKicker}>SIMULATED RECORD</p>
              <h2 className={styles.xyShopTitle}>{editorTitle}</h2>
              <p className={styles.xyShopSub}>只记录 TA 自己想出掉的旧物，不连接真实二手平台。</p>
            </header>
            <label className={styles.xyEditorField}>
              <span>二手意图</span>
              <textarea
                rows={2}
                value={userIntent}
                placeholder="可选：想让 TA 整理什么方向的二手想法"
                onChange={(e) => setUserIntent(e.target.value)}
                data-testid="phone-secondhand-intent-input"
              />
            </label>
            <button
              type="button"
              className={styles.xyBtnGhost}
              onClick={() => void handleGenerateDraft()}
              disabled={aiBusy || saveBusy || !ownerAgent}
              data-testid="phone-secondhand-ai-button"
              style={{ flex: '0 0 auto', alignSelf: 'flex-start' }}
            >
              {aiBusy ? '生成中…' : '让 TA 自己整理'}
            </button>
            {aiError ? (
              <p className={styles.xyEditorError} role="alert">{aiError}</p>
            ) : null}
            <label className={styles.xyEditorField}>
              <span>物品名</span>
              <input value={draft.itemName} onChange={(e) => updateDraft({ itemName: e.target.value })} />
            </label>
            <label className={styles.xyEditorField}>
              <span>状态</span>
              <select
                value={draft.status}
                onChange={(e) => updateDraft({ status: e.target.value as SecondhandEntryStatus })}
              >
                {FILTERS.filter((item) => item.value !== 'all').map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.xyEditorField}>
              <span>记录风格</span>
              <select
                value={draft.platformStyle}
                onChange={(e) => updateDraft({ platformStyle: e.target.value as SecondhandDraft['platformStyle'] })}
              >
                {Object.entries(PLATFORM_STYLE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.xyEditorField}>
              <span>类别</span>
              <input value={draft.category} onChange={(e) => updateDraft({ category: e.target.value })} />
            </label>
            <label className={styles.xyEditorField}>
              <span>期望卖价</span>
              <input
                value={draft.askingPrice}
                placeholder="按 TA 世界观写：现代¥/$ · 古代两银子 · 民国大洋 · 西幻金币 · 未来信用点"
                onChange={(e) => updateDraft({ askingPrice: e.target.value })}
              />
            </label>
            {/**
             * 金额组：数值 + 货币单位折一行。两者强绑——单独填数值没单位就不知道币种，
             * 单独填单位没数值也无法求和。填了金额组就视作有明确价格，列表/详情主价位
             * 槽位会优先显示「¥120」而不是「期望卖价」自由文本。
             */}
            <div style={{ display: 'flex', gap: 12 }}>
              <label className={styles.xyEditorField} style={{ flex: 1.6 }}>
                <span>记账金额</span>
                <input
                  inputMode="decimal"
                  value={draft.amountText}
                  placeholder="可选，纯数字（如 120，填了优先于期望卖价显示）"
                  onChange={(e) => updateDraft({ amountText: e.target.value })}
                />
              </label>
              <label className={styles.xyEditorField} style={{ flex: 1 }}>
                <span>货币单位</span>
                <input
                  value={draft.currency}
                  placeholder="¥ / 两银子 / 信用点"
                  onChange={(e) => updateDraft({ currency: e.target.value })}
                />
              </label>
            </div>
            <label className={styles.xyEditorField}>
              <span>价格 delta</span>
              <input
                value={draft.delta}
                placeholder="可选，与卖价同货币（『比当初买价低 ¥220』『省了半两』『卖不上价』）"
                onChange={(e) => updateDraft({ delta: e.target.value })}
              />
            </label>
            <label className={styles.xyEditorField}>
              <span>买家 / 接手人</span>
              <input
                value={draft.buyer}
                placeholder="可选，TA 想象里来接手的买家（如『巷口的旧书客』）"
                onChange={(e) => updateDraft({ buyer: e.target.value })}
              />
            </label>
            <label className={styles.xyEditorField}>
              <span>记录原因</span>
              <input value={draft.reason} onChange={(e) => updateDraft({ reason: e.target.value })} />
            </label>
            <label className={styles.xyEditorField}>
              <span>标签</span>
              <input value={draft.tagsText} onChange={(e) => updateDraft({ tagsText: e.target.value })} />
            </label>
            <label className={styles.xyEditorField}>
              <span>备注</span>
              <textarea
                rows={4}
                value={draft.content}
                onChange={(e) => updateDraft({ content: e.target.value })}
              />
            </label>
            {saveError ? (
              <p className={styles.xyEditorError} role="alert">{saveError}</p>
            ) : null}
            <div className={styles.xyEditorActions}>
              <button
                type="button"
                className={styles.xyEditorPrimary}
                onClick={saveDraft}
                disabled={saveBusy || aiBusy}
              >
                {editing ? '保存修改' : '保存记录'}
              </button>
            </div>
          </section>
        ) : selected ? (
          <SecondhandDetailView
            entry={selected}
            ta={ta}
            onEdit={openEdit}
            onDelete={handleDeleteSelected}
            deleteBusy={deleteBusy}
          />
        ) : (
          <div className={styles.xyScroll}>
            <header className={styles.xyShopHero}>
              <p className={styles.xyShopKicker}>RESALE NOTES</p>
              <h2 className={styles.xyShopTitle}>{ta} 的二手清单</h2>
              <p className={styles.xyShopSub}>
                模拟挂出、在谈和已出掉的旧物清单，不含真实交易、平台、成交价或链接。
              </p>
              {heroStats.length > 0 ? (
                <div className={styles.xyShopStats}>
                  {heroStats.map((s) => (
                    <span key={s.status}>
                      <b>{s.count}</b>
                      {s.label}
                    </span>
                  ))}
                </div>
              ) : null}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                <button
                  type="button"
                  className={styles.xyBtnGhost}
                  onClick={() => void runBulkGeneration('manual')}
                  disabled={bulkBusy || !ownerAgent}
                  data-testid="phone-secondhand-bulk-button"
                  title="批量生成最近几天的二手记录，自动补齐上次到今天的空白"
                >
                  {bulkBusy && bulkBusyKind === 'manual' ? '批量生成中…' : '批量新增'}
                </button>
              </div>
              {bulkBusy && bulkBusyKind === 'initial' ? (
                <p className={styles.phoneAppHint} style={{ margin: '8px 0 0' }}>
                  正在为 TA 初始化过去 14 天的二手清单历史…
                </p>
              ) : null}
              {bulkNotice ? (
                <p className={styles.phoneAppHint} style={{ margin: '8px 0 0' }}>{bulkNotice}</p>
              ) : null}
              {bulkError ? (
                <p className={styles.xyEditorError} role="alert" style={{ margin: '8px 0 0' }}>
                  批量生成失败：{bulkError}
                </p>
              ) : null}
            </header>

            {pendingDrafts.length > 0 ? (
              <section
                className={styles.xyDraftSection}
                aria-label="待确认二手草稿"
                data-testid="phone-secondhand-pending-drafts"
              >
                <p className={styles.xyDraftHeader}>待确认草稿 · 来自心跳巡检</p>
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
                      data-testid={`phone-secondhand-draft-${d.id}`}
                    >
                      <input
                        type="text"
                        className={styles.xyDraftInput}
                        value={working.itemName}
                        onChange={(e) => handleDraftFieldChange(d.id, { itemName: e.target.value })}
                        placeholder="物品名"
                        aria-label="待确认二手草稿物品名"
                        data-testid={`phone-secondhand-draft-name-${d.id}`}
                        disabled={busy}
                      />
                      <div className={styles.xyDraftRow}>
                        <select
                          className={styles.xyDraftSelect}
                          value={working.status}
                          onChange={(e) =>
                            handleDraftFieldChange(d.id, { status: e.target.value as SecondhandDraftStatus })
                          }
                          disabled={busy}
                          aria-label="待确认二手草稿状态"
                          data-testid={`phone-secondhand-draft-status-${d.id}`}
                        >
                          {FILTERS.filter((item) => item.value !== 'all').map((item) => (
                            <option key={item.value} value={item.value}>
                              {item.label}
                            </option>
                          ))}
                        </select>
                        <input
                          type="text"
                          className={styles.xyDraftInput}
                          value={working.category}
                          onChange={(e) => handleDraftFieldChange(d.id, { category: e.target.value })}
                          placeholder="类别（可选）"
                          aria-label="待确认二手草稿类别"
                          disabled={busy}
                        />
                        <input
                          type="text"
                          className={styles.xyDraftInput}
                          value={working.askingPrice}
                          onChange={(e) => handleDraftFieldChange(d.id, { askingPrice: e.target.value })}
                          placeholder="期望卖价（可选，按 TA 世界观选货币：¥/$/两银子/大洋/金币/信用点 …）"
                          aria-label="待确认二手草稿期望卖价"
                          disabled={busy}
                        />
                      </div>
                      <div className={styles.xyDraftRow}>
                        <input
                          type="text"
                          inputMode="decimal"
                          className={styles.xyDraftInput}
                          value={working.amountText}
                          onChange={(e) => handleDraftFieldChange(d.id, { amountText: e.target.value })}
                          placeholder="记账金额（可选，纯数字给账本求和用）"
                          aria-label="待确认二手草稿记账金额"
                          data-testid={`phone-secondhand-draft-amount-${d.id}`}
                          disabled={busy}
                        />
                        <input
                          type="text"
                          className={styles.xyDraftInput}
                          value={working.currency}
                          onChange={(e) => handleDraftFieldChange(d.id, { currency: e.target.value })}
                          placeholder="货币单位（可选，¥/两银子/信用点）"
                          aria-label="待确认二手草稿货币单位"
                          data-testid={`phone-secondhand-draft-currency-${d.id}`}
                          disabled={busy}
                        />
                      </div>
                      <textarea
                        className={styles.xyDraftTextarea}
                        value={working.content}
                        onChange={(e) => handleDraftFieldChange(d.id, { content: e.target.value })}
                        rows={2}
                        placeholder="备注（可选）"
                        aria-label="待确认二手草稿备注"
                        disabled={busy}
                      />
                      {d.reason ? (
                        <p className={styles.xyDraftReason}>理由：{d.reason}</p>
                      ) : null}
                      <div className={styles.xyDraftActions}>
                        <button
                          type="button"
                          className={styles.xyDraftConfirm}
                          onClick={() => void handleConfirmDraft(d)}
                          disabled={busy}
                          data-testid={`phone-secondhand-draft-confirm-${d.id}`}
                        >
                          {busy && draftBusyKind === 'plain' ? '处理中…' : '确认生成'}
                        </button>
                        <button
                          type="button"
                          className={styles.xyDraftConfirm}
                          onClick={() => void handleConfirmDraftWithPolish(d)}
                          disabled={busy}
                          data-testid={`phone-secondhand-draft-confirm-polish-${d.id}`}
                          title="先让 AI 按 TA 世界观货币润色 askingPrice / delta / buyer，再确认进清单"
                        >
                          {busy && draftBusyKind === 'polish' ? '润色中…' : '确认并润色价格'}
                        </button>
                        <button
                          type="button"
                          className={styles.xyDraftDiscard}
                          onClick={() => void handleDiscardDraft(d)}
                          disabled={busy}
                          data-testid={`phone-secondhand-draft-discard-${d.id}`}
                        >
                          丢弃
                        </button>
                      </div>
                    </div>
                  );
                })}
              </section>
            ) : null}

            <div className={styles.xySegWrap}>
              <div className={styles.xySeg} role="tablist" aria-label="二手状态筛选">
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
                data-testid="phone-secondhand-empty"
                style={{ padding: '24px 18px', textAlign: 'center' }}
              >
                还没有二手记录。
              </p>
            ) : null}

            <div className={styles.xyShopList}>
              {visibleEntries.map((entry) => {
                const days = daysAgo(entry.updatedAt);
                /**
                 * buyer 行优先级：metadata.buyer（AI/用户写的具体买家）
                 *   → category（"摄影 · 旧物"这种）
                 *   → platformStyle label 兜底（"清单感"等，最弱）
                 */
                const buyerLine = entry.metadata.buyer
                  || entry.metadata.category
                  || (entry.metadata.platformStyle && entry.metadata.platformStyle !== 'generic'
                    ? PLATFORM_STYLE_LABELS[entry.metadata.platformStyle]
                    : '');
                const amountLine = formatAmountWithCurrency(entry.metadata.amount, entry.metadata.currency);
                return (
                  <button
                    key={entry.id}
                    type="button"
                    className={styles.xyRowCard}
                    onClick={() => setSelectedId(entry.id)}
                  >
                    <aside className={styles.xyRowCardStub}>
                      <span className={styles.xyRowCardDay}>{formatDayStub(days)}</span>
                      <span className={styles.xyRowCardDayUnit}>天前</span>
                    </aside>
                    <div className={styles.xyRowCardBody}>
                      <div className={styles.xyRowCardTop}>
                        <StatusChip status={entry.metadata.status} />
                        {buyerLine ? <span className={styles.xyRowCardSeller}>{buyerLine}</span> : null}
                      </div>
                      <h3 className={styles.xyRowCardName}>{entry.metadata.itemName}</h3>
                      {entry.metadata.reason || entry.content ? (
                        <p className={styles.xyRowCardReason}>{entry.metadata.reason || entry.content}</p>
                      ) : null}
                      <div className={styles.xyRowCardFoot}>
                        {/**
                         * 主价位槽位二选一：amount/currency 有 → 显示「¥120」（机器可读，
                         * 也是接记账的语义）；否则降级 askingPrice 文本（"够换一壶酒"
                         * 这类推不出价格的氛围表达）。delta 始终作为次要小字（"卖不上价"
                         * 这类对比信息），与主价位独立。
                         */}
                        {amountLine ? (
                          <span
                            className={styles.xyRowCardPrice}
                            data-testid={`phone-secondhand-row-amount-${entry.id}`}
                          >
                            {amountLine}
                          </span>
                        ) : entry.metadata.askingPrice ? (
                          <span className={styles.xyRowCardPrice}>{entry.metadata.askingPrice}</span>
                        ) : null}
                        {entry.metadata.delta ? (
                          <span className={styles.xyRowCardDelta}>· {entry.metadata.delta}</span>
                        ) : null}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>

            <button
              type="button"
              className={styles.xyFab}
              onClick={openCompose}
              aria-label="新增二手记录"
            >
              新增二手记录
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function SecondhandDetailView({
  entry,
  ta,
  onEdit,
  onDelete,
  deleteBusy,
}: {
  entry: SecondhandEntry;
  ta: string;
  onEdit: () => void;
  onDelete: () => void;
  deleteBusy: boolean;
}) {
  const platform = entry.metadata.platformStyle ?? 'generic';
  const toneCls = PLATFORM_COVER_TONE[platform];
  const days = daysAgo(entry.updatedAt);
  const status = entry.metadata.status;
  const onMainline = isOnMainline(status);
  const currentIdx = onMainline ? TIMELINE_MAINLINE.findIndex((m) => m.key === status) : -1;
  const branchLabel = (() => {
    if (status === 'negotiating') return { title: '在谈中', hint: '有人来问，还在谈。' };
    if (status === 'kept') return { title: '留下了', hint: '想了想，还是舍不得卖。' };
    if (status === 'delisted') {
      return { title: '已撤下', hint: entry.metadata.reason ?? '没卖掉，先撤回来。' };
    }
    return null;
  })();

  return (
    <div className={`${styles.xyDetail} ${styles.xyScroll}`}>
      <div className={`${styles.xyDetailCover} ${toneCls}`}>
        <div className={styles.xyDetailCoverTop}>
          <span className={styles.xyDetailCoverCat}>
            {entry.metadata.category ?? '记录'}
          </span>
          <span className={styles.xyDetailCoverSeller}>
            {entry.metadata.buyer ?? ta}
          </span>
        </div>
        <h1 className={styles.xyDetailCoverName}>{entry.metadata.itemName}</h1>
        <div className={styles.xyDetailCoverFoot}>
          <StatusChip status={status} solid />
          {platform !== 'generic' ? (
            <span className={`${styles.xyChip} ${styles.xyChipTintSlate}`}>
              {PLATFORM_STYLE_LABELS[platform]}
            </span>
          ) : null}
        </div>
      </div>

      <div className={styles.xyDetailBody}>
        <p className={styles.phoneShoppingSafeNote}>
          这只是 TA 自己的小手机二手记录，不连接真实平台。
        </p>
        <p className={styles.xyDetailMeta}>
          {metaVerb(status)} {formatDayStub(days)} 天前
        </p>

        {(() => {
          const amountLine = formatAmountWithCurrency(entry.metadata.amount, entry.metadata.currency);
          if (!amountLine && !entry.metadata.askingPrice && !entry.metadata.delta) return null;
          return (
            <div className={styles.xyDetailPriceRow}>
              {/** 主价位槽位：见 row card 同名注释（amount 优先于 askingPrice）。 */}
              {amountLine ? (
                <span
                  className={styles.xyDetailPrice}
                  data-testid={`phone-secondhand-detail-amount-${entry.id}`}
                >
                  {amountLine}
                </span>
              ) : entry.metadata.askingPrice ? (
                <span className={styles.xyDetailPrice}>{entry.metadata.askingPrice}</span>
              ) : null}
              {entry.metadata.delta ? (
                <span className={styles.xyDetailDelta}>{entry.metadata.delta}</span>
              ) : null}
            </div>
          );
        })()}

        {entry.content || entry.metadata.reason ? (
          <div className={styles.xyDetailNote}>
            <p className={styles.xyDetailNoteKicker}>— 记下的话</p>
            {entry.content ? (
              <p className={styles.xyDetailNoteText}>{entry.content}</p>
            ) : null}
            {entry.metadata.reason ? (
              <p className={styles.xyDetailNoteReason}>{entry.metadata.reason}</p>
            ) : null}
          </div>
        ) : null}

        <div className={styles.xyDetailSection}>
          <p className={styles.xyDetailSecTitle}>状态时间线</p>
          {onMainline ? (
            <ol className={styles.xyDetailTimeline}>
              {TIMELINE_MAINLINE.map((node, idx) => {
                const dotCls =
                  idx < currentIdx
                    ? `${styles.xyDetailTimelineDot} ${styles.xyDetailTimelineDotDone}`
                    : idx === currentIdx
                      ? `${styles.xyDetailTimelineDot} ${styles.xyDetailTimelineDotActive}`
                      : styles.xyDetailTimelineDot;
                const rowCls = idx > currentIdx
                  ? `${styles.xyDetailTimelineRow} ${styles.xyDetailTimelinePending}`
                  : styles.xyDetailTimelineRow;
                return (
                  <li key={node.key}>
                    <span className={dotCls} />
                    <span className={rowCls}>
                      <b>{node.label}</b>
                      <i>{idx === currentIdx ? `${formatDayStub(days)} 天前` : idx < currentIdx ? '已经过' : '—'}</i>
                    </span>
                  </li>
                );
              })}
            </ol>
          ) : branchLabel ? (
            <div className={styles.xyDetailBranchCard}>
              <p className={styles.xyDetailBranchTitle}>{branchLabel.title}</p>
              <p className={styles.xyDetailBranchHint}>{branchLabel.hint}</p>
            </div>
          ) : null}
        </div>

        {entry.metadata.tags && entry.metadata.tags.length > 0 ? (
          <div className={styles.xyDetailSection}>
            <p className={styles.xyDetailSecTitle}>标签</p>
            <div className={styles.xyDetailTagRow}>
              {entry.metadata.tags.map((t) => (
                <span key={t} className={`${styles.xyChip} ${styles.xyChipTintSage}`}>
                  #{t}
                </span>
              ))}
            </div>
          </div>
        ) : null}

        <div className={styles.xyDetailActions}>
          <button type="button" className={styles.xyBtnGhost} onClick={onEdit}>
            编辑记录
          </button>
          <button
            type="button"
            className={`${styles.xyBtnGhost} ${styles.xyBtnGhostDanger}`}
            onClick={onDelete}
            disabled={deleteBusy}
          >
            删除这条记录
          </button>
        </div>
      </div>
    </div>
  );
}
