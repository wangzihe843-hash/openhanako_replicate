import { useEffect, useMemo, useRef, useState } from 'react';
import type { Agent } from '../types';
import styles from './XingyeShell.module.css';
import {
  generateSecondhandBuyerChatWithAI,
  pickRandomSecondhandBuyerChatCount,
} from './xingye-secondhand-ai';
import {
  readSecondhandBuyerChat,
  saveSecondhandBuyerChat,
  type SecondhandBuyerChat,
  type SecondhandBuyerChatMessage,
  type SecondhandBuyerChatStatus,
} from './xingye-secondhand-buyer-chat-store';
import type { SecondhandEntryMetadata } from './PhoneSecondhandApp';
import type { XingyeRoleProfile } from './xingye-profile-store';

type EntryLike = {
  id: string;
  agentId: string;
  updatedAt: string;
  content?: string;
  metadata: SecondhandEntryMetadata;
};

export interface SecondhandBuyerChatPanelProps {
  ownerAgent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  entry: EntryLike;
  /** TA 的显示名（卖家侧气泡 label） */
  taDisplayName: string;
  /** 返回详情页 */
  onBack: () => void;
}

function isChatEligibleStatus(value: string): value is SecondhandBuyerChatStatus {
  return value === 'sold' || value === 'negotiating';
}

function formatClockTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function formatDayHeader(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const month = d.getMonth() + 1;
  const day = d.getDate();
  return `${month} 月 ${day} 日`;
}

function buyerInitial(buyerName: string): string {
  const trimmed = buyerName.trim();
  if (!trimmed) return '买';
  return trimmed.slice(0, 1);
}

/**
 * 闲鱼风的"二手聊天"面板：
 *
 * - 顶部商品 banner（迷你卡：名字 / 价位 / 状态）
 * - 中段消息流（buyer 左灰、seller 右黄）
 * - 底部禁用输入框（历史快照不允许真发）
 *
 * 自我管理：
 * - mount 时检查 store 里有没有该 entry 的 chat → 有就直接渲染；没有就调 LLM 生成 + 落盘
 * - 提供「重新生成」按钮（出错或想换一段时用）
 */
