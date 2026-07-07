export type LocateStep = 'scroll' | 'load-more' | 'wait' | 'wait-element' | 'give-up';

export interface LocateStepInput {
  targetIndex: number;
  elementPresent: boolean;
  /** items 中是否存在 id === String(targetIndex) 的 message item */
  itemPresent: boolean;
  oldestId: string | undefined;
  hasMore: boolean;
  loadingMore: boolean;
}

export function resolveLocateStep(input: LocateStepInput): LocateStep {
  if (input.elementPresent) return 'scroll';
  // items 有该消息但 DOM 未注册：可能是 commit 间隙，也可能永远不会注册
  // （折叠块内 / 渲染为 null）。消费方做有界等待后决定滚动或放弃。
  if (input.itemPresent) return 'wait-element';
  const oldest = Number(input.oldestId ?? NaN);
  if (!Number.isFinite(oldest)) return 'wait'; // session 尚未初始化
  if (input.targetIndex < oldest) {
    if (input.loadingMore) return 'wait';
    return input.hasMore ? 'load-more' : 'give-up';
  }
  return 'give-up'; // 在窗口内却无此消息：id 对应的消息前端不可渲染
}
