/**
 * @vitest-environment jsdom
 */

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../types';
import { useStore } from '../stores';
import { hanaFetch } from '../hooks/use-hana-fetch';
import { LoreStudioDrawer } from './LoreStudioDrawer';
import { XINGYE_LORE_ENTRIES_STORAGE_KEY } from './xingye-lore-store';

const turnHoisted = vi.hoisted(() => ({ queue: [] as unknown[] }));

vi.mock('../hooks/use-hana-fetch', () => ({
  hanaUrl: (path: string) => path,
  hanaFetch: vi.fn(),
}));

vi.mock('../settings/actions', () => ({
  loadAgents: vi.fn(async () => undefined),
}));

const agent: Agent = { id: 'agent-1', name: '林雾', yuan: 'hanako', isPrimary: true };

// 默认实现：turn → 从队列取一轮；其余(storage 等) → ok。各用例可自行 mockImplementation 覆盖。
const defaultHanaImpl = async (path: string): Promise<Response> => {
  if (path === '/api/xingye/lore-studio/turn') {
    const turn = turnHoisted.queue.shift();
    return { ok: true, json: async () => ({ ok: true, turn, modelTier: 'utility' }) } as Response;
  }
  return { ok: true, json: async () => ({ ok: true }) } as Response;
};

beforeEach(() => {
  (window as unknown as { __XINGYE_PERSISTENCE_DEV_LOCAL__?: boolean }).__XINGYE_PERSISTENCE_DEV_LOCAL__ = true;
  window.localStorage.clear();
  turnHoisted.queue = [];
  useStore.setState({ serverPort: '17333', activeServerConnection: null });
  // 每个用例从干净的默认实现开始，避免上一个用例 mockImplementation 泄漏。
  vi.mocked(hanaFetch).mockReset();
  vi.mocked(hanaFetch).mockImplementation(defaultHanaImpl);
});

afterEach(() => {
  delete (window as unknown as { __XINGYE_PERSISTENCE_DEV_LOCAL__?: boolean }).__XINGYE_PERSISTENCE_DEV_LOCAL__;
  cleanup();
  vi.restoreAllMocks();
});

function renderDrawer(onApplied = vi.fn()) {
  render(
    <LoreStudioDrawer
      agent={agent}
      open
      onClose={vi.fn()}
      displayName="林雾"
      relationshipLabel="朋友"
      shortBio=""
      existingProfile={{}}
      onApplied={onApplied}
    />,
  );
  return onApplied;
}

