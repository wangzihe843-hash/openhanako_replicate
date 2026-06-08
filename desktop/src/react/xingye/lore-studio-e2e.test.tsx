/**
 * @vitest-environment jsdom
 *
 * 端到端（mock）：把整条「角色设定工坊」链路跑通——
 *   Phase 1：粘贴背景 → 提问 → 选项作答 → plan → 确认即存（lore 入库 + 人设落盘 + 黑化初始化）
 *   Phase 2：peer 升级建议 → 一键生成（复制世界观 / 源侧富化既有关系条目 / 新侧模板 / 播种关系 / 种 peerContext / 跳转）
 *   跳转落地：新角色工坊自动展开 → peer 微调（首轮带 peerContext + 已带来正文 → 确认更新世界观/关系）
 *
 * 用一套连贯的 mock：turn 队列 + 建 agent + 内存版 xingye-storage（profile.json / session.json）。
 * lore 与关系状态走 localStorage（dev-local 模式）。
 */
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../types';
import { useStore } from '../stores';
import { hanaFetch } from '../hooks/use-hana-fetch';
import { RoleDetailPanel } from './RoleDetailPanel';
import { listLoreEntries } from './xingye-lore-store';
import { getRelationshipState } from './xingye-state-store';

vi.mock('../hooks/use-hana-fetch', () => ({ hanaUrl: (p: string) => p, hanaFetch: vi.fn() }));
vi.mock('../settings/actions', () => ({
  loadAgents: vi.fn(async () => undefined),
  browseAgent: vi.fn(async () => undefined),
}));

const e2e = vi.hoisted(() => ({ turns: [] as unknown[], store: new Map<string, unknown>() }));

const sourceAgent: Agent = { id: 'agent-1', name: '林雾', yuan: 'hanako', isPrimary: true };
const newAgent: Agent = { id: 'agent-2', name: '寒鸦', yuan: 'hanako', isPrimary: false };

const hanaImpl = async (path: string, init?: RequestInit): Promise<Response> => {
  if (path === '/api/xingye/lore-studio/turn') {
    return { ok: true, json: async () => ({ ok: true, turn: e2e.turns.shift(), modelTier: 'utility' }) } as Response;
  }
  if (path === '/api/agents' && init?.method === 'POST') {
    return { ok: true, json: async () => ({ ok: true, id: 'agent-2', name: '寒鸦' }) } as Response;
  }
  if (path === '/api/xingye/storage') {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const key = `${body.agentId}:${body.relativePath}`;
    if (body.action === 'readJson') {
      return { ok: true, json: async () => ({ data: e2e.store.get(key) ?? null }) } as Response;
    }
    if (body.action === 'writeJson') {
      e2e.store.set(key, body.data);
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    }
    return { ok: true, json: async () => ({ ok: true }) } as Response;
  }
  // identity/ishiki/config PUT 等
  return { ok: true, json: async () => ({ ok: true }) } as Response;
};

beforeEach(() => {
  (window as unknown as { __XINGYE_PERSISTENCE_DEV_LOCAL__?: boolean }).__XINGYE_PERSISTENCE_DEV_LOCAL__ = true;
  window.localStorage.clear();
  e2e.turns = [];
  e2e.store.clear();
  useStore.setState({ serverPort: '17333', activeServerConnection: null, agents: [sourceAgent] });
  vi.mocked(hanaFetch).mockReset();
  vi.mocked(hanaFetch).mockImplementation(hanaImpl);
});

afterEach(() => {
  delete (window as unknown as { __XINGYE_PERSISTENCE_DEV_LOCAL__?: boolean }).__XINGYE_PERSISTENCE_DEV_LOCAL__;
  cleanup();
  vi.restoreAllMocks();
});

