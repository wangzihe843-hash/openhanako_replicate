/**
 * reusable-subagent-store.js — 可复用 subagent 实例的持久化账本
 *
 * 按 reuseKey（= realAgentId::taskSuffix）记录每个复用实例的稳定 session 文件路径
 * （childSessionPath）与运行计数。subagent 工具派单时按 reuseKey 查到上次的
 * childSessionPath，作为 executeIsolated 的 resumeSessionPath 续接历史（带记忆）。
 *
 * 与 SubagentRunStore（按 taskId 记单次运行）正交：本账本按实例长期存活，跨多次运行。
 * 状态归属唯一确定：reuseKey 由调用方显式传入并持久化，组件字段（agentId/taskSuffix/
 * parentSessionPath）一并落盘供审计，禁从全局焦点推导。
 */

import fs from "node:fs";
import path from "node:path";
import { atomicWriteSync } from "../shared/safe-fs.js";

// v2：reuseKey 从「全局 agentId::suffix」改为「per-session sessionPath::agentId::suffix」
// （每对话各自独立实例）。v1 旧条目无 session 维度、无法重映射，加载时整体丢弃（见 _load）。
export const REUSABLE_SUBAGENT_STORE_VERSION = 2;

function nowIso() {
  return new Date().toISOString();
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function pickString(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

function pickCount(value) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function normalizeInstance(reuseKey, record = {}, existing = null) {
  const timestamp = nowIso();
  return {
    ...(existing || {}),
    reuseKey,
    childSessionPath: pickString(record.childSessionPath) || existing?.childSessionPath || null,
    parentSessionPath: pickString(record.parentSessionPath) || existing?.parentSessionPath || null,
    agentId: pickString(record.agentId) || existing?.agentId || null,
    taskSuffix: pickString(record.taskSuffix) || existing?.taskSuffix || null,
    summary: pickString(record.summary) || existing?.summary || null,
    lastStatus: pickString(record.lastStatus) || existing?.lastStatus || null,
    runCount: pickCount(record.runCount ?? existing?.runCount),
    createdAt: existing?.createdAt || pickString(record.createdAt) || timestamp,
    lastRunAt: pickString(record.lastRunAt) || existing?.lastRunAt || null,
    updatedAt: timestamp,
  };
}

export class ReusableSubagentStore {
  constructor(persistPath) {
    this._persistPath = persistPath || null;
    this._instances = new Map();
    // 进程内 per-reuseKey 串行锁（不持久化）。store 是 engine 单例、跨所有 per-agent
    // subagent 工具闭包共享，所以这把锁天然全局：不同来源 agent 委派同一复用实例
    // （如 butter::探索）也会串行，杜绝并发写同一 append-only JSONL 文件。
    this._chains = new Map();
    if (this._persistPath) this._load();
  }

  /** 查实例记录（含 childSessionPath，供 resume）。未知 key 返回 null。 */
  get(reuseKey) {
    if (!reuseKey) return null;
    return clone(this._instances.get(reuseKey) || null);
  }

  /**
   * 一次运行开始：runCount +1，刷新 childSessionPath / lastRunAt。
   * 首次创建时 createdAt 落定，之后不变。
   */
  beginRun(reuseKey, record = {}) {
    if (!reuseKey) return null;
    const existing = this._instances.get(reuseKey) || null;
    const next = normalizeInstance(reuseKey, {
      ...record,
      runCount: (existing?.runCount || 0) + 1,
      lastRunAt: nowIso(),
    }, existing);
    this._instances.set(reuseKey, next);
    this._save();
    return clone(next);
  }

  /**
   * 一次运行结束：更新 summary / lastStatus，不动 runCount。
   * 未知 key 返回 null（不为不存在的实例静默建空记录，符合"禁兜底"）。
   */
  finishRun(reuseKey, record = {}) {
    if (!reuseKey) return null;
    const existing = this._instances.get(reuseKey) || null;
    if (!existing) return null;
    const next = normalizeInstance(reuseKey, {
      ...record,
      lastStatus: pickString(record.status) || pickString(record.lastStatus),
    }, existing);
    this._instances.set(reuseKey, next);
    this._save();
    return clone(next);
  }

  /** 删除实例记录（build-to-delete）。删成功返回 true，本不存在返回 false。 */
  remove(reuseKey) {
    if (!reuseKey || !this._instances.has(reuseKey)) return false;
    this._instances.delete(reuseKey);
    this._save();
    return true;
  }

  /**
   * 删除某 agent 的所有复用实例记录（agent 被删除时其 agentDir/reusable 文件已随之消失）。
   * 返回删除条数。build-to-delete：避免悬挂指向已删文件的账本条目。
   */
  removeByAgentId(agentId) {
    if (!agentId) return 0;
    let removed = 0;
    for (const [key, rec] of this._instances) {
      if (rec.agentId === agentId) {
        this._instances.delete(key);
        removed += 1;
      }
    }
    if (removed) this._save();
    return removed;
  }

  /**
   * 删除某 parent session 的所有复用实例记录（session 清理 / 删除时调用）。
   * per-session 作用域归属落地：实例随其所属对话一同退场。返回删除条数。
   */
  removeBySession(parentSessionPath) {
    if (!parentSessionPath) return 0;
    let removed = 0;
    for (const [key, rec] of this._instances) {
      if (rec.parentSessionPath === parentSessionPath) {
        this._instances.delete(key);
        removed += 1;
      }
    }
    if (removed) this._save();
    return removed;
  }

  list() {
    return Array.from(this._instances.values()).map(clone);
  }

  get size() {
    return this._instances.size;
  }

  /** 该复用实例当前是否有运行在飞（串行锁占用中）。派单时据此给「实例忙，已排队」反馈。 */
  isBusy(reuseKey) {
    return !!reuseKey && this._chains.has(reuseKey);
  }

  /**
   * 串行执行同一 reuseKey 的运行：append-only JSONL 不能并发写同一文件，必须排队。
   * 无论上一个成功失败都接着跑下一个；链尾自清理避免 Map 泄漏。
   * 返回 taskFn 的结果 promise（taskFn 抛错向外抛，由调用方处理，不污染链）。
   */
  runSerialized(reuseKey, taskFn) {
    if (!reuseKey) return Promise.resolve().then(() => taskFn());
    const prev = this._chains.get(reuseKey) || Promise.resolve();
    // 本次运行：prev 完成后才开始 taskFn（串行）。
    const run = prev.then(() => taskFn());
    // 链尾：吞错只为让后续排队者能继续；错误本身由对外返回值向外抛。
    const tail = run.then(() => {}, () => {});
    this._chains.set(reuseKey, tail);
    // settle 后若自己仍是链尾（无人接续）则清出 Map → isBusy 落回 false。
    tail.then(() => {
      if (this._chains.get(reuseKey) === tail) this._chains.delete(reuseKey);
    });
    // 对外 promise 在「清理判定」之后才 settle：保证 await 返回时 isBusy 已准确。
    return tail.then(() => run);
  }

  _save() {
    if (!this._persistPath) return;
    const data = {
      schemaVersion: REUSABLE_SUBAGENT_STORE_VERSION,
      instances: Object.fromEntries(this._instances.entries()),
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
    // 破坏性 scope 迁移：v1（全局 agentId::suffix）/ 无版本裸 map 的 key 不含 session 维度，
    // 无法重映射到 v2 per-session 作用域，故 v<2 整体丢弃、起空账本（显式迁移、不静默错配，铁律#6）。
    const ver = typeof raw?.schemaVersion === "number" ? raw.schemaVersion : 0;
    if (ver < 2) return;
    const instances = raw?.instances && typeof raw.instances === "object" ? raw.instances : {};
    for (const [reuseKey, value] of Object.entries(instances)) {
      if (!reuseKey || !value || typeof value !== "object") continue;
      this._instances.set(reuseKey, normalizeInstance(reuseKey, value));
    }
  }
}
