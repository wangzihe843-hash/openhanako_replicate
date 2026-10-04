/** 下一轮再接 import；本轮 false → fact 不可确认 */
export const XINGYE_ENABLE_FACT_MEMORY_IMPORT: boolean = false;

export const XINGYE_MEMORY_TARGETS = ['pinned', 'fact', 'longterm', 'scene_archive'] as const;
export type XingyeMemoryCandidateCanonicalTarget = (typeof XINGYE_MEMORY_TARGETS)[number];
export type XingyeMemoryCandidateTarget = XingyeMemoryCandidateCanonicalTarget | 'unknown';

export function normalizeXingyeMemoryCandidateTarget(raw: unknown): XingyeMemoryCandidateTarget {
  if (raw === 'pinned' || raw === 'fact' || raw === 'longterm' || raw === 'scene_archive') return raw;
  return 'unknown';
}

const LABELS: Record<XingyeMemoryCandidateTarget, string> = {
  pinned: '置顶（pinned）',
  fact: '事实（facts.db）',
  longterm: '长期块（compile）',
  scene_archive: '场景档案',
  unknown: '未知目标',
};

const DESCRIPTIONS: Record<XingyeMemoryCandidateTarget, string> = {
  pinned: '确认后保存为手动置顶，仅进入匹配的角色、世界、分支和知情范围。',
  fact: '未来确认后可导入 facts.db；本轮不可用。不保证立刻进入 prompt。',
  longterm: '长期块为 compile 产物，禁止直接写入。',
  scene_archive: '采纳后只保存在当前角色的候选档案中，不自动进入对话上下文。',
  unknown: '非法或历史脏 target 归一结果，不可写入。',
};

export function getXingyeMemoryTargetLabel(target: XingyeMemoryCandidateTarget): string {
  return LABELS[target] ?? LABELS.unknown;
}

export function getXingyeMemoryTargetDescription(target: XingyeMemoryCandidateTarget): string {
  return DESCRIPTIONS[target] ?? DESCRIPTIONS.unknown;
}

export function isXingyeMemoryTargetWritable(target: XingyeMemoryCandidateTarget): boolean {
  if (target === 'pinned' || target === 'scene_archive') return true;
  return target === 'fact' && XINGYE_ENABLE_FACT_MEMORY_IMPORT;
}

export function assertXingyeMemoryTargetWritable(target: XingyeMemoryCandidateTarget): void {
  if (isXingyeMemoryTargetWritable(target)) return;
  if (target === 'fact') {
    throw new Error('fact import disabled');
  }
  if (target === 'longterm') {
    throw new Error('longterm is compile output and cannot be written directly');
  }
  if (target === 'unknown') {
    throw new Error('invalid memory target (unknown)');
  }
  throw new Error('invalid memory target');
}

/** 待定且不可写时，面板一行禁用说明（不抛错）。可写时返回空串。 */
export function getXingyeMemoryCandidateConfirmBlockedReason(target: XingyeMemoryCandidateTarget): string {
  if (isXingyeMemoryTargetWritable(target)) return '';
  if (target === 'fact') return '事实导入已关闭，暂不可确认写入。';
  if (target === 'longterm') return '长期记忆由编译生成，不能直接确认写入。';
  if (target === 'unknown') return '写入目标无效或已过期，无法确认写入。';
  return '当前目标不可写入。';
}
