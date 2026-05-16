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
const persistenceMock = vi.hoisted(() => ({ getXingyePersistenceStorage: vi.fn(() => null) }));
const heartbeatMock = vi.hoisted(() => ({
  peekDeskHeartbeatUiOutcome: vi.fn<(agentId: string) => string | null>(() => null),
}));

vi.mock('../hooks/use-hana-fetch', () => hanaFetchMock);
vi.mock('./xingye-recent-context', () => recentContextMock);
vi.mock('./xingye-lore-store', () => loreStoreMock);
vi.mock('./xingye-persistence', () => persistenceMock);
vi.mock('./xingye-desk-heartbeat-memory', () => heartbeatMock);

import {
  buildReadingAnnotationPrompt,
  inferReadingAnnotationWithAI,
  normalizeReadingAnnotationResult,
} from './xingye-reading-annotation-ai';
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
  backgroundSummary: '幼年经历战乱。',
  updatedAt: '2026-05-16T00:00:00.000Z',
};

const book = {
  title: 'Man\'s Search for Meaning',
  authors: ['Viktor E. Frankl'],
  subjects: ['Nazi concentration camps', 'psychotherapy'],
};

describe('normalizeReadingAnnotationResult', () => {
  it('keeps title + annotation + mood and truncates to length caps', () => {
    const out = normalizeReadingAnnotationResult({
      title: 'a'.repeat(80),
      annotation: 'b'.repeat(500),
      mood: 'c'.repeat(40),
    });
    expect(out).not.toBeNull();
    expect(out!.title.length).toBeLessThanOrEqual(32);
    expect(out!.annotation.length).toBeLessThanOrEqual(300);
    expect(out!.mood?.length).toBeLessThanOrEqual(8);
  });

  it('falls back to truncated annotation when title is missing', () => {
    const out = normalizeReadingAnnotationResult({ annotation: '这段话让我想到当年的冬天，雪线之外的寂静。' });
    expect(out?.title).toBeTruthy();
    expect(out?.title.length).toBeLessThanOrEqual(20);
  });

  it('returns null when annotation is missing', () => {
    expect(normalizeReadingAnnotationResult({ title: '只有标题' })).toBeNull();
    expect(normalizeReadingAnnotationResult(null)).toBeNull();
    expect(normalizeReadingAnnotationResult('not an object')).toBeNull();
  });
});

describe('buildReadingAnnotationPrompt', () => {
  it('includes profile, book, passage, and forbids re-quoting in annotation', () => {
    const prompt = buildReadingAnnotationPrompt({
      agent: linwu,
      ownerProfile: linwuProfile,
      book,
      passage: 'Between stimulus and response there is a space.',
      recentSceneBlock: '最近用户问 TA 失温处理顺序。',
      stableLoreBlock: '- 《雪线急救》（背景）\n林雾长期在雪线附近救治伤患。',
      heartbeatBlock: '巡检已触发 · 一切正常',
    });
    expect(prompt).toContain('林雾');
    expect(prompt).toContain('战地医生');
    expect(prompt).toContain("Man's Search for Meaning");
    expect(prompt).toContain('Between stimulus and response there is a space.');
    expect(prompt).toContain('最近用户问 TA 失温处理顺序');
    expect(prompt).toContain('雪线急救');
    expect(prompt).toContain('巡检已触发');
    expect(prompt).toContain('不要把原文重复一遍');
    expect(prompt).toContain('「批注」不是「复述」');
    expect(prompt).toContain('不要在批注里再创造新的原文引用');
  });

  it('uses placeholders when no profile/recent/lore/heartbeat are available', () => {
    const prompt = buildReadingAnnotationPrompt({
      agent: linwu,
      ownerProfile: null,
      book,
      passage: 'A short line.',
      recentSceneBlock: '',
      stableLoreBlock: '',
      heartbeatBlock: '',
    });
    expect(prompt).toContain('（无可用 profile）');
    expect(prompt).toContain('（暂无最近聊天）');
    expect(prompt).toContain('（暂无 lore）');
    expect(prompt).toContain('（无）');
  });

  it('annotates citation line when sourceCitation is provided', () => {
    const prompt = buildReadingAnnotationPrompt({
      agent: linwu,
      ownerProfile: linwuProfile,
      book,
      passage: 'A short line.',
      passageCitation: {
        provider: 'wikiquote', lang: 'en', pageTitle: 'Viktor Frankl',
        pageUrl: 'https://en.wikiquote.org/wiki/Viktor_Frankl',
      },
      recentSceneBlock: '',
      stableLoreBlock: '',
      heartbeatBlock: '',
    });
    expect(prompt).toContain('原文出处：wikiquote');
    expect(prompt).toContain('Viktor Frankl');
  });
});

