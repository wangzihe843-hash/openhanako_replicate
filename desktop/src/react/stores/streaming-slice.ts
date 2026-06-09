export interface ActiveSessionStream {
  streamId: string | null;
  turnId: string | null;
}

export interface StreamingStatusIdentity {
  streamId?: string | null;
  turnId?: string | null;
}

export interface StreamingSlice {
  /** 所有正在 streaming 的 session path 集合（单一事实源） */
  streamingSessions: string[];
  /** 正在 streaming 的 session 身份。用于忽略旧 turn/status 迟到事件。 */
  activeSessionStreams: Record<string, ActiveSessionStream>;
  addStreamingSession: (path: string, identity?: StreamingStatusIdentity) => void;
  removeStreamingSession: (path: string, identity?: StreamingStatusIdentity) => boolean;
  /** 后台 session 已完成新输出，但用户尚未切回查看。 */
  unreadOutputSessionPaths: string[];
  markSessionOutputUnread: (path: string) => void;
  clearSessionOutputUnread: (path: string) => void;
  /** 按 session path 存储的内联错误（权威源）。text 为 null 表示无 error。 */
  inlineErrors: Record<string, string | null>;
  /** 写入某个 session 的 inline error；ttl>0 时 ttl 毫秒后自动清除（默认 5s）。新 error 覆盖旧 error 会取消旧定时器。 */
  setInlineError: (path: string, text: string, ttlMs?: number) => void;
  /** 清除某个 session 的 inline error（同时取消其定时器）。 */
  clearInlineError: (path: string) => void;
  /** 模型切换进行中（阻止发送） */
  modelSwitching: boolean;
  setModelSwitching: (v: boolean) => void;
}

// 定时器按 sessionPath 存在模块闭包里，不污染 store 的可见状态。
// 生命周期规则：
//   - setInlineError 覆盖写入时，先 clear 旧 timer 再起新的，避免"旧 timer 误清新 text"竞态
//   - clearInlineError 清状态时同步 clear timer，防 timer 在 null 写入后继续 fire
//   - timer 回调内部用 get() 取最新 text：若已被新 error 覆盖，get().inlineErrors[sp] 不等于本次写入的 text，不动它
const inlineErrorTimers = new Map<string, ReturnType<typeof setTimeout>>();

function cancelTimer(path: string): void {
  const t = inlineErrorTimers.get(path);
  if (t) {
    clearTimeout(t);
    inlineErrorTimers.delete(path);
  }
}

function normalizeIdentityPart(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function hasExplicitIdentity(identity: StreamingStatusIdentity | undefined): boolean {
  return !!identity
    && (Object.prototype.hasOwnProperty.call(identity, 'streamId')
      || Object.prototype.hasOwnProperty.call(identity, 'turnId'));
}

function identitiesMatch(
  current: ActiveSessionStream | undefined,
  incoming: StreamingStatusIdentity | undefined,
): boolean {
  if (!current || !hasExplicitIdentity(incoming)) return true;
  const currentStreamId = normalizeIdentityPart(current.streamId);
  const incomingStreamId = normalizeIdentityPart(incoming?.streamId);
  if (currentStreamId && incomingStreamId && currentStreamId !== incomingStreamId) return false;

  const currentTurnId = normalizeIdentityPart(current.turnId);
  const incomingTurnId = normalizeIdentityPart(incoming?.turnId);
  if (currentTurnId && incomingTurnId && currentTurnId !== incomingTurnId) return false;

  return true;
}

export const createStreamingSlice = (
  set: (partial: Partial<StreamingSlice> | ((s: StreamingSlice) => Partial<StreamingSlice>)) => void,
  get?: () => StreamingSlice,
): StreamingSlice => ({
  streamingSessions: [],
  activeSessionStreams: {},
  addStreamingSession: (path, identity) => set((s) => {
    const active = s.activeSessionStreams || {};
    const current = active[path];
    const explicitIdentity = hasExplicitIdentity(identity);
    return {
      streamingSessions: s.streamingSessions.includes(path)
        ? s.streamingSessions
        : [...s.streamingSessions, path],
      activeSessionStreams: {
        ...active,
        [path]: {
          streamId: explicitIdentity
            ? normalizeIdentityPart(identity?.streamId)
            : (current?.streamId ?? null),
          turnId: explicitIdentity
            ? normalizeIdentityPart(identity?.turnId)
            : (current?.turnId ?? null),
        },
      },
    };
  }),
  removeStreamingSession: (path, identity) => {
    let applied = true;
    set((s) => {
      const active = s.activeSessionStreams || {};
      if (!identitiesMatch(active[path], identity)) {
        applied = false;
        return {};
      }
      const { [path]: _removed, ...restActive } = active;
      return {
        streamingSessions: s.streamingSessions.filter(p => p !== path),
        activeSessionStreams: restActive,
      };
    });
    return applied;
  },
  unreadOutputSessionPaths: [],
  markSessionOutputUnread: (path) => set((s) => ({
    unreadOutputSessionPaths: s.unreadOutputSessionPaths.includes(path)
      ? s.unreadOutputSessionPaths
      : [...s.unreadOutputSessionPaths, path],
  })),
  clearSessionOutputUnread: (path) => set((s) => ({
    unreadOutputSessionPaths: s.unreadOutputSessionPaths.filter(p => p !== path),
  })),
  inlineErrors: {},
  setInlineError: (path, text, ttlMs = 5000) => {
    cancelTimer(path);
    set((s) => ({ inlineErrors: { ...s.inlineErrors, [path]: text } }));
    if (ttlMs > 0) {
      const timer = setTimeout(() => {
        inlineErrorTimers.delete(path);
        const current = get?.().inlineErrors[path];
        if (current !== text) return;
        set((s) => ({ inlineErrors: { ...s.inlineErrors, [path]: null } }));
      }, ttlMs);
      inlineErrorTimers.set(path, timer);
    }
  },
  clearInlineError: (path) => {
    cancelTimer(path);
    set((s) => ({ inlineErrors: { ...s.inlineErrors, [path]: null } }));
  },
  modelSwitching: false,
  setModelSwitching: (v) => set({ modelSwitching: v }),
});
