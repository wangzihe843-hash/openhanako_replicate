/**
 * xingye-health-store.ts — 健康模块的持久化层。
 *
 * 每天一条 XingyeHealthDay，按 isoDate 主键存进 `health/days.jsonl`
 * （位于 HANA_HOME/agents/{agentId}/xingye/ 下，与日记 / 占卜同风格）。
 *
 * 记录极小（scenario + advice + 元信息），所以 upsert 直接整文件重写——
 * 几十到几百天的量级下成本可忽略，换来「同日重新生成 = 覆盖」的简单语义。
 */

import {
  type HealthAdvice,
  type HealthScenario,
  type XingyeHealthDay,
} from './xingye-health-data';
import { createXingyeStore } from './xingye-store-utils';
import type { XingyeStorageBackend } from './xingye-storage-backend';

/** 相对路径，位于 HANA_HOME/agents/{agentId}/xingye/ 下。 */
export const XINGYE_HEALTH_DAYS_JSONL = 'health/days.jsonl';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_SCENARIOS: ReadonlySet<HealthScenario> = new Set<HealthScenario>([
  'calm',
  'high_stress',
  'active',
]);

/** 落盘行额外带 `key`，让通用 JSONL 后端能按 isoDate 去重 / 删除。 */
type HealthDayRow = XingyeHealthDay & { key: string };

function normalizeAdvice(value: unknown): HealthAdvice | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const body = typeof raw.body === 'string' ? raw.body.trim() : '';
  if (!body) return null;
  const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim().slice(0, 60) : '今日分析';
  const generatedAt =
    typeof raw.generatedAt === 'string' && raw.generatedAt.trim() ? raw.generatedAt.trim().slice(0, 16) : '';
  return { title, body: body.slice(0, 1200), generatedAt };
}

function normalizeRow(value: unknown): XingyeHealthDay | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const isoDate = typeof raw.isoDate === 'string' && ISO_DATE_RE.test(raw.isoDate) ? raw.isoDate : '';
  if (!isoDate) return null;
  const scenario = VALID_SCENARIOS.has(raw.scenario as HealthScenario)
    ? (raw.scenario as HealthScenario)
    : 'calm';
  const generatedAt =
    typeof raw.generatedAt === 'string' && raw.generatedAt ? raw.generatedAt : new Date(0).toISOString();
  const source = raw.source === 'fallback' ? 'fallback' : 'ai';
  return {
    isoDate,
    scenario,
    advice: normalizeAdvice(raw.advice),
    generatedAt,
    source,
  };
}

/** 新 → 旧（isoDate 倒序）。 */
function sortDaysDesc(a: XingyeHealthDay, b: XingyeHealthDay): number {
  if (a.isoDate === b.isoDate) return 0;
  return a.isoDate < b.isoDate ? 1 : -1;
}

export function createXingyeHealthStore(backend?: XingyeStorageBackend) {
  const store = createXingyeStore(backend);

  /**
   * 读取 + 归一化某 agent 的全部健康日。后端读失败会**抛出**（不吞错）。
   * 给 upsert 用：读不到既有记录就绝不继续整表覆写。listHealthDays 在它外面再包一层
   * catch，让纯展示 / 取历史的只读场景仍能容忍读失败。
   */
  async function readHealthDaysStrict(aid: string): Promise<XingyeHealthDay[]> {
    const rows = await store.listJsonl<unknown>(aid, XINGYE_HEALTH_DAYS_JSONL);
    const seen = new Set<string>();
    const out: XingyeHealthDay[] = [];
    // 后写的同一天覆盖先写的：倒序遍历，第一次见到的 isoDate 即最新。
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const day = normalizeRow(rows[i]);
      if (!day || seen.has(day.isoDate)) continue;
      seen.add(day.isoDate);
      out.push(day);
    }
    return out.sort(sortDaysDesc);
  }

  async function listHealthDays(agentId: string): Promise<XingyeHealthDay[]> {
    const aid = agentId.trim();
    if (!aid) return [];
    try {
      return await readHealthDaysStrict(aid);
    } catch {
      // 只读场景（列表展示 / AI 取历史）容忍读失败：当作空，不影响后续。
      return [];
    }
  }

  async function getHealthDay(agentId: string, isoDate: string): Promise<XingyeHealthDay | null> {
    const target = isoDate.trim();
    if (!ISO_DATE_RE.test(target)) return null;
    const days = await listHealthDays(agentId);
    return days.find((d) => d.isoDate === target) ?? null;
  }

  /**
   * 写入 / 覆盖某一天的记录。同一 isoDate 已存在时整体替换。
   * 返回写入后的完整列表（新 → 旧），调用方可直接拿去刷新 UI。
   */
  async function upsertHealthDay(agentId: string, day: XingyeHealthDay): Promise<XingyeHealthDay[]> {
    const aid = agentId.trim();
    if (!aid) throw new Error('保存健康数据失败：缺少 agentId。');
    const normalized = normalizeRow(day);
    if (!normalized) throw new Error('保存健康数据失败：记录格式无效。');
    // 关键：用「读失败会抛出」的严格读取。upsert 是整表重写（writeJsonl 先截断再写），
    // 一旦既有记录没读到就 merge 成只剩今天，会把过往健康日全部清空。读不到直接抛错
    // 中止写入，把瞬时读失败暴露成 setAiError，而不是静默把历史抹平成一条。
    const existing = await readHealthDaysStrict(aid);
    const merged = [normalized, ...existing.filter((d) => d.isoDate !== normalized.isoDate)].sort(sortDaysDesc);
    const rows: HealthDayRow[] = merged.map((d) => ({ ...d, key: d.isoDate }));
    await store.writeJsonl<HealthDayRow>(aid, XINGYE_HEALTH_DAYS_JSONL, rows);
    return merged;
  }

  return { listHealthDays, getHealthDay, upsertHealthDay };
}

const defaultHealthStore = createXingyeHealthStore();

export const listHealthDays = defaultHealthStore.listHealthDays;
export const getHealthDay = defaultHealthStore.getHealthDay;
export const upsertHealthDay = defaultHealthStore.upsertHealthDay;
