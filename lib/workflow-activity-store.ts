/**
 * workflow-activity-store.js —— 右侧活动卡（workflow + subagent）的持久化背书
 *
 * ActivityHub 是内存广播层，进程重启即清空，导致右侧卡（WorkflowCard / AgentActivityCard）
 * 重启消失。这个 store 把 ActivityHub 标记为可持久的活动（workflow / workflow_agent / subagent，
 * 见 activity-hub.js 的 PERSISTABLE_KINDS）落盘（hanakoHome/workflow-activity.json），作为
 * ActivityHub 的「持久化背书」：upsert 写穿、重启回灌、会话退场清理、72h TTL 修剪。
 * 名称沿用 workflow-activity（首次落地时仅 workflow），实为 ActivityHub 通用持久层。
 *
 * 归属：每条 entry 自带 sessionPath，按 path 存取（listBySession / removeBySession），
 * 不从焦点指针推导（状态归属唯一确定）。这是 dumb 持久层——entry 的规范化由 ActivityHub 负责。
 */
import fs from "node:fs";
import path from "node:path";
import { atomicWriteSync } from "../shared/safe-fs.ts";

export const WORKFLOW_ACTIVITY_STORE_VERSION = 1;

export class WorkflowActivityStore {
  declare _persistPath: string | null;
  declare _entries: Map<string, any>;

  constructor(persistPath: any) {
    this._persistPath = persistPath || null;
    /** @type {Map<string, object>} */
    this._entries = new Map();
    // 防抖落盘状态：upsert 高频，标脏后由单个 ~1s unref 定时器合并写盘，
    // 避免每次 upsert 都 O(n) 全量 stringify（大 workflow 下聚合 O(n²)）。
    this._dirty = false;
    this._saveTimer = null;
    if (this._persistPath) this._load();
  }

  upsert(entry: any) {
    if (!entry || typeof entry.id !== "string" || !entry.id) return null;
    const prev = this._entries.get(entry.id);
    const next = { ...entry };
    this._entries.set(next.id, next);
    // 状态转移（新建 / status 变化，含 running→done/failed 终态）是「跑到一半被重启
    // → 遗留 running 判孤儿 → 重启后判 failed」这条耐久契约的落盘依据，必须同步写穿，
    // 否则崩在防抖窗口内会丢掉 running 记录、孤儿判定失效（workflow-activity-restart 覆盖）。
    // 仅「同 id 同 status 的进度更新」（token 累计等高频 churn，大 workflow 下的 O(n²) 主因）
    // 走防抖合并。
    if (!prev || prev.status !== next.status) {
      this._dirty = true;
      this.flush();
    } else {
      this._save();
    }
    return { ...next };
  }

  get(id: string) {
    const e = this._entries.get(id);
    return e ? { ...e } : null;
  }

  list() {
    return [...this._entries.values()].map((e) => ({ ...e }));
  }

  listBySession(sessionPath: string) {
    if (!sessionPath) return [];
    const out = [];
    for (const e of this._entries.values()) {
      if (e.sessionPath === sessionPath) out.push({ ...e });
    }
    return out;
  }

  /** 会话退场（删除 / 归档 / 冷清理）时回收该 session 的活动，返回删除条数。 */
  removeBySession(sessionPath: string) {
    if (!sessionPath) return 0;
    let removed = 0;
    for (const [id, e] of this._entries) {
      if (e.sessionPath === sessionPath) {
        this._entries.delete(id);
        removed++;
      }
    }
    // 会话退场是耐久关键路径：标脏后同步落盘，防防抖窗口内进程退出丢掉清理结果。
    if (removed) {
      this._dirty = true;
      this.flush();
    }
    return removed;
  }

  /**
   * 删除早于 maxAgeMs 的 entry（按 finishedAt，回退 startedAt）。nowMs 由调用方传入
   * （服务端 Date.now()，测试可注入），返回删除条数。与 session 72h 冷清理对齐。
   */
  prune(maxAgeMs: number, nowMs: number) {
    if (!Number.isFinite(maxAgeMs) || !Number.isFinite(nowMs)) return 0;
    const cutoff = nowMs - maxAgeMs;
    let removed = 0;
    for (const [id, e] of this._entries) {
      const ts = Number.isFinite(e.finishedAt)
        ? e.finishedAt
        : (Number.isFinite(e.startedAt) ? e.startedAt : null);
      if (ts != null && ts < cutoff) {
        this._entries.delete(id);
        removed++;
      }
    }
    // prune（TTL 冷清理）是耐久关键路径：标脏后同步落盘，不留给防抖窗口。
    if (removed) {
      this._dirty = true;
      this.flush();
    }
    return removed;
  }

  get size() {
    return this._entries.size;
  }

  /** 标记脏数据，延迟 1 秒批量写盘（合并高频 upsert）。 */
  _save() {
    if (!this._persistPath) return;
    this._dirty = true;
    if (!this._saveTimer) {
      this._saveTimer = setTimeout(() => this._flushToDisk(), 1000);
      if (this._saveTimer.unref) this._saveTimer.unref();
    }
  }

  /**
   * 同步把待写状态落盘（如有）。耐久关键路径（关停 / prune / removeBySession）调用，
   * 防防抖窗口内进程退出丢掉最终状态。
   */
  flush() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    this._flushToDisk();
  }

  _flushToDisk() {
    this._saveTimer = null;
    if (!this._persistPath || !this._dirty) return;
    this._dirty = false;
    const data = {
      schemaVersion: WORKFLOW_ACTIVITY_STORE_VERSION,
      entries: Object.fromEntries(this._entries.entries()),
    };
    fs.mkdirSync(path.dirname(this._persistPath), { recursive: true });
    atomicWriteSync(this._persistPath, JSON.stringify(data, null, 2) + "\n");
  }

  _load() {
    if (!this._persistPath || !fs.existsSync(this._persistPath)) return;
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this._persistPath, "utf-8"));
    } catch {
      // 损坏文件不崩：按空账本起步，下次 _save 覆盖。
      return;
    }
    const entries = raw?.entries && typeof raw.entries === "object" ? raw.entries : {};
    for (const [id, value] of Object.entries(entries)) {
      if (!id || !value || typeof value !== "object") continue;
      this._entries.set(id, { ...value, id });
    }
  }
}
