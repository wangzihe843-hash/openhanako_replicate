import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import { loadHistoryState, saveHistoryState } from './xingye-app-history-state';
import { XingyePersistenceBindingError } from './xingye-persistence';
import { generateTripsHistoryWithAI, generateTripsUpdateWithAI } from './xingye-trips-ai';
import {
  appendTripDraft,
  appendTripEntry,
  confirmTripDraft,
  deleteTripEntry,
  discardTripDraft,
  listTripDrafts,
  listTripEntries,
  normalizeTripModeKey,
  type TripModeKey,
  type XingyeTripEntry,
  type XingyeTripPendingDraft,
} from './xingye-trips-store';
import shell from './XingyeShell.module.css';
import css from './PhoneTripsApp.module.css';

export interface PhoneTripsAppProps {
  ownerAgent: Agent | null;
  ownerProfile: XingyeRoleProfile | null | undefined;
  displayName: string;
  onBack: () => void;
}

/* ============================================================
   交通方式图标（24×24 线稿；复杂载具用简化抽象）
   ============================================================ */
const MODE_ICONS: Record<TripModeKey, ReactNode> = {
  walk: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="13" cy="4.4" r="1.7" />
      <path d="M13 7.5 10.6 13l-2.1 1.4" />
      <path d="m13 7.5 2.6 1.7L17 12" />
      <path d="M11.4 11.2 10 21" />
      <path d="m12.6 12.2 2 3.2.8 5.6" />
    </svg>
  ),
  ride: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 20v-5a5 5 0 0 1 5-5h1l4-4 1.5 1.5-1.6 2.6 1.4 1a4 4 0 0 1 1.7 3.3V20" />
      <path d="M9.5 20v-3" />
      <path d="M16.5 20v-3" />
    </svg>
  ),
  cart: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 7h10v9H3z" />
      <path d="M13 10h4l3 3v3h-7z" />
      <circle cx="7" cy="18" r="1.7" />
      <circle cx="17" cy="18" r="1.7" />
    </svg>
  ),
  transit: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 16.5V13l2.2-4.5a2 2 0 0 1 1.8-1.1h6a2 2 0 0 1 1.8 1.1L19 13v3.5" />
      <path d="M3.5 16.5h17" />
      <path d="M7 13h10" />
      <circle cx="8" cy="18" r="1.6" />
      <circle cx="16" cy="18" r="1.6" />
    </svg>
  ),
  boat: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3.5 15.5 5 20.5h14l1.5-5" />
      <path d="M5.5 15.5V11h13v4.5" />
      <path d="M9 11V7.5h6V11" />
      <path d="M12 3v4.5" />
    </svg>
  ),
  rail: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 19.5h18" />
      <rect x="6.5" y="9.5" width="11" height="6" rx="1" />
      <circle cx="9" cy="17.5" r="1.3" />
      <circle cx="15" cy="17.5" r="1.3" />
      <path d="M12 9.5V5m-2.2 0h4.4" />
    </svg>
  ),
  fly: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 12 21 4l-6 16-3.5-6.5L3 12Z" />
      <path d="m11.5 13.5 3.5-5.5" />
    </svg>
  ),
  mystic: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <ellipse cx="11.5" cy="12" rx="5" ry="8" />
      <ellipse cx="11.5" cy="12" rx="2.1" ry="4" />
      <path d="m19 4 .7 1.6 1.6.7-1.6.7-.7 1.6-.7-1.6-1.6-.7 1.6-.7L19 4Z" />
    </svg>
  ),
};

function modeIcon(mode: string): ReactNode {
  return MODE_ICONS[normalizeTripModeKey(mode)];
}

const ICON_ARROW = (
  <svg viewBox="0 0 28 12" aria-hidden="true">
    <path d="M1 6h25" />
    <path d="m21 1.5 5 4.5-5 4.5" />
  </svg>
);
const ICON_PEN = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M14.5 5.5 18.5 9.5" />
    <path d="M5 19l1-3.5L16 5.5a2 2 0 0 1 3 3L8.5 18 5 19Z" />
  </svg>
);
const ICON_CLOCK = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </svg>
);
const ICON_RULER = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M5 19 19 5l-2-2L3 17Z" />
    <path d="m7 13 1.5 1.5" />
    <path d="m10 10 1.5 1.5" />
    <path d="m13 7 1.5 1.5" />
  </svg>
);
const ICON_COIN = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7v10M9 9.5h4.5a1.5 1.5 0 0 1 0 3H9m0 0h6" />
  </svg>
);

