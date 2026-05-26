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
  appendShoppingDraft,
  confirmShoppingDraft,
  discardShoppingDraft,
  listShoppingDrafts,
  type ShoppingDraftStatus,
  type XingyePendingShoppingDraft,
} from './xingye-shopping-drafts';
import type { XingyeRoleProfile } from './xingye-profile-store';
import {
  generateShoppingDraftWithAI,
  generateShoppingHistoryWithAI,
  generateShoppingPolishWithAI,
} from './xingye-shopping-ai';
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

export interface PhoneShoppingAppProps {
  ownerAgent: Agent | null;
  ownerProfile?: XingyeRoleProfile | null;
  displayName: string;
  onBack: () => void;
}

export type ShoppingEntryStatus =
  | 'wanted'
  | 'ordered'
  | 'received'
  | 'hesitating'
  | 'returned'
  | 'favorite';

export type ShoppingEntryMetadata = {
  status: ShoppingEntryStatus;
  platformStyle?: 'amazon' | 'taobao' | 'xianyu' | 'generic';
  itemName: string;
  category?: string;
  reason?: string;
  imaginedPrice?: string;
  /**
   * 卖家 / 店家名（如「光阴二手店」「街口那家成衣」）。
   * 列表卡 mono 行和详情封面右上角显示，给清单加氛围。
   * AI 生成时给短小的虚构店名；用户手填可空。
   */
  seller?: string;
  /**
   * 价格 delta 短语（如「比想象便宜 ¥220」「凑得起」「省了半两」）。
   * 与 imaginedPrice 共用同一货币体系（现代 ¥/$、古代两银子、西幻金币、未来信用点 …）。
   * 列表 row-card-foot 和详情 detail-price-row 的次要小字。
   */
  delta?: string;
  /**
   * 记账用数值金额。`imaginedPrice` 是给人看的氛围文本，`amount` 是给记账模块按
   * 币种求和用的纯数值，与 `currency` 搭配。两者独立，可只填其一。
   */
  amount?: number;
  /** `amount` 的货币单位（¥ / $ / 两银子 / 金币 / 信用点 …）。 */
  currency?: string;
  tags?: string[];
};

type ShoppingEntry = AppEntry & {
  appId: 'shopping';
  metadata: ShoppingEntryMetadata;
};

type ShoppingDraft = {
  itemName: string;
  status: ShoppingEntryStatus;
  platformStyle: NonNullable<ShoppingEntryMetadata['platformStyle']>;
  category: string;
  imaginedPrice: string;
  amountText: string;
  currency: string;
  delta: string;
  seller: string;
  reason: string;
  tagsText: string;
  content: string;
};

const SHOPPING_APP_ID = 'shopping';

const STATUS_LABELS: Record<ShoppingEntryStatus, string> = {
  wanted: '想买',
  hesitating: '犹豫',
  ordered: '已下单',
  received: '已收到',
  favorite: '已收藏',
  returned: '已退掉',
};

/**
 * 6 种 status → 5 色 tone（terracotta/sage/ochre/plum/slate）。
 * 见 optimized/IMPLEMENTATION_NOTES.md 1.2 表。
 */
type ChipTone = 'terracotta' | 'sage' | 'ochre' | 'plum' | 'slate';

const STATUS_TONES: Record<ShoppingEntryStatus, ChipTone> = {
  wanted: 'ochre',
  hesitating: 'slate',
  ordered: 'terracotta',
  received: 'sage',
  favorite: 'plum',
  returned: 'slate',
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

const FILTERS: Array<{ value: 'all' | ShoppingEntryStatus; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'wanted', label: '想买' },
  { value: 'hesitating', label: '犹豫' },
  { value: 'ordered', label: '已下单' },
  { value: 'received', label: '已收到' },
  { value: 'favorite', label: '已收藏' },
  { value: 'returned', label: '已退掉' },
];

const PLATFORM_STYLE_LABELS: Record<NonNullable<ShoppingEntryMetadata['platformStyle']>, string> = {
  generic: '普通记录',
  amazon: '清单感',
  taobao: '订单感',
  xianyu: '闲置感',
};

