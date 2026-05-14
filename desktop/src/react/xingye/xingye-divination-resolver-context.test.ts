import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../types';
import {
  resolveRecommendedDivinationMethod,
  DIVINATION_RESOLVER_CONTEXT_MIN_LEN,
} from './xingye-divination-method-resolver';
import { buildDivinationResolverContext } from './xingye-divination-resolver-context';
import type { XingyeRoleProfile } from './xingye-profile-store';
import * as profileStore from './xingye-profile-store';

const { postXingyeStorageMock } = vi.hoisted(() => ({
  postXingyeStorageMock: vi.fn(),
}));

vi.mock('./xingye-storage-api', () => ({
  postXingyeStorage: postXingyeStorageMock,
}));

vi.mock('./xingye-profile-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./xingye-profile-store')>();
  return {
    ...actual,
    readXingyeRoleProfile: vi.fn(),
  };
});

const readMock = vi.mocked(profileStore.readXingyeRoleProfile);

function mockReadJsonLore(data: unknown | null) {
  postXingyeStorageMock.mockImplementation(async (body: Record<string, unknown>) => {
    if (body.action === 'readJson' && body.relativePath === 'lore/entries.json') {
      if (data == null) return { missing: true, data: null };
      return { missing: false, data };
    }
    return { missing: true, data: null };
  });
}