function groupByChapter(entries: XingyeTripEntry[]): { chapter: string; items: XingyeTripEntry[] }[] {
  const groups: { chapter: string; items: XingyeTripEntry[] }[] = [];
  for (const t of entries) {
    let g = groups.find((x) => x.chapter === t.chapter);
    if (!g) {
      g = { chapter: t.chapter, items: [] };
      groups.push(g);
    }
    g.items.push(t);
  }
  return groups;
}

/* ── 一张车票（折叠态，硬板票） ── */
function TripTicket({ trip, onClick }: { trip: XingyeTripEntry; onClick: () => void }) {
  return (
    <button type="button" className={css.ticket} onClick={onClick}>
      <div className={css.ticketStub}>
        <span className={css.stubMode}>{modeIcon(trip.mode)}</span>
        {trip.serial ? <span className={css.stubSerial}>{trip.serial}</span> : <span />}
        <span className={css.stubPunch} />
      </div>
      <span className={css.ticketPerf} />
      <div className={css.ticketBody}>
        <div className={css.ticketTopline}>
          <span>{trip.serial}</span>
          <span>{trip.when}</span>
        </div>
        <div className={css.ticketRoute}>
          <div className={css.ticketPlace}>
            <div className={css.pName}>{trip.from.name}</div>
            {trip.from.meta ? <div className={css.pMeta}>{trip.from.meta}</div> : null}
          </div>
          <div className={css.ticketArrow}>{ICON_ARROW}</div>
          <div className={`${css.ticketPlace} ${css.toEnd}`}>
            <div className={css.pName}>{trip.to.name}</div>
            {trip.to.meta ? <div className={css.pMeta}>{trip.to.meta}</div> : null}
          </div>
        </div>
        <div className={css.ticketBottomline}>
          <span>{trip.modeLabel}</span>
          {trip.duration ? (
            <>
              <span className={css.dot} />
              <span>{trip.duration}</span>
            </>
          ) : null}
          {trip.cls ? <span className={css.ticketTag}>{trip.cls}</span> : null}
        </div>
        {trip.stampText ? (
          <div className={css.stamp}>
            <span className={css.stampText}>{trip.stampText}</span>
          </div>
        ) : null}
      </div>
    </button>
  );
}

/* ── 角色亲笔批注（手写体；默认「封缄」，点开有落笔书写的彩蛋） ── */
function HandNote({ text, author, atEnd }: { text: string; author: string; atEnd?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className={`${css.handNote}${atEnd ? ` ${css.atEnd}` : ''}${open ? ` ${css.handNoteOpen}` : ''}`}
    >
      <button
        type="button"
        className={css.handNoteHead}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={css.handPen}>{ICON_PEN}</span>
        <span className={css.handWho}>{author} · 亲笔</span>
        <span className={css.handTag}>{atEnd ? '终点' : '起点'}</span>
        <span className={css.handSeal} aria-hidden="true">
          <span className={css.handSealHint}>{open ? '收起' : '点开'}</span>
          <span className={css.handSealGlyph}>{open ? '启' : '缄'}</span>
        </span>
      </button>
      <div className={css.handNoteReveal}>
        <p className={css.handNoteText}>{text}</p>
      </div>
    </div>
  );
}

