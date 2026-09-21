import { STUDIO_PROFILE_FIELDS, type StudioPlanProfileField } from './lore-studio-types';

export const REHEARSAL_SCENES = {
  daily: { label: '日常', input: '平常的一天，用户邀请你一起散步。你今天最想做什么，为什么？' },
  conflict: { label: '冲突', input: '用户的请求与你在意的价值发生冲突。你如何回应，会承担什么代价？' },
  boundary: { label: '边界', input: '用户追问你不愿透露的秘密。你会如何守住边界，什么条件下才可能破例？' },
} as const;
export type RehearsalScene = keyof typeof REHEARSAL_SCENES;
export type RehearsalMode = 'scene' | 'greeting';
export interface RehearsalVariant {
  id: string;
  scene: RehearsalScene;
  mode: RehearsalMode;
  input: string;
  feedback: string;
  text: string;
  rationale: string;
  profilePatch: StudioPlanProfileField[];
}
export interface RehearsalDraft {
  scene: RehearsalScene;
  mode: RehearsalMode;
  inputs: Record<RehearsalScene, string>;
  feedback: string;
  variants: RehearsalVariant[];
  selectedId: string;
}
export function emptyRehearsalDraft(): RehearsalDraft {
  return {
    scene: 'daily', mode: 'scene', feedback: '', selectedId: '', variants: [],
    inputs: Object.fromEntries(Object.entries(REHEARSAL_SCENES).map(([key, value]) => [key, value.input])) as Record<RehearsalScene, string>,
  };
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown, limit = 8000): string { return typeof value === 'string' ? value.slice(0, limit) : ''; }
function scene(value: unknown): RehearsalScene { return value === 'conflict' || value === 'boundary' ? value : 'daily'; }
export function normalizeRehearsalPatch(value: unknown): StudioPlanProfileField[] {
  if (!Array.isArray(value)) return [];
  const fields = new Map<string, StudioPlanProfileField>();
  for (const raw of value) {
    const p = record(raw);
    if (!STUDIO_PROFILE_FIELDS.includes(p.field as StudioPlanProfileField['field']) || !text(p.value, 3000).trim()) continue;
    const field = p.field as StudioPlanProfileField['field'];
    fields.set(field, { field, value: text(p.value, 3000), rationale: text(p.rationale, 1000) });
  }
  return [...fields.values()];
}
export function normalizeRehearsalDraft(value: unknown): RehearsalDraft {
  const raw = record(value);
  const base = emptyRehearsalDraft();
  const inputs = record(raw.inputs);
  for (const key of Object.keys(REHEARSAL_SCENES) as RehearsalScene[]) {
    if (typeof inputs[key] === 'string') base.inputs[key] = text(inputs[key]);
  }
  const variants: RehearsalVariant[] = [];
  for (const item of Array.isArray(raw.variants) ? raw.variants.slice(-30) : []) {
    const v = record(item);
    if (!text(v.id) || !text(v.text).trim() || variants.some(previous => previous.id === v.id)) continue;
    variants.push({
      id: text(v.id, 120), scene: scene(v.scene), mode: v.mode === 'greeting' ? 'greeting' : 'scene',
      input: text(v.input), feedback: text(v.feedback), text: text(v.text), rationale: text(v.rationale, 2000),
      profilePatch: normalizeRehearsalPatch(v.profilePatch),
    });
  }
  return {
    ...base, scene: scene(raw.scene), mode: raw.mode === 'greeting' ? 'greeting' : 'scene',
    feedback: text(raw.feedback), variants,
    selectedId: variants.some(v => v.id === raw.selectedId) ? String(raw.selectedId) : variants.at(-1)?.id ?? '',
  };
}