describe('LoreStudioDrawer', () => {
  it('提问 → 选项作答 → 方案 → 确认写入：lore 入库且回调带补丁', async () => {
    turnHoisted.queue = [
      {
        type: 'questions',
        intro: '先确认一下世界观。',
        questions: [
          {
            id: 'q1',
            prompt: '两个族群之间通常如何相处？',
            category: 'worldview',
            multiSelect: false,
            allowCustom: true,
            options: [
              { label: '世代结盟', detail: '彼此通婚' },
              { label: '长期敌对' },
            ],
          },
        ],
      },
      {
        type: 'plan',
        summary: '整理出 1 条世界观与 1 处人设。',
        loreEntries: [
          { title: '两族结盟', content: '北境与林族世代通婚结盟。', category: 'worldview', insertionMode: 'keyword', keywords: ['北境', '林族'] },
        ],
        profilePatch: [{ field: 'behaviorLogic', value: '优先维护族盟。', rationale: '出身使然' }],
      },
    ];

    const onApplied = renderDrawer();

    // intro → 开始整理 → 出现提问
    const intro = await screen.findByPlaceholderText('粘贴完整背景故事…');
    fireEvent.change(intro, { target: { value: '一段背景故事。' } });
    fireEvent.click(screen.getByRole('button', { name: '开始整理' }));

    const option = await screen.findByRole('button', { name: /世代结盟/ });
    fireEvent.click(option);
    fireEvent.click(screen.getByRole('button', { name: '提交回答' }));

    // 方案就绪 → 确认写入
    const confirmBtn = await screen.findByRole('button', { name: /确认写入/ });
    expect(screen.getAllByText('整理出 1 条世界观与 1 处人设。').length).toBeGreaterThan(0);
    fireEvent.click(confirmBtn);

    // lore 入库
    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem(XINGYE_LORE_ENTRIES_STORAGE_KEY) ?? '{}') as Record<string, { title: string; insertionMode: string }>;
      const entry = Object.values(stored).find((e) => e.title === '两族结盟');
      expect(entry).toBeTruthy();
      expect(entry?.insertionMode).toBe('keyword');
    });

    // 回调把人设补丁带回（corruption 未给 → 不带档位）
    expect(onApplied).toHaveBeenCalledTimes(1);
    const arg = onApplied.mock.calls[0][0];
    expect(arg.loreCreated).toBe(1);
    expect(arg.profilePatch).toEqual({ behaviorLogic: '优先维护族盟。' });
    expect(arg.corruptionTendency).toBeUndefined();
  });

  it('Phase 2：确认写入后建议升级关系 → 一键生成并带过去世界观/关系 → 跳转', async () => {
    vi.mocked(hanaFetch).mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/xingye/lore-studio/turn') {
        const turn = turnHoisted.queue.shift();
        return { ok: true, json: async () => ({ ok: true, turn, modelTier: 'utility' }) } as Response;
      }
      if (path === '/api/agents' && init?.method === 'POST') {
        return { ok: true, json: async () => ({ ok: true, id: 'agent-2', name: '寒鸦' }) } as Response;
      }
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    });

    turnHoisted.queue = [
      {
        type: 'plan',
        loreEntries: [
          { title: '军师·寒鸦', content: '与你并肩多年的北境军师。', category: 'relationship', insertionMode: 'always', keywords: ['寒鸦'] },
          { title: '北境秩序', content: '两族世代盟约。', category: 'worldview', insertionMode: 'keyword', keywords: ['北境'] },
        ],
      },
      {
        type: 'peer-suggestions',
        candidates: [{ name: '寒鸦', roleInWorld: '北境军师', whyUpgrade: '戏份重', suggestedRelationshipToCurrent: '生死之交' }],
      },
    ];

    const onJump = vi.fn();
    render(
      <LoreStudioDrawer
        agent={agent}
        open
        onClose={vi.fn()}
        displayName="林雾"
        relationshipLabel=""
        shortBio=""
        existingProfile={{}}
        onApplied={vi.fn()}
        agents={[{ id: 'agent-1', name: '林雾' }]}
        userName="阿白"
        onJumpToAgent={onJump}
      />,
    );

    const intro = await screen.findByPlaceholderText('粘贴完整背景故事…');
    fireEvent.change(intro, { target: { value: '故事。' } });
    fireEvent.click(screen.getByRole('button', { name: '开始整理' }));

    const confirmBtn = await screen.findByRole('button', { name: /确认写入/ });
    fireEvent.click(confirmBtn);

    // peer 升级建议出现
    const genBtn = await screen.findByRole('button', { name: /一键生成并跳转/ });
    expect(screen.getAllByText(/北境军师/).length).toBeGreaterThan(0);
    fireEvent.click(genBtn);

    // 跳转到新角色
    await waitFor(() => expect(onJump).toHaveBeenCalledWith('agent-2'));

    // 新角色被带过去：世界观 + 「与「林雾」的关系」
    const stored = JSON.parse(window.localStorage.getItem(XINGYE_LORE_ENTRIES_STORAGE_KEY) ?? '{}') as Record<
      string,
      { agentId: string; title: string; category: string }
    >;
    const newAgentLore = Object.values(stored).filter((e) => e.agentId === 'agent-2');
    expect(newAgentLore.some((e) => e.title.includes('林雾') && e.category === 'relationship')).toBe(true);
    expect(newAgentLore.some((e) => e.category === 'worldview')).toBe(true);
  });

  it('peer 微调：带 peerContext 的会话首轮把已带来的世界观/关系正文喂给模型', async () => {
    // 预置：agent-1 已带来一条世界观（模拟从源角色复制过来）
    window.localStorage.setItem(
      XINGYE_LORE_ENTRIES_STORAGE_KEY,
      JSON.stringify({
        w1: {
          id: 'w1',
          agentId: 'agent-1',
          title: '两族秩序',
          content: '北境与林族世代盟约。',
          category: 'worldview',
          keywords: ['北境'],
          enabled: true,
          priority: 50,
          insertionMode: 'keyword',
          visibility: 'canonical',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      }),
    );
    vi.mocked(hanaFetch).mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/xingye/lore-studio/turn') {
        return { ok: true, json: async () => ({ ok: true, turn: { type: 'message', text: '收到' }, modelTier: 'utility' }) } as Response;
      }
      if (path === '/api/xingye/storage') {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        if (body.action === 'readJson' && body.relativePath === 'lore-studio/session.json') {
          return {
            ok: true,
            json: async () => ({
              data: {
                version: 1,
                agentId: 'agent-1',
                backgroundStory: '',
                phase: 'intro',
                messages: [],
                peerContext: { sourceAgentId: 'agent-0', sourceName: '老张' },
                updatedAt: '2026-01-01T00:00:00.000Z',
              },
            }),
          } as Response;
        }
        return { ok: true, json: async () => ({ ok: true }) } as Response;
      }
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    });

    renderDrawer();

    // peer 提示出现 + 粘贴新背景 + 开始整理
    expect(await screen.findByText(/刚从「老张」分出来/)).toBeInTheDocument();
    const intro = await screen.findByPlaceholderText('粘贴完整背景故事…');
    fireEvent.change(intro, { target: { value: '新角色的完整背景。' } });
    fireEvent.click(screen.getByRole('button', { name: '开始整理' }));

    // 首轮请求带 peerContext + 已带来条目的正文
    await waitFor(() => {
      expect(vi.mocked(hanaFetch).mock.calls.some((c) => c[0] === '/api/xingye/lore-studio/turn')).toBe(true);
    });
    const turnCall = vi.mocked(hanaFetch).mock.calls.find((c) => c[0] === '/api/xingye/lore-studio/turn')!;
    const reqBody = JSON.parse(String((turnCall[1] as RequestInit).body)) as {
      peerContext?: { sourceName?: string };
      fineTuneEntries?: { title: string; content: string }[];
    };
    expect(reqBody.peerContext).toEqual({ sourceAgentId: 'agent-0', sourceName: '老张' });
    expect(reqBody.fineTuneEntries?.some((e) => e.title === '两族秩序' && e.content.includes('世代盟约'))).toBe(true);
  });

  it('不确定时先提问：渲染选项与自定义输入框', async () => {
    turnHoisted.queue = [
      {
        type: 'questions',
        questions: [
          {
            id: 'q1',
            prompt: '在被欺骗后 TA 会怎么做？',
            category: 'background',
            multiSelect: false,
            allowCustom: true,
            options: [{ label: '冷处理疏远' }, { label: '当面对质' }],
          },
        ],
      },
    ];
    renderDrawer();

    const intro = await screen.findByPlaceholderText('粘贴完整背景故事…');
    fireEvent.change(intro, { target: { value: '故事。' } });
    fireEvent.click(screen.getByRole('button', { name: '开始整理' }));

    expect(await screen.findByText('在被欺骗后 TA 会怎么做？')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /冷处理疏远/ })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('或自定义回答…')).toBeInTheDocument();
    // 没有方案 → 没有确认写入按钮
    expect(screen.queryByRole('button', { name: /确认写入/ })).not.toBeInTheDocument();
  });

  it('keyword 模式但没关键词的方案条目 → 渲染警告', async () => {
    turnHoisted.queue = [
      {
        type: 'plan',
        summary: '一条没关键词的世界观。',
        loreEntries: [
          { title: '北境秩序', content: '两族世代盟约。', category: 'worldview', insertionMode: 'keyword', keywords: [] },
        ],
      },
    ];
    renderDrawer();

    const intro = await screen.findByPlaceholderText('粘贴完整背景故事…');
    fireEvent.change(intro, { target: { value: '故事。' } });
    fireEvent.click(screen.getByRole('button', { name: '开始整理' }));

    // 方案渲染后，keyword 条目空关键词 → 出现「永远不会被注入」的警告
    expect(await screen.findByText(/keyword 模式需要关键词/)).toBeInTheDocument();
  });
});
