/** Narrative preferences only: provider sampling and reasoning settings live elsewhere. */
export type XingyeExpressionPresets = {
  length?: 'concise' | 'balanced' | 'detailed';
  perspective?: 'first' | 'third';
  innerThought?: 'none' | 'brief' | 'detailed';
};

export const XINGYE_EXPRESSION_GROUPS = [
  { key: 'length', label: '篇幅', options: [
    { value: 'concise', label: '简短', prompt: '篇幅简短，围绕当前互动给出必要的对白与动作。' },
    { value: 'balanced', label: '适中', prompt: '篇幅适中，让对白与必要的场景细节保持平衡。' },
    { value: 'detailed', label: '细致', prompt: '篇幅较长，充分描写当前互动的细节，在需要用户选择时停下。' },
  ] },
  { key: 'perspective', label: '叙事视角', options: [
    { value: 'first', label: '第一人称', prompt: '用当前角色的第一人称叙述，限于该角色所知和可观察的信息。' },
    { value: 'third', label: '第三人称', prompt: '用第三人称叙述当前角色，限于该角色所知和可观察的信息。' },
  ] },
  { key: 'innerThought', label: '心理描写', options: [
    { value: 'none', label: '仅可观察动作', prompt: '通过可观察的动作和对白表现情绪，不直接描写内心独白。' },
    { value: 'brief', label: '少量', prompt: '仅在必要时简短描写当前角色的心理活动。' },
    { value: 'detailed', label: '丰富', prompt: '可以细致描写当前角色的心理活动，但不替用户设定想法。' },
  ] },
] as const;

export type XingyeExpressionGroup = keyof XingyeExpressionPresets;
export type XingyeExpressionSource = 'character' | 'preset' | 'scene';

/** Reject arrays, unknown keys and invalid values rather than guessing a winner. */
export function normalizeXingyeExpressionPresets(input: unknown): XingyeExpressionPresets {
  const result: XingyeExpressionPresets = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return result;
  for (const group of XINGYE_EXPRESSION_GROUPS) {
    const value = (input as Record<string, unknown>)[group.key];
    if (Object.prototype.hasOwnProperty.call(input, group.key)
      && group.options.some(option => option.value === value)) {
      Object.assign(result, { [group.key]: value });
    }
  }
  return result;
}

export function resolveXingyeExpressionPresets(base: unknown, override?: unknown) {
  const presets = normalizeXingyeExpressionPresets(base);
  const scene = normalizeXingyeExpressionPresets(override);
  return XINGYE_EXPRESSION_GROUPS.map(group => {
    const value = scene[group.key] ?? presets[group.key];
    const source: XingyeExpressionSource = scene[group.key] ? 'scene' : presets[group.key] ? 'preset' : 'character';
    const option = group.options.find(candidate => candidate.value === value);
    return { key: group.key, label: group.label, value, source,
      valueLabel: option?.label ?? '沿用角色设定', prompt: option?.prompt ?? '' };
  });
}

export function formatXingyeExpressionPresets(base: unknown, override?: unknown): string {
  const rows = resolveXingyeExpressionPresets(base, override).filter(row => row.value);
  if (!rows.length) return '';
  return ['【当前有效表达预设】',
    '以下仅约束当前回复的表达，不改变角色经历、价值观或长期记忆。不得替用户决定行动、对白或心理。',
    ...rows.map(row => `- ${row.label}（${row.source === 'scene' ? '临时场景覆盖' : '会话预设'}）：${row.prompt}`),
  ].join('\n');
}
