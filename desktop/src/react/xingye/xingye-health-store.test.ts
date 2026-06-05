import { describe, expect, it, vi } from 'vitest';
import { makeHealthDay, type XingyeHealthDay } from './xingye-health-data';
import {
  createMemoryXingyeStorageBackend,
  type XingyeStorageBackend,
} from './xingye-storage-backend';
import { createXingyeHealthStore, XINGYE_HEALTH_DAYS_JSONL } from './xingye-health-store';

function aiDay(isoDate: string): XingyeHealthDay {
  return makeHealthDay({
    isoDate,
    scenario: 'calm',
    advice: { title: '今日分析', body: '状态平稳，继续保持。', generatedAt: '09:14' },
    source: 'ai',
  });
}

describe('xingye-health-store', () => {
  it('returns an empty list for a missing file', async () => {
    const store = createXingyeHealthStore(createMemoryXingyeStorageBackend());
    await expect(store.listHealthDays('agent-a')).resolves.toEqual([]);
  });

  it('upserts a day and lists it back', async () => {
    const store = createXingyeHealthStore(createMemoryXingyeStorageBackend());
    const list = await store.upsertHealthDay('agent-a', aiDay('2026-05-21'));
    expect(list).toHaveLength(1);
    expect(list[0].isoDate).toBe('2026-05-21');
    await expect(store.getHealthDay('agent-a', '2026-05-21')).resolves.toMatchObject({
      isoDate: '2026-05-21',
      scenario: 'calm',
    });
  });

  it('sorts days newest-first', async () => {
    const store = createXingyeHealthStore(createMemoryXingyeStorageBackend());
    await store.upsertHealthDay('agent-a', aiDay('2026-05-19'));
    await store.upsertHealthDay('agent-a', aiDay('2026-05-21'));
    const list = await store.upsertHealthDay('agent-a', aiDay('2026-05-20'));
    expect(list.map((d) => d.isoDate)).toEqual(['2026-05-21', '2026-05-20', '2026-05-19']);
  });

  it('overwrites the same isoDate instead of appending a duplicate', async () => {
    const store = createXingyeHealthStore(createMemoryXingyeStorageBackend());
    await store.upsertHealthDay('agent-a', aiDay('2026-05-21'));
    const list = await store.upsertHealthDay(
      'agent-a',
      makeHealthDay({
        isoDate: '2026-05-21',
        scenario: 'high_stress',
        advice: { title: '今日分析', body: '压力偏高。', generatedAt: '20:00' },
        source: 'ai',
      }),
    );
    expect(list).toHaveLength(1);
    expect(list[0].scenario).toBe('high_stress');
  });

  it('keeps each agent scoped separately', async () => {
    const store = createXingyeHealthStore(createMemoryXingyeStorageBackend());
    await store.upsertHealthDay('agent-a', aiDay('2026-05-21'));
    await expect(store.listHealthDays('agent-b')).resolves.toEqual([]);
  });

  it('aborts without overwriting when the existing read fails (no silent data wipe)', async () => {
    // 回归：upsert 是整表重写。若读既有记录失败被吞成空、再 merge 成只剩今天，
    // 会把过往健康日全部清空（线上「健康历史丢失」事故的同款路径）。读失败必须抛错、
    // 且绝不触发 writeJsonl。
    const writeJsonl = vi.fn(async () => {});
    const failingBackend: XingyeStorageBackend = {
      async readJson() {
        return null;
      },
      async writeJson() {},
      async appendJsonl() {},
      async listJsonl() {
        throw new Error('backend offline');
      },
      writeJsonl,
      async deleteJsonlRecord() {
        return false;
      },
    };
    const store = createXingyeHealthStore(failingBackend);
    await expect(store.upsertHealthDay('agent-a', aiDay('2026-05-21'))).rejects.toThrow('backend offline');
    expect(writeJsonl).not.toHaveBeenCalled();
  });

  it('normalizes malformed rows: bad scenario falls back to calm, empty advice becomes null', async () => {
    const backend = createMemoryXingyeStorageBackend();
    const store = createXingyeHealthStore(backend);
    await backend.appendJsonl('agent-a', XINGYE_HEALTH_DAYS_JSONL, {
      key: '2026-05-18',
      isoDate: '2026-05-18',
      scenario: 'weird_value',
      advice: { title: 'x', body: '   ' },
      generatedAt: '2026-05-18T00:00:00.000Z',
      source: 'ai',
    });
    await backend.appendJsonl('agent-a', XINGYE_HEALTH_DAYS_JSONL, { key: 'junk', notADate: true });
    const list = await store.listHealthDays('agent-a');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ isoDate: '2026-05-18', scenario: 'calm', advice: null });
  });
});
