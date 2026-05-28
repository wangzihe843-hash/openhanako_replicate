/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../hooks/use-hana-fetch', () => ({
  hanaFetch: vi.fn(),
}));

vi.mock('./xingye-storage-api', () => ({
  postXingyeStorage: vi.fn(),
}));

import { hanaFetch } from '../hooks/use-hana-fetch';
import { postXingyeStorage } from './xingye-storage-api';
import {
  generateJournalDraftWithAI,
  generateJournalHistoryWithAI,
  normalizeJournalDraftResult,
  normalizeJournalHistoryResults,
} from './xingye-journal-ai';

describe('normalizeJournalDraftResult', () => {
  it('accepts body or legacy content', () => {
    expect(normalizeJournalDraftResult({ title: 'A', body: '正文' })).toEqual({ title: 'A', body: '正文' });
    expect(normalizeJournalDraftResult({ content: '仅正文' })).toEqual({ title: '仅正文', body: '仅正文' });
  });

  it('clamps long unicode bodies', () => {
    const long = '字'.repeat(600);
    const r = normalizeJournalDraftResult({ title: 't', body: long });
    expect(r?.body.length).toBeLessThanOrEqual(521);
    expect(r?.body.endsWith('…')).toBe(true);
  });
});

describe('generateJournalDraftWithAI', () => {
  beforeEach(() => {
    vi.mocked(postXingyeStorage).mockReset();
    vi.mocked(hanaFetch).mockReset();
    vi.mocked(postXingyeStorage).mockResolvedValue({ missing: true } as never);
    vi.mocked(hanaFetch).mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { title: '夜路', body: '有点累，但还好。' } }),
    } as Response);
  });

  it('posts phone-generate with kind journal_draft', async () => {
    const agent = { id: 'agent-j', name: 'Lin', yuan: 'y' as const };
    await expect(generateJournalDraftWithAI({ agent: agent as never, ownerProfile: null })).resolves.toEqual({
      title: '夜路',
      body: '有点累，但还好。',
    });
    expect(hanaFetch).toHaveBeenCalledWith(
      '/api/xingye/phone-generate',
      expect.objectContaining({
        method: 'POST',
      }),
    );
    const generateCall = vi.mocked(hanaFetch).mock.calls.find((call) => call[0] === '/api/xingye/phone-generate');
    const bodyStr = String(generateCall?.[1]?.body ?? '');
    const body = JSON.parse(bodyStr) as { kind?: string; prompt?: string };
    expect(body.kind).toBe('journal_draft');
    expect(body.prompt).toContain('私人日记');
    expect(body.prompt).toContain('第一人称');
  });
});

describe('normalizeJournalHistoryResults', () => {
  const TODAY = '2026-05-28';

  it('accepts { entries: [...] } envelope', () => {
    const result = normalizeJournalHistoryResults(
      {
        entries: [
          { title: 'A', body: '正文一', dayKey: '2025-03-10' },
          { title: 'B', body: '正文二', dayKey: '2024-11-02', mood: '安静' },
        ],
      },
      TODAY,
    );
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ title: 'A', body: '正文一', mood: undefined, dayKey: '2025-03-10' });
    expect(result[1].dayKey).toBe('2024-11-02');
    expect(result[1].mood).toBe('安静');
  });

  it('falls back to { drafts: [...] } envelope when 模型用错关键字', () => {
    const result = normalizeJournalHistoryResults(
      {
        drafts: [{ title: 'A', body: '正文', dayKey: '2024-01-15' }],
      },
      TODAY,
    );
    expect(result).toHaveLength(1);
    expect(result[0].dayKey).toBe('2024-01-15');
  });

  it('accepts bare array fallback', () => {
    const result = normalizeJournalHistoryResults(
      [{ title: 'A', body: '正文', dayKey: '2023-06-01' }],
      TODAY,
    );
    expect(result).toHaveLength(1);
    expect(result[0].dayKey).toBe('2023-06-01');
  });

  it('drops entries with empty body', () => {
    const result = normalizeJournalHistoryResults(
      {
        entries: [
          { title: '空', body: '   ', dayKey: '2025-03-10' },
          { title: '好', body: '有内容', dayKey: '2025-03-12' },
        ],
      },
      TODAY,
    );
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('好');
  });

  it('marks dateSmudged + sentinel dayKey when model gives future date', () => {
    const result = normalizeJournalHistoryResults(
      {
        entries: [
          { title: 'A', body: '过去的', dayKey: '2025-03-10' },
          { title: 'B', body: '未来的', dayKey: '2099-12-31' },
        ],
      },
      TODAY,
    );
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ title: 'A', dayKey: '2025-03-10' });
    expect(result[0].dateSmudged).toBeUndefined();
    expect(result[1]).toMatchObject({ title: 'B', dayKey: '0001-01-01', dateSmudged: true });
  });

  it('marks dateSmudged for malformed or missing dayKey (does NOT drop)', () => {
    const result = normalizeJournalHistoryResults(
      {
        entries: [
          { title: 'A', body: '正文一', dayKey: '去年某天' },
          { title: 'B', body: '正文二' /* no dayKey */ },
          { title: 'C', body: '正文三', dayKey: 'not-a-date' },
          { title: 'D', body: '正文四', dayKey: '2024-06-01' },
        ],
      },
      TODAY,
    );
    expect(result).toHaveLength(4);
    expect(result[0].dateSmudged).toBe(true);
    expect(result[1].dateSmudged).toBe(true);
    expect(result[2].dateSmudged).toBe(true);
    expect(result[3].title).toBe('D');
    expect(result[3].dayKey).toBe('2024-06-01');
    expect(result[3].dateSmudged).toBeUndefined();
  });

  it('keeps entries with duplicate dayKey (same day can have multiple journal entries)', () => {
    const result = normalizeJournalHistoryResults(
      {
        entries: [
          { title: '早上', body: '清晨的咖啡和窗外的雨。', dayKey: '2025-03-10' },
          { title: '晚上', body: '一天的尾声，灯下读旧信。', dayKey: '2025-03-10' },
        ],
      },
      TODAY,
    );
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.title)).toEqual(['早上', '晚上']);
    expect(result.every((r) => r.dayKey === '2025-03-10')).toBe(true);
  });

  it('drops only when content is semantically duplicated (same title)', () => {
    const result = normalizeJournalHistoryResults(
      {
        entries: [
          { title: '雨夜', body: '海风把灯吹得歪斜。', dayKey: '2025-03-10' },
          { title: '雨夜', body: '另一篇但标题撞了。', dayKey: '2024-03-10' },
          { title: '晴天', body: '阳光好得让人想晒被子。', dayKey: '2023-08-15' },
        ],
      },
      TODAY,
    );
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.title)).toEqual(['雨夜', '晴天']);
  });

  it('returns empty array only when all entries are content-duplicates of each other', () => {
    const result = normalizeJournalHistoryResults(
      {
        entries: [
          { title: '复读', body: '同样的内容反复出现。', dayKey: '2024-01-01' },
          { title: '复读', body: '又是同样的内容反复出现。', dayKey: '2024-02-01' },
        ],
      },
      TODAY,
    );
    expect(result).toHaveLength(1);
  });

  it('returns empty array for non-object / non-array input', () => {
    expect(normalizeJournalHistoryResults(null, TODAY)).toEqual([]);
    expect(normalizeJournalHistoryResults('text', TODAY)).toEqual([]);
  });
});

