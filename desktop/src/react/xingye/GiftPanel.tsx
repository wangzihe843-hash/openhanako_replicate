/**
 * 赠礼系统面板（与小手机/朋友圈/秘密空间同级 tab）。
 *
 * 流程：
 *  1. 首次打开（initializedAt 缺失）→ 自初始化：resolver 确定归属集（确定性）+
 *     一次 LLM 调用产出最爱/stance/气质/回复池（见 xingye-gifts-ai.ts），落
 *     gifts/state.json。失败 = 「这次不动」，展示重试。
 *  2. 全部 11 套礼物全量展示（跨世界观不隐藏，归属集置顶）；最爱礼物**绝不标识**，
 *     由 user 送中后通过特效发现。
 *  3. 送礼零 LLM：认知矩阵 + stance 查表出冲量 → updateRelationshipState 走
 *     阶段曲线落库；回复从预生成池抽取；流水进 gifts/log.jsonl。
 *
 * 持久化不变量（见项目记忆）：reload 带 reloadSeqRef 守卫；首启 bootstrap 用
 * initialBootstrapTriedRef 保证每个 agent 只试一次；loadGiftState 读失败抛错时
 * 绝不当「未初始化」处理。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Agent } from '../types';
import { getXingyePersistenceStorage } from './xingye-persistence';
import { useXingyeRoleProfile } from './xingye-profile-store';
import { listLoreEntries } from './xingye-lore-store';
import { getRelationshipState, updateRelationshipState } from './xingye-state-store';
import {
  XINGYE_GIFT_SETS,
  getGiftSet,
  type XingyeGiftItem,
  type XingyeGiftSet,
  type XingyeGiftSetId,
} from './xingye-gift-catalog';
import { buildGiftEraAgentLike, resolveGiftEra } from './xingye-gift-era-resolver';
import {
  resolveGiftFamiliarity,
  resolveGiftReaction,
  type GiftFamiliarity,
  type GiftReaction,
} from './xingye-gift-dynamics';
import { generateGiftInitWithAI } from './xingye-gifts-ai';
import {
  appendGiftLog,
  hasFavoriteHit,
  listGiftLog,
  loadGiftState,
  saveGiftState,
  type XingyeGiftLogRecord,
  type XingyeGiftState,
} from './xingye-gift-store';
import styles from './GiftPanel.module.css';

interface GiftPanelProps {
  agent: Agent | null;
}

type ReactionDisplay = {
  gift: XingyeGiftItem;
  reaction: GiftReaction;
  reply: string;
};

const TIER_KICKERS: Record<GiftReaction['tier'], string> = {
  favorite: 'PERFECT · 正中心意',
  pleased: 'PLEASED · 喜欢',
  flat: 'OKAY · 收下了',
  displeased: 'HMM · 不太对胃口',
  curious: 'CURIOUS · 这是什么',
};

const FAMILIARITY_HINTS: Partial<Record<GiftFamiliarity, string>> = {
  mundane: '在 TA 的世界里很常见',
  historical: '对 TA 来说是老物件',
  alien: 'TA 的世界里没有这种东西',
};

/** 命中最爱特效的星屑位置（百分比坐标 + 错峰延迟），写死保证确定性。 */
const SPARKLE_SPOTS: Array<{ left: string; top: string; delay: string; scale: number }> = [
  { left: '8%', top: '14%', delay: '0s', scale: 1 },
  { left: '88%', top: '10%', delay: '0.2s', scale: 0.8 },
  { left: '16%', top: '70%', delay: '0.45s', scale: 0.7 },
  { left: '80%', top: '64%', delay: '0.6s', scale: 1.1 },
  { left: '50%', top: '4%', delay: '0.85s', scale: 0.6 },
  { left: '94%', top: '38%', delay: '1.0s', scale: 0.75 },
  { left: '4%', top: '42%', delay: '1.15s', scale: 0.9 },
];

function pickFrom(list: string[], fallback: string): string {
  if (!list.length) return fallback;
  return list[Math.floor(Math.random() * list.length)] ?? fallback;
}

function fillGiftName(template: string, giftName: string): string {
  return template.replace(/\{gift\}/g, giftName);
}