/* ── 详情页 ── */
function TripDetail({
  trip,
  author,
  onBack,
  onDelete,
}: {
  trip: XingyeTripEntry;
  author: string;
  onBack: () => void;
  onDelete: () => void;
}) {
  const stopIdx = trip.route.map((n, i) => (n.kind === 'stop' ? i : -1)).filter((i) => i >= 0);
  const firstStop = stopIdx[0];
  const lastStop = stopIdx[stopIdx.length - 1];
  const eyebrow = [trip.chapter, trip.when].filter(Boolean).join(' · ');

  return (
    <div className={shell.phoneShell} aria-label="行程详情">
      <div className={shell.phoneStatusBar}>
        <button type="button" className={shell.phoneBackButton} onClick={onBack}>
          返回行程
        </button>
        <span>这一程</span>
      </div>
      <div className={`${shell.phoneBody} ${css.tripsRoot}`}>
        {eyebrow ? <div className={css.detailEyebrow}>{eyebrow}</div> : null}
        <div className={css.detailScroll}>
          <div className={css.detailTicket}>
            <div className={css.detailTicketTop}>
              <span>存根{trip.when ? ` · ${trip.when}` : ''}</span>
              {trip.cls ? <span className={css.clsBadge}>{trip.cls}</span> : null}
            </div>
            <div className={css.detailTicketMain}>
              <div className={css.detailRouteHead}>
                <div>
                  <div className={css.pName}>{trip.from.name}</div>
                  {trip.from.meta ? <div className={css.pMeta}>{trip.from.meta}</div> : null}
                </div>
                <div className={css.midGlyph}>{modeIcon(trip.mode)}</div>
                <div className={css.toEnd}>
                  <div className={css.pName}>{trip.to.name}</div>
                  {trip.to.meta ? <div className={css.pMeta}>{trip.to.meta}</div> : null}
                </div>
              </div>
              <div className={css.detailMetaRow}>
                {trip.duration ? (
                  <span className={css.mItem}>
                    {ICON_CLOCK}
                    <b>{trip.duration}</b>
                  </span>
                ) : null}
                {trip.distance ? (
                  <span className={css.mItem}>
                    {ICON_RULER}
                    <b>{trip.distance}</b>
                  </span>
                ) : null}
                {trip.pass ? (
                  <span className={css.mItem}>
                    {ICON_COIN}
                    <b>{trip.pass}</b>
                  </span>
                ) : null}
                {trip.serial ? (
                  <span className={css.mItem}>
                    No.<b>{trip.serial}</b>
                  </span>
                ) : null}
              </div>
            </div>
            {trip.stampText ? (
              <div className={css.detailStamp}>
                <span className={css.stampText}>{trip.stampText}</span>
              </div>
            ) : null}
          </div>

          <div className={css.routeCard}>
            <div className={css.routeSectionLabel}>途经</div>
            <div className={css.timeline}>
              {trip.route.map((n, i) => {
                if (n.kind === 'seg') {
                  const isWalk = n.mode === 'walk';
                  return (
                    <div className={css.tlNode} key={i}>
                      <div className={css.tlTime} />
                      <div className={css.tlRail}>
                        <span className={`${css.tlLine}${isWalk ? ` ${css.walk}` : ''}`} />
                      </div>
                      <div className={css.tlBody}>
                        <span className={`${css.tlSegTag}${isWalk ? ` ${css.walk}` : ''}`}>
                          {modeIcon(n.mode)}
                          {n.label}
                        </span>
                        {n.detail ? <div className={css.tlSub}>{n.detail}</div> : null}
                      </div>
                    </div>
                  );
                }
                const isFirst = i === firstStop;
                const isLast = i === lastStop;
                const isMajor = n.major === true || isFirst || isLast;
                const isVia = !isMajor;
                return (
                  <div className={css.tlNode} key={i}>
                    <div className={css.tlTime}>{n.time ?? ''}</div>
                    <div className={css.tlRail}>
                      {isLast ? null : <span className={css.tlLine} />}
                      <span className={`${css.tlDot} ${isVia ? css.via : css.major}`} />
                    </div>
                    <div className={css.tlBody}>
                      <div className={`${css.tlStation}${isVia ? ` ${css.viaName}` : ''}`}>{n.name}</div>
                      {n.sub ? <div className={css.tlSub}>{n.sub}</div> : null}
                      {isFirst && trip.noteFrom ? <HandNote text={trip.noteFrom} author={author} /> : null}
                      {isLast && trip.noteTo ? <HandNote text={trip.noteTo} author={author} atEnd /> : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {trip.mood ? (
            <div className={css.moodCard}>
              <div className={css.moodLabel}>当时写下</div>
              <p>{trip.mood}</p>
              {trip.moodTags.length > 0 ? (
                <div className={css.moodMeta}>
                  {trip.moodTags.map((m) => (
                    <span key={m}>{m}</span>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          <div className={css.deleteRow}>
            <button type="button" className={css.deleteButton} onClick={onDelete}>
              删除这一程
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── 待确认行程草稿卡（心跳巡检产出） ── */
function TripDraftCard({
  draft,
  busy,
  onConfirm,
  onDiscard,
}: {
  draft: XingyeTripPendingDraft;
  busy: boolean;
  onConfirm: () => void;
  onDiscard: () => void;
}) {
  const eyebrow = [draft.chapter, draft.when].filter(Boolean).join(' · ');
  return (
    <div className={css.draftCard} data-testid={`phone-trips-draft-${draft.id}`}>
      <div className={css.draftHead}>
        <span className={css.draftBadge}>待确认</span>
        {eyebrow ? <span className={css.draftEyebrow}>{eyebrow}</span> : null}
      </div>
      <div className={css.draftRoute}>
        <span className={css.draftMode}>{modeIcon(draft.mode)}</span>
        <span className={css.draftPlace}>{draft.from.name}</span>
        <span className={css.draftArrow}>{ICON_ARROW}</span>
        <span className={css.draftPlace}>{draft.to.name}</span>
      </div>
      {draft.modeLabel ? <div className={css.draftModeLabel}>{draft.modeLabel}</div> : null}
      {draft.reason ? <div className={css.draftReason}>{draft.reason}</div> : null}
      <div className={css.draftActions}>
        <button
          type="button"
          className={css.draftConfirm}
          disabled={busy}
          data-testid={`phone-trips-draft-confirm-${draft.id}`}
          onClick={onConfirm}
        >
          {busy ? '处理中…' : '确认收进行程'}
        </button>
        <button
          type="button"
          className={css.draftDiscard}
          disabled={busy}
          data-testid={`phone-trips-draft-discard-${draft.id}`}
          onClick={onDiscard}
        >
          丢弃
        </button>
      </div>
    </div>
  );
}

export function PhoneTripsApp({ ownerAgent, ownerProfile, displayName, onBack }: PhoneTripsAppProps) {
  const ownerAgentId = ownerAgent?.id ?? '';
  const author = displayName?.trim() || ownerAgent?.name || 'TA';

  const [entries, setEntries] = useState<XingyeTripEntry[]>([]);
  const [pendingDrafts, setPendingDrafts] = useState<XingyeTripPendingDraft[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [draftBusyId, setDraftBusyId] = useState<string | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [manualBusy, setManualBusy] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);
  const [manualNotice, setManualNotice] = useState<string | null>(null);

  /**
   * 首次打开行程 app 的一次性初始化（按 lore 生成 3–5 段过去行程）。
   * - initialBootstrapTriedRef 在 ownerAgentId 切换时复位；同一 owner 一个 mount 周期
   *   最多尝试一次，失败也不会无限重试（不写 initializedAt → 下次重新打开会再试）。
   */
  const initialBootstrapTriedRef = useRef<string | null>(null);
  const [initBusy, setInitBusy] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [initNotice, setInitNotice] = useState<string | null>(null);

  /**
   * 持久化绑定变更脉冲：切角色后 refreshXingyeAgentPersistence 完成会派发
   * 'xingye-persistence-changed'。把它纳入初始化 effect 的依赖，让「绑定竞态被守卫拦下、
   * tried 已重置」的情形在重绑完成后能自动重跑一次初始化（否则没有依赖变化不会重试）。
   */
  const [persistenceTick, setPersistenceTick] = useState(0);
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onPersistenceChanged = () => setPersistenceTick((t) => t + 1);
    window.addEventListener('xingye-persistence-changed', onPersistenceChanged);
    return () => window.removeEventListener('xingye-persistence-changed', onPersistenceChanged);
  }, []);

  /**
   * 防跨角色脏写：切角色时 ownerAgentId 变化会触发新一轮 reload，但上一个角色还在飞的
   * 读取可能后落地、用旧数据覆盖新角色。每次 reload 自增请求序号，落 setState 前校验仍是
   * 最新一轮（与 PhoneMmChatApp / PhoneDivinationApp 的 cancelled 守卫同语义，这里用单调
   * 请求号覆盖所有调用点——delete / confirm / 手动整理后也复用 reloadEntries）。
   */
  const reloadSeqRef = useRef(0);

  const reloadEntries = useCallback(async () => {
    const seq = ++reloadSeqRef.current;
    if (!ownerAgentId) {
      setEntries([]);
      setPendingDrafts([]);
      return;
    }
    setListLoading(true);
    setListError(null);
    try {
      const [rows, drafts] = await Promise.all([
        listTripEntries(ownerAgentId),
        listTripDrafts(ownerAgentId),
      ]);
      if (seq !== reloadSeqRef.current) return; // 被更晚一轮 reload 取代，丢弃本次结果
      setEntries(rows);
      setPendingDrafts(drafts);
    } catch (e) {
      if (seq !== reloadSeqRef.current) return;
      setListError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === reloadSeqRef.current) setListLoading(false);
    }
  }, [ownerAgentId]);

  useEffect(() => {
    setSelectedId(null);
    setListError(null);
    setPendingDrafts([]);
    setDraftError(null);
    setManualError(null);
    setManualNotice(null);
    initialBootstrapTriedRef.current = null;
    setInitError(null);
    setInitNotice(null);
  }, [ownerAgentId]);

  useEffect(() => {
    void reloadEntries();
    // cleanup：作废本轮 reload，让切角色后旧角色的在飞读取无法再 setState（与上面的请求号双保险）。
    return () => {
      reloadSeqRef.current += 1;
    };
  }, [reloadEntries]);

  /**
   * 「首次打开行程」初始化：按 lore 生成 3–5 段过去行程，直接写入 entries.jsonl。
   * 成功才写 history-state.initializedAt——失败时不写，用户下次打开会重试。
   */
  const runInitialBootstrap = useCallback(async () => {
    if (!ownerAgent || !ownerAgentId) return;
    setInitBusy(true);
    setInitError(null);
    setInitNotice(null);
    try {
      const desiredCount = 3 + Math.floor(Math.random() * 3);
      const drafts = await generateTripsHistoryWithAI({
        agent: ownerAgent,
        ownerProfile: ownerProfile ?? null,
        desiredCount,
      });
      if (drafts.length === 0) {
        throw new Error('模型未生成任何行程');
      }
      // 保持模型给的顺序 append——列表按 chapter 聚合，写入顺序即叙事顺序。
      for (const d of drafts) {
        await appendTripEntry(ownerAgentId, d);
      }
      await saveHistoryState(ownerAgentId, 'trips', {
        initializedAt: new Date().toISOString(),
      });
      setInitNotice(`已为 ${author} 翻出 ${drafts.length} 段走过的路`);
      await reloadEntries();
    } catch (e) {
      if (e instanceof XingyePersistenceBindingError) {
        // 持久化还没绑定到本 owner（刚切角色的瞬时竞态）：不是真失败。重置 tried，让重绑完成后
        // （persistenceTick 自增触发初始化 effect 重跑）再初始化，不弹错误条、不写 initializedAt。
        initialBootstrapTriedRef.current = null;
      } else {
        setInitError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setInitBusy(false);
    }
  }, [ownerAgent, ownerAgentId, ownerProfile, author, reloadEntries]);

  useEffect(() => {
    if (!ownerAgent || !ownerAgentId) return;
    if (listLoading) return;
    if (initBusy) return;
    if (initialBootstrapTriedRef.current === ownerAgentId) return;
    // 已经有行程，或 agent 心跳已经垫了待确认草稿 → 视为已初始化过，跳过。
    if (entries.length > 0 || pendingDrafts.length > 0) {
      initialBootstrapTriedRef.current = ownerAgentId;
      return;
    }
    initialBootstrapTriedRef.current = ownerAgentId;
    (async () => {
      try {
        const state = await loadHistoryState(ownerAgentId, 'trips');
        if (state.initializedAt) return;
        // 二次确认：mount 初次 entries.length=0 不能当真，直接落盘问一次；
        // 也覆盖老用户场景（加这个功能前已写过行程但没 marker）：有内容只补 marker。
        const [freshEntries, freshDrafts] = await Promise.all([
          listTripEntries(ownerAgentId),
          listTripDrafts(ownerAgentId),
        ]);
        if (freshEntries.length > 0 || freshDrafts.length > 0) {
          await saveHistoryState(ownerAgentId, 'trips', {
            initializedAt: new Date().toISOString(),
          });
          return;
        }
        await runInitialBootstrap();
      } catch (err) {
        console.warn('[PhoneTripsApp] init bootstrap failed:', err);
      }
    })();
  }, [ownerAgent, ownerAgentId, listLoading, initBusy, entries.length, pendingDrafts.length, runInitialBootstrap, persistenceTick]);

  const handleDelete = useCallback(
    async (entryId: string) => {
      if (!ownerAgentId) return;
      try {
        await deleteTripEntry(ownerAgentId, entryId);
        setSelectedId(null);
        await reloadEntries();
      } catch (e) {
        setListError(e instanceof Error ? e.message : String(e));
      }
    },
    [ownerAgentId, reloadEntries],
  );

  const handleConfirmDraft = useCallback(
    async (draft: XingyeTripPendingDraft) => {
      if (!ownerAgentId) return;
      setDraftBusyId(draft.id);
      setDraftError(null);
      try {
        await confirmTripDraft(ownerAgentId, draft.id);
        setPendingDrafts((prev) => prev.filter((d) => d.id !== draft.id));
        await reloadEntries();
      } catch (e) {
        setDraftError(e instanceof Error ? e.message : String(e));
      } finally {
        setDraftBusyId(null);
      }
    },
    [ownerAgentId, reloadEntries],
  );

  const handleDiscardDraft = useCallback(
    async (draft: XingyeTripPendingDraft) => {
      if (!ownerAgentId) return;
      if (typeof window !== 'undefined' && !window.confirm('丢弃这条待确认行程草稿？')) return;
      setDraftBusyId(draft.id);
      setDraftError(null);
      try {
        const ok = await discardTripDraft(ownerAgentId, draft.id);
        if (ok) {
          setPendingDrafts((prev) => prev.filter((d) => d.id !== draft.id));
        }
      } catch (e) {
        setDraftError(e instanceof Error ? e.message : String(e));
      } finally {
        setDraftBusyId(null);
      }
    },
    [ownerAgentId],
  );

  /**
   * 「整理新行程」手动 AI 更新：从最近聊天 / 上次巡检 / 关系状态 / lore 里提取 TA
   * 之前没记过的过去旅程，产出 1–3 条**待确认草稿**（落到下方草稿区，不直接进
   * 「已走过的路」）。与购物 / 记账的手动批量更新同模式。
   */
  const handleManualUpdate = useCallback(async () => {
    if (!ownerAgent || !ownerAgentId) return;
    setManualBusy(true);
    setManualError(null);
    setManualNotice(null);
    try {
      const drafts = await generateTripsUpdateWithAI({
        agent: ownerAgent,
        ownerProfile: ownerProfile ?? null,
        existingTrips: entries,
      });
      for (const d of drafts) {
        await appendTripDraft(ownerAgentId, { ...d, source: 'xingye-trips-manual' });
      }
      setManualNotice(`已整理 ${drafts.length} 段新行程草稿，在下方确认或丢弃`);
      await reloadEntries();
    } catch (e) {
      setManualError(
        e instanceof XingyePersistenceBindingError
          ? '角色数据还在加载（刚切换角色？），请稍候再点一次「整理新行程」。'
          : e instanceof Error
            ? e.message
            : String(e),
      );
    } finally {
      setManualBusy(false);
    }
  }, [ownerAgent, ownerAgentId, ownerProfile, entries, reloadEntries]);

  if (!ownerAgent || !ownerAgentId) {
    return (
      <div className={shell.phoneShell} aria-label="行程">
        <div className={shell.phoneStatusBar}>
          <button type="button" className={shell.phoneBackButton} onClick={onBack}>
            返回首页
          </button>
          <span>行程</span>
        </div>
        <div className={shell.phoneBody}>
          <section className={shell.phoneAppCard}>
            <h3 className={shell.phoneAppTitle}>行程不可用</h3>
            <p className={shell.phoneAppHint}>
              未选择角色 / 小手机不可用。行程写入当前角色在 HANA_HOME 下的星野目录，不能使用隐式角色回退。
            </p>
            <p className={shell.phoneAppHint}>请返回星野角色页，选择有效角色后再打开行程。</p>
          </section>
        </div>
      </div>
    );
  }

  const selected = selectedId ? entries.find((t) => t.id === selectedId) ?? null : null;
  if (selected) {
    return (
      <TripDetail
        trip={selected}
        author={author}
        onBack={() => setSelectedId(null)}
        onDelete={() => handleDelete(selected.id)}
      />
    );
  }

  const groups = groupByChapter(entries);

  return (
    <div className={shell.phoneShell} aria-label="行程">
      <div className={shell.phoneStatusBar}>
        <button type="button" className={shell.phoneBackButton} onClick={onBack}>
          返回首页
        </button>
        <span>行程</span>
      </div>
      <div className={`${shell.phoneBody} ${css.tripsRoot}`}>
        <div className={css.listScroll}>
          <div className={css.listIntro}>
            {author} 走过的路——每一张旧票根，一段已经发生、不会重来的路。
          </div>

          <div className={css.manualRow}>
            <button
              type="button"
              className={css.manualButton}
              disabled={manualBusy || initBusy}
              data-testid="phone-trips-manual-update"
              onClick={() => void handleManualUpdate()}
            >
              {manualBusy ? '正在翻找…' : '整理新行程'}
            </button>
            <span className={css.manualHint}>从最近聊天 / 设定里补一段没记过的路</span>
          </div>
          {manualNotice && !manualBusy ? <div className={css.initBanner}>{manualNotice}</div> : null}
          {manualError && !manualBusy ? (
            <div className={`${css.initBanner} ${css.error}`}>整理失败：{manualError}</div>
          ) : null}

          {initBusy ? (
            <div className={css.initBanner}>正在从设定里翻找 {author} 走过的路……</div>
          ) : null}
          {initError && !initBusy ? (
            <div className={`${css.initBanner} ${css.error}`}>
              初始化行程失败：{initError}（下次打开会重试）
            </div>
          ) : null}
          {initNotice && !initBusy ? <div className={css.initBanner}>{initNotice}</div> : null}
          {listError ? (
            <div className={`${css.initBanner} ${css.error}`}>读取失败：{listError}</div>
          ) : null}

          {pendingDrafts.length > 0 ? (
            <section className={css.draftSection} data-testid="phone-trips-pending-drafts">
              <div className={css.draftSectionLabel}>待确认草稿 · 心跳巡检 / 手动整理</div>
              {draftError ? (
                <div className={`${css.initBanner} ${css.error}`}>草稿操作失败：{draftError}</div>
              ) : null}
              {pendingDrafts.map((d) => (
                <TripDraftCard
                  key={d.id}
                  draft={d}
                  busy={draftBusyId === d.id}
                  onConfirm={() => handleConfirmDraft(d)}
                  onDiscard={() => handleDiscardDraft(d)}
                />
              ))}
            </section>
          ) : null}

          {!initBusy && entries.length === 0 && pendingDrafts.length === 0 && !initError ? (
            <div className={css.emptyHint} data-testid="phone-trips-empty">
              还没有行程。首次打开会按 {author} 的设定，自动整理几段 TA 过去走过的路。
            </div>
          ) : null}

          {groups.map((g) => (
            <Fragment key={g.chapter}>
              <div className={css.chapterLabel}>{g.chapter}</div>
              {g.items.map((t) => (
                <TripTicket key={t.id} trip={t} onClick={() => setSelectedId(t.id)} />
              ))}
            </Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}
