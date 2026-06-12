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

vi.mock('./xingye-phone-store', () => ({
  // 互动者池经 buildContactLoreHints 取「已确认」联系人（待『新的朋友』通过的候选不进池）。
  getConfirmedVirtualContacts: vi.fn(),
  // moments-ai 通过 resolveContactDisplayName 拿到与通讯录 UI 同口径的显示名
  // （meta.remark 优先 → contact.displayName）。测试里默认实现回退到 contact.displayName，
  // 等价于无 phone-contact-meta 的情况；个别 case 用 mockImplementation 注入 remark 优先。
  resolveContactDisplayName: vi.fn(),
  // peerAgents 的 impressionOfAuthor 走 getPhoneContactMeta（peer 通讯录里对发帖人的印象）。
  getPhoneContactMeta: vi.fn(),
}));

// 内容级去重需要读 agent 自己已发的朋友圈，喂给 anchor block 与硬过滤路径。
// 仅 mock listXingyeMomentPosts；其他导出保持原模块（actor-level 处理走 normalizePost
// 等仍是原实现，不影响这层 mock）。
vi.mock('./xingye-moments-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./xingye-moments-store')>();
  return {
    ...actual,
    listXingyeMomentPosts: vi.fn(),
  };
});

import { hanaFetch } from '../hooks/use-hana-fetch';
import { postXingyeStorage } from './xingye-storage-api';
import { getPhoneContactMeta, getConfirmedVirtualContacts, resolveContactDisplayName } from './xingye-phone-store';
import { listXingyeMomentPosts } from './xingye-moments-store';
import {
  generateXingyeMomentDraftWithAI,
  normalizeMomentDraftResult,
} from './xingye-moments-ai';

