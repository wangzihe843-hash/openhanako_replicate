import { beforeEach, describe, expect, it, vi } from 'vitest';

const hanaFetchMock = vi.hoisted(() => ({ hanaFetch: vi.fn() }));
const loreRuntimeMock = vi.hoisted(() => ({
  buildXingyeLoreRuntimeQueryText: vi.fn(() => ''),
  collectXingyeLoreRuntimeContext: vi.fn(() => ({ entries: [] })),
  formatXingyeLoreRuntimeContextBlock: vi.fn(() => ''),
}));
const loreStoreMock = vi.hoisted(() => ({
  listLoreEntries: vi.fn(() => []),
  XINGYE_LORE_CATEGORY_LABELS: {} as Record<string, string>,
}));
const persistenceMock = vi.hoisted(() => ({
  getXingyePersistenceStorage: vi.fn(() => null),
}));
const speakerMock = vi.hoisted(() => ({
  resolveXingyeSpeakerUserName: vi.fn(async () => '你'),
  formatXingyeSpeakerContextForPrompt: vi.fn(() => '【说话人】（测试）'),
}));

vi.mock('../hooks/use-hana-fetch', () => hanaFetchMock);
vi.mock('./xingye-lore-runtime-context', () => loreRuntimeMock);
vi.mock('./xingye-lore-store', () => loreStoreMock);
vi.mock('./xingye-persistence', () => persistenceMock);
vi.mock('./xingye-speaker-context', () => speakerMock);

import { hanaFetch } from '../hooks/use-hana-fetch';
import {
  buildReadingHistoryPrompt,
  generateReadingHistoryWithAI,
  normalizeReadingHistoryResults,
} from './xingye-reading-history-ai';

const agent = { id: 'agent-r', name: '林雾', yuan: 'hanako' as const };

function annotationsOf(books: ReturnType<typeof normalizeReadingHistoryResults>): string[] {
  return books.flatMap((b) => b.annotations.map((a) => a.title));
}

