/**
 * stream-invalidator.ts — streamBufferManager 的注册桥接
 *
 * 打破循环依赖（chat-slice → use-stream-buffer → stores → chat-slice）：
 * use-stream-buffer 在模块加载时调 register*，chat-slice 和 session-actions
 * 通过纯函数入口触达 streamBufferManager，不反向 import 其模块。
 *
 * 未注册时调用均 no-op，保证 store 的加载顺序不会导致崩溃。
 */

export interface StreamBufferSnapshot {
  hasContent: boolean;
  messageId: string | null;
  text: string;
  thinking: string;
  mood: string;
  moodYuan: string;
  inThinking: boolean;
  inMood: boolean;
}

type Invalidator = (sessionPath?: string) => void;
type Snapshotter = (sessionPath: string) => StreamBufferSnapshot | null;
type SessionStreamMetaCleaner = (sessionPath: string) => void;

let _invalidator: Invalidator | null = null;
let _snapshotter: Snapshotter | null = null;
let _sessionStreamMetaCleaner: SessionStreamMetaCleaner | null = null;

export function registerStreamBufferInvalidator(fn: Invalidator): void {
  _invalidator = fn;
}

export function registerStreamBufferSnapshot(fn: Snapshotter): void {
  _snapshotter = fn;
}

/**
 * stream-resume 在模块加载时注册其 per-session 流元数据清理器。经此桥接，session
 * 归属方（chat-slice）无需反向 import services/stream-resume——后者会拉入
 * websocket/use-stream-buffer/stores 形成循环依赖（模块求值期 TDZ）。
 */
export function registerSessionStreamMetaCleaner(fn: SessionStreamMetaCleaner): void {
  _sessionStreamMetaCleaner = fn;
}

/** 由 session 数据归属方调用：清除指定 session 的 streamBuffer 状态 */
export function invalidateStreamBuffer(sessionPath?: string): void {
  _invalidator?.(sessionPath);
}

/** 读取当前 in-flight streamBuffer 的快照；无内容或未注册时返回 null */
export function snapshotStreamBuffer(sessionPath: string): StreamBufferSnapshot | null {
  return _snapshotter ? _snapshotter(sessionPath) : null;
}

/** 由 session 数据归属方调用（clearSession / LRU eviction）：清除该 session 的 stream-resume 流元数据 */
export function clearSessionStreamMeta(sessionPath?: string): void {
  if (!sessionPath) return;
  _sessionStreamMetaCleaner?.(sessionPath);
}