describe('inferReadingAnnotationWithAI', () => {
  beforeEach(() => {
    hanaFetchMock.hanaFetch.mockReset();
    recentContextMock.collectRecentContextForAgent.mockReset();
    recentContextMock.describeRecentContextForPrompt.mockReset();
    loreStoreMock.listLoreEntries.mockReset();
    heartbeatMock.peekDeskHeartbeatUiOutcome.mockReset();
    loreStoreMock.listLoreEntries.mockReturnValue([]);
    recentContextMock.collectRecentContextForAgent.mockReturnValue({
      agentId: 'test01', messages: [], summaryText: '', sourceNotes: [], hasOpenHanakoMessages: false,
    });
    recentContextMock.describeRecentContextForPrompt.mockReturnValue('');
    heartbeatMock.peekDeskHeartbeatUiOutcome.mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('posts to /api/xingye/phone-generate with kind=reading_annotation and returns normalized result', async () => {
    hanaFetchMock.hanaFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        result: { title: '面对沉默的余地', annotation: '我懂这种顿挫，但雪地里我们没有那个余地。', mood: '克制' },
      }),
    } as Response);

    const out = await inferReadingAnnotationWithAI({
      agent: linwu,
      ownerProfile: linwuProfile,
      book,
      passage: 'Between stimulus and response there is a space.',
    });

    expect(hanaFetchMock.hanaFetch).toHaveBeenCalledWith(
      '/api/xingye/phone-generate',
      expect.objectContaining({ method: 'POST' }),
    );
    const body = JSON.parse(hanaFetchMock.hanaFetch.mock.calls[0][1].body as string);
    expect(body).toMatchObject({ kind: 'reading_annotation', ownerAgentId: 'test01', agentId: 'test01' });
    expect(body.prompt).toContain('Between stimulus and response there is a space.');
    expect(out).toEqual({ title: '面对沉默的余地', annotation: '我懂这种顿挫，但雪地里我们没有那个余地。', mood: '克制' });
  });

  it('passes heartbeat outcome through to the prompt when present', async () => {
    heartbeatMock.peekDeskHeartbeatUiOutcome.mockReturnValue('巡检失败：远端不可达');
    hanaFetchMock.hanaFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { annotation: '心里有点不安。' } }),
    } as Response);
    await inferReadingAnnotationWithAI({ agent: linwu, ownerProfile: linwuProfile, book, passage: 'A short line.' });
    const body = JSON.parse(hanaFetchMock.hanaFetch.mock.calls[0][1].body as string);
    expect(body.prompt).toContain('巡检失败：远端不可达');
  });

  it('throws when the server reports an error envelope', async () => {
    hanaFetchMock.hanaFetch.mockResolvedValue({
      ok: false,
      json: async () => ({ ok: false, error: '模型暂不可用' }),
    } as Response);
    await expect(inferReadingAnnotationWithAI({ agent: linwu, ownerProfile: linwuProfile, book, passage: 'A short line.' }))
      .rejects.toThrow(/模型暂不可用/);
  });

  it('throws when the model returns no annotation', async () => {
    hanaFetchMock.hanaFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { title: '只有标题' } }),
    } as Response);
    await expect(inferReadingAnnotationWithAI({ agent: linwu, ownerProfile: linwuProfile, book, passage: 'A short line.' }))
      .rejects.toThrow(/模型返回无效/);
  });
});
