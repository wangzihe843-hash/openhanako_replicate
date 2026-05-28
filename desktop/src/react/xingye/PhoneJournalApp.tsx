import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Agent } from '../types';
import { useStore } from '../stores';
import { loadHistoryState, saveHistoryState } from './xingye-app-history-state';
import styles from './XingyeShell.module.css';
import { generateJournalDraftWithAI, generateJournalHistoryWithAI } from './xingye-journal-ai';
import {
  appendJournalEntry,
  confirmJournalDraft,
  deleteJournalEntry,
  discardJournalDraft,
  listJournalDrafts,
  listJournalEntries,
  type XingyeJournalDraft,
  type XingyeJournalEntry,
} from './xingye-journal-store';
import { useXingyeRoleProfile } from './xingye-profile-store';

export interface PhoneJournalAppProps {
  ownerAgent: Agent | null;
  displayName: string;
  onBack: () => void;
}

const CN_NUMERALS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
const CN_WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

function chineseDay(d: number): string {
  if (d <= 10) return CN_NUMERALS[d - 1];
  if (d < 20) return `十${CN_NUMERALS[d - 11]}`;
  if (d === 20) return '二十';
  if (d < 30) return `二十${CN_NUMERALS[d - 21]}`;
  if (d === 30) return '三十';
  return `三十${CN_NUMERALS[d - 31]}`;
}

function chineseMonth(m: number): string {
  if (m === 1) return '一月';
  if (m === 2) return '二月';
  if (m === 3) return '三月';
  if (m === 4) return '四月';
  if (m === 5) return '五月';
  if (m === 6) return '六月';
  if (m === 7) return '七月';
  if (m === 8) return '八月';
  if (m === 9) return '九月';
  if (m === 10) return '十月';
  if (m === 11) return '十一月';
  return '十二月';
}

/**
 * 设计稿风格的日组标题："今天 · 五月十四  星期四" / "五月十二  星期二"。
 *
 * 整组都是 dateSmudged 时，列表分组渲染层直接走「时间已模糊」走另一路，
 * 不进这里——所以这里假设 dayKey 都是真实日期。
 */
function formatGroupHeading(dayKey: string): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const today = new Date();
  const isToday =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  const cnDate = `${chineseMonth(m)}${chineseDay(d)}`;
  const weekday = `星期${CN_WEEKDAYS[date.getDay()]}`;
  return isToday ? `今天 · ${cnDate}  ${weekday}` : `${cnDate}  ${weekday}`;
}

/** dateSmudged 条目共用的分组标签——"墨迹模糊·年代不可考"。 */
const SMUDGED_GROUP_HEADING = '墨迹模糊 · 年代不可考';
/** 详情页 meta 行的污损替代文案。 */
const SMUDGED_DETAIL_LABEL = '· · ·  墨迹模糊  · · ·';

/**
 * 详情页 meta 行的日期格式："2026 · 05 · 14 · THU"。
 */
function dayLabelForDetail(dayKey: string): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const weekday = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][date.getDay()];
  const mm = String(m).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  return `${y} · ${mm} · ${dd} · ${weekday}`;
}

/**
 * 不同日记卡的 washi tape 颜色（按 entry index 循环）。
 */
const WASHI_TAPE_COLORS = ['#fbe3a8', '#f4b5b5', '#c5e4d0', '#d6c7f0', '#b8d4ec'];

