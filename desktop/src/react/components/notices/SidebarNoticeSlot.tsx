import { useEffect, useMemo, useState } from 'react';
import { useTrainUpdateState } from '../../hooks/use-train-update-state';
import type { TrainUpdatePhase, TrainUpdateProgressState } from '../../hooks/use-train-update-state';
import type { CrashFallbackNotice } from '../../types';
import styles from './SidebarNoticeSlot.module.css';

/**
 * 左下角更新贴纸默认使用“内容更新”语境；壳更新只在
 * `minShellBlocked`（不更新壳收不到新列车）时才占用这张卡片。壳更新器
 * 自己下载好了这件事本身不再触发卡片——那安静躺在设置页，不来打扰这里。
 * 两种触发态互斥：`minShellBlocked` 为真时切到"需更新应用本体"形态
 * （点击走既有 autoUpdateInstall 流程，这是唯一允许从这张卡片走壳安装的
 * 情形），否则只要 `available` 非空就是默认的列车形态（点击 = applyNow，
 * 下载→验签→激活→重载一条龙，进行中的阶段/进度直接显示在卡面上）。
 *
 * 两种触发态的叉号语义不同：
 * - blocked（需更新应用本体）= "本 session 安静，下次启动重新出现" ——
 *   用组件内存状态（不落 localStorage），进程重启即天然重置。
 * - train（默认热更新）= 沿用既有 dismissed-key 机制（按 "version:X" 存
 *   localStorage），出现新版本自然重新弹出。
 *
 * 第三种触发态 fallback（崩溃回退提示）优先级最高——它不是"有没有更新"这
 * 类可选提示，是"已经发生的事情，用户必须被告知"：连续启动/加载失败触发
 * 自动回退到上一版本后，用户此前完全无感知（只写日志），这是明确
 * 禁止的静默降级。它的叉号语义也不同于前两种：一次性 ack（关掉即消费，
 * 状态归属在主进程内存，见 desktop/main.cjs 的 `_crashFallbackNotice`），
 * 不用 dismissed-key，也不用组件内存——数据源是 hook 里的
 * `fallbackNotice`，本组件只负责渲染与转发 ack 动作。
 */
const DISMISSED_TRAIN_UPDATE_KEY = 'hana-sidebar-train-update-dismissed-key';

type NoticeStorage = Pick<Storage, 'getItem' | 'setItem'>;

interface SidebarUpdateNoticeCardProps {
  available: { version: string } | null;
  minShellBlocked: boolean;
  phase: TrainUpdatePhase;
  progress: TrainUpdateProgressState | null;
  fallbackNotice?: CrashFallbackNotice | null;
  onInstallShell?: () => void | Promise<unknown>;
  onApplyTrain?: () => void | Promise<unknown>;
  onAckFallback?: () => void | Promise<unknown>;
  storage?: NoticeStorage | null;
}

const tr = (key: string, vars?: Record<string, string | number>) => window.t?.(key, vars) ?? key;

function safeStorage(): NoticeStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readDismissedKey(storage: NoticeStorage | null, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeDismissedKey(storage: NoticeStorage | null, storageKey: string, value: string): void {
  try {
    storage?.setItem(storageKey, value);
  } catch {
    // Ignore storage failures; the in-memory dismissed state still hides the card for this mount.
  }
}

function trainNoticeKey(available: { version: string } | null): string | null {
  return available ? `version:${available.version}` : null;
}

function percentOf(progress: TrainUpdateProgressState | null): number {
  if (!progress || !progress.totalBytes) return 0;
  return Math.max(0, Math.min(100, Math.round((progress.receivedBytes / progress.totalBytes) * 100)));
}

function RefreshIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 2v6h-6" />
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M3 22v-6h6" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

// fallback 形态没有可点击的动作（不像 train/blocked 那样点卡片即触发下载/
// 安装），复用 .refreshIcon 的位置与样式 token，只换一个语义正确的图标
// （提醒，不是刷新），避免误导用户以为点击卡面能做什么。
function AlertIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
    </svg>
  );
}

interface StickerContent {
  kind: 'blocked' | 'train' | 'fallback';
  title: string;
  /** 内容版本号小字：显示已激活内容版本，不显示壳版本或 train 号。 */
  subtitle: string | null;
}

/**
 * 三态选择，fallbackNotice 优先级最高（已经发生的事必须先说清楚），其次
 * minShellBlocked（唯一"壳"相关的触发源，不再看壳自动更新器自己的
 * 'downloaded' 状态），最后才是默认的 train 形态。纯函数，独立可测。
 */
