import { useEffect, useRef, useState } from 'react';
import type { Agent } from '../types';
import styles from './XingyeShell.module.css';
import type { XingyeRoleProfile } from './xingye-profile-store';
import {
  readAppReview,
  reviewSentimentFromStars,
  saveAppReview,
  type AppReviewRecord,
  type AppReviewSide,
  type ReviewSentiment,
} from './xingye-app-review-store';
import {
  generateSecondhandReviewWithAI,
  generateShoppingReviewWithAI,
} from './xingye-review-ai';
import { ensureSecondhandBuyerChat } from './xingye-secondhand-ai';

/**
 * 购物 / 二手详情页内联「评价」区。
 *
 * 与买家聊天面板同范式（懒生成 + 按 entryId 缓存复用），但**只读、无「换一段」**——
 * 评价一次定稿（见 xingye-app-review-store 注释）。
 *
 * - 购物：渲染 1 条 TA(买家) 对商品的评价；TA 差评时其下缩进显示店家小作文回复。
 * - 二手：渲染闲鱼式 2 条互评（卖家(TA)→买家、买家→卖家/商品）。
 * - 未作出评价的一侧（reviewed=false）显示「该用户未作出评价，系统默认给出好评」（固定 5 星好评）。
 */

const TIER_LABEL: Record<ReviewSentiment, string> = {
  good: '好评',
  neutral: '中评',
  bad: '差评',
};

const TIER_CHIP_CLASS: Record<ReviewSentiment, string> = {
  good: styles.xyChipTintSage,
  neutral: styles.xyChipTintSlate,
  bad: styles.xyChipTintTerracotta,
};

const DEFAULT_REVIEW_NOTE = '该用户未作出评价，系统默认给出好评';

function StarRow({ stars }: { stars: number }) {
  const filled = Math.max(0, Math.min(5, Math.round(stars)));
  return (
    <span className={styles.xyReviewStars} aria-label={`${filled} 星`}>
      {'★'.repeat(filled)}
      <span className={styles.xyReviewStarsEmpty}>{'★'.repeat(5 - filled)}</span>
    </span>
  );
}

function ReviewSideCard({ side, label }: { side: AppReviewSide; label: string }) {
  const tier = reviewSentimentFromStars(side.stars);
  return (
    <div className={styles.xyReviewCard} data-testid={`xy-review-side-${side.by}`}>
      <div className={styles.xyReviewCardHead}>
        <span className={styles.xyReviewSideLabel}>{label}</span>
        <span className={`${styles.xyChip} ${TIER_CHIP_CLASS[tier]}`}>{TIER_LABEL[tier]}</span>
      </div>
      <StarRow stars={side.stars} />
      {side.reviewed && side.text ? (
        <p className={styles.xyReviewText}>{side.text}</p>
      ) : (
        <p className={styles.xyReviewDefault}>{DEFAULT_REVIEW_NOTE}</p>
      )}
    </div>
  );
}

type ReviewState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; record: AppReviewRecord };

export interface ShoppingReviewSectionProps {
  ownerAgent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  entry: {
    id: string;
    content?: string;
    metadata: {
      itemName: string;
      status: string;
      category?: string;
      seller?: string;
      reason?: string;
      imaginedPrice?: string;
      tags?: string[];
    };
  };
  /** TA 的显示名（评价 label） */
  taDisplayName: string;
}