describe('normalizeReadingHistoryResults', () => {
  it('parses { books: [...] } envelope into nested book + annotations', () => {
    const out = normalizeReadingHistoryResults({
      books: [
        {
          title: '霍乱时期的爱情',
          authors: ['马尔克斯'],
          subjects: ['爱情', '拉美文学'],
          description: '一段跨越半世纪的等待。',
          annotations: [
            { title: '等待', annotation: '原来等待本身也可以是一种生活。', mood: '怅然', occurredAt: '2024-03-15' },
            { title: '河船', annotation: '最后那趟永不靠岸的船，让我有点想哭。', occurredAt: '2024-04-02' },
          ],
        },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0].book.title).toBe('霍乱时期的爱情');
    expect(out[0].book.authors).toEqual(['马尔克斯']);
    expect(out[0].book.subjects).toEqual(['爱情', '拉美文学']);
    expect(out[0].annotations).toHaveLength(2);
    // 合法 ISO occurredAt 原样保留（UTC 解析）
    expect(out[0].annotations[0].occurredAt?.startsWith('2024-03-15')).toBe(true);
    expect(out[0].annotations[0].dateSmudged).toBeUndefined();
  });

  it('accepts bare array and { entries } / { items } envelopes', () => {
    const book = {
      title: '书', authors: [], annotations: [{ title: 't', annotation: '正文' }],
    };
    expect(normalizeReadingHistoryResults([book])).toHaveLength(1);
    expect(normalizeReadingHistoryResults({ entries: [book] })).toHaveLength(1);
    expect(normalizeReadingHistoryResults({ items: [book] })).toHaveLength(1);
  });

  it('does NOT drop annotations for malformed/missing occurredAt — marks them smudged (occurredAt null, no fabricated date)', () => {
    const out = normalizeReadingHistoryResults({
      books: [
        {
          title: '一本书',
          authors: [],
          annotations: [
            { title: 'A', annotation: '合法时间。', occurredAt: '2024-06-01' },
            { title: 'B', annotation: '中文时间感。', occurredAt: '三天前' },
            { title: 'C', annotation: '完全乱写的时间。', occurredAt: 'not-a-date' },
            { title: 'D', annotation: '根本没给时间。' },
          ],
        },
      ],
    });
    // 四条全部保留——时间字段从不导致丢弃
    expect(out[0].annotations).toHaveLength(4);
    const [a, b, c, d] = out[0].annotations;
    // A 合法 ISO、B 中文时间感 → 解析成功，不 smudge
    expect(a.occurredAt?.startsWith('2024-06-01')).toBe(true);
    expect(a.dateSmudged).toBeUndefined();
    expect(typeof b.occurredAt).toBe('string');
    expect(b.dateSmudged).toBeUndefined();
    // C 乱写、D 缺失 → 不编造日期：occurredAt = null + dateSmudged
    expect(c.occurredAt).toBeNull();
    expect(c.dateSmudged).toBe(true);
    expect(d.occurredAt).toBeNull();
    expect(d.dateSmudged).toBe(true);
  });

  it('drops an annotation ONLY when it is an exact dup within the same book (similar/unique kept)', () => {
    const out = normalizeReadingHistoryResults({
      books: [
        {
          title: '同书',
          authors: [],
          annotations: [
            { title: '重复标题', annotation: '第一条内容。', occurredAt: '2024-01-01' },
            { title: '重复标题', annotation: '标题撞车，应被丢。', occurredAt: '2024-01-02' },
            { title: '另一个角度', annotation: '完全不同的感受与切口。', occurredAt: '2024-01-03' },
          ],
        },
      ],
    });
    // 标题完全相同 → exact_dup 丢第二条；第三条保留
    expect(out[0].annotations.map((a) => a.title)).toEqual(['重复标题', '另一个角度']);
  });

  it('keeps same-title annotations across DIFFERENT books (dedup is per-book)', () => {
    const out = normalizeReadingHistoryResults({
      books: [
        { title: '书一', authors: [], annotations: [{ title: '撞名', annotation: '书一里的批注。' }] },
        { title: '书二', authors: [], annotations: [{ title: '撞名', annotation: '书二里的批注。' }] },
      ],
    });
    expect(out).toHaveLength(2);
    expect(annotationsOf(out)).toEqual(['撞名', '撞名']);
  });

  it('caps books to 5; does NOT count-drop annotations (only dedup drops) below the safety valve', () => {
    const manyAnnotations = Array.from({ length: 7 }, (_, i) => ({
      title: `标题${i}`,
      annotation: `第 ${i} 条完全不同的批注内容，避免被判重。`,
    }));
    const manyBooks = Array.from({ length: 9 }, (_, i) => ({
      title: `书 ${i}`,
      authors: [],
      annotations: manyAnnotations,
    }));
    const out = normalizeReadingHistoryResults({ books: manyBooks });
    // 书按「3–5 本」需求截到 5 本
    expect(out).toHaveLength(5);
    // 7 条互不重复的批注全部保留——计数不丢内容（远低于 8 的安全阀）
    expect(out.every((b) => b.annotations.length === 7)).toBe(true);
  });

  it('drops books with empty title and annotations with empty body', () => {
    const out = normalizeReadingHistoryResults({
      books: [
        { title: '   ', authors: [], annotations: [{ title: 'x', annotation: '有内容' }] },
        {
          title: '有效书',
          authors: [],
          annotations: [
            { title: '空', annotation: '   ' },
            { title: '实', annotation: '真的有内容。' },
          ],
        },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0].book.title).toBe('有效书');
    expect(out[0].annotations.map((a) => a.title)).toEqual(['实']);
  });

  it('returns [] for non-object / non-array input', () => {
    expect(normalizeReadingHistoryResults(null)).toEqual([]);
    expect(normalizeReadingHistoryResults('text')).toEqual([]);
    expect(normalizeReadingHistoryResults(42)).toEqual([]);
  });
});

describe('buildReadingHistoryPrompt', () => {
  it('encodes book count, the no-fabricated-quote guard, and occurredAt schema', () => {
    const prompt = buildReadingHistoryPrompt({
      agent,
      profile: null,
      stableLoreBlock: '',
      keywordLoreBlock: '',
      desiredBookCount: 4,
      todayYmd: '2026-06-05',
    });
    expect(prompt).toContain('初始化历史');
    expect(prompt).toContain('不要伪造');
    expect(prompt).toContain('occurredAt');
    expect(prompt).toContain('"books"');
    expect(prompt).toContain('2026-06-05');
  });

  it('clamps desiredBookCount to [3, 5]', () => {
    const high = buildReadingHistoryPrompt({
      agent, profile: null, stableLoreBlock: '', keywordLoreBlock: '', desiredBookCount: 99, todayYmd: '2026-06-05',
    });
    expect(high).toContain('books 数组长度 = 5');
    const low = buildReadingHistoryPrompt({
      agent, profile: null, stableLoreBlock: '', keywordLoreBlock: '', desiredBookCount: 1, todayYmd: '2026-06-05',
    });
    expect(low).toContain('books 数组长度 = 3');
  });
});

describe('generateReadingHistoryWithAI', () => {
  beforeEach(() => {
    vi.mocked(hanaFetch).mockReset();
  });

  it('posts phone-generate with kind reading_history', async () => {
    vi.mocked(hanaFetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        result: {
          books: [
            { title: '书', authors: ['作者'], annotations: [{ title: 't', annotation: '一条批注。', occurredAt: '2024-01-01' }] },
          ],
        },
      }),
    } as Response);

    const out = await generateReadingHistoryWithAI({
      agent: agent as never,
      ownerProfile: null,
      desiredBookCount: 4,
    });
    expect(out).toHaveLength(1);

    const call = vi.mocked(hanaFetch).mock.calls.find((c) => c[0] === '/api/xingye/phone-generate');
    const body = JSON.parse(String(call?.[1]?.body ?? '')) as { kind?: string; prompt?: string };
    expect(body.kind).toBe('reading_history');
    expect(body.prompt).toContain('阅读笔记');
  });

  it('throws when the model returns zero usable books', async () => {
    vi.mocked(hanaFetch).mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { books: [{ title: '', annotations: [] }] } }),
    } as Response);
    await expect(
      generateReadingHistoryWithAI({ agent: agent as never, ownerProfile: null, desiredBookCount: 4 }),
    ).rejects.toThrow(/未生成可用的读书历史/);
  });
});
