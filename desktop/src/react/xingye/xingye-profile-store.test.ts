/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../types';
import type { XingyeLoreEntry } from './xingye-lore-store';
import {
  XINGYE_PROFILE_JSON_RELATIVE_PATH,
  XINGYE_ROLE_PROFILES_LEGACY_STORAGE_KEY,
  buildOpenHanakoAgentSyncPayload,
  filterLoreEntriesForAgentSync,
  buildOpenHanakoIdentity,
  buildOpenHanakoIshiki,
  getXingyeRoleProfileDisplay,
  readXingyeRoleProfile,
  saveXingyeRoleProfile,
} from './xingye-profile-store';
import { postXingyeStorage } from './xingye-storage-api';

const hoisted = vi.hoisted(() => ({
  fileData: new Map<string, unknown>(),
  mockConnection: {
    serverId: 'local',
    spaceId: 'local',
    label: 'test',
    baseUrl: 'http://127.0.0.1:17333',
    wsUrl: 'ws://127.0.0.1:17333',
    token: null,
    authState: 'paired' as const,
    trustState: 'local' as const,
    capabilities: ['chat'],
  },
}));

vi.mock('./xingye-storage-api', () => ({
  postXingyeStorage: vi.fn(async (body: Record<string, unknown>) => {
    const agentId = String(body.agentId ?? '');
    const relativePath = String(body.relativePath ?? '');
    const key = `${agentId}:${relativePath}`;
    if (body.action === 'readJson') {
      return { data: hoisted.fileData.has(key) ? hoisted.fileData.get(key) : null };
    }
    if (body.action === 'writeJson') {
      hoisted.fileData.set(key, body.data);
      return { ok: true };
    }
    return {};
  }),
}));

vi.mock('../stores', () => ({
  useStore: Object.assign(
    (fn: (s: { activeServerConnection: typeof hoisted.mockConnection | null; agents: { id: string }[] }) => unknown) =>
      fn({ activeServerConnection: hoisted.mockConnection, agents: [] }),
    {
      getState: () => ({ activeServerConnection: hoisted.mockConnection, agents: [] }),
    },
  ),
}));