describe('generateJournalHistoryWithAI', () => {
  beforeEach(() => {
    vi.mocked(postXingyeStorage).mockReset();
    vi.mocked(hanaFetch).mockReset();
    vi.mocked(postXingyeStorage).mockResolvedValue({ missing: true } as never);
    vi.mocked(hanaFetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        result: {
          entries: [
            { title: '雨夜', body: '海风吹得灯影歪斜。', mood: '安静', dayKey: '2025-03-10' },
            { title: '搬家那天', body: '把旧本子又装回箱子。', dayKey: '2024-11-02' },
            { title: '生日', body: '没人记得，但 TA 自己记得。', dayKey: '2023-08-15' },
          ],
        },
      }),
    } as Response);
  });

  it('posts phone-generate with kind journal_draft and history-mode prompt', async () => {
    const agent = { id: 'agent-j', name: 'Lin', yuan: 'y' as const };
    const result = await generateJournalHistoryWithAI({
      agent: agent as never,
      ownerProfile: null,
      desiredCount: 4,
    });
    expect(result).toHaveLength(3);
    expect(result[0].dayKey).toBe('2025-03-10');

    const generateCall = vi.mocked(hanaFetch).mock.calls.find((call) => call[0] === '/api/xingye/phone-generate');
    const bodyStr = String(generateCall?.[1]?.body ?? '');
    const body = JSON.parse(bodyStr) as { kind?: string; prompt?: string };
    expect(body.kind).toBe('journal_draft');
    expect(body.prompt).toContain('初始化历史');
    expect(body.prompt).toContain('跨期分布');
  });

  it('throws when model returns zero usable entries', async () => {
    vi.mocked(hanaFetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, result: { entries: [{ title: '', body: '' }] } }),
    } as Response);
    const agent = { id: 'agent-j', name: 'Lin', yuan: 'y' as const };
    await expect(
      generateJournalHistoryWithAI({ agent: agent as never, ownerProfile: null, desiredCount: 4 }),
    ).rejects.toThrow(/未生成可用的历史日记/);
  });

  it('clamps desiredCount to [3, 5]', async () => {
    const agent = { id: 'agent-j', name: 'Lin', yuan: 'y' as const };
    await generateJournalHistoryWithAI({ agent: agent as never, ownerProfile: null, desiredCount: 99 });
    const call = vi.mocked(hanaFetch).mock.calls.find((c) => c[0] === '/api/xingye/phone-generate');
    const body = JSON.parse(String(call?.[1]?.body ?? '')) as { prompt?: string };
    // prompt 含 "数组长度必须 = 5"（clamp 上限）
    expect(body.prompt).toMatch(/长度必须 = 5/);
  });
});