describe('lore-studio 完整链路（mock）', () => {
  it('Phase1 提问→作答→plan→确认即存 → Phase2 建 peer 带世界观/关系→跳转 → 新角色 peer 微调', async () => {
    e2e.turns = [
      // —— Phase 1 第一轮：提问 ——
      {
        type: 'questions',
        intro: '先确认关系。',
        questions: [
          {
            id: 'q1',
            prompt: '林雾与寒鸦是什么关系？',
            category: 'relationship',
            multiSelect: false,
            allowCustom: true,
            options: [{ label: '生死之交' }, { label: '宿敌' }],
          },
        ],
      },
      // —— Phase 1 第二轮：方案 ——
      {
        type: 'plan',
        summary: '整理完成。',
        loreEntries: [
          { title: '北境秩序', content: '北境与林族世代盟约。', category: 'worldview', insertionMode: 'keyword', keywords: ['北境', '林族'] },
          { title: '军师·寒鸦', content: '与你并肩多年的军师，沉默可靠。', category: 'relationship', insertionMode: 'always', keywords: ['寒鸦'] },
        ],
        profilePatch: [{ field: 'behaviorLogic', value: '先观察再行动。' }],
        corruptionTendency: 'latent',
        corruptionSeed: 12, // = latent 基线 → 不弹待确认层
      },
      // —— Phase 2：peer 升级建议 ——
      {
        type: 'peer-suggestions',
        candidates: [{ name: '寒鸦', roleInWorld: '北境军师', whyUpgrade: '常与用户并肩', suggestedRelationshipToCurrent: '生死之交' }],
      },
      // —— 新角色工坊：peer 微调方案 ——
      {
        type: 'plan',
        summary: '微调完成。',
        loreEntries: [
          { title: '北境秩序', content: '（寒鸦视角）北境军政由军师统筹。', category: 'worldview', insertionMode: 'keyword', keywords: ['北境'], isUpdate: true },
          { title: '与「林雾」的关系', content: '林雾是我并肩多年的主君，生死相托。', category: 'relationship', insertionMode: 'always', keywords: ['林雾'], isUpdate: true },
        ],
        profilePatch: [{ field: 'identitySummary', value: '北境军师寒鸦。' }],
      },
    ];

    const onOpenAgentStudio = vi.fn();
    const { rerender } = render(
      <RoleDetailPanel
        key="agent-1"
        agent={sourceAgent}
        isOpenHanakoCurrent={false}
        onBack={vi.fn()}
        onChat={vi.fn()}
        onPhone={vi.fn()}
        onOpenAgentStudio={onOpenAgentStudio}
      />,
    );

    // ============ Phase 1 ============
    await waitFor(() => expect(screen.getByLabelText('星野昵称')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'AI 整理设定' }));
    const intro = await screen.findByPlaceholderText('粘贴完整背景故事…');
    fireEvent.change(intro, { target: { value: '林雾是北境守将，与军师寒鸦并肩多年。' } });
    fireEvent.click(screen.getByRole('button', { name: '开始整理' }));

    // 提问 → 选项作答 → 提交
    fireEvent.click(await screen.findByRole('button', { name: /生死之交/ }));
    fireEvent.click(screen.getByRole('button', { name: '提交回答' }));

    // 方案 → 确认即存
    fireEvent.click(await screen.findByRole('button', { name: /确认写入/ }));

    // lore 入源角色
    await waitFor(() => {
      const titles = listLoreEntries('agent-1').map((e) => e.title);
      expect(titles).toEqual(expect.arrayContaining(['北境秩序', '军师·寒鸦']));
    });
    // 人设直接落库（profile.json）
    await waitFor(() => {
      expect((e2e.store.get('agent-1:profile.json') as { behaviorLogic?: string } | undefined)?.behaviorLogic).toBe('先观察再行动。');
    });
    // 黑化按模型档位初始化进「TA 的状态」（latent 基线 12）
    await waitFor(() => {
      expect(getRelationshipState('agent-1')?.corruption).toBe(12);
    });

    // ============ Phase 2 ============
    const gen = await screen.findByRole('button', { name: /一键生成并跳转/ });
    fireEvent.click(gen);
    await waitFor(() => expect(onOpenAgentStudio).toHaveBeenCalledWith('agent-2'));

    // 新角色：世界观被复制过来
    const onB = listLoreEntries('agent-2');
    expect(onB.some((e) => e.category === 'worldview' && e.title === '北境秩序')).toBe(true);
    // 新角色侧 peer 关系（与源角色，模板脚手架）
    expect(onB.some((e) => e.category === 'relationship' && e.title.includes('林雾'))).toBe(true);
    // 源角色侧：Phase 1 的「军师·寒鸦」被追加 peer 链接，而不是新增空模板
    const aRel = listLoreEntries('agent-1').filter((e) => e.title === '军师·寒鸦');
    expect(aRel).toHaveLength(1);
    expect(aRel[0].content).toContain('与你并肩多年的军师'); // 原内容保留
    expect(aRel[0].content).toContain('现在是独立角色'); // 追加链接
    expect(aRel[0].content).toContain('agent-2'); // 对方 agent id（供 dm）
    expect(listLoreEntries('agent-1').some((e) => e.title === '与「寒鸦」的关系')).toBe(false); // 没新增空模板
    // 新角色↔用户关系数值已播种
    expect(getRelationshipState('agent-2')).toBeTruthy();
    // 新角色 session 种了 peerContext（供跳转后微调）
    expect((e2e.store.get('agent-2:lore-studio/session.json') as { peerContext?: { sourceAgentId?: string; sourceName?: string } } | undefined)?.peerContext).toEqual({
      sourceAgentId: 'agent-1',
      sourceName: '林雾',
    });

    // ============ 跳转落地：新角色工坊 peer 微调 ============
    useStore.setState({ agents: [sourceAgent, newAgent] });
    rerender(
      <RoleDetailPanel
        key="agent-2"
        agent={newAgent}
        isOpenHanakoCurrent={false}
        onBack={vi.fn()}
        onChat={vi.fn()}
        onPhone={vi.fn()}
        onOpenAgentStudio={onOpenAgentStudio}
        autoOpenStudioFor="agent-2"
        onAutoOpenStudioConsumed={vi.fn()}
      />,
    );

    // 工坊自动展开 + peer 感知提示
    expect(await screen.findByText(/刚从「林雾」分出来/)).toBeInTheDocument();
    const intro2 = await screen.findByPlaceholderText('粘贴完整背景故事…');
    fireEvent.change(intro2, { target: { value: '寒鸦自幼习武，效忠林雾，沉默寡言。' } });
    fireEvent.click(screen.getByRole('button', { name: '开始整理' }));

    // 首轮请求带 peerContext + 已带来条目的正文
    await waitFor(() => {
      const calls = vi.mocked(hanaFetch).mock.calls.filter((c) => c[0] === '/api/xingye/lore-studio/turn');
      const last = calls[calls.length - 1];
      expect(last).toBeTruthy();
      const body = JSON.parse(String((last![1] as RequestInit).body)) as {
        peerContext?: { sourceName?: string };
        fineTuneEntries?: { title: string }[];
      };
      expect(body.peerContext?.sourceName).toBe('林雾');
      expect(body.fineTuneEntries?.some((e) => e.title === '北境秩序')).toBe(true);
    });

    // 微调方案 → 确认 → 世界观「北境秩序」被 update（仍一条，内容更新），不新增
    fireEvent.click(await screen.findByRole('button', { name: /确认写入/ }));
    await waitFor(() => {
      const wv = listLoreEntries('agent-2').filter((e) => e.title === '北境秩序');
      expect(wv).toHaveLength(1);
      expect(wv[0].content).toContain('军政由军师统筹');
    });
    // 与「林雾」的关系条目被填成真内容
    const bRel = listLoreEntries('agent-2').filter((e) => e.title === '与「林雾」的关系');
    expect(bRel).toHaveLength(1);
    expect(bRel[0].content).toContain('生死相托');
  });
});