function formatLogTime(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function describeImpulse(reaction: GiftReaction): { text: string; direction: 'up' | 'down' | 'none' } {
  const a = reaction.impulse.affectionDelta;
  if (a > 0) return { text: '好感似乎上升了', direction: 'up' };
  if (a < 0) return { text: '气氛有点僵', direction: 'down' };
  return { text: '心情没什么波动', direction: 'none' };
}

export function GiftPanel({ agent }: GiftPanelProps) {
  const profile = useXingyeRoleProfile(agent?.id ?? null);
  const [giftState, setGiftState] = useState<XingyeGiftState | null>(null);
  const [log, setLog] = useState<XingyeGiftLogRecord[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [initializing, setInitializing] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ setId: XingyeGiftSetId; gift: XingyeGiftItem } | null>(null);
  const [sending, setSending] = useState(false);
  const [reactionDisplay, setReactionDisplay] = useState<ReactionDisplay | null>(null);

  const reloadSeqRef = useRef(0);
  const initialBootstrapTriedRef = useRef<string | null>(null);

  const ownerAgentId = agent?.id ?? null;

  const runInitialization = useCallback(async (targetAgent: Agent) => {
    setInitializing(true);
    setInitError(null);
    try {
      // 归属集：resolver 确定性判定（profile + lore 全量语料）。
      const loreTexts = (() => {
        try {
          return listLoreEntries(targetAgent.id, getXingyePersistenceStorage())
            .filter((entry) => entry.enabled)
            .map((entry) => `${entry.title}\n${entry.content}`);
        } catch {
          return [] as string[];
        }
      })();
      const profileSnapshot = profile;
      const resolution = resolveGiftEra(
        buildGiftEraAgentLike(targetAgent, profileSnapshot, { lore: loreTexts }),
      );
      const result = await generateGiftInitWithAI({
        agent: targetAgent,
        profile: profileSnapshot,
        eraSetId: resolution.setId,
      });
      const next = await saveGiftState(targetAgent.id, {
        initializedAt: new Date().toISOString(),
        eraSetId: resolution.setId,
        favoriteGiftId: result.favoriteGiftId,
        temperament: result.temperament,
        stances: result.stances,
        replies: result.replies,
      });
      if (ownerAgentId === targetAgent.id) {
        setGiftState(next);
      }
    } catch (error) {
      if (ownerAgentId === targetAgent.id) {
        setInitError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (ownerAgentId === targetAgent.id) {
        setInitializing(false);
      }
    }
  }, [ownerAgentId, profile]);

  const reload = useCallback(async () => {
    if (!agent) {
      setGiftState(null);
      setLog([]);
      return;
    }
    const seq = ++reloadSeqRef.current;
    setLoadError(null);
    try {
      const [state, logRows] = await Promise.all([
        loadGiftState(agent.id),
        listGiftLog(agent.id).catch(() => [] as XingyeGiftLogRecord[]),
      ]);
      if (seq !== reloadSeqRef.current) return;
      setGiftState(state);
      setLog(logRows);
      // 首次打开自动初始化：每个 agent 只自动尝试一次；读取失败（抛错）不会走到这里，
      // 不会被误判为未初始化。
      if (!state.initializedAt && initialBootstrapTriedRef.current !== agent.id) {
        initialBootstrapTriedRef.current = agent.id;
        void runInitialization(agent);
      }
    } catch (error) {
      if (seq !== reloadSeqRef.current) return;
      setGiftState(null);
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, [agent, runInitialization]);

  useEffect(() => {
    setSelected(null);
    setReactionDisplay(null);
    setInitError(null);
    void reload();
  }, [reload]);

  const eraSet: XingyeGiftSet | null = useMemo(() => {
    if (!giftState?.eraSetId) return null;
    try {
      return getGiftSet(giftState.eraSetId);
    } catch {
      return null;
    }
  }, [giftState?.eraSetId]);

  /** 归属集置顶，其余按 catalog 顺序。 */
  const orderedSets = useMemo(() => {
    if (!eraSet) return XINGYE_GIFT_SETS;
    return [eraSet, ...XINGYE_GIFT_SETS.filter((set) => set.id !== eraSet.id)];
  }, [eraSet]);

  const pickReply = useCallback((
    state: XingyeGiftState,
    gift: XingyeGiftItem,
    familiarity: GiftFamiliarity,
    isFavorite: boolean,
  ): string => {
    const pools = state.replies;
    if (isFavorite) {
      return pickFrom(pools?.favorite ?? [], '……这个，你怎么知道的。');
    }
    if (familiarity === 'native') {
      const line = pools?.nativeByGift?.[gift.id];
      if (line) return line;
      return fillGiftName(pickFrom(pools?.mundane ?? [], '{gift}吗，谢谢。'), gift.nameZh);
    }
    const pool = familiarity === 'mundane'
      ? pools?.mundane
      : familiarity === 'historical'
        ? pools?.historical
        : pools?.alien;
    const fallback = familiarity === 'alien'
      ? '这{gift}……究竟是做什么用的？'
      : familiarity === 'historical'
        ? '{gift}……这可有些年头了吧。'
        : '{gift}吗，谢谢，收下了。';
    return fillGiftName(pickFrom(pool ?? [], fallback), gift.nameZh);
  }, []);

  const handleSend = useCallback(async () => {
    if (!agent || !selected || !giftState?.initializedAt || !giftState.eraSetId || sending) return;
    setSending(true);
    try {
      const { setId, gift } = selected;
      const familiarity = resolveGiftFamiliarity(giftState.eraSetId, setId);
      const isFavorite = familiarity === 'native' && gift.id === giftState.favoriteGiftId;
      const currentCorruption = getRelationshipState(agent.id)?.corruption ?? 0;
      const reaction = resolveGiftReaction({
        familiarity,
        stance: familiarity === 'native' ? giftState.stances?.[gift.id] : undefined,
        isFavorite,
        favoriteHitBefore: hasFavoriteHit(log),
        temperament: giftState.temperament ?? 'gracious',
        currentCorruption,
      });
      const reply = pickReply(giftState, gift, familiarity, isFavorite);

      updateRelationshipState(agent.id, {
        affectionDelta: reaction.impulse.affectionDelta,
        trustDelta: reaction.impulse.trustDelta,
        loyaltyDelta: reaction.impulse.loyaltyDelta,
        jealousyDelta: reaction.impulse.jealousyDelta,
        corruptionDelta: reaction.impulse.corruptionDelta,
        reason: `收到了用户送的「${gift.nameZh}」`,
      });

      const record: XingyeGiftLogRecord = {
        id: `gift-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        giftSetId: setId,
        giftId: gift.id,
        giftNameZh: gift.nameZh,
        familiarity,
        tier: reaction.tier,
        reply,
        impulse: { ...reaction.impulse },
        sentAt: new Date().toISOString(),
      };
      // 流水写失败不应吞掉已发生的反应：先展示，再尽力落盘。
      setLog((prev) => [...prev, record]);
      setReactionDisplay({ gift, reaction, reply });
      setSelected(null);
      try {
        await appendGiftLog(agent.id, record);
      } catch (error) {
        console.warn('[GiftPanel] failed to append gift log:', error);
      }
    } finally {
      setSending(false);
    }
  }, [agent, selected, giftState, log, sending, pickReply]);

  if (!agent) {
    return (
      <section className={styles.panel} aria-label="赠礼">
        <div className={styles.placeholder}>先在「角色」页选择一位角色，再来挑礼物。</div>
      </section>
    );
  }

  const displayName = profile?.displayName || agent.name;
  const initialized = Boolean(giftState?.initializedAt);

  return (
    <section className={styles.panel} aria-label="赠礼">
      <header className={styles.header}>
        <div>
          <p className={styles.kicker}>GIFT · 心意</p>
          <h2 className={styles.title}>给 {displayName} 的礼物</h2>
          <p className={styles.subtitle}>挑一件送出去。有些东西会比别的更得 TA 的心——哪一件，得自己试。</p>
        </div>
        {eraSet ? (
          <span className={styles.eraBadge}>TA 的世界 · {eraSet.labelZh}</span>
        ) : null}
      </header>

      {loadError ? (
        <div className={`${styles.notice} ${styles.noticeError}`}>
          赠礼数据读取失败：{loadError}
          <button className={styles.retryButton} type="button" onClick={() => void reload()}>
            重试
          </button>
        </div>
      ) : null}

      {initializing ? (
        <div className={styles.notice}>正在了解 TA 的喜好……（首次打开会根据 TA 的人设准备赠礼偏好）</div>
      ) : null}

      {initError ? (
        <div className={`${styles.notice} ${styles.noticeError}`}>
          初始化失败：{initError}
          <button
            className={styles.retryButton}
            type="button"
            onClick={() => { if (agent) void runInitialization(agent); }}
          >
            重试
          </button>
        </div>
      ) : null}

      {orderedSets.map((set) => {
        const isNative = eraSet?.id === set.id;
        const familiarity = giftState?.eraSetId
          ? resolveGiftFamiliarity(giftState.eraSetId, set.id)
          : null;
        const hint = familiarity && familiarity !== 'native' ? FAMILIARITY_HINTS[familiarity] : null;
        return (
          <section className={styles.setSection} key={set.id}>
            <div className={styles.setHeader}>
              <h3 className={styles.setTitle}>{set.labelZh}</h3>
              {isNative ? <span className={styles.nativeTag}>TA 的世界</span> : null}
              {hint ? <span className={styles.setHint}>{hint}</span> : null}
            </div>
            <div className={styles.giftGrid}>
              {set.items.map((gift) => {
                const isSelected = selected?.setId === set.id && selected.gift.id === gift.id;
                return (
                  <button
                    key={gift.id}
                    type="button"
                    className={`${styles.giftCard}${isSelected ? ` ${styles.giftCardSelected}` : ''}`}
                    title={gift.desc}
                    onClick={() => setSelected(isSelected ? null : { setId: set.id, gift })}
                  >
                    <img className={styles.giftImage} src={gift.image} alt={gift.nameZh} />
                    <span className={styles.giftName}>{gift.nameZh}</span>
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}

      {selected ? (
        <div className={styles.sendBar}>
          <img className={styles.sendBarImage} src={selected.gift.image} alt="" />
          <div className={styles.sendBarMeta}>
            <p className={styles.sendBarName}>{selected.gift.nameZh}</p>
            <p className={styles.sendBarDesc}>{selected.gift.desc}</p>
          </div>
          <button
            className={styles.sendButton}
            type="button"
            disabled={sending || !initialized}
            onClick={() => void handleSend()}
          >
            {sending ? '送出中…' : initialized ? `送给 ${displayName}` : '准备中…'}
          </button>
        </div>
      ) : null}

      {log.length ? (
        <section className={styles.historySection}>
          <h3 className={styles.historyTitle}>送礼记录</h3>
          {[...log].slice(-8).reverse().map((row) => (
            <div className={styles.historyItem} key={row.id}>
              <span className={styles.historyTime}>{formatLogTime(row.sentAt)}</span>
              <span>{row.giftNameZh}</span>
              <span className={styles.historyReply}>{row.reply}</span>
            </div>
          ))}
        </section>
      ) : null}

      {reactionDisplay ? (
        <div
          className={styles.reactionOverlay}
          role="dialog"
          aria-label="礼物反应"
          onClick={() => setReactionDisplay(null)}
        >
          <div
            className={`${styles.reactionCard}${reactionDisplay.reaction.tier === 'favorite' ? ` ${styles.reactionCardFavorite}` : ''}`}
            onClick={(event) => event.stopPropagation()}
          >
            {reactionDisplay.reaction.tier === 'favorite' ? (
              <div className={styles.sparkleField} aria-hidden="true">
                {SPARKLE_SPOTS.map((spot, index) => (
                  <span
                    key={index}
                    className={styles.sparkle}
                    style={{
                      left: spot.left,
                      top: spot.top,
                      animationDelay: spot.delay,
                      transform: `scale(${spot.scale})`,
                    }}
                  />
                ))}
              </div>
            ) : null}
            <img
              className={`${styles.reactionImage}${reactionDisplay.reaction.tier === 'favorite' ? ` ${styles.reactionImageFavorite}` : ''}`}
              src={reactionDisplay.gift.image}
              alt={reactionDisplay.gift.nameZh}
            />
            <p className={`${styles.reactionTier}${reactionDisplay.reaction.tier === 'favorite' ? ` ${styles.reactionTierFavorite}` : ''}`}>
              {TIER_KICKERS[reactionDisplay.reaction.tier]}
            </p>
            <p className={styles.reactionReply}>{reactionDisplay.reply}</p>
            {(() => {
              const { text, direction } = describeImpulse(reactionDisplay.reaction);
              const cls = direction === 'up'
                ? ` ${styles.reactionDeltaUp}`
                : direction === 'down'
                  ? ` ${styles.reactionDeltaDown}`
                  : '';
              return <p className={`${styles.reactionDelta}${cls}`}>{text}</p>;
            })()}
            <button
              className={styles.reactionClose}
              type="button"
              onClick={() => setReactionDisplay(null)}
            >
              知道了
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
