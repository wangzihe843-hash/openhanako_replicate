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

// ──────────────────────────────────────────────────────────────────────────
//  Entry origin classification
// ──────────────────────────────────────────────────────────────────────────

/**
 * 心跳 confirm 路径产出的 entry id 一律带这个前缀（见各模块 confirmXxxDraft 注释）。
 * 同时是「区分 auto / user 内容」的权威信号：consumer 看到带这个前缀的 id 即可断定
 * 是 agent 自动产出（heartbeat 草稿确认）；其他都是用户手动产出。
 *
 * 服务端 lib/xingye/heartbeat-consumer.js 也硬编码了这个字符串作 fallback，
 * 改动时两边都要同步。
 */
export const FROM_DRAFT_ID_PREFIX = 'from-draft-';

export type XingyeEntryOrigin = 'auto' | 'user';

/**
 * 根据 entry / message / post / record 的 id 判定来源。
 *
 * 用 id 前缀做权威判定（而不是 entry.source 字段 / 调用方 hint）是因为：
 *   1. 前缀是 confirm 路径强制写入的，无法绕过
 *   2. 单一 source of truth，加新模块不会忘
 *   3. 旧事件 payload 没有 origin 字段时，消费者也能用同样规则回填
 */
export function originFromEntryId(id: string | null | undefined): XingyeEntryOrigin {
  if (typeof id !== 'string') return 'user';
  return id.startsWith(FROM_DRAFT_ID_PREFIX) ? 'auto' : 'user';
}