export function ShoppingReviewSection({ ownerAgent, ownerProfile, entry, taDisplayName }: ShoppingReviewSectionProps) {
  const agentId = ownerAgent.id;
  const [state, setState] = useState<ReviewState>({ phase: 'loading' });
  const initRef = useRef<string | null>(null);

  useEffect(() => {
    const boundary = `${agentId}:${entry.id}`;
    if (initRef.current === boundary) return;
    initRef.current = boundary;
    let cancelled = false;
    (async () => {
      setState({ phase: 'loading' });
      try {
        const existing = await readAppReview(agentId, 'shopping', entry.id);
        if (cancelled) return;
        if (existing) {
          setState({ phase: 'ready', record: existing });
          return;
        }
        const result = await generateShoppingReviewWithAI({
          agent: ownerAgent,
          ownerProfile,
          entry: {
            itemName: entry.metadata.itemName,
            status: entry.metadata.status,
            category: entry.metadata.category,
            seller: entry.metadata.seller,
            reason: entry.metadata.reason,
            imaginedPrice: entry.metadata.imaginedPrice,
            content: entry.content,
            tags: entry.metadata.tags,
          },
        });
        if (cancelled) return;
        const record: AppReviewRecord = {
          entryId: entry.id,
          itemName: entry.metadata.itemName,
          itemStatus: entry.metadata.status,
          sides: result.sides,
          sellerReply: result.sellerReply,
          generatedAt: new Date().toISOString(),
        };
        await saveAppReview(agentId, 'shopping', record);
        if (cancelled) return;
        setState({ phase: 'ready', record });
      } catch (err) {
        if (cancelled) return;
        setState({ phase: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId, entry.id, entry.content, entry.metadata, ownerAgent, ownerProfile]);

  const sellerName = entry.metadata.seller?.trim() || '店家';
  const agentSide = state.phase === 'ready' ? state.record.sides.find((s) => s.by === 'agent') : null;
  const sellerReply = state.phase === 'ready' ? state.record.sellerReply : null;

  return (
    <div className={styles.xyDetailSection} data-testid={`phone-shopping-review-${entry.id}`}>
      <p className={styles.xyDetailSecTitle}>评价</p>
      {state.phase === 'loading' ? (
        <p className={styles.phoneAppHint} style={{ margin: 0 }}>正在生成评价…</p>
      ) : state.phase === 'error' ? (
        <p className={styles.phoneAppHint} role="alert" style={{ margin: 0 }}>评价生成失败：{state.message}</p>
      ) : agentSide ? (
        <>
          <ReviewSideCard side={agentSide} label={`${taDisplayName || 'TA'} 的评价`} />
          {sellerReply ? (
            <div className={styles.xyReviewSellerReply} data-testid={`phone-shopping-review-seller-reply-${entry.id}`}>
              <span className={styles.xyReviewSellerReplyLabel}>{sellerName} 回复：</span>
              <p className={styles.xyReviewSellerReplyText}>{sellerReply}</p>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

export interface SecondhandReviewSectionProps {
  ownerAgent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  entry: {
    id: string;
    /** 用于补生成买家聊天时给消息打时间戳（见下方 ensure-chat 流程）。 */
    updatedAt: string;
    content?: string;
    metadata: {
      itemName: string;
      status: string;
      category?: string;
      askingPrice?: string;
      delta?: string;
      buyer?: string;
      reason?: string;
      platformStyle?: string;
      tags?: string[];
    };
  };
  taDisplayName: string;
}

export function SecondhandReviewSection({ ownerAgent, ownerProfile, entry, taDisplayName }: SecondhandReviewSectionProps) {
  const agentId = ownerAgent.id;
  const [state, setState] = useState<ReviewState>({ phase: 'loading' });
  const initRef = useRef<string | null>(null);

  useEffect(() => {
    const boundary = `${agentId}:${entry.id}`;
    if (initRef.current === boundary) return;
    initRef.current = boundary;
    let cancelled = false;
    (async () => {
      setState({ phase: 'loading' });
      try {
        const existing = await readAppReview(agentId, 'secondhand', entry.id);
        if (cancelled) return;
        if (existing) {
          setState({ phase: 'ready', record: existing });
          return;
        }
        // 互评必须基于「最终已售形态」的买家聊天，统一走共享 ensureSecondhandBuyerChat：
        //  - 直接标为已售、从没生成过聊天 → 现在补生成整段；
        //  - 在谈→已售但缓存还停在 negotiating（缺成交收尾）→ 迁移续写收尾并落盘。
        // 这样评价基于完整聊天，且用户之后点开聊天面板看到的就是同一段（不会再各自迁移而对不上）。
        // 失败不阻塞：退回"无聊天"，互评仍按商品信息 + 人设生成。
        let buyerChatMessages: Array<{ role: 'buyer' | 'seller'; text: string }> | undefined;
        try {
          const chat = await ensureSecondhandBuyerChat({
            agent: ownerAgent,
            ownerProfile,
            agentId,
            entry: {
              id: entry.id,
              updatedAt: entry.updatedAt,
              content: entry.content,
              metadata: {
                itemName: entry.metadata.itemName,
                status: 'sold',
                category: entry.metadata.category,
                askingPrice: entry.metadata.askingPrice,
                delta: entry.metadata.delta,
                buyer: entry.metadata.buyer,
                reason: entry.metadata.reason,
                platformStyle: entry.metadata.platformStyle,
                tags: entry.metadata.tags,
              },
            },
          });
          if (cancelled) return;
          if (chat.messages?.length) {
            buyerChatMessages = chat.messages.map((m) => ({ role: m.role, text: m.text }));
          }
        } catch {
          buyerChatMessages = undefined;
        }
        if (cancelled) return;
        const result = await generateSecondhandReviewWithAI({
          agent: ownerAgent,
          ownerProfile,
          entry: {
            itemName: entry.metadata.itemName,
            status: entry.metadata.status,
            category: entry.metadata.category,
            askingPrice: entry.metadata.askingPrice,
            delta: entry.metadata.delta,
            buyer: entry.metadata.buyer,
            reason: entry.metadata.reason,
            content: entry.content,
            tags: entry.metadata.tags,
          },
          buyerChatMessages,
        });
        if (cancelled) return;
        const record: AppReviewRecord = {
          entryId: entry.id,
          itemName: entry.metadata.itemName,
          itemStatus: entry.metadata.status,
          sides: result.sides,
          generatedAt: new Date().toISOString(),
        };
        await saveAppReview(agentId, 'secondhand', record);
        if (cancelled) return;
        setState({ phase: 'ready', record });
      } catch (err) {
        if (cancelled) return;
        setState({ phase: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId, entry.id, entry.updatedAt, entry.content, entry.metadata, ownerAgent, ownerProfile]);

  const buyerName = entry.metadata.buyer?.trim() || '买家';
  const ta = taDisplayName || 'TA';
  const agentSide = state.phase === 'ready' ? state.record.sides.find((s) => s.by === 'agent') : null;
  const buyerSide = state.phase === 'ready' ? state.record.sides.find((s) => s.by === 'counterparty') : null;

  return (
    <div className={styles.xyDetailSection} data-testid={`phone-secondhand-review-${entry.id}`}>
      <p className={styles.xyDetailSecTitle}>互评</p>
      {state.phase === 'loading' ? (
        <p className={styles.phoneAppHint} style={{ margin: 0 }}>正在生成互评…</p>
      ) : state.phase === 'error' ? (
        <p className={styles.phoneAppHint} role="alert" style={{ margin: 0 }}>互评生成失败：{state.message}</p>
      ) : (
        <>
          {agentSide ? <ReviewSideCard side={agentSide} label={`卖家（${ta}）给买家的评价`} /> : null}
          {buyerSide ? <ReviewSideCard side={buyerSide} label={`买家「${buyerName}」的评价`} /> : null}
        </>
      )}
    </div>
  );
}
