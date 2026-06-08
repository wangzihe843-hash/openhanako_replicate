/**
 * 把工坊「方案(plan)」落盘。
 *
 * 范围：只负责写 **lore 条目**（直接落盘）。人设(profile)补丁不在这里写——它经
 * onApplied 回填到 RoleDetailPanel 表单，复用面板既有的 profile 保存 + corruptionSeed
 * 待确认 UX（见 LoreStudioDrawer / RoleDetailPanel）。
 *
 * 去重：按标题（不分大小写、优先同分类）匹配既有条目 → 命中则做「更新补丁」(updateLoreEntry)，
 * 否则新增(createLoreEntry)。贴合 propose-draft 偏好：已有实体做更新而非新增重复。
 */
import {
  createLoreEntry,
  listLoreEntries,
  updateLoreEntry,
  type XingyeLoreEntry,
  type XingyeLoreEntryInput,
} from './xingye-lore-store';
import {
  STUDIO_PROFILE_FIELDS,
  type StudioPlanLoreEntry,
  type StudioPlanProfileField,
  type StudioProfileField,
} from './lore-studio-types';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export interface ApplyLoreResult {
  created: XingyeLoreEntry[];
  updated: XingyeLoreEntry[];
  skipped: StudioPlanLoreEntry[];
}

function normTitle(title: string): string {
  return title.trim().toLowerCase();
}

function findExistingByTitle(
  entries: XingyeLoreEntry[],
  title: string,
  category: string,
): XingyeLoreEntry | undefined {
  const t = normTitle(title);
  // 优先同分类同名，回退任意分类同名（避免同名跨分类重复）。
  return (
    entries.find((e) => normTitle(e.title) === t && e.category === category) ??
    entries.find((e) => normTitle(e.title) === t)
  );
}

/**
 * 把方案里的 lore 条目写入指定 agent 的设定库。
 * 传 storage（测试用 mock）会一路透传给 lore-store 的读写。
 */
export function applyLoreEntries(
  agentId: string,
  planEntries: StudioPlanLoreEntry[],
  storage?: StorageLike | null,
): ApplyLoreResult {
  const created: XingyeLoreEntry[] = [];
  const updated: XingyeLoreEntry[] = [];
  const skipped: StudioPlanLoreEntry[] = [];

  for (const pe of planEntries) {
    const title = (pe?.title ?? '').trim();
    const content = (pe?.content ?? '').trim();
    if (!agentId || !title || !content) {
      skipped.push(pe);
      continue;
    }

    const input: XingyeLoreEntryInput = {
      title,
      content,
      category: pe.category,
      insertionMode: pe.insertionMode,
      keywords: Array.isArray(pe.keywords) ? pe.keywords : [],
    };

    // 每条都重新读，确保同一批里前面刚写的也能被后面命中去重。
    const current = listLoreEntries(agentId, storage ?? undefined);
    const match = findExistingByTitle(current, title, pe.category);

    if (match) {
      const next = updateLoreEntry(match.id, input, storage ?? undefined);
      if (next) updated.push(next);
      else skipped.push(pe);
    } else {
      const next = createLoreEntry(agentId, input, storage ?? undefined);
      created.push(next);
    }
  }

  return { created, updated, skipped };
}

/**
 * 把方案的 profilePatch 摊平成「字段→值」映射（只保留合法字段与非空值）。
 * 给 RoleDetailPanel 回填表单用——不在此处持久化。
 */
export function flattenProfilePatch(
  patch?: StudioPlanProfileField[],
): Partial<Record<StudioProfileField, string>> {
  const out: Partial<Record<StudioProfileField, string>> = {};
  const allowed = STUDIO_PROFILE_FIELDS as readonly string[];
  for (const p of patch ?? []) {
    if (!p?.field || !allowed.includes(p.field)) continue;
    const value = typeof p.value === 'string' ? p.value.trim() : '';
    if (value) out[p.field] = value;
  }
  return out;
}