describe('normalizeMomentDraftResult', () => {
  it('accepts content or legacy body and returns empty seed arrays', () => {
    expect(normalizeMomentDraftResult({ content: '萍水相逢' })).toEqual({
      content: '萍水相逢',
      seedLikes: [],
      seedComments: [],
    });
    expect(normalizeMomentDraftResult({ body: '退而求其次' })).toEqual({
      content: '退而求其次',
      seedLikes: [],
      seedComments: [],
    });
  });

  it('clamps long unicode content', () => {
    const long = '字'.repeat(400);
    const r = normalizeMomentDraftResult({ content: long });
    expect(r?.content.length).toBeLessThanOrEqual(281);
    expect(r?.content.endsWith('…')).toBe(true);
  });

  it('returns null for empty / non-object', () => {
    expect(normalizeMomentDraftResult(null)).toBeNull();
    expect(normalizeMomentDraftResult({})).toBeNull();
    expect(normalizeMomentDraftResult({ content: '   ' })).toBeNull();
  });

  it('resolves likes / comments against virtual_contact + peer agent pools, drops unknown refs', () => {
    const raw = {
      content: 'ok',
      likes: [
        { ref: 'vc:vc-1' },
        { ref: 'agent:hanako' },
        { ref: 'vc:does-not-exist' }, // dropped
        { ref: 'agent:linwu' }, // dropped (self)
        { ref: 'vc:vc-1' }, // dedupe
      ],
      comments: [
        { ref: 'vc:vc-1', body: '保重' },
        { ref: 'agent:hanako', body: '听见了' },
        { ref: 'vc:vc-1', body: '   ' }, // dropped (empty body)
        { ref: 'unknown', body: 'x' }, // dropped
        { ref: 'agent:hanako', body: '字'.repeat(200) }, // body clamped
      ],
    };
    const r = normalizeMomentDraftResult(raw, {
      ownerAgentId: 'linwu',
      virtualContacts: [{ id: 'vc-1', displayName: '北门旧巷' }],
      peerAgents: [
        { id: 'hanako', displayName: 'Hanako' },
        { id: 'linwu', displayName: '林雾 (self)' }, // self in peer list filtered
      ],
    });
    expect(r?.seedLikes.map((l) => `${l.actorType}:${l.actorId}`)).toEqual([
      'virtual_contact:linwu:vc-1',
      'agent:hanako',
    ]);
    expect(r?.seedComments.map((c) => `${c.actorType}:${c.actorId}`)).toEqual([
      'virtual_contact:linwu:vc-1',
      'agent:hanako',
      'agent:hanako',
    ]);
    // long body clamped
    expect(r?.seedComments[2].body.length).toBeLessThanOrEqual(61);
    expect(r?.seedComments[2].body.endsWith('…')).toBe(true);
  });

  it('drops all likes / comments when no pools provided (cannot resolve refs)', () => {
    const r = normalizeMomentDraftResult({
      content: 'x',
      likes: [{ ref: 'vc:vc-1' }],
      comments: [{ ref: 'vc:vc-1', body: 'y' }],
    });
    expect(r?.seedLikes).toEqual([]);
    expect(r?.seedComments).toEqual([]);
  });

  it('accepts string-array form of likes (model may emit ["agent:hanako", "vc:vc-1"])', () => {
    const r = normalizeMomentDraftResult(
      {
        content: 'x',
        likes: ['agent:hanako', 'vc:vc-1', '   ', 'agent:hanako'], // dedupe + drop empty
      },
      {
        ownerAgentId: 'linwu',
        virtualContacts: [{ id: 'vc-1', displayName: '北门旧巷' }],
        peerAgents: [{ id: 'hanako', displayName: 'Hanako' }],
      },
    );
    expect(r?.seedLikes.map((l) => `${l.actorType}:${l.actorId}`)).toEqual([
      'agent:hanako',
      'virtual_contact:linwu:vc-1',
    ]);
  });

  it('accepts alternate ref field names (agentId / actor / actorId / contactId)', () => {
    const r = normalizeMomentDraftResult(
      {
        content: 'x',
        likes: [
          { agentId: 'agent:hanako' }, // agentId carrying full ref
          { actor: 'vc:vc-1' },        // actor carrying full ref
        ],
        comments: [
          { actorId: 'agent:hanako', text: '听见了' },          // alternate field for both ref and body
          { contactId: 'vc:vc-1', message: '保重' },              // contactId + message
        ],
      },
      {
        ownerAgentId: 'linwu',
        virtualContacts: [{ id: 'vc-1', displayName: '北门旧巷' }],
        peerAgents: [{ id: 'hanako', displayName: 'Hanako' }],
      },
    );
    expect(r?.seedLikes.map((l) => `${l.actorType}:${l.actorId}`)).toEqual([
      'agent:hanako',
      'virtual_contact:linwu:vc-1',
    ]);
    expect(r?.seedComments.map((c) => `${c.actorType}:${c.actorId}:${c.body}`)).toEqual([
      'agent:hanako:听见了',
      'virtual_contact:linwu:vc-1:保重',
    ]);
  });

  it('infers missing prefix when bare id matches the pool (e.g. "hanako" → agent:hanako)', () => {
    const r = normalizeMomentDraftResult(
      {
        content: 'x',
        likes: ['hanako', { ref: 'vc-1' }], // 无前缀，分别从 agent / vc 池命中
      },
      {
        ownerAgentId: 'linwu',
        virtualContacts: [{ id: 'vc-1', displayName: '北门旧巷' }],
        peerAgents: [{ id: 'hanako', displayName: 'Hanako' }],
      },
    );
    expect(r?.seedLikes.map((l) => `${l.actorType}:${l.actorId}`)).toEqual([
      'agent:hanako',
      'virtual_contact:linwu:vc-1',
    ]);
  });

  it('warns to console when entries are dropped (observability)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    normalizeMomentDraftResult(
      {
        content: 'x',
        likes: [{ ref: 'agent:unknown' }, 'agent:hanako'],
      },
      {
        ownerAgentId: 'linwu',
        peerAgents: [{ id: 'hanako', displayName: 'Hanako' }],
      },
    );
    const calls = warnSpy.mock.calls.map((args) => String(args[0] ?? ''));
    expect(calls.some((line) => line.includes('[xingye-moments-ai] likes parse'))).toBe(true);
    warnSpy.mockRestore();
  });
});