/**
 * `platformStyle` → 详情封面色调。见 optimized/IMPLEMENTATION_NOTES.md 1.5。
 */
const PLATFORM_COVER_TONE: Record<NonNullable<ShoppingEntryMetadata['platformStyle']>, string> = {
  amazon: styles.xyToneGold,
  taobao: styles.xyToneWarm,
  xianyu: styles.xyToneCool,
  generic: styles.xyTonePlum,
};

/**
 * 状态主线时间线（wanted → ordered → received）。
 * hesitating / favorite / returned 不在主线上，单独渲染状态卡片（detail-branch-card）。
 */
const TIMELINE_MAINLINE: Array<{ key: ShoppingEntryStatus; label: string }> = [
  { key: 'wanted', label: '想买' },
  { key: 'ordered', label: '已下单' },
  { key: 'received', label: '已收到' },
];

function isOnMainline(status: ShoppingEntryStatus): boolean {
  return TIMELINE_MAINLINE.some((m) => m.key === status);
}

function emptyDraft(): ShoppingDraft {
  return {
    itemName: '',
    status: 'wanted',
    platformStyle: 'generic',
    category: '',
    imaginedPrice: '',
    amountText: '',
    currency: '',
    delta: '',
    seller: '',
    reason: '',
    tagsText: '',
    content: '',
  };
}

function isShoppingStatus(value: unknown): value is ShoppingEntryStatus {
  return (
    value === 'wanted' ||
    value === 'ordered' ||
    value === 'received' ||
    value === 'hesitating' ||
    value === 'returned' ||
    value === 'favorite'
  );
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((tag) => (typeof tag === 'string' ? tag.trim() : ''))
    .filter(Boolean)
    .slice(0, 8);
}

function normalizeShoppingEntry(entry: AppEntry): ShoppingEntry {
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
    appId: 'shopping',
    metadata: {
      status: isShoppingStatus(meta.status) ? meta.status : 'wanted',
      platformStyle,
      itemName,
      category: typeof meta.category === 'string' && meta.category.trim() ? meta.category.trim() : undefined,
      reason: typeof meta.reason === 'string' && meta.reason.trim() ? meta.reason.trim() : undefined,
      imaginedPrice:
        typeof meta.imaginedPrice === 'string' && meta.imaginedPrice.trim()
          ? meta.imaginedPrice.trim()
          : undefined,
      seller:
        typeof meta.seller === 'string' && meta.seller.trim() ? meta.seller.trim() : undefined,
      delta:
        typeof meta.delta === 'string' && meta.delta.trim() ? meta.delta.trim() : undefined,
      amount: normalizeAmount(meta.amount),
      currency: normalizeCurrency(meta.currency),
      tags: normalizeTags(meta.tags),
    },
  };
}

function draftFromEntry(entry: ShoppingEntry): ShoppingDraft {
  return {
    itemName: entry.metadata.itemName || entry.title,
    status: entry.metadata.status,
    platformStyle: entry.metadata.platformStyle ?? 'generic',
    category: entry.metadata.category ?? '',
    imaginedPrice: entry.metadata.imaginedPrice ?? '',
    amountText: entry.metadata.amount != null ? String(entry.metadata.amount) : '',
    currency: entry.metadata.currency ?? '',
    delta: entry.metadata.delta ?? '',
    seller: entry.metadata.seller ?? '',
    reason: entry.metadata.reason ?? '',
    tagsText: (entry.metadata.tags ?? []).join(', '),
    content: entry.content,
  };
}

