import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Agent } from '../types';
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
  type Ledger,
  type LedgerCurrencyTotals,
  type LedgerEntry,
} from './xingye-accounting-ledger';
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

export interface PhoneAccountingAppProps {
  ownerAgent: Agent | null;
  ownerProfile?: XingyeRoleProfile | null;
  displayName: string;
  onBack: () => void;
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

const WESTERN_PREFIX_CURRENCY = /^[¥$€£￥]$/;

function formatAmountWithCurrency(amount: number | null, currency: string | null): string {
  if (amount === null) return '—';
  const num = Number.isInteger(amount)
    ? String(amount)
    : amount.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  if (!currency) return num;
  if (WESTERN_PREFIX_CURRENCY.test(currency)) return `${currency}${num}`;
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

export function PhoneAccountingApp({ ownerAgent, ownerProfile, displayName, onBack }: PhoneAccountingAppProps) {
  const ownerAgentId = ownerAgent?.id ?? '';
  const [ledger, setLedger] = useState<Ledger>({ entries: [], summary: { byCurrency: [], missingAmountCount: 0 } });
  const [pendingDrafts, setPendingDrafts] = useState<XingyePendingAccountingDraft[]>([]);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterValue>('all');
  const [composeOpen, setComposeOpen] = useState(false);
  const [compose, setCompose] = useState<ComposeDraft>(() => emptyCompose());
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

  const reload = useCallback(async () => {
    if (!ownerAgentId) {
      setLedger({ entries: [], summary: { byCurrency: [], missingAmountCount: 0 } });
      setPendingDrafts([]);
      setDraftEdits({});
      return;
    }
    setLoading(true);
    setListError(null);
    try {
      const [lg, drafts] = await Promise.all([
        loadLedger(ownerAgentId),
        listAccountingDrafts(ownerAgentId),
      ]);
      setLedger(lg);
      setPendingDrafts(drafts);
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [ownerAgentId]);

  useEffect(() => {
    setComposeOpen(false);
    setSaveError(null);
    setListError(null);
    setBulkNotice(null);
    setBulkError(null);
    initialBootstrapTriedRef.current = null;
  }, [ownerAgentId]);

  useEffect(() => {
    void reload();
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
        : planBulkRequest(await loadHistoryState(ownerAgentId, 'accounting'));
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
        const drafts = distributeOccurredAtFallback(rawDrafts, plan.endDays);
        if (drafts.length === 0) {
          throw new Error('模型未生成任何可用条目');
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
        setBulkNotice(
          kind === 'initial'
            ? `已为 TA 生成 ${drafts.length} 条过去 ${plan.endDays} 天的账目历史`
            : `已生成 ${drafts.length} 条草稿，请在待确认区检查（${plan.hintText}）`,
        );
        await reload();
      } catch (err) {
        setBulkError(err instanceof Error ? err.message : String(err));
      } finally {
        setBulkBusy(false);
        setBulkBusyKind(null);
      }
    },
    [ownerAgent, ownerAgentId, ownerProfile, reload],
  );

  /**
   * 首次打开 app 时的自动初始化：
   *  - entries 为空 + history-state 没 initializedAt → 跑初始化；
   *  - 任何一条不满足 → 跳过（不会"删光后又自动重灌"）。
   */
  useEffect(() => {
    if (!ownerAgent || !ownerAgentId) return;
    if (loading) return;
    if (initialBootstrapTriedRef.current === ownerAgentId) return;
    if (ledger.entries.length > 0) {
      initialBootstrapTriedRef.current = ownerAgentId;
      return;
    }
    initialBootstrapTriedRef.current = ownerAgentId;
    (async () => {
      try {
        const state = await loadHistoryState(ownerAgentId, 'accounting');
        if (state.initializedAt) return;
        await runBulkGeneration('initial');
      } catch (err) {
        console.warn('[PhoneAccountingApp] init bootstrap failed:', err);
      }
    })();
  }, [ownerAgent, ownerAgentId, loading, ledger.entries.length, runBulkGeneration]);

  const visibleEntries = useMemo(() => {
    if (filter === 'all') return ledger.entries;
    return ledger.entries.filter((e) => e.direction === filter);
  }, [ledger.entries, filter]);

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
          onClick={composeOpen ? closeCompose : onBack}
        >
          {composeOpen ? '取消' : '返回首页'}
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
        ) : (
          <div className={styles.xyScroll}>
            <header className={styles.xyShopHero}>
              <p className={styles.xyShopKicker}>LEDGER NOTES</p>
              <h2 className={styles.xyShopTitle}>{ta} 的账本</h2>
              <p className={styles.xyShopSub}>
                工资、房租、餐饮、人情……购物 / 二手之外的现金流。多币种独立分组，不跨币换算。
              </p>
            </header>

            {/* 多币种汇总卡片：每张卡显示一种货币的收入/支出/净值 */}
            {ledger.summary.byCurrency.length > 0 ? (
              <section className={styles.xyDraftSection} aria-label="账本汇总">
                <p className={styles.xyDraftHeader}>
                  账本汇总
                  {ledger.summary.missingAmountCount > 0
                    ? ` · ${ledger.summary.missingAmountCount} 笔待补金额`
                    : ''}
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {ledger.summary.byCurrency.map((b, idx) => (
                    <CurrencyTotalsCard key={b.currency || `__empty_${idx}`} totals={b} />
                  ))}
                </div>
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

            {/* 账本列表 */}
            <div className={styles.xyShopList}>
              {visibleEntries.map((e) => (
                <LedgerRow key={`${e.source}::${e.id}`} entry={e} onDelete={() => void handleDeleteEntry(e)} />
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

function CurrencyTotalsCard({ totals }: { totals: LedgerCurrencyTotals }) {
  const currencyLabel = totals.currency || '未标注币种';
  return (
    <div className={styles.xyDraftCard} aria-label={`${currencyLabel} 汇总`}>
      <div className={styles.xyDraftRow} style={{ alignItems: 'baseline', gap: 18 }}>
        <strong style={{ fontSize: 15 }}>{currencyLabel}</strong>
        <span>
          收入 <b>{formatAmountWithCurrency(totals.income, totals.currency || null)}</b>
        </span>
        <span>
          支出 <b>{formatAmountWithCurrency(totals.expense, totals.currency || null)}</b>
        </span>
        <span>
          净 <b>{formatAmountWithCurrency(totals.net, totals.currency || null)}</b>
        </span>
        <span style={{ marginLeft: 'auto', opacity: 0.6 }}>{totals.realizedCount} 笔</span>
      </div>
    </div>
  );
}

function LedgerRow({ entry, onDelete }: { entry: LedgerEntry; onDelete: () => void }) {
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
  return (
    <div className={styles.xyRowCard} style={{ cursor: 'default' }}>
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
          {!entry.realized ? (
            <span className={`${styles.xyChip} ${styles.xyChipTintSlate}`}>未实现</span>
          ) : null}
          {entry.category ? (
            <span className={styles.xyRowCardSeller}>{entry.category}</span>
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
          {entry.source === 'accounting' ? (
            <button
              type="button"
              className={styles.xyBtnGhost}
              onClick={onDelete}
              style={{ marginLeft: 'auto', padding: '2px 10px', fontSize: 12 }}
              aria-label={`删除记账 ${entry.title}`}
            >
              删除
            </button>
          ) : null}
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