describe('generateXingyeMomentDraftWithAI', () => {
  beforeEach(() => {
    vi.mocked(postXingyeStorage).mockReset();
    vi.mocked(hanaFetch).mockReset();
    vi.mocked(getConfirmedVirtualContacts).mockReset();
    vi.mocked(resolveContactDisplayName).mockReset();
    vi.mocked(getPhoneContactMeta).mockReset();
    vi.mocked(listXingyeMomentPosts).mockReset();
    // 默认：无历史朋友圈 → anchor 块为空、内容去重不触发。
    vi.mocked(listXingyeMomentPosts).mockResolvedValue([]);
    vi.mocked(getPhoneContactMeta).mockReturnValue(null as never);
    vi.mocked(postXingyeStorage).mockResolvedValue({ missing: true } as never);
    vi.mocked(getConfirmedVirtualContacts).mockReturnValue([]);
    // Default：fallback 到 contact.displayName（无 remark 场景），与通讯录 UI 一致
    vi.mocked(resolveContactDisplayName).mockImplementation(
      (_ownerAgentId: string, _targetType: unknown, targetId: string) => {
        const list = vi.mocked(getConfirmedVirtualContacts).mock.results.flatMap((r) =>
          r.type === 'return' ? (r.value as Array<{ id: string; displayName: string }>) : [],
        );
        return list.find((c) => c.id === targetId)?.displayName ?? '虚拟联系人';
      },
    );
    vi.mocked(hanaFetch).mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { content: '今天天有点低' } }),
    } as Response);
  });

  it('prompt enforces likes/comments as mandatory when any pool is non-empty (with few-shot)', async () => {
    vi.mocked(getConfirmedVirtualContacts).mockReturnValue([
      {
        ownerAgentId: 'linwu',
        id: 'vc-night',
        displayName: '夜班搭子',
        kind: 'coworker',
        createdAt: '2026-05-11T00:00:00.000Z',
        updatedAt: '2026-05-11T00:00:00.000Z',
      },
    ] as never);
    const agent = { id: 'linwu', name: '林雾', yuan: 'y' as const };
    await generateXingyeMomentDraftWithAI({
      agent: agent as never,
      ownerProfile: null,
      peerAgents: [{ id: 'hanako', displayName: 'Hanako' }],
    });
    const generateCall = vi.mocked(hanaFetch).mock.calls.find(
      (call) => call[0] === '/api/xingye/phone-generate',
    );
    const prompt = JSON.parse(String(generateCall?.[1]?.body ?? '{}')).prompt as string;
    // 必出指令
    expect(prompt).toMatch(/必须.*至少 2 条 likes/);
    expect(prompt).toMatch(/至少 1 条 comments/);
    // few-shot 示例：让模型看到具体应该长什么样
    expect(prompt).toContain('凌晨三点的便利店');
    expect(prompt).toContain('"ref": "agent:hanako"');
    // 仍允许两池全空时省略
    expect(prompt).toContain('两个池都是「（无）」时才允许省略');
  });

  it('prompt pushes comments to include peer agents, not only virtual contacts', async () => {
    const agent = { id: 'linwu', name: '林雾', yuan: 'y' as const };
    await generateXingyeMomentDraftWithAI({
      agent: agent as never,
      ownerProfile: null,
      peerAgents: [{ id: 'hanako', displayName: 'Hanako' }],
    });
    const generateCall = vi.mocked(hanaFetch).mock.calls.find(
      (call) => call[0] === '/api/xingye/phone-generate',
    );
    const prompt = JSON.parse(String(generateCall?.[1]?.body ?? '{}')).prompt as string;
    // 显式规则：peerAgents 池非空时 comments 至少 1 条来自 agent
    expect(prompt).toContain('不要只来自虚拟联系人');
    // few-shot 示例的 comments 里现在带了一条 agent 评论
    expect(prompt).toContain('又通宵？明早我替你盯着会。');
  });

  it('feeds each peer agent the impression-of-author from their contact book (agent↔agent grounding)', async () => {
    vi.mocked(getPhoneContactMeta).mockImplementation(
      ((ownerId: string, targetType: unknown, targetId: string) => {
        if (ownerId === 'hanako' && targetType === 'agent' && targetId === 'linwu') {
          return { impression: '林雾面冷心热，别被那张臭脸吓到' };
        }
        return null;
      }) as never,
    );
    const agent = { id: 'linwu', name: '林雾', yuan: 'y' as const };
    await generateXingyeMomentDraftWithAI({
      agent: agent as never,
      ownerProfile: null,
      peerAgents: [{ id: 'hanako', displayName: 'Hanako' }],
    });
    const generateCall = vi.mocked(hanaFetch).mock.calls.find(
      (call) => call[0] === '/api/xingye/phone-generate',
    );
    const prompt = JSON.parse(String(generateCall?.[1]?.body ?? '{}')).prompt as string;
    // peer 对发帖人的印象进了 prompt，模型替 peer 写评论时有关系依据
    expect(prompt).toContain('impressionOfAuthor');
    expect(prompt).toContain('林雾面冷心热，别被那张臭脸吓到');
  });

  it('feeds each virtual contact the owner-side impression into the prompt', async () => {
    vi.mocked(getConfirmedVirtualContacts).mockReturnValue([
      {
        ownerAgentId: 'linwu',
        id: 'vc-1',
        displayName: '北门旧巷',
        kind: 'rival',
        impression: '嘴上不饶人，但记仇',
        relationshipHint: '老对头',
        createdAt: '2026-05-11T00:00:00.000Z',
        updatedAt: '2026-05-11T00:00:00.000Z',
      },
    ] as never);
    const agent = { id: 'linwu', name: '林雾', yuan: 'y' as const };
    await generateXingyeMomentDraftWithAI({
      agent: agent as never,
      ownerProfile: null,
    });
    const generateCall = vi.mocked(hanaFetch).mock.calls.find(
      (call) => call[0] === '/api/xingye/phone-generate',
    );
    const prompt = JSON.parse(String(generateCall?.[1]?.body ?? '{}')).prompt as string;
    // 发帖人对 vc 的印象进了 prompt，且标清楚了方向（发帖人视角）
    expect(prompt).toContain('嘴上不饶人，但记仇');
    expect(prompt).toContain('发帖人对 TA');
  });

  it('posts phone-generate with kind moments and contains moments-specific prompt markers', async () => {
    const agent = { id: 'agent-m', name: 'Hanako', yuan: 'y' as const };
    await expect(
      generateXingyeMomentDraftWithAI({ agent: agent as never, ownerProfile: null }),
    ).resolves.toEqual({ content: '今天天有点低', seedLikes: [], seedComments: [] });

    const generateCall = vi.mocked(hanaFetch).mock.calls.find(
      (call) => call[0] === '/api/xingye/phone-generate',
    );
    expect(generateCall).toBeDefined();
    const bodyStr = String(generateCall?.[1]?.body ?? '');
    const body = JSON.parse(bodyStr) as { kind?: string; prompt?: string };
    expect(body.kind).toBe('moments');
    expect(body.prompt).toContain('朋友圈');
    expect(body.prompt).toContain('第一人称');
    // Graceful degradation markers when context is missing
    expect(body.prompt).toContain('（无）');
  });

  it('passes virtual_contact pool from contacts store + peerAgents into prompt and resolves seed actors', async () => {
    vi.mocked(getConfirmedVirtualContacts).mockReturnValue([
      {
        ownerAgentId: 'linwu',
        id: 'vc-1',
        displayName: '北门旧巷',
        kind: 'friend',
        createdAt: '2026-05-11T00:00:00.000Z',
        updatedAt: '2026-05-11T00:00:00.000Z',
      },
    ] as never);
    vi.mocked(hanaFetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        result: {
          content: '萍水相逢',
          likes: [{ ref: 'vc:vc-1' }, { ref: 'agent:hanako' }],
          comments: [{ ref: 'vc:vc-1', body: '保重' }],
        },
      }),
    } as Response);

    const agent = { id: 'linwu', name: '林雾', yuan: 'y' as const };
    const result = await generateXingyeMomentDraftWithAI({
      agent: agent as never,
      ownerProfile: null,
      peerAgents: [{ id: 'hanako', displayName: 'Hanako' }],
    });

    expect(result.content).toBe('萍水相逢');
    expect(result.seedLikes.map((l) => `${l.actorType}:${l.actorId}`)).toEqual([
      'virtual_contact:linwu:vc-1',
      'agent:hanako',
    ]);
    expect(result.seedComments).toEqual([
      {
        actorType: 'virtual_contact',
        actorId: 'linwu:vc-1',
        actorName: '北门旧巷',
        body: '保重',
      },
    ]);

    // Prompt must include both pools with refs the model can echo back
    const generateCall = vi.mocked(hanaFetch).mock.calls.find(
      (call) => call[0] === '/api/xingye/phone-generate',
    );
    const prompt = JSON.parse(String(generateCall?.[1]?.body ?? '{}')).prompt as string;
    expect(prompt).toContain('vc:vc-1');
    expect(prompt).toContain('agent:hanako');
  });

  it('uses phone contacts UI display name (meta.remark > contact.displayName) for virtual_contact actorName', async () => {
    // 还原 user 截图里的现象：contact.displayName = "便利店夜班同事"（LLM 起的全称），
    // 用户在通讯录里把 remark 改成"夜班搭子"。朋友圈写入的 actorName 必须是后者。
    vi.mocked(getConfirmedVirtualContacts).mockReturnValue([
      {
        ownerAgentId: 'hanako',
        id: 'vc-night',
        displayName: '便利店夜班同事', // 原始
        kind: 'coworker',
        createdAt: '2026-05-11T00:00:00.000Z',
        updatedAt: '2026-05-11T00:00:00.000Z',
      },
    ] as never);
    vi.mocked(resolveContactDisplayName).mockImplementation(
      (_ownerAgentId: string, _targetType: unknown, targetId: string) =>
        targetId === 'vc-night' ? '夜班搭子' : '虚拟联系人', // remark 优先
    );
    vi.mocked(hanaFetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        result: {
          content: '凌晨三点的便利店',
          comments: [{ ref: 'vc:vc-night', body: '又轮到你守夜？' }],
        },
      }),
    } as Response);

    const agent = { id: 'hanako', name: 'Hanako', yuan: 'y' as const };
    const result = await generateXingyeMomentDraftWithAI({
      agent: agent as never,
      ownerProfile: null,
    });
    expect(result.seedComments).toEqual([
      {
        actorType: 'virtual_contact',
        actorId: 'hanako:vc-night',
        actorName: '夜班搭子', // ← 通讯录显示名，不是原始 displayName
        body: '又轮到你守夜？',
      },
    ]);

    // 同时确认 prompt 池里发给模型的 displayName 也是通讯录显示名
    const generateCall = vi.mocked(hanaFetch).mock.calls.find(
      (call) => call[0] === '/api/xingye/phone-generate',
    );
    const prompt = JSON.parse(String(generateCall?.[1]?.body ?? '{}')).prompt as string;
    expect(prompt).toContain('夜班搭子');
    expect(prompt).not.toContain('便利店夜班同事');
  });

  it('does not throw when getConfirmedVirtualContacts itself throws (graceful degradation)', async () => {
    vi.mocked(getConfirmedVirtualContacts).mockImplementation(() => {
      throw new Error('contacts store unavailable');
    });
    const agent = { id: 'linwu', name: '林雾', yuan: 'y' as const };
    await expect(
      generateXingyeMomentDraftWithAI({ agent: agent as never, ownerProfile: null }),
    ).resolves.toEqual({ content: '今天天有点低', seedLikes: [], seedComments: [] });
  });

  it('throws when server returns error envelope', async () => {
    vi.mocked(hanaFetch).mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: 'rate limit' }),
    } as Response);
    const agent = { id: 'agent-m', name: 'Hanako', yuan: 'y' as const };
    await expect(
      generateXingyeMomentDraftWithAI({ agent: agent as never, ownerProfile: null }),
    ).rejects.toThrow(/rate limit/);
  });

  it('throws when model returns no content', async () => {
    vi.mocked(hanaFetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, result: {} }),
    } as Response);
    const agent = { id: 'agent-m', name: 'Hanako', yuan: 'y' as const };
    await expect(
      generateXingyeMomentDraftWithAI({ agent: agent as never, ownerProfile: null }),
    ).rejects.toThrow(/模型返回无效/);
  });

  describe('interactions-only mode (existingContent non-empty)', () => {
    it('switches the prompt to interactions-only mode and includes the existing content verbatim', async () => {
      vi.mocked(getConfirmedVirtualContacts).mockReturnValue([
        {
          ownerAgentId: 'linwu',
          id: 'vc-night',
          displayName: '夜班搭子',
          kind: 'coworker',
          createdAt: '2026-05-11T00:00:00.000Z',
          updatedAt: '2026-05-11T00:00:00.000Z',
        },
      ] as never);
      const agent = { id: 'linwu', name: '林雾', yuan: 'y' as const };
      await generateXingyeMomentDraftWithAI({
        agent: agent as never,
        ownerProfile: null,
        peerAgents: [{ id: 'hanako', displayName: 'Hanako' }],
        existingContent: '海风把灯影吹得有点歪。',
      });
      const generateCall = vi.mocked(hanaFetch).mock.calls.find(
        (call) => call[0] === '/api/xingye/phone-generate',
      );
      const prompt = JSON.parse(String(generateCall?.[1]?.body ?? '{}')).prompt as string;
      /** Interactions-only header marker (and NOT the regular writing-identity instructions). */
      expect(prompt).toContain('围观互动生成器');
      expect(prompt).toContain('你的任务**不是**写 content');
      expect(prompt).not.toContain('写作身份：以当前角色身份发一条朋友圈短动态');
      /** The existing content is embedded in the prompt for the model to react to. */
      expect(prompt).toContain('海风把灯影吹得有点歪。');
      expect(prompt).toContain('【用户已写好的正文（content；必须一字不改）】');
      /** Likes/comments rules remain — that's the whole point of the call. */
      expect(prompt).toMatch(/必须.*至少 2 条 likes/);
    });

    it('verbatim-overwrites returned content with existingContent (defends against model drift)', async () => {
      vi.mocked(hanaFetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          result: {
            /** Model misbehaves and rewrites content despite the prompt. */
            content: '模型擅自改写的正文',
            likes: [],
            comments: [],
          },
        }),
      } as Response);
      const agent = { id: 'agent-m', name: 'Hanako', yuan: 'y' as const };
      const result = await generateXingyeMomentDraftWithAI({
        agent: agent as never,
        ownerProfile: null,
        existingContent: '用户原话保留不动。',
      });
      expect(result.content).toBe('用户原话保留不动。');
    });

    it('synthesizes empty interactions when model omits content entirely in interactions-only mode', async () => {
      vi.mocked(hanaFetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, result: {} }),
      } as Response);
      const agent = { id: 'agent-m', name: 'Hanako', yuan: 'y' as const };
      const result = await generateXingyeMomentDraftWithAI({
        agent: agent as never,
        ownerProfile: null,
        existingContent: '内容是用户写的。',
      });
      /** Even with the model returning {}, user content is preserved and we return empty seeds. */
      expect(result).toEqual({
        content: '内容是用户写的。',
        seedLikes: [],
        seedComments: [],
      });
    });

    it('blank/whitespace existingContent does NOT trigger interactions-only mode', async () => {
      const agent = { id: 'agent-m', name: 'Hanako', yuan: 'y' as const };
      await generateXingyeMomentDraftWithAI({
        agent: agent as never,
        ownerProfile: null,
        existingContent: '   ',
      });
      const generateCall = vi.mocked(hanaFetch).mock.calls.find(
        (call) => call[0] === '/api/xingye/phone-generate',
      );
      const prompt = JSON.parse(String(generateCall?.[1]?.body ?? '{}')).prompt as string;
      expect(prompt).not.toContain('围观互动生成器');
      expect(prompt).toContain('写作身份：以当前角色身份发一条朋友圈短动态');
    });
  });

  /**
   * 内容级去重叠加在 actor 级去重之上：
   *   - actor 级去重在 normalizePost / dedupeLikes 里管「谁互动」；
   *   - 这里测内容级——anchor block 进 prompt + duplicateOfExisting 旁路提示。
   *
   * 注意：anchor 拉的是 `listXingyeMomentPosts(agent.id)`，因此 agent 切换天然按 author 隔离；
   * 这里集中验证 (1) 无历史→占位、(2) 有历史→进 prompt、(3) 命中重复→duplicateOfExisting 被填。
   */
  describe('content-level dedup (anchor + duplicateOfExisting)', () => {
    it('无历史时 prompt 用占位「这是 TA 的第一条朋友圈」，结果无 duplicateOfExisting', async () => {
      vi.mocked(listXingyeMomentPosts).mockResolvedValue([]);
      const agent = { id: 'agent-m', name: 'Hanako', yuan: 'y' as const };
      const result = await generateXingyeMomentDraftWithAI({
        agent: agent as never,
        ownerProfile: null,
      });
      const generateCall = vi.mocked(hanaFetch).mock.calls.find(
        (call) => call[0] === '/api/xingye/phone-generate',
      );
      const prompt = JSON.parse(String(generateCall?.[1]?.body ?? '{}')).prompt as string;
      expect(prompt).toContain('跨条朋友圈反重复锚点');
      expect(prompt).toContain('这是 TA 的第一条朋友圈');
      expect(result.duplicateOfExisting).toBeUndefined();
    });

    it('有历史时 anchor 进 prompt（开头样本 + 日期 + 作者），生成内容不撞 → 无 duplicateOfExisting', async () => {
      vi.mocked(listXingyeMomentPosts).mockResolvedValue([
        {
          id: 'p1',
          authorAgentId: 'hanako',
          authorName: 'Hanako',
          content: '凌晨三点的便利店，泡面味混着冷气。',
          imageUrls: [],
          createdAt: '2026-05-25T03:14:00.000Z',
          updatedAt: '2026-05-25T03:14:00.000Z',
          likes: [],
          comments: [],
        },
      ]);
      // 模型返回的新正文跟历史毫不相关 → 不应当被判重
      vi.mocked(hanaFetch).mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, result: { content: '今天天气真好，海风温柔。' } }),
      } as Response);
      const agent = { id: 'hanako', name: 'Hanako', yuan: 'y' as const };
      const result = await generateXingyeMomentDraftWithAI({
        agent: agent as never,
        ownerProfile: null,
      });
      const generateCall = vi.mocked(hanaFetch).mock.calls.find(
        (call) => call[0] === '/api/xingye/phone-generate',
      );
      const prompt = JSON.parse(String(generateCall?.[1]?.body ?? '{}')).prompt as string;
      // anchor 真的灌进了 prompt（开头第一句 + 日期 + 作者名）
      expect(prompt).toContain('近期朋友圈开头样本');
      expect(prompt).toContain('凌晨三点的便利店');
      expect(prompt).toContain('Hanako');
      expect(prompt).toContain('2026-05-25');
      // 内容不撞 → 不应当旁路命中
      expect(result.content).toBe('今天天气真好，海风温柔。');
      expect(result.duplicateOfExisting).toBeUndefined();
    });

    it('生成内容与历史同 author 高度相似 → duplicateOfExisting 被填，但 content / seeds 不变', async () => {
      const existingPost = {
        id: 'p1',
        authorAgentId: 'hanako',
        authorName: 'Hanako',
        content: '凌晨三点的便利店，泡面味混着冷气，店员在收银台后面打瞌睡。',
        imageUrls: [],
        createdAt: '2026-05-25T03:14:00.000Z',
        updatedAt: '2026-05-25T03:14:00.000Z',
        likes: [],
        comments: [],
      };
      vi.mocked(listXingyeMomentPosts).mockResolvedValue([existingPost]);
      // 模型「不听话」：anchor 已经告诉它别复读，它还是写了主题几乎一模一样的正文。
      // 内容级硬过滤兜底——填充 duplicateOfExisting 让 UI 决定怎么处理。
      vi.mocked(hanaFetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          result: {
            content: '凌晨三点的便利店，泡面味混着冷气，店员在收银台后面打瞌睡呢。',
          },
        }),
      } as Response);
      const agent = { id: 'hanako', name: 'Hanako', yuan: 'y' as const };
      const result = await generateXingyeMomentDraftWithAI({
        agent: agent as never,
        ownerProfile: null,
      });
      expect(result.duplicateOfExisting).toBeDefined();
      expect(result.duplicateOfExisting?.postId).toBe('p1');
      expect(result.duplicateOfExisting?.authorName).toBe('Hanako');
      expect(result.duplicateOfExisting?.createdAt).toBe('2026-05-25T03:14:00.000Z');
      expect(result.duplicateOfExisting?.score).toBeGreaterThanOrEqual(0.75);
      expect(result.duplicateOfExisting?.contentExcerpt).toContain('凌晨三点的便利店');
      // 旁路提示不应当篡改正文 / 互动 —— 旁路就是「让 UI 决定」，不替 UI 决定。
      expect(result.content).toContain('凌晨三点的便利店');
      expect(result.seedLikes).toEqual([]);
      expect(result.seedComments).toEqual([]);
    });

    it('生成内容主题与历史完全不同 → 无 duplicateOfExisting（不要假阳性）', async () => {
      vi.mocked(listXingyeMomentPosts).mockResolvedValue([
        {
          id: 'p1',
          authorAgentId: 'hanako',
          authorName: 'Hanako',
          content: '凌晨三点的便利店，泡面味混着冷气。',
          imageUrls: [],
          createdAt: '2026-05-25T03:14:00.000Z',
          updatedAt: '2026-05-25T03:14:00.000Z',
          likes: [],
          comments: [],
        },
      ]);
      vi.mocked(hanaFetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          result: { content: '今天去爬山了，山顶云海特别美。' },
        }),
      } as Response);
      const agent = { id: 'hanako', name: 'Hanako', yuan: 'y' as const };
      const result = await generateXingyeMomentDraftWithAI({
        agent: agent as never,
        ownerProfile: null,
      });
      expect(result.duplicateOfExisting).toBeUndefined();
    });

    it('listXingyeMomentPosts 抛错时优雅降级：anchor 走占位，主流程不抛、不带 duplicateOfExisting', async () => {
      vi.mocked(listXingyeMomentPosts).mockRejectedValue(new Error('posts.jsonl unreadable'));
      const agent = { id: 'hanako', name: 'Hanako', yuan: 'y' as const };
      const result = await generateXingyeMomentDraftWithAI({
        agent: agent as never,
        ownerProfile: null,
      });
      const generateCall = vi.mocked(hanaFetch).mock.calls.find(
        (call) => call[0] === '/api/xingye/phone-generate',
      );
      const prompt = JSON.parse(String(generateCall?.[1]?.body ?? '{}')).prompt as string;
      // 读取失败 → 占位字符串仍出现，prompt 不残缺
      expect(prompt).toContain('这是 TA 的第一条朋友圈');
      expect(result.content).toBe('今天天有点低'); // beforeEach 的默认返回
      expect(result.duplicateOfExisting).toBeUndefined();
    });
  });
});