function buildInputFromDraft(draft: ShoppingDraft) {
  const itemName = draft.itemName.trim();
  const tags = draft.tagsText
    .split(/[,，]/)
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 8);
  const metadata: ShoppingEntryMetadata = {
    status: draft.status,
    platformStyle: draft.platformStyle,
    itemName,
  };
  const category = draft.category.trim();
  const imaginedPrice = draft.imaginedPrice.trim();
  const amount = parseAmountText(draft.amountText);
  const currency = normalizeCurrency(draft.currency);
  const delta = draft.delta.trim();
  const seller = draft.seller.trim();
  const reason = draft.reason.trim();
  if (category) metadata.category = category;
  if (imaginedPrice) metadata.imaginedPrice = imaginedPrice;
  if (amount !== undefined) metadata.amount = amount;
  if (currency) metadata.currency = currency;
  if (delta) metadata.delta = delta;
  if (seller) metadata.seller = seller;
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
 * 把 amount + currency 拼成主价位短文本，例如 `¥99` / `99 两银子`。
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

/** 详情页 meta 行的动词：「记于 / 下单于 / 收到于 X 天前」 */
function metaVerb(status: ShoppingEntryStatus): string {
  if (status === 'ordered') return '下单于';
  if (status === 'received') return '收到于';
  return '记于';
}

function StatusChip({ status, solid }: { status: ShoppingEntryStatus; solid?: boolean }) {
  const tone = STATUS_TONES[status];
  const variantCls = solid ? TONE_SOLID_CLASS[tone] : TONE_TINT_CLASS[tone];
  return <span className={`${styles.xyChip} ${variantCls}`}>{STATUS_LABELS[status]}</span>;
}

