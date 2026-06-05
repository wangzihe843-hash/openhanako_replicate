/**
 * @vitest-environment jsdom
 */

import { describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({
  postXingyeStorage: vi.fn<(body: Record<string, unknown>) => Promise<unknown>>(),
}));
vi.mock('./xingye-storage-api', () => apiMock);

import {
  daysBetweenYmd,
  distributeOccurredAtFallback,
  loadHistoryState,
  parseChineseTimeHint,
  planBulkRequest,
  planInitialBulkRequest,
  saveHistoryState,
  toYmd,
} from './xingye-app-history-state';

describe('toYmd / daysBetweenYmd', () => {
  it('formats Date to YYYY-MM-DD', () => {
    const d = new Date(2026, 4, 26, 18, 30); // May 26 2026 18:30 local
    expect(toYmd(d)).toBe('2026-05-26');
  });

  it('formats ISO string to YYYY-MM-DD', () => {
    expect(toYmd('2026-05-26T08:00:00.000Z')).toMatch(/^2026-05-2[56]$/);
  });

  it('daysBetweenYmd is positive when 第二个 > 第一个', () => {
    expect(daysBetweenYmd('2026-05-20', '2026-05-26')).toBe(6);
    expect(daysBetweenYmd('2026-05-26', '2026-05-26')).toBe(0);
  });
});

describe('planInitialBulkRequest', () => {
  it('returns a 14-day initial plan with count in [6,10]', () => {
    const plan = planInitialBulkRequest();
    expect(plan.mode).toBe('recent');
    expect(plan.endDays).toBe(14);
    expect(plan.count).toBeGreaterThanOrEqual(6);
    expect(plan.count).toBeLessThanOrEqual(10);
    expect(plan.hintText).toMatch(/14|过去/);
  });
});

describe('planBulkRequest', () => {
  it('no history → recent plan with 4 drafts / 3 days', () => {
    const plan = planBulkRequest({ version: 1 });
    expect(plan.mode).toBe('recent');
    expect(plan.count).toBe(4);
    expect(plan.endDays).toBe(3);
  });

  it('lastCoveredDate within threshold → recent', () => {
    const today = toYmd(new Date());
    const plan = planBulkRequest({ version: 1, lastCoveredDate: today });
    expect(plan.mode).toBe('recent');
  });

  it('lastCoveredDate older than threshold → gap_fill with count proportional to gap', () => {
    const ten = new Date();
    ten.setDate(ten.getDate() - 10);
    const plan = planBulkRequest({ version: 1, lastCoveredDate: toYmd(ten) });
    expect(plan.mode).toBe('gap_fill');
    expect(plan.count).toBeGreaterThanOrEqual(4);
    expect(plan.count).toBeLessThanOrEqual(8);
    expect(plan.endDays).toBeGreaterThanOrEqual(10);
  });

  it('falls back to lastBulkAt when lastCoveredDate missing', () => {
    const seven = new Date();
    seven.setDate(seven.getDate() - 7);
    const plan = planBulkRequest({ version: 1, lastBulkAt: seven.toISOString() });
    expect(plan.mode).toBe('gap_fill');
  });
});

describe('parseChineseTimeHint', () => {
  function daysAgoFromIso(iso: string): number {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const ms = startOfDay.getTime() - new Date(iso).getTime();
    return Math.round(ms / (24 * 3600 * 1000));
  }

  it('parses 「N 天前」 with Arabic and Chinese digits', () => {
    expect(daysAgoFromIso(parseChineseTimeHint('3 天前')!)).toBe(3);
    expect(daysAgoFromIso(parseChineseTimeHint('三天前')!)).toBe(3);
    expect(daysAgoFromIso(parseChineseTimeHint('五天前')!)).toBe(5);
    expect(daysAgoFromIso(parseChineseTimeHint('十天前')!)).toBe(10);
    expect(daysAgoFromIso(parseChineseTimeHint('十二天前')!)).toBe(12);
    expect(daysAgoFromIso(parseChineseTimeHint('二十天前')!)).toBe(20);
    expect(daysAgoFromIso(parseChineseTimeHint('两天前')!)).toBe(2);
  });

  it('parses common keywords', () => {
    expect(daysAgoFromIso(parseChineseTimeHint('今天')!)).toBe(0);
    expect(daysAgoFromIso(parseChineseTimeHint('昨天')!)).toBe(1);
    expect(daysAgoFromIso(parseChineseTimeHint('昨晚')!)).toBe(1);
    expect(daysAgoFromIso(parseChineseTimeHint('前天')!)).toBe(2);
    expect(daysAgoFromIso(parseChineseTimeHint('大前天')!)).toBe(3);
  });

  it('parses weeks (中文 + 阿拉伯)', () => {
    expect(daysAgoFromIso(parseChineseTimeHint('两周前')!)).toBe(14);
    expect(daysAgoFromIso(parseChineseTimeHint('1 星期前')!)).toBe(7);
  });

  it('maps fuzzy expressions to heuristic days', () => {
    expect(daysAgoFromIso(parseChineseTimeHint('前几天')!)).toBe(3);
    expect(daysAgoFromIso(parseChineseTimeHint('上周')!)).toBe(7);
    expect(daysAgoFromIso(parseChineseTimeHint('这周')!)).toBe(2);
    expect(daysAgoFromIso(parseChineseTimeHint('上个月')!)).toBe(30);
  });

  it('returns undefined for unparseable strings', () => {
    expect(parseChineseTimeHint('反正最近')).toBeUndefined();
    expect(parseChineseTimeHint('好久之前')).toBeUndefined();
    expect(parseChineseTimeHint('')).toBeUndefined();
    expect(parseChineseTimeHint(undefined)).toBeUndefined();
  });
});

