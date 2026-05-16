import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hanaFetchMock = vi.hoisted(() => ({ hanaFetch: vi.fn() }));
const recentContextMock = vi.hoisted(() => ({
  collectRecentContextForAgent: vi.fn(),
  describeRecentContextForPrompt: vi.fn(),
}));
const loreStoreMock = vi.hoisted(() => ({
  listLoreEntries: vi.fn(() => []),
  XINGYE_LORE_CATEGORY_LABELS: {} as Record<string, string>,
}));
const persistenceMock = vi.hoisted(() => ({
  getXingyePersistenceStorage: vi.fn(() => null),
}));

vi.mock('../hooks/use-hana-fetch', () => hanaFetchMock);
vi.mock('./xingye-recent-context', () => recentContextMock);
vi.mock('./xingye-lore-store', () => loreStoreMock);
vi.mock('./xingye-persistence', () => persistenceMock);

import {
  buildReadingTopicsPrompt,
  inferReadingTopicsWithAI,
  normalizeReadingTopicsResult,
} from './xingye-reading-topics-ai';
import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';

const linwu: Agent = {
  id: 'test01',
  name: '林雾',
  yuan: 'hanako',
  isPrimary: false,
  hasAvatar: false,
};

const linwuProfile: XingyeRoleProfile = {
  agentId: 'test01',
  displayName: '林雾',
  shortBio: '战地医生，喜欢冬天。',
  personalitySummary: '克制，关注创伤恢复。',
  backgroundSummary: '幼年经历战乱，长期救治伤患。',
  updatedAt: '2026-05-16T00:00:00.000Z',
};

describe('normalizeReadingTopicsResult', () => {
  it('keeps lowercase ASCII subjects with Chinese label/reason and caps at 6', () => {
    const raw = {
      topics: [
        { subject: 'War Memoir', label: '战争回忆', reason: '幼年经历战乱' },
        { subject: 'medical ethics', label: '医疗伦理', reason: '长期救治伤患' },
        { subject: 'philosophy of mind', label: '心智哲学' },
        { subject: 'history of medicine', label: '医学史' },
        { subject: 'survival fiction', label: '生存小说', reason: '荒野场景' },
        { subject: 'biography', label: '传记' },
        { subject: 'extra topic', label: '超出上限不应进入' },
      ],
    };
    expect(normalizeReadingTopicsResult(raw)).toEqual([
      { subject: 'war memoir', label: '战争回忆', reason: '幼年经历战乱' },
      { subject: 'medical ethics', label: '医疗伦理', reason: '长期救治伤患' },
      { subject: 'philosophy of mind', label: '心智哲学' },
      { subject: 'history of medicine', label: '医学史' },
      { subject: 'survival fiction', label: '生存小说', reason: '荒野场景' },
      { subject: 'biography', label: '传记' },
    ]);
  });

  it('drops non-English subjects (Chinese/Japanese), bare punctuation, and duplicates', () => {
    expect(normalizeReadingTopicsResult({
      topics: [
        { subject: '战地医生', label: '战地医生' },
        { subject: 'science fiction', label: '科幻' },
        { subject: 'science fiction', label: '重复' },
        { subject: '!!!', label: '空' },
        { subject: 'a', label: '太短' },
        { subject: '   anthropology   ', label: '人类学' },
      ],
    })).toEqual([
      { subject: 'science fiction', label: '科幻' },
      { subject: 'anthropology', label: '人类学' },
    ]);
  });

  it('returns [] when payload is missing topics or wrong shape', () => {
    expect(normalizeReadingTopicsResult(null)).toEqual([]);
    expect(normalizeReadingTopicsResult({})).toEqual([]);
    expect(normalizeReadingTopicsResult({ topics: 'nope' })).toEqual([]);
  });
});

