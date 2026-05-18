/**
 * Per-key in-flight Promise dedupe for draft confirm.
 *
 * 为什么需要：xingye 各模块的 confirmXxxDraft 走「list → append entry → delete draft」
 * 三步；如果 UI 在第一步 await 期间又触发了同 draftId 的 confirm（双击、跨窗口、
 * 网络抖动后 retry 等），两路都会跑 append → 同一 draft 产出多条 entry。
 *
 * 这个 helper 在进程内按 key 去重：同 key 已有 in-flight 任务时，第二次调用直接复用
 * 现有 Promise，避免重复执行；任务完成（成功/失败）后清掉 map 项，不长期持有。
 *
 * 跨进程/跨标签的并发不在保护范围；那种场景需要服务端做 idempotency key，本仓库
 * 当前不必要——但 confirmXxxDraft 还应配合「确定性 entry id + 先 list 查重」做幂等
 * append，二者组合后即使锁绕过也只产出一条 entry。
 */

const inflight = new Map<string, Promise<unknown>>();

export async function withDraftConfirmLock<T>(
  key: string,
  task: () => Promise<T>,
): Promise<T> {
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const p = (async () => {
    try {
      return await task();
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

/** 仅供测试使用：清空 in-flight map（用于隔离用例之间的状态）。 */
export function __resetDraftConfirmLockForTests(): void {
  inflight.clear();
}