describe('distributeOccurredAtFallback', () => {
  it('fills missing occurredAt slots while preserving existing ones', () => {
    const drafts = [
      { title: 'a', occurredAt: undefined },
      { title: 'b', occurredAt: '2026-05-20T00:00:00.000Z' },
      { title: 'c', occurredAt: undefined },
      { title: 'd', occurredAt: undefined },
    ];
    const out = distributeOccurredAtFallback(drafts, 14);
    expect(out[1].occurredAt).toBe('2026-05-20T00:00:00.000Z'); // 保留
    expect(out[0].occurredAt).toBeDefined();
    expect(out[2].occurredAt).toBeDefined();
    expect(out[3].occurredAt).toBeDefined();
    // 所有兜底值都在过去（≥ 1 天前）
    for (const d of [out[0], out[2], out[3]]) {
      const diffDays = (Date.now() - new Date(d.occurredAt!).getTime()) / (24 * 3600 * 1000);
      expect(diffDays).toBeGreaterThanOrEqual(0.5);
      expect(diffDays).toBeLessThanOrEqual(15);
    }
  });

  it('returns empty array unchanged', () => {
    expect(distributeOccurredAtFallback([], 14)).toEqual([]);
  });
});

/**
 * loadHistoryState / saveHistoryState 的错误语义（回归 2026-06-05 的 clobber 加固）：
 * 缺文件 = 「未初始化」返默认；后端/传输错误必须抛出，绝不能吞成 {version:1}，
 * 否则首启 bootstrap 误判重灌、saveHistoryState 抹掉已有 initializedAt。
 */
describe('loadHistoryState · 错误语义', () => {
  it('文件缺失（readJson→null）返回 {version:1}，视为未初始化', async () => {
    apiMock.postXingyeStorage.mockReset();
    apiMock.postXingyeStorage.mockResolvedValue({ ok: true, data: null, missing: true });
    await expect(loadHistoryState('agent-a', 'accounting')).resolves.toEqual({ version: 1 });
  });

  it('正常读到已初始化状态时如实归一化', async () => {
    apiMock.postXingyeStorage.mockReset();
    apiMock.postXingyeStorage.mockResolvedValue({
      ok: true,
      data: { version: 1, initializedAt: '2026-05-01T00:00:00.000Z', lastCoveredDate: '2026-05-01' },
    });
    await expect(loadHistoryState('agent-a', 'accounting')).resolves.toMatchObject({
      version: 1,
      initializedAt: '2026-05-01T00:00:00.000Z',
      lastCoveredDate: '2026-05-01',
    });
  });

  it('后端读取报错时抛出（不吞成 {version:1}）', async () => {
    apiMock.postXingyeStorage.mockReset();
    apiMock.postXingyeStorage.mockRejectedValue(new Error('server connection not ready'));
    await expect(loadHistoryState('agent-a', 'accounting')).rejects.toThrow('server connection not ready');
  });

  it('空 agentId 直接返回默认（不打后端）', async () => {
    apiMock.postXingyeStorage.mockReset();
    await expect(loadHistoryState('', 'accounting')).resolves.toEqual({ version: 1 });
    expect(apiMock.postXingyeStorage).not.toHaveBeenCalled();
  });
});

describe('saveHistoryState · 读当前失败时不写', () => {
  it('读当前状态报错 → 抛出且不发起 writeJson（不把已有 initializedAt 抹掉）', async () => {
    apiMock.postXingyeStorage.mockReset();
    apiMock.postXingyeStorage.mockImplementation(async (body) => {
      if (body.action === 'readJson') throw new Error('server connection not ready');
      return { ok: true };
    });
    await expect(
      saveHistoryState('agent-a', 'accounting', { lastBulkAt: '2026-06-05T00:00:00.000Z' }),
    ).rejects.toThrow('server connection not ready');
    const writeCalls = apiMock.postXingyeStorage.mock.calls.filter(
      ([body]) => body.action === 'writeJson',
    );
    expect(writeCalls).toHaveLength(0);
  });

  it('读到当前状态时合并 patch 写回（保留已有 initializedAt）', async () => {
    apiMock.postXingyeStorage.mockReset();
    apiMock.postXingyeStorage.mockImplementation(async (body) => {
      if (body.action === 'readJson') {
        return { ok: true, data: { version: 1, initializedAt: '2026-05-01T00:00:00.000Z' } };
      }
      return { ok: true };
    });
    await saveHistoryState('agent-a', 'accounting', { lastCoveredDate: '2026-06-05' });
    const writeCall = apiMock.postXingyeStorage.mock.calls.find(
      ([body]) => body.action === 'writeJson',
    );
    expect(writeCall?.[0]).toMatchObject({
      action: 'writeJson',
      data: {
        version: 1,
        initializedAt: '2026-05-01T00:00:00.000Z',
        lastCoveredDate: '2026-06-05',
      },
    });
  });
});