function resolveStickerContent({
  available,
  minShellBlocked,
  phase,
  progress,
  fallbackNotice,
}: Pick<SidebarUpdateNoticeCardProps, 'available' | 'minShellBlocked' | 'phase' | 'progress' | 'fallbackNotice'>): StickerContent | null {
  if (fallbackNotice) {
    return {
      kind: 'fallback',
      title: tr('settings.about.fallbackStickerTitle', {
        fromVersion: fallbackNotice.fromVersion ?? '?',
        toVersion: fallbackNotice.toVersion ?? '?',
      }),
      subtitle: null,
    };
  }
  if (minShellBlocked) {
    return {
      kind: 'blocked',
      title: tr('settings.about.shellStickerTitleBlocking'),
      subtitle: available ? `v${available.version}` : null,
    };
  }
  if (!available) return null;
  if (phase === 'downloading') {
    return {
      kind: 'train',
      title: tr('settings.about.trainStickerDownloading', { percent: percentOf(progress) }),
      subtitle: `v${available.version}`,
    };
  }
  if (phase === 'applying') {
    return {
      kind: 'train',
      title: tr('settings.about.trainStickerApplying'),
      subtitle: `v${available.version}`,
    };
  }
  return {
    kind: 'train',
    title: tr('settings.about.trainStickerTitle'),
    subtitle: `v${available.version}`,
  };
}

export function SidebarUpdateNoticeCard({
  available,
  minShellBlocked,
  phase,
  progress,
  fallbackNotice,
  onInstallShell,
  onApplyTrain,
  onAckFallback,
  storage,
}: SidebarUpdateNoticeCardProps) {
  const resolvedStorage = storage === undefined ? safeStorage() : storage;

  // blocked 形态的叉号状态只活在组件内存里（不落 localStorage）：进程
  // 重启 = 组件重新挂载 = 天然重置为"未叉过"，这正是"下次启动重新出现"的实现。
  const [blockedDismissed, setBlockedDismissed] = useState(false);

  const trainKey = trainNoticeKey(available);
  const [trainDismissedKey, setTrainDismissedKey] = useState<string | null>(
    () => readDismissedKey(resolvedStorage, DISMISSED_TRAIN_UPDATE_KEY),
  );
  useEffect(() => {
    setTrainDismissedKey(readDismissedKey(resolvedStorage, DISMISSED_TRAIN_UPDATE_KEY));
  }, [trainKey, resolvedStorage]);

  const content = useMemo(
    () => resolveStickerContent({ available, minShellBlocked, phase, progress, fallbackNotice }),
    [available, minShellBlocked, phase, progress, fallbackNotice],
  );

  if (!content) return null;
  if (content.kind === 'blocked' && blockedDismissed) return null;
  if (content.kind === 'train' && trainKey && trainDismissedKey === trainKey) return null;

  const dismiss = () => {
    if (content.kind === 'fallback') {
      // 一次性 ack：状态归属在主进程内存（见 use-train-update-state 的
      // ackFallbackNotice），不是本组件的本地 dismissed 状态——组件卸载/
      // 重挂载不应该让已 ack 的通知重新出现。
      void onAckFallback?.();
      return;
    }
    if (content.kind === 'blocked') {
      setBlockedDismissed(true);
      return;
    }
    if (trainKey) {
      writeDismissedKey(resolvedStorage, DISMISSED_TRAIN_UPDATE_KEY, trainKey);
      setTrainDismissedKey(trainKey);
    }
  };

  const handleAction = () => {
    if (content.kind === 'fallback') return; // 没有可执行的动作，点卡面无事发生
    if (content.kind === 'blocked') {
      void onInstallShell?.();
    } else {
      void onApplyTrain?.();
    }
  };

  return (
    <div className={styles.slot}>
      <section className={styles.card} role="status" aria-live="polite">
        <button type="button" className={styles.cardButton} onClick={handleAction}>
          <span className={styles.textBlock}>
            <span className={styles.title}>{content.title}</span>
            {content.subtitle && <span className={styles.subtitle}>{content.subtitle}</span>}
          </span>
          <span className={styles.refreshIcon}>
            {content.kind === 'fallback' ? <AlertIcon /> : <RefreshIcon />}
          </span>
        </button>
        <button
          type="button"
          className={styles.closeButton}
          aria-label={content.kind === 'fallback' ? tr('settings.about.fallbackStickerAckLabel') : tr('window.close')}
          onClick={dismiss}
        >
          <CloseIcon />
        </button>
      </section>
    </div>
  );
}

export function SidebarNoticeSlot() {
  const { available, minShellBlocked, phase, progress, fallbackNotice, applyNow, ackFallbackNotice } = useTrainUpdateState();

  return (
    <SidebarUpdateNoticeCard
      available={available}
      minShellBlocked={minShellBlocked}
      phase={phase}
      progress={progress}
      fallbackNotice={fallbackNotice}
      onInstallShell={() => window.hana?.autoUpdateInstall?.()}
      onApplyTrain={() => applyNow()}
      onAckFallback={() => ackFallbackNotice()}
    />
  );
}