describe('buildReadingTopicsPrompt', () => {
  it('includes profile, recent chat, lore blocks and JSON output schema hint', () => {
    const prompt = buildReadingTopicsPrompt({
      agent: linwu,
      ownerProfile: linwuProfile,
      recentSceneBlock: '最近一次用户问林雾如何处理战场失温。',
      stableLoreBlock: '- 《雪线急救》（背景）\n林雾长期在雪线附近救治伤患。',
    });
    expect(prompt).toContain('林雾');
    expect(prompt).toContain('战地医生');
    expect(prompt).toContain('最近一次用户问林雾如何处理战场失温');
    expect(prompt).toContain('雪线急救');
    expect(prompt).toContain('Open Library subject');
    expect(prompt).toContain('{"topics"');
  });

  it('falls back to placeholder blocks when profile / recent / lore are empty', () => {
    const prompt = buildReadingTopicsPrompt({
      agent: linwu,
      ownerProfile: null,
      recentSceneBlock: '',
      stableLoreBlock: '',
    });
    expect(prompt).toContain('（无可用 profile）');
    expect(prompt).toContain('（暂无最近聊天上下文）');
    expect(prompt).toContain('（暂无 lore）');
  });
});

describe('inferReadingTopicsWithAI', () => {
  beforeEach(() => {
    hanaFetchMock.hanaFetch.mockReset();
    recentContextMock.collectRecentContextForAgent.mockReset();
    recentContextMock.describeRecentContextForPrompt.mockReset();
    loreStoreMock.listLoreEntries.mockReset();
    loreStoreMock.listLoreEntries.mockReturnValue([]);
    recentContextMock.collectRecentContextForAgent.mockReturnValue({
      agentId: 'test01',
      messages: [],
      summaryText: '',
      sourceNotes: [],
      hasOpenHanakoMessages: false,
    });
    recentContextMock.describeRecentContextForPrompt.mockReturnValue('');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('posts to /api/xingye/phone-generate with kind=reading_topics and returns normalized topics', async () => {
    hanaFetchMock.hanaFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        result: {
          topics: [
            { subject: 'War Memoir', label: '战争回忆', reason: '幼年经历战乱' },
            { subject: 'medical ethics', label: '医疗伦理', reason: '长期救治伤患' },
          ],
        },
      }),
    } as Response);

    const topics = await inferReadingTopicsWithAI({ agent: linwu, ownerProfile: linwuProfile });

    expect(hanaFetchMock.hanaFetch).toHaveBeenCalledWith(
      '/api/xingye/phone-generate',
      expect.objectContaining({
        method: 'POST',
        body: expect.any(String),
      }),
    );
    const body = JSON.parse(hanaFetchMock.hanaFetch.mock.calls[0][1].body as string);
    expect(body).toMatchObject({
      kind: 'reading_topics',
      ownerAgentId: 'test01',
      agentId: 'test01',
    });
    expect(typeof body.prompt).toBe('string');
    expect(body.prompt).toContain('Open Library subject');

    expect(topics).toEqual([
      { subject: 'war memoir', label: '战争回忆', reason: '幼年经历战乱' },
      { subject: 'medical ethics', label: '医疗伦理', reason: '长期救治伤患' },
    ]);
  });

  it('throws the server error when the response is not ok', async () => {
    hanaFetchMock.hanaFetch.mockResolvedValue({
      ok: false,
      json: async () => ({ ok: false, error: '模型暂不可用' }),
    } as Response);
    await expect(inferReadingTopicsWithAI({ agent: linwu, ownerProfile: linwuProfile }))
      .rejects.toThrow(/模型暂不可用/);
  });

  it('throws when the model returns no usable topics', async () => {
    hanaFetchMock.hanaFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { topics: [{ subject: '战地医生', label: '战地医生' }] } }),
    } as Response);
    await expect(inferReadingTopicsWithAI({ agent: linwu, ownerProfile: linwuProfile }))
      .rejects.toThrow(/模型未返回可用的阅读类别/);
  });
});