export function SecondhandBuyerChatPanel(props: SecondhandBuyerChatPanelProps) {
  const { ownerAgent, ownerProfile, entry, taDisplayName, onBack } = props;
  const [chat, setChat] = useState<SecondhandBuyerChat | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initBoundaryRef = useRef<string | null>(null);

  const status = entry.metadata.status;
  const eligible = isChatEligibleStatus(status);
  const buyerName = useMemo(
    () => entry.metadata.buyer?.trim() || '陌生人',
    [entry.metadata.buyer],
  );

  /**
   * 触发首次懒生成：
   * - mount + entry 变化时跑一次 read；read 命中 → 直接渲染
   * - read 未命中且 status 合法 → 立刻 generate + save
   * - initBoundaryRef 防同一 entry 内重复触发（React StrictMode 双渲染保护）
   */
  useEffect(() => {
    if (!eligible) return;
    const boundary = `${entry.agentId}:${entry.id}`;
    if (initBoundaryRef.current === boundary) return;
    initBoundaryRef.current = boundary;

    let cancelled = false;
    (async () => {
      setError(null);
      setBusy(true);
      try {
        const existing = await readSecondhandBuyerChat(entry.agentId, entry.id);
        if (cancelled) return;
        if (existing) {
          setChat(existing);
          setBusy(false);
          return;
        }
        const result = await generateSecondhandBuyerChatWithAI({
          agent: ownerAgent,
          ownerProfile,
          entry: {
            id: entry.id,
            updatedAt: entry.updatedAt,
            content: entry.content,
            metadata: {
              itemName: entry.metadata.itemName,
              status: status as SecondhandBuyerChatStatus,
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
        const record: SecondhandBuyerChat = {
          entryId: entry.id,
          buyerName,
          itemName: entry.metadata.itemName,
          itemStatus: status as SecondhandBuyerChatStatus,
          messages: result.messages,
          generatedAt: new Date().toISOString(),
        };
        await saveSecondhandBuyerChat(entry.agentId, record);
        if (cancelled) return;
        setChat(record);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    eligible,
    entry.id,
    entry.agentId,
    entry.updatedAt,
    entry.content,
    entry.metadata,
    ownerAgent,
    ownerProfile,
    status,
    buyerName,
  ]);

  const handleRegenerate = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await generateSecondhandBuyerChatWithAI({
        agent: ownerAgent,
        ownerProfile,
        entry: {
          id: entry.id,
          updatedAt: entry.updatedAt,
          content: entry.content,
          metadata: {
            itemName: entry.metadata.itemName,
            status: status as SecondhandBuyerChatStatus,
            category: entry.metadata.category,
            askingPrice: entry.metadata.askingPrice,
            delta: entry.metadata.delta,
            buyer: entry.metadata.buyer,
            reason: entry.metadata.reason,
            platformStyle: entry.metadata.platformStyle,
            tags: entry.metadata.tags,
          },
        },
        desiredMessageCount: pickRandomSecondhandBuyerChatCount(),
      });
      const record: SecondhandBuyerChat = {
        entryId: entry.id,
        buyerName,
        itemName: entry.metadata.itemName,
        itemStatus: status as SecondhandBuyerChatStatus,
        messages: result.messages,
        generatedAt: new Date().toISOString(),
      };
      await saveSecondhandBuyerChat(entry.agentId, record);
      setChat(record);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!eligible) {
    return (
      <div className={styles.xyBuyerChatPanel}>
        <p className={styles.phoneAppHint} style={{ padding: '24px 18px' }}>
          仅在「在谈」或「已售出」的二手记录里才会有与买家的聊天历史。
        </p>
        <div style={{ padding: '0 18px' }}>
          <button type="button" className={styles.xyBtnGhost} onClick={onBack}>
            返回详情
          </button>
        </div>
      </div>
    );
  }

  const messages = chat?.messages ?? [];
  let lastDayLabel = '';

  return (
    <div className={styles.xyBuyerChatPanel} data-testid={`phone-secondhand-buyer-chat-${entry.id}`}>
      <header className={styles.xyBuyerChatHeader}>
        <div className={styles.xyBuyerChatHeaderTop}>
          <button
            type="button"
            className={styles.xyBuyerChatHeaderBack}
            onClick={onBack}
            aria-label="返回二手详情"
          >
            ‹ 返回
          </button>
          <div className={styles.xyBuyerChatHeaderTitle}>
            <span className={styles.xyBuyerChatHeaderName}>{buyerName}</span>
            <span className={styles.xyBuyerChatHeaderSub}>
              {status === 'sold' ? '已成交' : '还在谈'} · 二手 IM
            </span>
          </div>
          <button
            type="button"
            className={styles.xyBuyerChatHeaderRefresh}
            onClick={() => void handleRegenerate()}
            disabled={busy}
            title="重新生成这段聊天"
            aria-label="重新生成聊天"
          >
            {busy ? '…' : '换一段'}
          </button>
        </div>
        <div className={styles.xyBuyerChatItemBanner}>
          <div className={styles.xyBuyerChatItemBannerLeft}>
            <p className={styles.xyBuyerChatItemBannerName}>{entry.metadata.itemName}</p>
            {entry.metadata.askingPrice ? (
              <p className={styles.xyBuyerChatItemBannerPrice}>{entry.metadata.askingPrice}</p>
            ) : null}
          </div>
          <span className={styles.xyBuyerChatItemBannerBadge}>
            {status === 'sold' ? '已售出' : '在谈中'}
          </span>
        </div>
      </header>

      <div className={styles.xyBuyerChatThread} aria-live="polite">
        {busy && messages.length === 0 ? (
          <p className={styles.phoneAppHint} style={{ textAlign: 'center', padding: '24px 18px' }}>
            正在生成与买家的聊天记录…
          </p>
        ) : null}
        {error && messages.length === 0 ? (
          <div style={{ padding: '24px 18px', textAlign: 'center' }}>
            <p className={styles.phoneAppHint} role="alert">
              生成失败：{error}
            </p>
            <button
              type="button"
              className={styles.xyBtnGhost}
              onClick={() => void handleRegenerate()}
              disabled={busy}
              style={{ marginTop: 8 }}
            >
              {busy ? '生成中…' : '再试一次'}
            </button>
          </div>
        ) : null}

        {messages.map((msg) => {
          const dayLabel = formatDayHeader(msg.at);
          const showDay = dayLabel && dayLabel !== lastDayLabel;
          if (showDay) lastDayLabel = dayLabel;
          return (
            <div key={msg.id}>
              {showDay ? (
                <div className={styles.xyBuyerChatDayDivider}>
                  <span>{dayLabel}</span>
                </div>
              ) : null}
              <ChatBubble
                message={msg}
                buyerInitial={buyerInitial(buyerName)}
                sellerLabel={taDisplayName || 'TA'}
              />
            </div>
          );
        })}

        {messages.length > 0 ? (
          <div
            className={
              status === 'sold'
                ? styles.xyBuyerChatSysSold
                : styles.xyBuyerChatSysNegotiating
            }
            role="status"
          >
            {status === 'sold'
              ? `订单已成交 · ${entry.metadata.askingPrice || '价格已商定'}`
              : '对方仍在考虑中'}
          </div>
        ) : null}

        {error && messages.length > 0 ? (
          <p className={styles.phoneAppHint} role="alert" style={{ textAlign: 'center', padding: '8px 18px' }}>
            上次重新生成失败：{error}
          </p>
        ) : null}
      </div>

      <footer className={styles.xyBuyerChatFooter}>
        <div className={styles.xyBuyerChatComposerDisabled}>
          这是 TA 手机里的历史聊天快照 · 无法继续回复
        </div>
      </footer>
    </div>
  );
}

function ChatBubble({
  message,
  buyerInitial,
  sellerLabel,
}: {
  message: SecondhandBuyerChatMessage;
  buyerInitial: string;
  sellerLabel: string;
}) {
  const isBuyer = message.role === 'buyer';
  const rowCls = isBuyer
    ? `${styles.xyBuyerChatRow} ${styles.xyBuyerChatRowBuyer}`
    : `${styles.xyBuyerChatRow} ${styles.xyBuyerChatRowSeller}`;
  const bubbleCls = isBuyer ? styles.xyBuyerChatBubbleBuyer : styles.xyBuyerChatBubbleSeller;
  const time = formatClockTime(message.at);
  return (
    <div className={rowCls}>
      {isBuyer ? <span className={styles.xyBuyerChatAvatar}>{buyerInitial}</span> : null}
      <div className={styles.xyBuyerChatBubbleCol}>
        <span className={styles.xyBuyerChatBubbleMeta}>
          {isBuyer ? '买家' : sellerLabel} · {time}
        </span>
        <div className={bubbleCls}>{message.text}</div>
      </div>
      {!isBuyer ? <span className={styles.xyBuyerChatAvatarSeller}>我</span> : null}
    </div>
  );
}
