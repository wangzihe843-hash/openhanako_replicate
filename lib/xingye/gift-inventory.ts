/**
 * 共享礼物库存 · 服务端单一事实源。
 *
 * 全体 agent 共享一份库存（不属于任何具体角色），落在保留作用域 `__shared__` 下：
 *   HANA_HOME/agents/__shared__/xingye/gifts/inventory.json
 *
 * 三类写入都在 withXingyeAgentEventLock("__shared__") 内做 read-modify-write，串行化：
 *   - 心跳掉落（scheduler 进程内直接调 adjust(+1)）
 *   - 送礼消耗（渲染端经 /api/xingye/storage 的 adjustGifts action → 这里 adjust(-1, requireAvailable)）
 *   - 赠礼系统初始化（每 agent 首次 init 每种礼物 +1，按 agentId 幂等）
 * 锁是进程内的（events.js 的 per-key Promise 链），渲染端写也走同进程的存储路由，故同一把
 * "__shared__" 锁能覆盖全部写者，避免裸 read→write 交错丢增量。
 *
 * 读语义沿用赠礼/历史层的硬规则：缺文件 → 空库存（合法首写）；解析/IO 错误 → **抛**，
 * 绝不当空库存覆写（否则一次瞬时读失败会把全体共享库存清零）。
 */

import fs from "node:fs";
import path from "node:path";

import { withXingyeAgentEventLock } from "./events.js";
import { ALL_GIFT_KEYS } from "../../shared/xingye-gift-catalog-data.ts";

/** 与 xingye-storage.js / desktop 端保持一致的共享库存作用域 id（双下划线包裹不与真实角色冲突）。 */
export const SHARED_GIFT_SCOPE_ID = "__shared__";

const INVENTORY_RELATIVE_PATH = path.join("xingye", "gifts", "inventory.json");

const ALL_GIFT_KEY_SET: Set<string> = new Set(ALL_GIFT_KEYS);

export type SharedGiftInventory = {
  version: 1;
  /** 复合键 `setId/giftId` → 数量（>0 才落盘，0 会被裁掉）。 */
  counts: Record<string, number>;
  /** 已经贡献过「初始化 +1」的 agentId（保证每 agent 只灌一次）。 */
  grantedByInit: string[];
};

function inventoryFilePath(agentsDir: string): string {
  return path.join(agentsDir, SHARED_GIFT_SCOPE_ID, INVENTORY_RELATIVE_PATH);
}

function emptyInventory(): SharedGiftInventory {
  return { version: 1, counts: {}, grantedByInit: [] };
}

function normalize(raw: unknown): SharedGiftInventory {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptyInventory();
  const r = raw as Record<string, unknown>;
  const counts: Record<string, number> = {};
  if (r.counts && typeof r.counts === "object" && !Array.isArray(r.counts)) {
    for (const [key, value] of Object.entries(r.counts as Record<string, unknown>)) {
      if (!ALL_GIFT_KEY_SET.has(key)) continue;
      const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 0;
      if (n > 0) counts[key] = n;
    }
  }
  const grantedByInit: string[] = [];
  if (Array.isArray(r.grantedByInit)) {
    for (const id of r.grantedByInit) {
      if (typeof id === "string" && id.trim() && !grantedByInit.includes(id)) grantedByInit.push(id);
    }
  }
  return { version: 1, counts, grantedByInit };
}

/**
 * 读取共享库存。缺文件 → 空库存；解析/IO 错误抛出（调用方须容错处理，抛 = 安全地「这次不动」）。
 * 不加锁（纯读）；与写入的 RMW 共享同一文件，读到的是上一次 atomic rename 后的完整快照。
 */
export async function readSharedGiftInventory(agentsDir: string): Promise<SharedGiftInventory> {
  const file = inventoryFilePath(agentsDir);
  let content: string;
  try {
    content = await fs.promises.readFile(file, "utf-8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return emptyInventory();
    throw err;
  }
  return normalize(JSON.parse(content));
}

async function atomicWriteInventory(file: string, data: SharedGiftInventory): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  await fs.promises.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
  await fs.promises.rename(tmp, file);
}

export type AdjustResult = {
  ok: boolean;
  counts: Record<string, number>;
  /** ok=false 时，列出库存不足的复合键（requireAvailable 下）。 */
  insufficient?: string[];
};

/**
 * 原子增减共享库存（RMW under lock）。
 *
 * @param deltas 复合键 → 增减量（掉落 +1、送礼 -1）。未知键忽略。
 * @param requireAvailable 为 true 时（送礼），任一键扣减后会 <0 则整体拒绝、不写盘，
 *   返回 { ok:false, insufficient }，让调用方拦住这次送礼。掉落 +1 不传此项。
 */
export async function adjustSharedGiftInventory(
  agentsDir: string,
  deltas: Record<string, number>,
  opts: { requireAvailable?: boolean } = {},
): Promise<AdjustResult> {
  const requireAvailable = opts.requireAvailable === true;
  return withXingyeAgentEventLock(SHARED_GIFT_SCOPE_ID, async () => {
    const file = inventoryFilePath(agentsDir);
    const inv = await readSharedGiftInventory(agentsDir);
    const next = { ...inv.counts };

    const insufficient: string[] = [];
    for (const [key, rawDelta] of Object.entries(deltas)) {
      if (!ALL_GIFT_KEY_SET.has(key)) continue;
      const delta = Math.floor(Number(rawDelta) || 0);
      if (!delta) continue;
      const after = (next[key] ?? 0) + delta;
      if (requireAvailable && after < 0) {
        insufficient.push(key);
        continue;
      }
      if (after > 0) next[key] = after;
      else delete next[key];
    }

    if (requireAvailable && insufficient.length) {
      // 原子拒绝：不写盘，库存维持原样。
      return { ok: false, counts: inv.counts, insufficient };
    }

    await atomicWriteInventory(file, { version: 1, counts: next, grantedByInit: inv.grantedByInit });
    return { ok: true, counts: next };
  });
}

/**
 * 赠礼系统初始化时的「每种礼物 +1」（全体共享池）。按 agentId 幂等：该 agent 已贡献过则 no-op。
 */
export async function grantInitGifts(agentsDir: string, agentId: string): Promise<SharedGiftInventory> {
  const aid = String(agentId ?? "").trim();
  return withXingyeAgentEventLock(SHARED_GIFT_SCOPE_ID, async () => {
    const file = inventoryFilePath(agentsDir);
    const inv = await readSharedGiftInventory(agentsDir);
    if (!aid || inv.grantedByInit.includes(aid)) return inv;
    const counts = { ...inv.counts };
    for (const key of ALL_GIFT_KEYS) counts[key] = (counts[key] ?? 0) + 1;
    const next: SharedGiftInventory = { version: 1, counts, grantedByInit: [...inv.grantedByInit, aid] };
    await atomicWriteInventory(file, next);
    return next;
  });
}
