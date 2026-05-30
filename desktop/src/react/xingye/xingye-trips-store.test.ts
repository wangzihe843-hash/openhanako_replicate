/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const postMock = vi.hoisted(() => vi.fn());

vi.mock('./xingye-storage-api', () => ({
  postXingyeStorage: postMock,
}));

import {
  appendTripEntry,
  deleteTripEntry,
  listTripEntries,
  normalizeTripDraft,
  normalizeTripModeKey,
  XINGYE_TRIPS_ENTRIES_JSONL,
} from './xingye-trips-store';

const validRaw = {
  serial: '北门 · 丙申 0003',
  when: '停电夜',
  chapter: '童年 · 北门',
  mode: 'walk',
  modeLabel: '徒步 · 岑姨背着',
  cls: '徒步',
  from: { name: '北门诊所', meta: '后院 · 第三阶' },
  to: { name: '岑姨家', meta: '西厢' },
  duration: '一时辰',
  distance: '一里',
  pass: '—',
  stampText: '到家',
  noteFrom: '第三阶的青苔没人铲。雨天走左边。',
  noteTo: '黄铜纽扣收在铁皮盒里。',
  mood: '岑姨把我背回来的。',
  moodTags: ['停电', '右踝扭伤'],
  route: [
    { kind: 'stop', time: '酉时', name: '北门诊所 · 后院', sub: '第三阶' },
    { kind: 'seg', mode: 'walk', label: '岑姨背着，穿巷', detail: '约一里' },
    { kind: 'stop', via: true, name: '风铃巷口' },
    { kind: 'stop', time: '戌时', name: '岑姨家 · 西厢', sub: '到' },
  ],
};

describe('normalizeTripModeKey', () => {
  it('keeps known keys (case-insensitive)', () => {
    expect(normalizeTripModeKey('boat')).toBe('boat');
    expect(normalizeTripModeKey('FLY')).toBe('fly');
    expect(normalizeTripModeKey('  ride ')).toBe('ride');
  });

  it('falls back to walk for unknown / non-string', () => {
    expect(normalizeTripModeKey('teleport')).toBe('walk');
    expect(normalizeTripModeKey(undefined)).toBe('walk');
    expect(normalizeTripModeKey(42)).toBe('walk');
  });
});

describe('normalizeTripDraft', () => {
  it('normalizes a full trip and forces first/last route stops to major', () => {
    const d = normalizeTripDraft(validRaw);
    expect(d).not.toBeNull();
    expect(d!.from.name).toBe('北门诊所');
    expect(d!.to.name).toBe('岑姨家');
    expect(d!.mode).toBe('walk');
    const stops = d!.route.filter((n) => n.kind === 'stop') as Array<{ major?: boolean }>;
    expect(stops[0]!.major).toBe(true);
    expect(stops[stops.length - 1]!.major).toBe(true);
  });

  it('returns null when from or to is missing', () => {
    expect(normalizeTripDraft({ ...validRaw, from: undefined })).toBeNull();
    expect(normalizeTripDraft({ ...validRaw, to: { meta: 'x' } })).toBeNull();
    expect(normalizeTripDraft(null)).toBeNull();
  });

  it('synthesizes a fallback route (2 stops + 1 seg) when route has < 2 stops', () => {
    const d = normalizeTripDraft({ ...validRaw, route: [] });
    const stops = d!.route.filter((n) => n.kind === 'stop');
    expect(stops).toHaveLength(2);
    expect(d!.route.some((n) => n.kind === 'seg')).toBe(true);
  });

  it('coerces unknown mode to walk and defaults modeLabel', () => {
    const d = normalizeTripDraft({ ...validRaw, mode: 'spaceship', modeLabel: '' });
    expect(d!.mode).toBe('walk');
    expect(d!.modeLabel).toBe('徒步');
  });
});

describe('xingye-trips-store', () => {
  beforeEach(() => {
    postMock.mockReset();
  });

  it('listTripEntries posts listJsonl, filters invalid rows, preserves order', async () => {
    postMock.mockResolvedValueOnce({
      ok: true,
      records: [
        { id: 'a', ...validRaw },
        { id: 'b', ...validRaw, chapter: '十七岁' },
        { ...validRaw }, // no id → dropped
        { id: 'c', from: { name: '' }, to: { name: 'x' } }, // missing from → dropped
      ],
    });
    const rows = await listTripEntries('agent-x');
    expect(postMock).toHaveBeenCalledWith({
      action: 'listJsonl',
      agentId: 'agent-x',
      relativePath: XINGYE_TRIPS_ENTRIES_JSONL,
    });
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('appendTripEntry posts appendJsonl with trips path and a key === id row', async () => {
    postMock.mockResolvedValueOnce({ ok: true });
    const entry = await appendTripEntry('agent-x', validRaw as never);
    expect(entry.id.length).toBeGreaterThan(4);
    expect(entry.from.name).toBe('北门诊所');
    expect(entry.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const call = postMock.mock.calls.find((c) => (c[0] as { action?: string }).action === 'appendJsonl')?.[0] as {
      relativePath: string;
      data: { key: string; id: string };
    };
    expect(call.relativePath).toBe(XINGYE_TRIPS_ENTRIES_JSONL);
    expect(call.data.key).toBe(call.data.id);
  });

  it('appendTripEntry throws when from/to missing', async () => {
    await expect(appendTripEntry('agent-x', { ...validRaw, from: { name: '' } } as never)).rejects.toThrow();
  });

  it('deleteTripEntry posts deleteJsonlRecord and returns deleted flag', async () => {
    postMock.mockResolvedValueOnce({ deleted: true });
    const ok = await deleteTripEntry('agent-x', 'a');
    expect(ok).toBe(true);
    expect(postMock).toHaveBeenCalledWith({
      action: 'deleteJsonlRecord',
      agentId: 'agent-x',
      relativePath: XINGYE_TRIPS_ENTRIES_JSONL,
      recordId: 'a',
    });
  });
});