export function PhoneShoppingApp({ ownerAgent, ownerProfile, displayName, onBack }: PhoneShoppingAppProps) {
  const ownerAgentId = ownerAgent?.id ?? '';
  const [entries, setEntries] = useState<ShoppingEntry[]>([]);
  const [pendingDrafts, setPendingDrafts] = useState<XingyePendingShoppingDraft[]>([]);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | ShoppingEntryStatus>('all');
  const [composeOpen, setComposeOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ShoppingDraft>(() => emptyDraft());
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
      status: ShoppingDraftStatus;
      content: string;
      category: string;
      imaginedPrice: string;
      amountText: string;
      currency: string;
    }>
  >({});
  const [draftBusyId, setDraftBusyId] = useState<string | null>(null);
  /**
   * 草稿卡 busy 区分：'plain' = 直通车「确认生成」；'polish' = 二段式「确认并润色价格」；
   * 'discard' = 丢弃；null = 空闲。
   * 跟 MomentsPanel 的 draftBusyKind 同款——让两个按钮的"处理中…"文案各显示在自己头上，
   * 而不是同时变灰让用户搞不清哪个在跑。
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
        listAppEntries(ownerAgentId, SHOPPING_APP_ID),
        listShoppingDrafts(ownerAgentId),
      ]);
      setEntries(rows.map(normalizeShoppingEntry).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)));
      setPendingDrafts(drafts);
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [ownerAgentId]);

  const draftWorkingValue = useCallback(
    (d: XingyePendingShoppingDraft) => {
      const edit = draftEdits[d.id];
      if (edit) return edit;
      return {
        itemName: d.itemName,
        status: d.status,
        content: d.content ?? '',
        category: d.category ?? '',
        imaginedPrice: d.imaginedPrice ?? '',
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
      status: ShoppingDraftStatus;
      content: string;
      category: string;
      imaginedPrice: string;
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
        imaginedPrice: d.imaginedPrice ?? '',
        amountText: d.amount != null ? String(d.amount) : '',
        currency: d.currency ?? '',
      };
      return { ...prev, [draftId]: { ...base, ...patch } };
    });
  };

  /**
   * 直通车：用 working（草稿字段 ± 用户在卡片上的临时编辑）直接确认进 entries。
   * 不动 imaginedPrice / delta / seller 之外的字段。delta / seller 此路径上没编辑入口，
   * 沿用 draft 原值（confirmShoppingDraft 内部把 undefined 当"沿用"）。
   */
  const handleConfirmDraft = async (d: XingyePendingShoppingDraft) => {
    if (!ownerAgentId) return;
    setDraftBusyId(d.id);
    setDraftBusyKind('plain');
    setDraftError(null);
    try {
      const working = draftWorkingValue(d);
      const parsedAmount = parseAmountText(working.amountText);
      const entry = await confirmShoppingDraft(ownerAgentId, d.id, {
        itemName: working.itemName,
        status: working.status,
        content: working.content.trim() ? working.content : null,
        category: working.category.trim() ? working.category : null,
        imaginedPrice: working.imaginedPrice.trim() ? working.imaginedPrice : null,
        amount: working.amountText.trim() ? (parsedAmount ?? null) : null,
        currency: working.currency.trim() ? working.currency : null,
      });
      const normalized = normalizeShoppingEntry(entry);
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
   * 二段式：先调 generateShoppingPolishWithAI 只重写 imaginedPrice / delta / seller，
   * 再用润色后的三字段（覆盖 draft 原值）连同 working 的其它字段一起 confirm 进 entries。
   * itemName / content / status / category / reason / tags 永远 verbatim 锁——
   * polish prompt 不输出它们，即使模型乱写也只影响这三个字段，正文不会被污染。
   *
   * 任一步失败：保留 draft 不消失，把错误展示到 draftError，让用户决定走「确认生成」直通车还是重试。
   */
  const handleConfirmDraftWithPolish = async (d: XingyePendingShoppingDraft) => {
    if (!ownerAgentId || !ownerAgent) return;
    setDraftBusyId(d.id);
    setDraftBusyKind('polish');
    setDraftError(null);
    try {
      const working = draftWorkingValue(d);
      const polish = await generateShoppingPolishWithAI({
        agent: ownerAgent,
        ownerProfile: ownerProfile ?? null,
        draft: {
          itemName: working.itemName,
          status: working.status,
          category: working.category,
          content: working.content,
          reason: d.reason,
          tags: d.tags,
          imaginedPrice: working.imaginedPrice,
          delta: d.delta,
          seller: d.seller,
        },
      });
      // 优先沿用用户在草稿卡上手填的 amount/currency；用户没填时才用 polish 后的
      // imaginedPrice 本地解析结果（在 normalizeShoppingPolishResult 里完成），避免覆盖
      // 用户手动改过的金额。
      const parsedAmount = parseAmountText(working.amountText);
      const fallbackAmount = polish.amount;
      const fallbackCurrency = polish.currency;
      const entry = await confirmShoppingDraft(ownerAgentId, d.id, {
        itemName: working.itemName,
        status: working.status,
        content: working.content.trim() ? working.content : null,
        category: working.category.trim() ? working.category : null,
        imaginedPrice: polish.imaginedPrice ?? (working.imaginedPrice.trim() ? working.imaginedPrice : null),
        delta: polish.delta ?? undefined,
        seller: polish.seller ?? undefined,
        amount: working.amountText.trim()
          ? (parsedAmount ?? null)
          : (fallbackAmount ?? null),
        currency: working.currency.trim()
          ? working.currency
          : (fallbackCurrency ?? null),
      });
      const normalized = normalizeShoppingEntry(entry);
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

  const handleDiscardDraft = async (d: XingyePendingShoppingDraft) => {
    if (!ownerAgentId) return;
    if (!window.confirm('确定丢弃这条待确认购物草稿？此操作不可恢复，但角色可在下次巡检里重新提议。')) {
      return;
    }
    setDraftBusyId(d.id);
    setDraftBusyKind('discard');
    setDraftError(null);
    try {
      const ok = await discardShoppingDraft(ownerAgentId, d.id);
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
   * 历史批量生成的核心实现。
   * 初始化（kind='initial'）→ 直接写入 entries.jsonl（绕过 draft 流，避免初次打开就被一堆草稿淹没）；
   * 批量新增（kind='manual'）→ 写入 drafts.jsonl，沿用现有 draft 检查路径。
   * 任意 kind 成功后都更新 history-state.json，让 init 不再重跑、gap-fill 范围可计算。
   */
  const runBulkGeneration = useCallback(
    async (kind: 'initial' | 'manual') => {
      if (!ownerAgent || !ownerAgentId) return;
      const plan: BulkPlan = kind === 'initial'
        ? planInitialBulkRequest()
        : planBulkRequest(await loadHistoryState(ownerAgentId, 'shopping'));
      setBulkBusy(true);
      setBulkBusyKind(kind);
      setBulkError(null);
      setBulkNotice(null);
      try {
        const rawDrafts = await generateShoppingHistoryWithAI({
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
            if (d.imaginedPrice) metadata.imaginedPrice = d.imaginedPrice;
            if (d.delta) metadata.delta = d.delta;
            if (d.seller) metadata.seller = d.seller;
            if (d.amount !== undefined) metadata.amount = d.amount;
            if (d.currency) metadata.currency = d.currency;
            if (d.reason) metadata.reason = d.reason;
            if (d.tags && d.tags.length > 0) metadata.tags = d.tags;
            if (d.occurredAt) metadata.occurredAt = d.occurredAt;
            await appendAppEntry(ownerAgentId, SHOPPING_APP_ID, {
              title: d.itemName,
              content: d.content,
              metadata,
              source: 'xingye-shopping-init-history',
              // 行卡「X 天前」用 entry.updatedAt；初始化要让它回到 occurredAt 那一天。
              createdAt: d.occurredAt,
            });
          }
        } else {
          for (const d of drafts) {
            await appendShoppingDraft(ownerAgentId, {
              itemName: d.itemName,
              status: d.status,
              platformStyle: d.platformStyle,
              category: d.category,
              imaginedPrice: d.imaginedPrice,
              delta: d.delta,
              seller: d.seller,
              amount: d.amount,
              currency: d.currency,
              reason: d.reason,
              content: d.content,
              tags: d.tags,
              occurredAt: d.occurredAt,
              source: 'xingye-shopping-bulk',
            });
          }
        }
        const now = new Date();
        await saveHistoryState(ownerAgentId, 'shopping', {
          ...(kind === 'initial' ? { initializedAt: now.toISOString() } : {}),
          lastBulkAt: now.toISOString(),
          lastCoveredDate: toYmd(now),
        });
        setBulkNotice(
          kind === 'initial'
            ? `已为 TA 生成 ${drafts.length} 条过去 ${plan.endDays} 天的购物历史`
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

  /**
   * 首次打开 app 自动初始化：entries 空 + state.initializedAt 缺失 → 跑一次。
   * 已 init 或已有 entries 都跳过——防止"删光后又自动重灌"。
   */
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
        const state = await loadHistoryState(ownerAgentId, 'shopping');
        if (state.initializedAt) return;
        await runBulkGeneration('initial');
      } catch (err) {
        console.warn('[PhoneShoppingApp] init bootstrap failed:', err);
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
   * hero 区上 4 个统计数字。按 ordered → received → hesitating → wanted → favorite → returned
   * 的优先级取「有数」的前 4 个状态。
   */
  const heroStats = useMemo(() => {
    const counts: Record<ShoppingEntryStatus, number> = {
      ordered: 0, received: 0, hesitating: 0, wanted: 0, favorite: 0, returned: 0,
    };
    for (const e of entries) counts[e.metadata.status]++;
    const priority: ShoppingEntryStatus[] = ['ordered', 'received', 'hesitating', 'wanted', 'favorite', 'returned'];
    return priority.filter((s) => counts[s] > 0).slice(0, 4).map((s) => ({
      status: s,
      label: STATUS_LABELS[s],
      count: counts[s],
    }));
  }, [entries]);

  const updateDraft = (patch: Partial<ShoppingDraft>) => {
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
      const result = await generateShoppingDraftWithAI({
        agent: ownerAgent,
        ownerProfile: ownerProfile ?? null,
        userIntent: userIntent.trim(),
      });
      setDraft({
        itemName: result.itemName,
        status: result.status,
        platformStyle: result.platformStyle,
        category: result.category ?? '',
        imaginedPrice: result.imaginedPrice ?? '',
        // amount + currency 由 parseImaginedPriceToMoney 从 imaginedPrice 本地确定性解析
        // （见 normalizeShoppingDraftResult）。解析不出来（fallback 写法）→ 留空，由用户决定。
        amountText: result.amount != null ? String(result.amount) : '',
        currency: result.currency ?? '',
        delta: result.delta ?? '',
        seller: result.seller ?? '',
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
        const updated = await updateAppEntry(ownerAgentId, SHOPPING_APP_ID, selected.id, input);
        if (updated) {
          const normalized = normalizeShoppingEntry(updated);
          setEntries((prev) =>
            prev.map((entry) => (entry.id === normalized.id ? normalized : entry)).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
          );
          setSelectedId(normalized.id);
        } else {
          await reloadEntries();
        }
        setEditing(false);
      } else {
        const row = normalizeShoppingEntry(await appendAppEntry(ownerAgentId, SHOPPING_APP_ID, input));
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
    if (!window.confirm('确定删除这条购物记录？此操作不可恢复。')) return;
    setDeleteBusy(true);
    try {
      const ok = await deleteAppEntry(ownerAgentId, SHOPPING_APP_ID, selected.id);
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
      <div className={`${styles.phoneShell} ${styles.xyPalette}`} aria-label="购物记录">
        <div className={styles.phoneStatusBar}>
          <button type="button" className={styles.phoneBackButton} onClick={onBack}>
            返回首页
          </button>
          <span>购物</span>
        </div>
        <div className={styles.phoneBody}>
          <section className={styles.phoneAppCard}>
            <h3 className={styles.phoneAppTitle}>购物记录不可用</h3>
            <p className={styles.phoneAppHint}>请选择有效角色后再打开购物记录。</p>
          </section>
        </div>
      </div>
    );
  }

  const editorOpen = composeOpen || editing;
  const editorTitle = editing ? '编辑购物记录' : '新增购物记录';
  const ta = displayName || ownerAgent?.name || 'TA';

  return (
    <div className={`${styles.phoneShell} ${styles.xyPalette}`} aria-label="购物记录">
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
        <span>购物</span>
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
              <p className={styles.xyShopSub}>只记录 TA 自己的小手机购物想法，不连接真实平台。</p>
            </header>
            <label className={styles.xyEditorField}>
              <span>购物意图</span>
              <textarea
                rows={2}
                value={userIntent}
                placeholder="可选：想让 TA 整理什么方向的购物想法"
                onChange={(e) => setUserIntent(e.target.value)}
                data-testid="phone-shopping-intent-input"
              />
            </label>
            <button
              type="button"
              className={styles.xyBtnGhost}
              onClick={() => void handleGenerateDraft()}
              disabled={aiBusy || saveBusy || !ownerAgent}
              data-testid="phone-shopping-ai-button"
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
                onChange={(e) => updateDraft({ status: e.target.value as ShoppingEntryStatus })}
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
                onChange={(e) => updateDraft({ platformStyle: e.target.value as ShoppingDraft['platformStyle'] })}
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
              <span>价格感</span>
              <input
                value={draft.imaginedPrice}
                placeholder="按 TA 世界观写：现代¥/$ · 古代两银子 · 民国大洋 · 西幻金币 · 未来信用点"
                onChange={(e) => updateDraft({ imaginedPrice: e.target.value })}
              />
            </label>
            {/**
             * 金额组：数值 + 货币单位折一行。两者强绑——单独填数值没单位就不知道币种，
             * 单独填单位没数值也无法求和。填了金额组就视作有明确价格，列表/详情主价位
             * 槽位会优先显示「¥99」而不是「价格感」自由文本。
             */}
            <div style={{ display: 'flex', gap: 12 }}>
              <label className={styles.xyEditorField} style={{ flex: 1.6 }}>
                <span>记账金额</span>
                <input
                  inputMode="decimal"
                  value={draft.amountText}
                  placeholder="可选，纯数字（如 99，填了优先于价格感显示）"
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
                placeholder="可选，与价格感同货币（『比想象便宜 ¥220』『省了半两』『凑得起』）"
                onChange={(e) => updateDraft({ delta: e.target.value })}
              />
            </label>
            <label className={styles.xyEditorField}>
              <span>卖家 / 店名</span>
              <input
                value={draft.seller}
                placeholder="可选，TA 想象里的小店或卖家（如『光阴二手店』）"
                onChange={(e) => updateDraft({ seller: e.target.value })}
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
          <ShoppingDetailView
            entry={selected}
            ta={ta}
            onEdit={openEdit}
            onDelete={handleDeleteSelected}
            deleteBusy={deleteBusy}
          />
        ) : (
          <div className={styles.xyScroll}>
            <header className={styles.xyShopHero}>
              <p className={styles.xyShopKicker}>SHOPPING NOTES</p>
              <h2 className={styles.xyShopTitle}>{ta} 的购物清单</h2>
              <p className={styles.xyShopSub}>
                模拟订单、收藏和想买清单，不含真实购买、推荐、价格查询或链接。
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
                  data-testid="phone-shopping-bulk-button"
                  title="批量生成最近几天的购物记录，自动补齐上次到今天的空白"
                >
                  {bulkBusy && bulkBusyKind === 'manual' ? '批量生成中…' : '批量新增'}
                </button>
              </div>
              {bulkBusy && bulkBusyKind === 'initial' ? (
                <p className={styles.phoneAppHint} style={{ margin: '8px 0 0' }}>
                  正在为 TA 初始化过去 14 天的购物历史…
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
                aria-label="待确认购物草稿"
                data-testid="phone-shopping-pending-drafts"
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
                      data-testid={`phone-shopping-draft-${d.id}`}
                    >
                      <input
                        type="text"
                        className={styles.xyDraftInput}
                        value={working.itemName}
                        onChange={(e) => handleDraftFieldChange(d.id, { itemName: e.target.value })}
                        placeholder="物品名"
                        aria-label="待确认购物草稿物品名"
                        data-testid={`phone-shopping-draft-name-${d.id}`}
                        disabled={busy}
                      />
                      <div className={styles.xyDraftRow}>
                        <select
                          className={styles.xyDraftSelect}
                          value={working.status}
                          onChange={(e) =>
                            handleDraftFieldChange(d.id, { status: e.target.value as ShoppingDraftStatus })
                          }
                          disabled={busy}
                          aria-label="待确认购物草稿状态"
                          data-testid={`phone-shopping-draft-status-${d.id}`}
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
                          aria-label="待确认购物草稿类别"
                          disabled={busy}
                        />
                        <input
                          type="text"
                          className={styles.xyDraftInput}
                          value={working.imaginedPrice}
                          onChange={(e) => handleDraftFieldChange(d.id, { imaginedPrice: e.target.value })}
                          placeholder="价格感（可选，按 TA 世界观选货币：¥/$/两银子/大洋/金币/信用点 …）"
                          aria-label="待确认购物草稿价格感"
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
                          aria-label="待确认购物草稿记账金额"
                          data-testid={`phone-shopping-draft-amount-${d.id}`}
                          disabled={busy}
                        />
                        <input
                          type="text"
                          className={styles.xyDraftInput}
                          value={working.currency}
                          onChange={(e) => handleDraftFieldChange(d.id, { currency: e.target.value })}
                          placeholder="货币单位（可选，¥/两银子/信用点）"
                          aria-label="待确认购物草稿货币单位"
                          data-testid={`phone-shopping-draft-currency-${d.id}`}
                          disabled={busy}
                        />
                      </div>
                      <textarea
                        className={styles.xyDraftTextarea}
                        value={working.content}
                        onChange={(e) => handleDraftFieldChange(d.id, { content: e.target.value })}
                        rows={2}
                        placeholder="备注（可选）"
                        aria-label="待确认购物草稿备注"
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
                          data-testid={`phone-shopping-draft-confirm-${d.id}`}
                        >
                          {busy && draftBusyKind === 'plain' ? '处理中…' : '确认生成'}
                        </button>
                        <button
                          type="button"
                          className={styles.xyDraftConfirm}
                          onClick={() => void handleConfirmDraftWithPolish(d)}
                          disabled={busy}
                          data-testid={`phone-shopping-draft-confirm-polish-${d.id}`}
                          title="先让 AI 按 TA 世界观货币润色 imaginedPrice / delta / seller，再确认进订单"
                        >
                          {busy && draftBusyKind === 'polish' ? '润色中…' : '确认并润色价格'}
                        </button>
                        <button
                          type="button"
                          className={styles.xyDraftDiscard}
                          onClick={() => void handleDiscardDraft(d)}
                          disabled={busy}
                          data-testid={`phone-shopping-draft-discard-${d.id}`}
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
              <div className={styles.xySeg} role="tablist" aria-label="购物状态筛选">
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
                data-testid="phone-shopping-empty"
                style={{ padding: '24px 18px', textAlign: 'center' }}
              >
                还没有购物记录。
              </p>
            ) : null}

            <div className={styles.xyShopList}>
              {visibleEntries.map((entry) => {
                const days = daysAgo(entry.updatedAt);
                /**
                 * seller 行优先级：metadata.seller（AI/用户写的具体店名）
                 *   → category（"摄影 · 二手"这种）
                 *   → platformStyle label 兜底（"清单感"等，最弱）
                 */
                const sellerLine = entry.metadata.seller
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
                        {sellerLine ? <span className={styles.xyRowCardSeller}>{sellerLine}</span> : null}
                      </div>
                      <h3 className={styles.xyRowCardName}>{entry.metadata.itemName}</h3>
                      {entry.metadata.reason || entry.content ? (
                        <p className={styles.xyRowCardReason}>{entry.metadata.reason || entry.content}</p>
                      ) : null}
                      <div className={styles.xyRowCardFoot}>
                        {/**
                         * 主价位槽位二选一：amount/currency 有 → 显示「¥99」（机器可读，
                         * 也是接记账的语义）；否则降级 imaginedPrice 文本（"约一杯奶茶钱"
                         * 这类推不出价格的氛围表达）。delta 始终作为次要小字（"降价 ¥20"
                         * 这类对比信息），与主价位独立。
                         */}
                        {amountLine ? (
                          <span
                            className={styles.xyRowCardPrice}
                            data-testid={`phone-shopping-row-amount-${entry.id}`}
                          >
                            {amountLine}
                          </span>
                        ) : entry.metadata.imaginedPrice ? (
                          <span className={styles.xyRowCardPrice}>{entry.metadata.imaginedPrice}</span>
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
              aria-label="新增购物记录"
            >
              新增购物记录
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ShoppingDetailView({
  entry,
  ta,
  onEdit,
  onDelete,
  deleteBusy,
}: {
  entry: ShoppingEntry;
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
    if (status === 'hesitating') return { title: '犹豫中', hint: '还没决定要不要。' };
    if (status === 'favorite') return { title: '已收藏', hint: '留个想头。' };
    if (status === 'returned') {
      return { title: '已退掉', hint: entry.metadata.reason ?? '和想象的不一样。' };
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
            {entry.metadata.seller ?? ta}
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
          这只是 TA 自己的小手机购物记录，不连接真实平台。
        </p>
        <p className={styles.xyDetailMeta}>
          {metaVerb(status)} {formatDayStub(days)} 天前
        </p>

        {(() => {
          const amountLine = formatAmountWithCurrency(entry.metadata.amount, entry.metadata.currency);
          if (!amountLine && !entry.metadata.imaginedPrice && !entry.metadata.delta) return null;
          return (
            <div className={styles.xyDetailPriceRow}>
              {/** 主价位槽位：见 row card 同名注释（amount 优先于 imaginedPrice）。 */}
              {amountLine ? (
                <span
                  className={styles.xyDetailPrice}
                  data-testid={`phone-shopping-detail-amount-${entry.id}`}
                >
                  {amountLine}
                </span>
              ) : entry.metadata.imaginedPrice ? (
                <span className={styles.xyDetailPrice}>{entry.metadata.imaginedPrice}</span>
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