/** 列表索引用：不展示全文，避免长日记占满列表 */
function excerptForJournalList(body: string, maxChars = 96): string {
  const collapsed = body.replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, Math.max(1, maxChars - 1))}…`;
}

export function PhoneJournalApp({ ownerAgent, displayName, onBack }: PhoneJournalAppProps) {
  const ownerAgentId = ownerAgent?.id ?? '';
  const ownerProfile = useXingyeRoleProfile(ownerAgentId);
  const [entries, setEntries] = useState<XingyeJournalEntry[]>([]);
  const [pendingDrafts, setPendingDrafts] = useState<XingyeJournalDraft[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftBody, setDraftBody] = useState('');
  const [draftMood, setDraftMood] = useState('');
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [draftAiBusy, setDraftAiBusy] = useState(false);
  const [draftAiError, setDraftAiError] = useState<string | null>(null);
  /**
   * 待确认草稿区的「行内编辑缓冲」。Key = draft.id。
   * 用户在小手机里改了字、还没按「确认生成」前，先在内存里保留改动；
   * 离开页面再回来时回退到 drafts.jsonl 的最新内容（草稿本身已落盘，不会丢）。
   */
  const [draftEdits, setDraftEdits] = useState<
    Record<string, { title: string; body: string; mood: string }>
  >({});
  const [draftBusyId, setDraftBusyId] = useState<string | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  /**
   * 「去和 TA 聊聊」入口的轻量确认提示。点完按钮 4s 自动复位。
   * 走 stagedChatQuote 槽：见 memory `feedback_share_to_chat_no_navigation` —
   * 不能直接写 quotedSelection，跨 session 会被清。
   */
  const [sharedToChatId, setSharedToChatId] = useState<string | null>(null);

  /**
   * 首次打开日记 app 的一次性初始化（按 lore 生成 3–5 篇过去日记）。
   * - initBusy / initError / initNotice 控制 UI 状态。
   * - initialBootstrapTriedRef 在 ownerAgentId 切换时复位；同一 owner 一个 mount 周期
   *   最多尝试一次，失败也不会无限重试（不写 initializedAt → 下次重新打开会再试）。
   */
  const initialBootstrapTriedRef = useRef<string | null>(null);
  const [initBusy, setInitBusy] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [initNotice, setInitNotice] = useState<string | null>(null);

  const reloadEntries = useCallback(async () => {
    if (!ownerAgentId) {
      setEntries([]);
      setPendingDrafts([]);
      setDraftEdits({});
      return;
    }
    setListLoading(true);
    setListError(null);
    try {
      const [rows, drafts] = await Promise.all([
        listJournalEntries(ownerAgentId),
        listJournalDrafts(ownerAgentId),
      ]);
      setEntries(rows);
      setPendingDrafts(drafts);
    } catch (e) {
      setListError(e instanceof Error ? e.message : String(e));
    } finally {
      setListLoading(false);
    }
  }, [ownerAgentId]);

  useEffect(() => {
    setSelectedId(null);
    setComposeOpen(false);
    setSaveError(null);
    setListError(null);
    setDraftError(null);
    setDraftEdits({});
    initialBootstrapTriedRef.current = null;
    setInitError(null);
    setInitNotice(null);
  }, [ownerAgentId]);

  useEffect(() => {
    void reloadEntries();
  }, [reloadEntries]);

  /**
   * 「首次打开日记」初始化：按 lore 生成 3–5 篇过去日记，直接写入 entries.jsonl
   * （走 appendJournalEntry，不走 draft 流——和购物 init 一致；首次打开不该被 5 条
   * 待确认草稿淹没）。条数从 [3,5] 内随机；模型给的 dayKey 跨期分布，缺失/无效项
   * 由 normalizeJournalHistoryResults 兜底撒在过去 30–360 天范围。
   *
   * 成功才写 history-state.initializedAt——失败时不写，用户下次打开会重试，但
   * 同一个 mount 周期不会反复触发（initialBootstrapTriedRef）。
   */
  const runInitialBootstrap = useCallback(async () => {
    if (!ownerAgent || !ownerAgentId) return;
    setInitBusy(true);
    setInitError(null);
    setInitNotice(null);
    try {
      const desiredCount = 3 + Math.floor(Math.random() * 3);
      const drafts = await generateJournalHistoryWithAI({
        agent: ownerAgent,
        ownerProfile: ownerProfile ?? null,
        desiredCount,
      });
      if (drafts.length === 0) {
        throw new Error('模型未生成任何历史日记');
      }
      /** 按 dayKey 升序 append，让 entries.jsonl 行序和真实时间序一致；列表显示靠
       *  内存里的 sortJournalEntries 重新按 dayKey 倒序，跟当前用户写的日记走同一条路。
       *  dateSmudged 条目用哨兵 0001-01-01，会自然排到最末。 */
      const sorted = [...drafts].sort((a, b) => (a.dayKey < b.dayKey ? -1 : 1));
      for (const d of sorted) {
        await appendJournalEntry(ownerAgentId, {
          title: d.title,
          body: d.body,
          dayKey: d.dayKey,
          mood: d.mood,
          dateSmudged: d.dateSmudged,
        });
      }
      await saveHistoryState(ownerAgentId, 'journal', {
        initializedAt: new Date().toISOString(),
      });
      setInitNotice(`已为 TA 整理出 ${drafts.length} 篇过去的日记`);
      await reloadEntries();
    } catch (e) {
      setInitError(e instanceof Error ? e.message : String(e));
    } finally {
      setInitBusy(false);
    }
  }, [ownerAgent, ownerAgentId, ownerProfile, reloadEntries]);

  useEffect(() => {
    if (!ownerAgent || !ownerAgentId) return;
    if (listLoading) return;
    if (initBusy) return;
    if (initialBootstrapTriedRef.current === ownerAgentId) return;
    // 已经有 entries 或 pendingDrafts → 视为已初始化过（或 agent 心跳已经垫了草稿），跳过。
    if (entries.length > 0 || pendingDrafts.length > 0) {
      initialBootstrapTriedRef.current = ownerAgentId;
      return;
    }
    initialBootstrapTriedRef.current = ownerAgentId;
    (async () => {
      try {
        const state = await loadHistoryState(ownerAgentId, 'journal');
        if (state.initializedAt) return;
        /**
         * 二次确认：初次 mount 时 reloadEntries 还没跑完，外层 entries.length=0 不能
         * 当真——直接落盘问一次。也覆盖老用户场景（在加这个功能之前已经写过日记但没
         * initializedAt marker）：发现有内容就只补 marker、不真的跑生成。
         */
        const [freshEntries, freshDrafts] = await Promise.all([
          listJournalEntries(ownerAgentId),
          listJournalDrafts(ownerAgentId),
        ]);
        if (freshEntries.length > 0 || freshDrafts.length > 0) {
          await saveHistoryState(ownerAgentId, 'journal', {
            initializedAt: new Date().toISOString(),
          });
          return;
        }
        await runInitialBootstrap();
      } catch (err) {
        console.warn('[PhoneJournalApp] init bootstrap failed:', err);
      }
    })();
  }, [
    ownerAgent,
    ownerAgentId,
    listLoading,
    initBusy,
    entries.length,
    pendingDrafts.length,
    runInitialBootstrap,
  ]);

  const draftWorkingValue = useCallback(
    (draft: XingyeJournalDraft) => {
      const edit = draftEdits[draft.id];
      if (edit) return edit;
      return { title: draft.title, body: draft.body, mood: draft.mood ?? '' };
    },
    [draftEdits],
  );

  const handleDraftFieldChange = (
    draftId: string,
    patch: Partial<{ title: string; body: string; mood: string }>,
  ) => {
    setDraftEdits((prev) => {
      const base = prev[draftId] ?? null;
      const draft = pendingDrafts.find((d) => d.id === draftId);
      if (!draft) return prev;
      const current = base ?? { title: draft.title, body: draft.body, mood: draft.mood ?? '' };
      return { ...prev, [draftId]: { ...current, ...patch } };
    });
  };

  const handleConfirmDraft = async (draft: XingyeJournalDraft) => {
    if (!ownerAgentId) return;
    setDraftBusyId(draft.id);
    setDraftError(null);
    try {
      const working = draftWorkingValue(draft);
      const moodTrim = working.mood.trim();
      const entry = await confirmJournalDraft(ownerAgentId, draft.id, {
        title: working.title,
        body: working.body,
        dayKey: draft.dayKey,
        mood: moodTrim ? moodTrim : null,
      });
      setEntries((prev) => {
        const next = [entry, ...prev.filter((p) => p.id !== entry.id)];
        next.sort((a, b) => {
          if (a.dayKey !== b.dayKey) return a.dayKey < b.dayKey ? 1 : -1;
          const taMs = Date.parse(a.createdAt);
          const tbMs = Date.parse(b.createdAt);
          return tbMs - taMs;
        });
        return next;
      });
      setPendingDrafts((prev) => prev.filter((d) => d.id !== draft.id));
      setDraftEdits((prev) => {
        if (!(draft.id in prev)) return prev;
        const { [draft.id]: _omitted, ...rest } = prev;
        return rest;
      });
    } catch (e) {
      setDraftError(e instanceof Error ? e.message : String(e));
    } finally {
      setDraftBusyId(null);
    }
  };

  const handleDiscardDraft = async (draft: XingyeJournalDraft) => {
    if (!ownerAgentId) return;
    if (!window.confirm('确定丢弃这条待确认草稿？此操作不可恢复，但角色可在下次巡检里重新提议。')) {
      return;
    }
    setDraftBusyId(draft.id);
    setDraftError(null);
    try {
      const ok = await discardJournalDraft(ownerAgentId, draft.id);
      if (ok) {
        setPendingDrafts((prev) => prev.filter((d) => d.id !== draft.id));
        setDraftEdits((prev) => {
          if (!(draft.id in prev)) return prev;
          const { [draft.id]: _omitted, ...rest } = prev;
          return rest;
        });
      } else {
        await reloadEntries();
      }
    } catch (e) {
      setDraftError(e instanceof Error ? e.message : String(e));
    } finally {
      setDraftBusyId(null);
    }
  };

  const selected = useMemo(
    () => (selectedId ? entries.find((e) => e.id === selectedId) ?? null : null),
    [entries, selectedId],
  );

  const grouped = useMemo(() => {
    const map = new Map<string, XingyeJournalEntry[]>();
    const sorted = [...entries].sort((a, b) => (a.dayKey < b.dayKey ? 1 : a.dayKey > b.dayKey ? -1 : 0));
    for (const e of sorted) {
      const list = map.get(e.dayKey) ?? [];
      list.push(e);
      map.set(e.dayKey, list);
    }
    return Array.from(map.entries());
  }, [entries]);

  const ta = displayName || ownerAgent?.name || 'TA';

  const openCompose = () => {
    setDraftTitle('');
    setDraftBody('');
    setDraftMood('');
    setSaveError(null);
    setDraftAiError(null);
    setComposeOpen(true);
  };

  const handleGenerateDraft = async () => {
    if (!ownerAgent) return;
    setDraftAiBusy(true);
    setDraftAiError(null);
    try {
      const r = await generateJournalDraftWithAI({ agent: ownerAgent, ownerProfile });
      setDraftTitle(r.title);
      setDraftBody(r.body);
      if (r.mood) setDraftMood(r.mood);
    } catch (e) {
      setDraftAiError(e instanceof Error ? e.message : String(e));
    } finally {
      setDraftAiBusy(false);
    }
  };

  const saveCompose = async () => {
    const title = draftTitle.trim() || '无标题';
    const body = draftBody.trim();
    if (!body || !ownerAgentId) {
      return;
    }
    setSaveBusy(true);
    setSaveError(null);
    try {
      const mood = draftMood.trim() || undefined;
      const row = await appendJournalEntry(ownerAgentId, { title, body, mood });
      setEntries((prev) => {
        const next = [row, ...prev.filter((p) => p.id !== row.id)];
        next.sort((a, b) => {
          if (a.dayKey !== b.dayKey) return a.dayKey < b.dayKey ? 1 : -1;
          const taMs = Date.parse(a.createdAt);
          const tbMs = Date.parse(b.createdAt);
          return tbMs - taMs;
        });
        return next;
      });
      setComposeOpen(false);
      setSelectedId(row.id);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaveBusy(false);
    }
  };

  useEffect(() => {
    if (!sharedToChatId) return undefined;
    const timer = setTimeout(() => setSharedToChatId(null), 4000);
    return () => clearTimeout(timer);
  }, [sharedToChatId]);

  const handleShareToChat = useCallback(
    (entry: XingyeJournalEntry) => {
      const lines: string[] = [];
      lines.push(`《${entry.title}》`);
      lines.push(entry.dateSmudged ? SMUDGED_DETAIL_LABEL : dayLabelForDetail(entry.dayKey));
      if (entry.mood) lines.push(`心情：「${entry.mood}」`);
      lines.push('');
      lines.push(entry.body);
      const text = lines.join('\n').trim();
      if (!text) return;
      useStore.getState().stageChatQuote({
        text,
        sourceTitle: `日记 · ${entry.title}`,
        sourceKind: 'journal',
        charCount: text.length,
        updatedAt: Date.now(),
      });
      setSharedToChatId(entry.id);
    },
    [],
  );

  const handleDeleteSelected = async () => {
    if (!selected || !ownerAgentId) return;
    if (!window.confirm('确定删除这条日记？此操作不可恢复。')) return;
    setDeleteBusy(true);
    try {
      const ok = await deleteJournalEntry(ownerAgentId, selected.id);
      if (ok) {
        setEntries((prev) => prev.filter((e) => e.id !== selected.id));
        setSelectedId(null);
      } else {
        await reloadEntries();
      }
    } finally {
      setDeleteBusy(false);
    }
  };

  if (!ownerAgentId) {
    return (
      <div className={styles.phoneShell} aria-label="日记">
        <div className={styles.phoneStatusBar}>
          <button type="button" className={styles.phoneBackButton} onClick={onBack}>
            返回首页
          </button>
          <span>日记</span>
        </div>
        <div className={styles.phoneBody}>
          <section className={styles.phoneAppCard}>
            <h3 className={styles.phoneAppTitle}>日记不可用</h3>
            <p className={styles.phoneAppHint}>
              未选择角色 / 小手机不可用。日记写入当前角色在 HANA_HOME 下的星野目录，不能使用隐式角色回退。
            </p>
            <p className={styles.phoneAppHint}>请返回星野角色页，选择有效角色后再打开小手机日记。</p>
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.phoneShell} aria-label="日记">
      <div className={styles.phoneStatusBar}>
        {selected ? (
          <button type="button" className={styles.phoneBackButton} onClick={() => setSelectedId(null)}>
            返回列表
          </button>
        ) : (
          <button type="button" className={styles.phoneBackButton} onClick={onBack}>
            返回首页
          </button>
        )}
        <span>日记</span>
      </div>

      <div className={styles.phoneBody}>
        {listError ? (
          <p className={styles.phoneAppHint} role="alert">
            加载失败：{listError}
          </p>
        ) : null}
        {listLoading && entries.length === 0 ? <p className={styles.phoneAppHint}>加载中…</p> : null}
        {initBusy ? (
          <p
            className={styles.phoneAppHint}
            role="status"
            data-testid="phone-journal-init-busy"
          >
            正在为 {ta} 翻找过去几页旧日记…（首次打开根据背景设定生成 3–5 篇过去日记）
          </p>
        ) : null}
        {initError ? (
          <p
            className={styles.phoneAppHint}
            role="alert"
            data-testid="phone-journal-init-error"
          >
            初始化历史日记失败：{initError}（下次打开会重试；也可以先点「记」自己写一条）
          </p>
        ) : null}
        {initNotice && !initBusy ? (
          <p
            className={styles.phoneAppHint}
            role="status"
            data-testid="phone-journal-init-notice"
          >
            {initNotice}
          </p>
        ) : null}

        {!selected ? (
          <div className={styles.phoneJournalLayout}>
            <div aria-hidden className={styles.phoneJournalPaperTexture} />
            <header className={styles.phoneJournalPageHeader}>
              <div className={styles.phoneJournalKicker}>JOURNAL · 日记本</div>
              <h2 className={styles.phoneJournalPageTitle}>{ta} 的日记</h2>
            </header>

            {pendingDrafts.length > 0 ? (
              <section
                className={styles.phoneJournalGroup}
                aria-label="待确认日记草稿"
                data-testid="phone-journal-pending-drafts"
              >
                <div className={styles.phoneJournalGroupLabel}>
                  <span aria-hidden className={styles.phoneJournalGroupDash} />
                  <span>待确认草稿 · 来自心跳巡检</span>
                </div>
                <p className={styles.phoneAppHint} style={{ margin: '4px 12px 12px' }}>
                  这些草稿由角色在巡检里提议，还没出现在你的日记列表里。点「确认生成」才会真正写入，
                  不确认时角色不会自作主张；离开页面再回来不会丢草稿。
                </p>
                {draftError ? (
                  <p className={styles.phoneAppHint} role="alert" style={{ margin: '0 12px 8px' }}>
                    {draftError}
                  </p>
                ) : null}
                <div className={styles.phoneJournalGroupCards}>
                  {pendingDrafts.map((draft) => {
                    const working = draftWorkingValue(draft);
                    const busy = draftBusyId === draft.id;
                    return (
                      <article
                        key={draft.id}
                        className={styles.phoneJournalCard}
                        style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8, transform: 'none' }}
                        data-testid={`phone-journal-draft-${draft.id}`}
                      >
                        <div className={styles.phoneJournalCardHead}>
                          <input
                            type="text"
                            value={working.title}
                            onChange={(event) =>
                              handleDraftFieldChange(draft.id, { title: event.target.value })
                            }
                            placeholder="标题"
                            aria-label="待确认草稿标题"
                            data-testid={`phone-journal-draft-title-${draft.id}`}
                            disabled={busy}
                            style={{ flex: 1, font: 'inherit', background: 'transparent', border: '1px dashed rgba(0,0,0,0.2)', padding: '4px 6px' }}
                          />
                        </div>
                        <p className={styles.phoneAppHint} style={{ margin: 0 }}>
                          {draft.dayKey} · 来源 {draft.source}
                          {draft.reason ? ` · 理由：${draft.reason}` : ''}
                        </p>
                        <textarea
                          value={working.body}
                          onChange={(event) =>
                            handleDraftFieldChange(draft.id, { body: event.target.value })
                          }
                          rows={4}
                          aria-label="待确认草稿正文"
                          data-testid={`phone-journal-draft-body-${draft.id}`}
                          disabled={busy}
                          style={{ width: '100%', font: 'inherit', background: 'transparent', border: '1px dashed rgba(0,0,0,0.2)', padding: '6px' }}
                        />
                        <input
                          type="text"
                          value={working.mood}
                          onChange={(event) =>
                            handleDraftFieldChange(draft.id, { mood: event.target.value })
                          }
                          placeholder="心情（可选）"
                          aria-label="待确认草稿心情"
                          data-testid={`phone-journal-draft-mood-${draft.id}`}
                          disabled={busy}
                          maxLength={24}
                          style={{ font: 'inherit', background: 'transparent', border: '1px dashed rgba(0,0,0,0.2)', padding: '4px 6px' }}
                        />
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          <button
                            type="button"
                            className={styles.phoneJournalPrimaryButton}
                            onClick={() => void handleConfirmDraft(draft)}
                            disabled={busy}
                            data-testid={`phone-journal-draft-confirm-${draft.id}`}
                          >
                            {busy ? '处理中…' : '确认生成'}
                          </button>
                          <button
                            type="button"
                            className={styles.phoneModalGhostButton}
                            onClick={() => void handleDiscardDraft(draft)}
                            disabled={busy}
                            data-testid={`phone-journal-draft-discard-${draft.id}`}
                          >
                            丢弃
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            ) : null}

            {grouped.length === 0 && pendingDrafts.length === 0 && !listLoading ? (
              <p className={styles.phoneJournalEmpty} data-testid="phone-journal-empty">
                还没有日记。点右下角「记」添加一条记录（写入当前角色目录，刷新或重启后仍在）。
              </p>
            ) : null}
            {grouped.length > 0
              ? grouped.map(([dayKey, list]) => {
                  // 整组都是污损条目 → 用「墨迹模糊」分组标签代替正常日期；
                  // 真实写入哨兵 0001-01-01 的条目会自然聚集到这里（最末），
                  // 不再按编造日期散落到真实年份里。
                  const groupSmudged = list.every((e) => e.dateSmudged);
                  return (
                    <div
                      key={dayKey}
                      className={styles.phoneJournalGroup}
                      data-smudged={groupSmudged ? 'true' : undefined}
                      data-testid={groupSmudged ? 'phone-journal-smudged-group' : undefined}
                    >
                      <div className={styles.phoneJournalGroupLabel}>
                        <span aria-hidden className={styles.phoneJournalGroupDash} />
                        <span>{groupSmudged ? SMUDGED_GROUP_HEADING : formatGroupHeading(dayKey)}</span>
                      </div>
                      <div className={styles.phoneJournalGroupCards}>
                        {list.map((e, idx) => {
                          const tapeColor = WASHI_TAPE_COLORS[idx % WASHI_TAPE_COLORS.length];
                          const slant = idx % 2 === 0 ? styles.phoneJournalCardSlant0 : styles.phoneJournalCardSlant1;
                          return (
                            <button
                              key={e.id}
                              type="button"
                              className={`${styles.phoneJournalCard} ${slant}`}
                              data-smudged={e.dateSmudged ? 'true' : undefined}
                              data-testid={e.dateSmudged ? `phone-journal-smudged-card-${e.id}` : undefined}
                              onClick={() => setSelectedId(e.id)}
                            >
                              <span aria-hidden className={styles.phoneJournalTape} style={{ background: tapeColor }} />
                              <div className={styles.phoneJournalCardHead}>
                                <h4 className={styles.phoneJournalCardTitle}>{e.title}</h4>
                                {e.mood ? (
                                  <span
                                    className={styles.phoneJournalMoodChip}
                                    data-testid={`phone-journal-mood-${e.id}`}
                                  >
                                    「{e.mood}」
                                  </span>
                                ) : null}
                              </div>
                              <p className={styles.phoneJournalCardExcerpt}>{excerptForJournalList(e.body)}</p>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })
              : null}

            <button
              type="button"
              className={styles.phoneJournalWaxSealButton}
              onClick={openCompose}
              disabled={listLoading}
              aria-label="写日记"
            >
              记
            </button>
          </div>
        ) : (
          <div className={styles.phoneJournalDetail}>
            <div aria-hidden className={styles.phoneJournalDetailRules} />
            <p
              className={styles.phoneJournalDetailMeta}
              data-smudged={selected.dateSmudged ? 'true' : undefined}
              data-testid={selected.dateSmudged ? 'phone-journal-detail-smudged' : undefined}
            >
              {selected.dateSmudged ? SMUDGED_DETAIL_LABEL : dayLabelForDetail(selected.dayKey)}
            </p>
            <h2 className={styles.phoneJournalDetailTitle}>{selected.title}</h2>
            {selected.mood ? (
              <p className={styles.phoneJournalMoodChip} data-testid="phone-journal-detail-mood">
                「{selected.mood}」
              </p>
            ) : null}
            <div className={styles.phoneJournalDetailBodyScroll}>
              <pre className={styles.phoneJournalDetailBody}>{selected.body}</pre>
            </div>
            <div aria-hidden className={styles.phoneJournalInkStamp}>
              {ta}
              <br />
              之印
            </div>
            <div
              style={{
                marginTop: 12,
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                alignItems: 'flex-start',
              }}
            >
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className={styles.phoneModalGhostButton}
                  onClick={() => handleShareToChat(selected)}
                  data-testid={`phone-journal-share-to-chat-${selected.id}`}
                  title={`把这条带到和 ${ta} 的聊天里`}
                >
                  去和 {ta} 聊聊这条
                </button>
                <button
                  type="button"
                  className={styles.phoneModalGhostButton}
                  onClick={() => void handleDeleteSelected()}
                  disabled={deleteBusy}
                >
                  {deleteBusy ? '删除中…' : '删除这条日记'}
                </button>
              </div>
              {sharedToChatId === selected.id ? (
                <p
                  className={styles.phoneAppHint}
                  role="status"
                  data-testid={`phone-journal-share-to-chat-notice-${selected.id}`}
                  style={{ margin: 0 }}
                >
                  已放进聊天输入框引用 —— 打开任意对话即可发出
                </p>
              ) : null}
            </div>
          </div>
        )}
      </div>

      {composeOpen ? (
        <div
          className={styles.phoneModalOverlay}
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setComposeOpen(false);
          }}
        >
          <div className={styles.phoneModalSheet} role="dialog" aria-modal="true" aria-labelledby="phone-journal-compose-title">
            <h3 id="phone-journal-compose-title" className={styles.phoneModalTitle}>
              写日记
            </h3>
            <div className={styles.phoneModalBody}>
              <label className={styles.phoneFormField}>
                <span>标题</span>
                <input value={draftTitle} onChange={(e) => setDraftTitle(e.target.value)} placeholder="可选" />
              </label>
              <label className={styles.phoneFormField}>
                <span>正文</span>
                <textarea value={draftBody} onChange={(e) => setDraftBody(e.target.value)} rows={6} placeholder="写点什么…" />
              </label>
              <label className={styles.phoneFormField}>
                <span>心情</span>
                <input
                  value={draftMood}
                  onChange={(e) => setDraftMood(e.target.value)}
                  placeholder="2–6 字短语，如「平淡 / 想他 / 安静」（可选）"
                  maxLength={24}
                  data-testid="phone-journal-mood-input"
                />
              </label>
              <div style={{ marginTop: 8 }}>
                <button
                  type="button"
                  className={styles.phoneModalGhostButton}
                  onClick={() => void handleGenerateDraft()}
                  disabled={draftAiBusy || saveBusy}
                >
                  {draftAiBusy ? '生成中…' : '生成草稿'}
                </button>
              </div>
              {draftAiError ? (
                <p className={styles.phoneAppHint} role="alert">
                  {draftAiError}
                </p>
              ) : null}
              {saveError ? (
                <p className={styles.phoneAppHint} role="alert">
                  {saveError}
                </p>
              ) : null}
            </div>
            <div className={styles.phoneModalActions}>
              <button type="button" className={styles.phoneModalGhostButton} onClick={() => setComposeOpen(false)} disabled={saveBusy || draftAiBusy}>
                取消
              </button>
              <button type="button" className={styles.phoneJournalPrimaryButton} onClick={() => void saveCompose()} disabled={saveBusy || draftAiBusy}>
                {saveBusy ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