describe('xingye-profile-store', () => {
  const agent: Agent = {
    id: 'agent-1',
    name: 'Hanako',
    yuan: 'hanako',
    isPrimary: true,
  };

  beforeEach(() => {
    hoisted.fileData.clear();
    window.localStorage.clear();
    vi.mocked(postXingyeStorage).mockClear();
    vi.mocked(postXingyeStorage).mockImplementation(async (body: Record<string, unknown>) => {
      const agentId = String(body.agentId ?? '');
      const relativePath = String(body.relativePath ?? '');
      const key = `${agentId}:${relativePath}`;
      if (body.action === 'readJson') {
        return { data: hoisted.fileData.has(key) ? hoisted.fileData.get(key) : null };
      }
      if (body.action === 'writeJson') {
        hoisted.fileData.set(key, body.data);
        return { ok: true };
      }
      return {};
    });
  });

  it('saves one Xingye profile per agent id to profile.json via storage API', async () => {
    const saved = await saveXingyeRoleProfile('agent-1', {
      displayName: '星野花子',
      shortBio: '会认真记住你的偏好。',
      relationshipLabel: '同伴',
      speakingStyle: '温柔直接',
      allowAutoMoments: true,
      allowProactiveDM: false,
    });

    expect(saved).toMatchObject({
      agentId: 'agent-1',
      displayName: '星野花子',
      shortBio: '会认真记住你的偏好。',
      relationshipLabel: '同伴',
      speakingStyle: '温柔直接',
      allowAutoMoments: true,
      allowProactiveDM: false,
    });
    expect(saved.updatedAt).toEqual(expect.any(String));
    expect(await readXingyeRoleProfile('agent-1')).toEqual(saved);
    expect(vi.mocked(postXingyeStorage)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'writeJson',
        agentId: 'agent-1',
        relativePath: XINGYE_PROFILE_JSON_RELATIVE_PATH,
      }),
    );
  });

  it('stores and clears a Xingye-only chat background data url', async () => {
    const saved = await saveXingyeRoleProfile('agent-1', {
      chatBackgroundDataUrl: 'data:image/webp;base64,background',
    });

    expect(saved.chatBackgroundDataUrl).toBe('data:image/webp;base64,background');
    expect(getXingyeRoleProfileDisplay(agent, saved).chatBackgroundDataUrl).toBe('data:image/webp;base64,background');
    expect(buildOpenHanakoAgentSyncPayload(agent, saved).identity).not.toContain('data:image');
    expect(buildOpenHanakoAgentSyncPayload(agent, saved).ishiki).not.toContain('data:image');

    const cleared = await saveXingyeRoleProfile('agent-1', {
      chatBackgroundDataUrl: undefined,
    });

    expect(cleared.chatBackgroundDataUrl).toBeUndefined();
  });

  it('falls back to OpenHanako agent fields when local fields are blank', async () => {
    const profile = await saveXingyeRoleProfile('agent-1', {
      displayName: '   ',
      shortBio: '',
    });

    expect(profile.displayName).toBeUndefined();
    expect(profile.shortBio).toBeUndefined();
    expect(getXingyeRoleProfileDisplay(agent, profile)).toMatchObject({
      displayName: 'Hanako',
      shortBio: '尚未填写角色简介。',
    });
  });

  it('returns null when storage read fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(postXingyeStorage).mockRejectedValueOnce(new Error('network'));
    await expect(readXingyeRoleProfile('agent-1')).resolves.toBeNull();
  });

  it('migrates once from legacy localStorage map when profile.json is missing', async () => {
    window.localStorage.setItem(
      XINGYE_ROLE_PROFILES_LEGACY_STORAGE_KEY,
      JSON.stringify({
        'agent-legacy': {
          agentId: 'agent-legacy',
          displayName: '迁移角色',
          shortBio: '来自旧 map。',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      }),
    );

    const loaded = await readXingyeRoleProfile('agent-legacy');
    expect(loaded?.displayName).toBe('迁移角色');
    expect(hoisted.fileData.get(`agent-legacy:${XINGYE_PROFILE_JSON_RELATIVE_PATH}`)).toMatchObject({
      displayName: '迁移角色',
    });
  });

  it('builds an OpenHanako sync payload from text persona fields only', () => {
    const payload = buildOpenHanakoAgentSyncPayload(agent, {
      agentId: 'agent-1',
      displayName: '星野花子',
      shortBio: '会认真记住用户偏好的搭子。',
      relationshipLabel: '同伴',
      speakingStyle: '温柔直接，回答简短。',
      avatarDataUrl: 'data:image/png;base64,avatar',
      chatBackgroundDataUrl: 'data:image/png;base64,bg',
      allowAutoMoments: true,
      allowProactiveDM: true,
      updatedAt: '2026-05-10T00:00:00.000Z',
    });

    expect(payload.identity).toContain('星野花子');
    expect(payload.identity).toContain('会认真记住用户偏好的搭子。');
    expect(payload.ishiki).toContain('同伴');
    expect(payload.ishiki).toContain('温柔直接，回答简短。表达清楚、稳定，不刻意夸张。');
    expect(payload.identity).not.toContain('data:image');
    expect(payload.ishiki).not.toContain('data:image');
    expect(payload.identity).not.toContain('allowAutoMoments');
    expect(payload.ishiki).not.toContain('allowProactiveDM');
  });

  it('expands thin Xingye fields into a structured Chinese OpenHanako persona', () => {
    const payload = buildOpenHanakoAgentSyncPayload(agent, {
      agentId: 'agent-1',
      displayName: '空',
      shortBio: 'test_01',
      relationshipLabel: '朋友',
      speakingStyle: 'deepseek原本风格',
      updatedAt: '2026-05-10T00:00:00.000Z',
    });

    expect(payload.identity).toContain('# 空');
    expect(payload.identity).toContain('身份尚未完全确定');
    expect(payload.identity).not.toContain('Xingye Persona');
    expect(payload.identity).not.toContain('synced from');
    expect(payload.identity).not.toContain('test_01');

    expect(payload.ishiki).toContain('# 人格定义');
    expect(payload.ishiki).toContain('## 角色是谁');
    expect(payload.ishiki).toContain('## 与用户关系');
    expect(payload.ishiki).toContain('## 说话风格');
    expect(payload.ishiki).toContain('## 互动方式');
    expect(payload.ishiki).toContain('## 稳定人设要求');
    expect(payload.ishiki).toContain('## 边界');
    expect(payload.ishiki).toContain('你与用户的关系是：朋友。');
    expect(payload.ishiki).toContain('理性、直接、克制，有判断力，解释清楚但不过度卖萌。');
    expect(payload.ishiki).toContain('你不编造没有依据的现实经历或外部事实。');
    expect(payload.ishiki).not.toContain('Xingye Persona Definition');
    expect(payload.ishiki).not.toContain('Use this persona as');
    expect(payload.ishiki).not.toContain('test_01');
  });

  it('uses a natural fallback when shortBio is blank', () => {
    const payload = buildOpenHanakoAgentSyncPayload(agent, {
      agentId: 'agent-1',
      displayName: '空',
      shortBio: '',
      relationshipLabel: '',
      speakingStyle: '',
      updatedAt: '2026-05-10T00:00:00.000Z',
    });

    expect(payload.identity).toContain('身份尚未完全确定');
    expect(payload.ishiki).toContain('你与用户的关系是：朋友。');
    expect(payload.ishiki).toContain('理性、直接、克制，有判断力，解释清楚但不过度卖萌。');
  });

  it('never injects lore into identity or ishiki sync payload', () => {
    const profile = {
      agentId: 'agent-1',
      displayName: '角色',
      shortBio: '这是一段足够长的简介用于避免占位符回退逻辑。',
      relationshipLabel: '朋友',
      speakingStyle: '温柔',
      identitySummary: '身份足量文字用于走完整人设分支。',
      backgroundSummary: '背景摘要。',
      personalitySummary: '人格摘要。',
      behaviorLogic: '行为逻辑。',
      values: '价值观。',
      taboos: '禁忌。',
      relationshipMode: '关系模式。',
      updatedAt: '2026-05-10T00:00:00.000Z',
    };
    const entries: XingyeLoreEntry[] = [
      {
        id: 'a',
        agentId: 'agent-1',
        title: '常驻',
        content: '始终生效的句子。',
        category: 'rule',
        keywords: [],
        enabled: true,
        priority: 10,
        insertionMode: 'always',
        visibility: 'canonical',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'b',
        agentId: 'agent-1',
        title: '关键词条',
        content: '关键词内容不应进入同步。',
        category: 'rule',
        keywords: ['k'],
        enabled: true,
        priority: 99,
        insertionMode: 'keyword',
        visibility: 'canonical',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'c',
        agentId: 'agent-1',
        title: '关闭',
        content: '禁用内容不出现。',
        category: 'rule',
        keywords: [],
        enabled: false,
        priority: 100,
        insertionMode: 'always',
        visibility: 'canonical',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ];
    const payload = buildOpenHanakoAgentSyncPayload(agent, profile, entries);
    expect(payload.ishiki).not.toContain('始终生效的句子');
    expect(payload.ishiki).not.toContain('星野设定（常驻条目）');
    expect(payload.ishiki).not.toContain('关键词内容不应进入同步');
    expect(payload.ishiki).not.toContain('禁用内容不出现');
    expect(payload.identity).not.toContain('始终生效的句子');
  });

  it('truncates very long profile fields in OpenHanako sync output', () => {
    const long = 'x'.repeat(500);
    const marker = 'UNIQUE_LONG_LORE_SNIPPET_SHOULD_NOT_APPEAR';
    const profile = {
      agentId: 'agent-1',
      displayName: '角色',
      shortBio: long,
      relationshipLabel: '朋友',
      speakingStyle: long,
      identitySummary: long,
      backgroundSummary: long,
      personalitySummary: long,
      behaviorLogic: long,
      values: long,
      taboos: long,
      relationshipMode: long,
      updatedAt: '2026-05-10T00:00:00.000Z',
    };
    const entries: XingyeLoreEntry[] = [
      {
        id: 'a',
        agentId: 'agent-1',
        title: 't',
        content: marker,
        category: 'background',
        keywords: [],
        enabled: true,
        priority: 10,
        insertionMode: 'always',
        visibility: 'canonical',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ];
    const payload = buildOpenHanakoAgentSyncPayload(agent, profile, entries);
    expect(payload.identity.length).toBeLessThan(2000);
    expect(payload.ishiki.length).toBeLessThan(4000);
    expect(payload.identity).not.toContain(marker);
    expect(payload.ishiki).not.toContain(marker);
    expect(payload.identity).toContain('…');
    expect(payload.ishiki).toContain('…');
  });

  it('filterLoreEntriesForAgentSync prefers higher priority first', () => {
    const entries: XingyeLoreEntry[] = [
      {
        id: 'low',
        agentId: 'agent-1',
        title: '低',
        content: 'x',
        category: 'rule',
        keywords: [],
        enabled: true,
        priority: 1,
        insertionMode: 'always',
        visibility: 'canonical',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'high',
        agentId: 'agent-1',
        title: '高',
        content: 'y',
        category: 'rule',
        keywords: [],
        enabled: true,
        priority: 80,
        insertionMode: 'always',
        visibility: 'canonical',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ];
    const sorted = filterLoreEntriesForAgentSync(entries);
    expect(sorted.map((e) => e.id)).toEqual(['high', 'low']);
  });

  it('does not emit product or engineering terms in OpenHanako formatter output', () => {
    const profile = {
      agentId: 'agent-1',
      displayName: '林雾',
      shortBio: '',
      relationshipLabel: '朋友',
      speakingStyle: '',
      identitySummary: '',
      backgroundSummary: '',
      personalitySummary: '',
      behaviorLogic: '',
      values: '',
      taboos: '',
      relationshipMode: '',
      updatedAt: '2026-05-10T00:00:00.000Z',
    };
    const combined = [
      buildOpenHanakoIdentity(agent, profile),
      buildOpenHanakoIshiki(agent, profile),
      buildOpenHanakoAgentSyncPayload(agent, profile).identity,
      buildOpenHanakoAgentSyncPayload(agent, profile).ishiki,
    ].join('\n');

    for (const term of [
      '星野模式',
      '创建的角色',
      '个人助手',
      '长期陪伴型角色',
      '设定库',
      '同步',
      'OpenHanako',
      'memory',
      'RAG',
      'prompt',
      '工程配置',
      '长期陪伴用户的个人助手',
      '用户在星野模式中创建的角色',
    ]) {
      expect(combined).not.toContain(term);
    }
  });
});