function baseEntry(
  id: string,
  patch: Partial<{
    title: string;
    content: string;
    enabled: boolean;
    insertionMode: string;
    visibility: string;
    keywords: string[];
    category: string;
    priority: number;
  }>,
) {
  const agentId = 'agent-lin';
  return {
    id,
    agentId,
    title: patch.title ?? 'T',
    content: patch.content ?? 'C',
    category: patch.category ?? 'background',
    keywords: patch.keywords ?? [],
    enabled: patch.enabled !== false,
    priority: patch.priority ?? 80,
    insertionMode: patch.insertionMode ?? 'always',
    visibility: patch.visibility ?? 'canonical',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('buildDivinationResolverContext', () => {
  const agent: Agent = { id: 'agent-lin', name: '林雾', yuan: 'lin', isPrimary: false };

  beforeEach(() => {
    readMock.mockReset();
    postXingyeStorageMock.mockReset();
    mockReadJsonLore(null);
  });

  it('parses top-level object entries.json and includes enabled entry content', async () => {
    readMock.mockResolvedValue({
      agentId: 'agent-lin',
      displayName: '林雾',
      shortBio: '短',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    mockReadJsonLore({
      e1: baseEntry('e1', {
        title: '长背景',
        content: '边境小城、战乱、炮声、资源不足、创伤处理、感染控制、基础外科缝合、止血、药物配给、紧急撤离判断。',
        enabled: true,
        insertionMode: 'always',
      }),
    });
    const built = await buildDivinationResolverContext('agent-lin', agent, null);
    expect(built?.agentLike.extraCorpus).toContain('边境小城');
    expect(built?.contextSources.some((s) => s.includes('xingye.lore.entries.json:长背景'))).toBe(true);
    expect(built?.profileOnlyNoEnabledLore).toBe(false);
    expect(built?.enabledLoreTitlesInCorpus).toContain('长背景');
  });

  it('supports array-shaped entries.json', async () => {
    readMock.mockResolvedValue({
      agentId: 'agent-lin',
      displayName: '林',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    mockReadJsonLore([
      baseEntry('row-a', {
        title: 'FromArray',
        content: 'ARRAY_SHAPE_BODY',
        enabled: true,
      }),
    ]);
    const built = await buildDivinationResolverContext('agent-lin', agent, null);
    expect(built?.agentLike.extraCorpus).toContain('ARRAY_SHAPE_BODY');
  });

  it('skips disabled lore: does not place disabled content in extraCorpus; counts skipped', async () => {
    readMock.mockResolvedValue({
      agentId: 'agent-lin',
      displayName: '林雾',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    mockReadJsonLore({
      hidden: baseEntry('hidden', {
        title: 'DisabledCanon',
        content: 'DISABLED_SECRET_LORE_XYZ',
        enabled: false,
        insertionMode: 'always',
        visibility: 'canonical',
        category: 'background',
      }),
    });
    const built = await buildDivinationResolverContext('agent-lin', agent, null);
    expect(built?.agentLike.extraCorpus ?? '').not.toContain('DISABLED_SECRET_LORE_XYZ');
    expect(built?.loreSkippedDisabledCount).toBe(1);
    expect(built?.enabledLoreTitlesInCorpus.length).toBe(0);
    expect(built?.profileOnlyNoEnabledLore).toBe(true);
  });

  it('keyword insertionMode: no full content without keyword hit; includes content when question matches', async () => {
    readMock.mockResolvedValue({
      agentId: 'agent-lin',
      displayName: '林',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    mockReadJsonLore({
      kw: baseEntry('kw', {
        title: '秘闻',
        content: 'FULL_KEYWORD_ONLY_WHEN_HIT',
        enabled: true,
        insertionMode: 'keyword',
        keywords: ['月球'],
      }),
    });
    const noQ = await buildDivinationResolverContext('agent-lin', agent, null, { divinationQuestion: '' });
    expect(noQ?.agentLike.extraCorpus ?? '').not.toContain('FULL_KEYWORD_ONLY_WHEN_HIT');
    expect(noQ?.agentLike.extraCorpus ?? '').toMatch(/秘闻/);

    const hit = await buildDivinationResolverContext('agent-lin', agent, null, { divinationQuestion: '关于月球旅行' });
    expect(hit?.agentLike.extraCorpus).toContain('FULL_KEYWORD_ONLY_WHEN_HIT');
  });

  it('profile-only 林雾式摘要：matchedSignals 非空、field_oracle 非零、理由提示仅 profile', async () => {
    readMock.mockResolvedValue({
      agentId: 'agent-lin',
      displayName: '林雾',
      shortBio: '边境医生，外冷内热，重视行动而非言语。',
      identitySummary: '边境医生，曾经历战乱，失去重要之人。',
      backgroundSummary: '幼年经历战乱与失去，后成为边境医生，长期救治伤患。',
      behaviorLogic: '以具体行动表达关心，避免空洞安慰，优先处理实际问题。',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    mockReadJsonLore({});
    const built = await buildDivinationResolverContext('agent-lin', agent, null);
    expect(built?.profileOnlyNoEnabledLore).toBe(true);
    expect(built!.contextLength).toBeGreaterThan(DIVINATION_RESOLVER_CONTEXT_MIN_LEN);
    const hint = {
      contextLength: built!.contextLength,
      contextSources: built!.contextSources,
      loreSkippedDisabledCount: built!.loreSkippedDisabledCount,
      enabledLoreTitlesInCorpus: built!.enabledLoreTitlesInCorpus,
      profileOnlyNoEnabledLore: built!.profileOnlyNoEnabledLore,
    };
    const r = resolveRecommendedDivinationMethod(built!.agentLike, hint);
    expect(r.matchedSignals.length).toBeGreaterThan(0);
    expect(r.scores.field_oracle).toBeGreaterThan(0);
    expect(r.method).toBe('field_oracle');
    expect(r.resolverReason).toMatch(/仅使用 profile 摘要|未读取到纳入占卜上下文的 enabled lore|未纳入 enabled lore/);
    expect(r.resolverReason).toContain('【占卜上下文调试】');
  });

  it('enabled long lore: field_oracle 高置信、contextLength 大于 profile-only', async () => {
    readMock.mockResolvedValue({
      agentId: 'agent-lin',
      displayName: '林雾',
      shortBio: '短摘要',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const long =
      '边境小城、战乱、炮声、资源不足、创伤处理、感染控制、基础外科缝合、止血、药物配给、紧急撤离判断。重复填充语料。'.repeat(12);
    mockReadJsonLore({
      long1: baseEntry('long1', {
        title: '战地长背景',
        content: long,
        enabled: true,
        insertionMode: 'always',
      }),
    });
    const built = await buildDivinationResolverContext('agent-lin', agent, null);
    const hint = {
      contextLength: built!.contextLength,
      contextSources: built!.contextSources,
      loreSkippedDisabledCount: built!.loreSkippedDisabledCount,
      enabledLoreTitlesInCorpus: built!.enabledLoreTitlesInCorpus,
      profileOnlyNoEnabledLore: built!.profileOnlyNoEnabledLore,
    };
    const r = resolveRecommendedDivinationMethod(built!.agentLike, hint);
    expect(built!.contextLength).toBeGreaterThan(400);
    expect(r.method).toBe('field_oracle');
    expect(r.autoSelected).toBe(true);
    expect(r.matchedSignals.some((s) => s.evidence.includes('资源不足') || s.evidence.includes('战乱'))).toBe(true);
    expect(hint.contextSources.some((s) => s.includes('战地长背景'))).toBe(true);
  });

  it('after lore becomes enabled, corpus grows (simulated second read)', async () => {
    readMock.mockResolvedValue({
      agentId: 'agent-lin',
      displayName: '林',
      shortBio: '边境医生，战乱中救治伤患。',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    mockReadJsonLore({});
    const first = await buildDivinationResolverContext('agent-lin', agent, null);
    mockReadJsonLore({
      x: baseEntry('x', {
        title: '新启用',
        content: '炮声与感染控制和止血药物配给资源不足'.repeat(5),
        enabled: true,
      }),
    });
    const second = await buildDivinationResolverContext('agent-lin', agent, null);
    expect(second!.contextLength).toBeGreaterThan(first!.contextLength);
    expect(second?.profileOnlyNoEnabledLore).toBe(false);
  });

  it('merges disk profile + hook overlay; sources list profile.json', async () => {
    const disk: XingyeRoleProfile = {
      agentId: 'agent-lin',
      displayName: '林雾',
      identitySummary: '边境医生',
      backgroundSummary: '熟悉感染控制与止血。',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    readMock.mockResolvedValue(disk);
    mockReadJsonLore(null);
    const fb: XingyeRoleProfile = {
      agentId: 'agent-lin',
      shortBio: 'overlay',
      updatedAt: '2026-01-02T00:00:00.000Z',
    };
    const built = await buildDivinationResolverContext('agent-lin', agent, fb);
    expect(built?.contextSources).toContain('xingye.profile.json');
    expect(built?.contextSources).toContain('xingye.profile(hook_overlay)');
    expect(built?.agentLike.shortBio).toContain('overlay');
  });

  it('uses hook profile overlay when disk is null', async () => {
    readMock.mockResolvedValue(null);
    mockReadJsonLore(null);
    const fb: XingyeRoleProfile = {
      agentId: 'agent-lin',
      displayName: '林',
      identitySummary: '仙侠剑修，八卦与江湖。',
      updatedAt: '2026-01-02T00:00:00.000Z',
    };
    const built = await buildDivinationResolverContext('agent-lin', agent, fb);
    expect(built?.contextSources).toContain('xingye.profile(hook_fallback)');
    expect(built?.agentLike.identitySummary).toContain('剑修');
  });
});
