/**
 * @vitest-environment jsdom
 */

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../types';
import { useStore } from '../stores';
import { RoleDetailPanel } from './RoleDetailPanel';
import { XINGYE_LORE_ENTRIES_STORAGE_KEY } from './xingye-lore-store';
import { getRelationshipState, saveRelationshipState } from './xingye-state-store';

const profileHoisted = vi.hoisted(() => ({
  profileByAgent: new Map<string, Record<string, unknown>>(),
}));

vi.mock('../hooks/use-hana-fetch', () => ({
  hanaUrl: (path: string) => path,
  hanaFetch: vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/xingye/extract-profile') {
      return {
        ok: true,
        json: async () => ({
          profile: {
            shortBio: '边境医生，冷静可靠。',
            identitySummary: '林雾是一名边境医生，长期在动荡地区救治伤患。',
            backgroundSummary: '幼年经历过战乱，因此不轻易信任他人。',
            personalitySummary: '外冷内热，克制可靠，重视承诺。',
            behaviorLogic: '先判断问题本质，再给出务实建议。',
            values: '重视承诺、事实和保护弱者。',
            taboos: '不喜欢空洞安慰，也不会轻易卖惨。',
            relationshipMode: '与用户是朋友关系，亲近但保持边界。',
            speakingStyle: '冷静、直接、少废话，但不是冷漠。',
          },
        }),
      } as Response;
    }
    if (path === '/api/xingye/storage') {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const aid = String(body.agentId ?? '');
      if (body.action === 'readJson' && body.relativePath === 'profile.json') {
        const data = profileHoisted.profileByAgent.get(aid) ?? null;
        return { ok: true, json: async () => ({ data }) } as Response;
      }
      if (body.action === 'writeJson' && body.relativePath === 'profile.json') {
        profileHoisted.profileByAgent.set(aid, body.data as Record<string, unknown>);
        return { ok: true, json: async () => ({ ok: true }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    }
    return {
      ok: true,
      json: async () => ({ ok: true }),
    } as Response;
  }),
}));

const { hanaFetch } = await import('../hooks/use-hana-fetch');

describe('RoleDetailPanel OpenHanako sync', () => {
  const agent: Agent = {
    id: 'agent-1',
    name: 'Hanako',
    yuan: 'hanako',
    isPrimary: true,
    hasAvatar: true,
  };

  beforeEach(() => {
    (window as unknown as { __XINGYE_PERSISTENCE_DEV_LOCAL__?: boolean }).__XINGYE_PERSISTENCE_DEV_LOCAL__ = true;
    window.localStorage.clear();
    profileHoisted.profileByAgent.clear();
    vi.mocked(hanaFetch).mockClear();
    useStore.setState({ serverPort: '17333', activeServerConnection: null });
  });

  afterEach(() => {
    delete (window as unknown as { __XINGYE_PERSISTENCE_DEV_LOCAL__?: boolean }).__XINGYE_PERSISTENCE_DEV_LOCAL__;
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows a sync preview and saves text persona fields through OpenHanako agent APIs', async () => {
    render(
      <RoleDetailPanel
        agent={agent}
        isOpenHanakoCurrent={true}
        onBack={vi.fn()}
        onChat={vi.fn()}
        onPhone={vi.fn()}
      />,
    );

    expect(screen.queryByRole('heading', { name: 'TA 当前状态' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '手动刷新状态' })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('星野昵称'), { target: { value: '星野花子' } });
    fireEvent.change(screen.getByLabelText('简介'), { target: { value: '会认真记住用户偏好的搭子。' } });
    fireEvent.change(screen.getByLabelText('关系标签'), { target: { value: '同伴' } });
    fireEvent.change(screen.getByLabelText('说话风格'), { target: { value: '温柔直接，回答简短。' } });

    expect(screen.getByText('OpenHanako 核心人格摘要预览')).toBeTruthy();
    expect(screen.getAllByText(/星野花子/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/温柔直接，回答简短。/).length).toBeGreaterThan(0);

    vi.mocked(hanaFetch).mockClear();
    fireEvent.click(screen.getByRole('button', { name: '更新核心人格摘要' }));

    await waitFor(() => {
      expect(hanaFetch).toHaveBeenCalledTimes(2);
    });
    expect(vi.mocked(hanaFetch).mock.calls.map((c) => c[0])).not.toContain('/api/agents/agent-1/config');
    expect(hanaFetch).toHaveBeenCalledWith('/api/agents/agent-1/identity', expect.objectContaining({
      method: 'PUT',
      body: expect.stringContaining('星野花子'),
    }));
    expect(hanaFetch).toHaveBeenCalledWith('/api/agents/agent-1/ishiki', expect.objectContaining({
      method: 'PUT',
      body: expect.stringContaining('温柔直接，回答简短。'),
    }));
    expect(JSON.stringify(vi.mocked(hanaFetch).mock.calls)).not.toContain('allowAutoMoments');
    expect(JSON.stringify(vi.mocked(hanaFetch).mock.calls)).not.toContain('avatarDataUrl');
  });

  it('optionally PATCHes agent.display name via config when syncing', async () => {
    render(
      <RoleDetailPanel
        agent={agent}
        isOpenHanakoCurrent={true}
        onBack={vi.fn()}
        onChat={vi.fn()}
        onPhone={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('星野昵称'), { target: { value: '星野花子' } });
    fireEvent.change(screen.getByLabelText('简介'), { target: { value: '会认真记住用户偏好的搭子。' } });

    fireEvent.click(screen.getByRole('checkbox', { name: '同步助手名称' }));
    vi.mocked(hanaFetch).mockClear();
    fireEvent.click(screen.getByRole('button', { name: '更新核心人格摘要' }));

    await waitFor(() => {
      expect(hanaFetch).toHaveBeenCalledTimes(3);
    });
    expect(hanaFetch).toHaveBeenCalledWith('/api/agents/agent-1/config', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ agent: { name: '星野花子' } }),
    }));
    expect(hanaFetch).toHaveBeenCalledWith('/api/agents/agent-1/identity', expect.objectContaining({
      method: 'PUT',
    }));
    expect(hanaFetch).toHaveBeenCalledWith('/api/agents/agent-1/ishiki', expect.objectContaining({
      method: 'PUT',
    }));
  });

  it('工坊确认写入：lore 入库、人设回填表单，但不直接保存/同步 agent', async () => {
    mockStudioPlan({
      type: 'plan',
      summary: '',
      loreEntries: [
        { title: '边境医生', content: '林雾长期在边境救治伤患。', category: 'background', insertionMode: 'always', keywords: [] },
      ],
      profilePatch: [
        { field: 'identitySummary', value: '林雾是一名边境医生，长期在动荡地区救治伤患。' },
        { field: 'behaviorLogic', value: '先判断问题本质，再给出务实建议。' },
      ],
    });

    render(
      <RoleDetailPanel
        agent={agent}
        isOpenHanakoCurrent={true}
        onBack={vi.fn()}
        onChat={vi.fn()}
        onPhone={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByLabelText('星野昵称')).toBeInTheDocument();
    });

    const confirmBtn = await openStudioToPlan();
    fireEvent.click(confirmBtn);

    // 人设补丁回填到表单
    await waitFor(() => {
      expect(screen.getByLabelText('身份摘要')).toHaveValue('林雾是一名边境医生，长期在动荡地区救治伤患。');
    });
    expect(screen.getByLabelText('行为逻辑')).toHaveValue('先判断问题本质，再给出务实建议。');

    // lore 已直接入库
    const stored = JSON.parse(window.localStorage.getItem(XINGYE_LORE_ENTRIES_STORAGE_KEY) ?? '{}') as Record<string, { title: string }>;
    expect(Object.values(stored).map((e) => e.title)).toContain('边境医生');

    // 确认即存：人设补丁直接落库（profile.json），但不同步 OpenHanako identity/ishiki
    await waitFor(() => {
      expect(profileHoisted.profileByAgent.get('agent-1')?.identitySummary).toBe('林雾是一名边境医生，长期在动荡地区救治伤患。');
    });
    expect(profileHoisted.profileByAgent.get('agent-1')?.behaviorLogic).toBe('先判断问题本质，再给出务实建议。');
    expect(JSON.stringify(vi.mocked(hanaFetch).mock.calls)).not.toContain('/api/agents/agent-1/identity');
    expect(JSON.stringify(vi.mocked(hanaFetch).mock.calls)).not.toContain('/api/agents/agent-1/ishiki');
  });

  it('阴暗面预设 select：默认「自动判断」，可手动切换（黑化值起点）', () => {
    render(
      <RoleDetailPanel
        agent={agent}
        isOpenHanakoCurrent={false}
        onBack={vi.fn()}
        onChat={vi.fn()}
        onPhone={vi.fn()}
      />,
    );
    const select = screen.getByTestId('xingye-role-corruption-tendency-select') as HTMLSelectElement;
    expect(select.value).toBe(''); // 默认自动判断 → 由本地关键词扫描兜底
    fireEvent.change(select, { target: { value: 'marked' } });
    expect(select.value).toBe('marked');
  });

  // 让工坊一轮直接返回一份 plan（跳过提问），用于驱动「确认写入 → lore 入库 + 人设回填 + 黑化弹层」路径。
  const mockStudioPlan = (turn: Record<string, unknown>) => {
    vi.mocked(hanaFetch).mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/xingye/lore-studio/turn') {
        return { ok: true, json: async () => ({ ok: true, turn, modelTier: 'utility' }) } as Response;
      }
      if (path === '/api/xingye/storage') {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        const aid = String(body.agentId ?? '');
        if (body.action === 'readJson' && body.relativePath === 'profile.json') {
          return { ok: true, json: async () => ({ data: profileHoisted.profileByAgent.get(aid) ?? null }) } as Response;
        }
        if (body.action === 'writeJson' && body.relativePath === 'profile.json') {
          profileHoisted.profileByAgent.set(aid, body.data as Record<string, unknown>);
          return { ok: true, json: async () => ({ ok: true }) } as Response;
        }
        // session.json 读/写等：返回空 → loadStudioSession 视作无会话（全新开始）。
        return { ok: true, json: async () => ({ ok: true }) } as Response;
      }
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    });
  };

  // 打开工坊 → 粘贴背景故事 → 开始整理 → 返回「确认写入」按钮（plan 已就绪）。
  async function openStudioToPlan() {
    fireEvent.click(screen.getByRole('button', { name: 'AI 整理设定' }));
    const intro = await screen.findByPlaceholderText('粘贴完整背景故事…');
    fireEvent.change(intro, { target: { value: '一段背景故事。' } });
    fireEvent.click(screen.getByRole('button', { name: '开始整理' }));
    return screen.findByRole('button', { name: /确认写入/ });
  }

  it('工坊方案含非基线精确黑化值 → 确认写入后弹层确认，采用后覆盖档位并落库', async () => {
    mockStudioPlan({
      type: 'plan',
      loreEntries: [{ title: '青梅', content: '从小一起长大、对你格外上心。', category: 'background', insertionMode: 'always', keywords: [] }],
      profilePatch: [{ field: 'shortBio', value: '占有欲偏重的青梅。' }],
      corruptionTendency: 'latent',
      corruptionSeed: 20,
    });
    render(
      <RoleDetailPanel agent={agent} isOpenHanakoCurrent={false} onBack={vi.fn()} onChat={vi.fn()} onPhone={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByLabelText('星野昵称')).toBeInTheDocument());

    const confirmBtn = await openStudioToPlan();
    fireEvent.click(confirmBtn);

    // 20 ≠ latent 基线 12 → 出现确认弹层，且此刻还没应用精确值
    const confirm = await screen.findByTestId('xingye-corruption-seed-confirm');
    expect(confirm).toHaveTextContent('20');
    expect(confirm).toHaveTextContent('12');
    expect(screen.queryByTestId('xingye-corruption-seed-applied')).not.toBeInTheDocument();

    // 采用 → 弹层消失，显示已应用精确起点 20
    fireEvent.click(screen.getByTestId('xingye-corruption-seed-accept'));
    expect(screen.queryByTestId('xingye-corruption-seed-confirm')).not.toBeInTheDocument();
    expect(screen.getByTestId('xingye-corruption-seed-applied')).toHaveTextContent('20');

    // 保存 → corruptionSeed 进 profile 落库（收紧到主保存键，避开 LoreEditor 的「保存设定条目」）
    fireEvent.click(screen.getByRole('button', { name: /^保存[到（]/ }));
    await waitFor(() => {
      expect(profileHoisted.profileByAgent.get('agent-1')?.corruptionSeed).toBe(20);
    });
  });

  it('工坊方案含非基线精确黑化值 → 选「按档位基线」则不落精确值', async () => {
    mockStudioPlan({
      type: 'plan',
      loreEntries: [{ title: '青梅', content: '青梅竹马。', category: 'background', insertionMode: 'always', keywords: [] }],
      corruptionTendency: 'latent',
      corruptionSeed: 20,
    });
    render(
      <RoleDetailPanel agent={agent} isOpenHanakoCurrent={false} onBack={vi.fn()} onChat={vi.fn()} onPhone={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByLabelText('星野昵称')).toBeInTheDocument());

    const confirmBtn = await openStudioToPlan();
    fireEvent.click(confirmBtn);
    await screen.findByTestId('xingye-corruption-seed-confirm');
    fireEvent.click(screen.getByTestId('xingye-corruption-seed-reject'));

    expect(screen.queryByTestId('xingye-corruption-seed-confirm')).not.toBeInTheDocument();
    expect(screen.queryByTestId('xingye-corruption-seed-applied')).not.toBeInTheDocument();
  });

  it('待确认精确黑化值持久化为草稿：关掉详情页再打开，待确认条仍在（无需重跑工坊）', async () => {
    mockStudioPlan({
      type: 'plan',
      loreEntries: [{ title: '青梅', content: '青梅竹马。', category: 'background', insertionMode: 'always', keywords: [] }],
      corruptionTendency: 'latent',
      corruptionSeed: 20,
    });
    const { unmount } = render(
      <RoleDetailPanel agent={agent} isOpenHanakoCurrent={false} onBack={vi.fn()} onChat={vi.fn()} onPhone={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByLabelText('星野昵称')).toBeInTheDocument());

    const confirmBtn = await openStudioToPlan();
    fireEvent.click(confirmBtn);
    await screen.findByTestId('xingye-corruption-seed-confirm');

    // 草稿（待确认精确值）已落到 profile.json
    await waitFor(() => {
      expect(profileHoisted.profileByAgent.get('agent-1')?.corruptionSeedPending).toBe(20);
    });

    // 关掉详情页（卸载）→ 重新打开（重挂载，不重跑工坊）
    unmount();
    render(
      <RoleDetailPanel agent={agent} isOpenHanakoCurrent={false} onBack={vi.fn()} onChat={vi.fn()} onPhone={vi.fn()} />,
    );

    // 待确认条从持久化草稿恢复（仍是 20 vs 基线 12），不必再跑一遍工坊
    const restored = await screen.findByTestId('xingye-corruption-seed-confirm');
    expect(restored).toHaveTextContent('20');
    expect(restored).toHaveTextContent('12');
  });

  it('工坊方案含基线黑化值（不偏离档位）→ 不弹确认层', async () => {
    mockStudioPlan({
      type: 'plan',
      loreEntries: [{ title: '青梅', content: '青梅竹马。', category: 'background', insertionMode: 'always', keywords: [] }],
      corruptionTendency: 'latent',
      corruptionSeed: 12,
    });
    render(
      <RoleDetailPanel agent={agent} isOpenHanakoCurrent={false} onBack={vi.fn()} onChat={vi.fn()} onPhone={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByLabelText('星野昵称')).toBeInTheDocument());

    const confirmBtn = await openStudioToPlan();
    fireEvent.click(confirmBtn);
    await waitFor(() => {
      expect((screen.getByTestId('xingye-role-corruption-tendency-select') as HTMLSelectElement).value).toBe('latent');
    });
    expect(screen.queryByTestId('xingye-corruption-seed-confirm')).not.toBeInTheDocument();
    expect(screen.queryByTestId('xingye-corruption-seed-applied')).not.toBeInTheDocument();
  });

  it('确认即存：黑化未初始化时，按模型档位一并初始化「TA 的状态」黑化值', async () => {
    mockStudioPlan({
      type: 'plan',
      loreEntries: [{ title: '出身', content: '边境长大。', category: 'background', insertionMode: 'always', keywords: [] }],
      corruptionTendency: 'marked',
      corruptionSeed: 28, // = marked 基线 → 不弹待确认层
    });
    render(
      <RoleDetailPanel agent={agent} isOpenHanakoCurrent={false} onBack={vi.fn()} onChat={vi.fn()} onPhone={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByLabelText('星野昵称')).toBeInTheDocument());

    // 确认前还没有关系状态
    expect(getRelationshipState('agent-1') ?? null).toBeNull();

    const confirmBtn = await openStudioToPlan();
    fireEvent.click(confirmBtn);

    // 确认即存：黑化按模型档位 marked(基线 28)初始化进「TA 的状态」
    await waitFor(() => {
      expect(getRelationshipState('agent-1')?.corruption).toBe(28);
    });
    expect(screen.queryByTestId('xingye-corruption-seed-confirm')).not.toBeInTheDocument();
  });

  it('重置黑化起点：选 marked 档 → 确认条显示目标 28，确定后给反馈并收起', () => {
    render(
      <RoleDetailPanel agent={agent} isOpenHanakoCurrent={false} onBack={vi.fn()} onChat={vi.fn()} onPhone={vi.fn()} />,
    );
    fireEvent.change(screen.getByTestId('xingye-role-corruption-tendency-select'), { target: { value: 'marked' } });

    fireEvent.click(screen.getByTestId('xingye-corruption-reset-open'));
    const confirm = screen.getByTestId('xingye-corruption-reset-confirm');
    expect(confirm).toHaveTextContent('重置回设定起点 28');

    fireEvent.click(screen.getByTestId('xingye-corruption-reset-confirm-btn'));
    expect(screen.queryByTestId('xingye-corruption-reset-confirm')).not.toBeInTheDocument();
    expect(screen.getByTestId('xingye-corruption-reset-msg')).toHaveTextContent('28');
  });

  it('重置黑化起点：取消则收起确认、不写反馈', () => {
    render(
      <RoleDetailPanel agent={agent} isOpenHanakoCurrent={false} onBack={vi.fn()} onChat={vi.fn()} onPhone={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId('xingye-corruption-reset-open'));
    expect(screen.getByTestId('xingye-corruption-reset-confirm')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('xingye-corruption-reset-cancel'));
    expect(screen.queryByTestId('xingye-corruption-reset-confirm')).not.toBeInTheDocument();
    expect(screen.queryByTestId('xingye-corruption-reset-msg')).not.toBeInTheDocument();
  });

  it('保存设定：改了黑化档位 → 同步写入「TA 的状态」的黑化值', async () => {
    render(
      <RoleDetailPanel agent={agent} isOpenHanakoCurrent={false} onBack={vi.fn()} onChat={vi.fn()} onPhone={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByLabelText('星野昵称')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('xingye-role-corruption-tendency-select'), { target: { value: 'marked' } });
    fireEvent.click(screen.getByRole('button', { name: /^保存/ }));

    await waitFor(() => {
      expect(getRelationshipState('agent-1')?.corruption).toBe(28);
    });
    expect(screen.getByTestId('xingye-corruption-reset-msg')).toHaveTextContent('TA 的状态');
  });

  it('保存设定：只改别的字段 → 不碰「TA 的状态」里已漂移的黑化', async () => {
    // 预置一个已存在、黑化已涨到 50 的状态
    saveRelationshipState({
      agentId: 'agent-1', targetType: 'user', targetId: '__user__',
      affection: 30, trust: 0, loyalty: 0, jealousy: 0, corruption: 50,
      mood: '平静', relationshipKey: 'friend', relationshipLabel: '朋友',
      source: 'manual', updatedAt: '2026-05-13T00:00:00.000Z',
    });
    render(
      <RoleDetailPanel agent={agent} isOpenHanakoCurrent={false} onBack={vi.fn()} onChat={vi.fn()} onPhone={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByLabelText('星野昵称')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('星野昵称'), { target: { value: '新名字' } });
    fireEvent.click(screen.getByRole('button', { name: /^保存/ }));

    await waitFor(() => expect(screen.getByText(/上次保存/)).toBeInTheDocument());
    expect(getRelationshipState('agent-1')?.corruption).toBe(50); // 黑化未被动
    expect(screen.queryByTestId('xingye-corruption-reset-msg')).not.toBeInTheDocument();
  });

  it('shows save failure when profile storage write fails', async () => {
    render(
      <RoleDetailPanel
        agent={agent}
        isOpenHanakoCurrent={true}
        onBack={vi.fn()}
        onChat={vi.fn()}
        onPhone={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText('星野昵称')).toBeInTheDocument();
    });

    vi.mocked(hanaFetch).mockImplementation(async (path: string) => {
      if (path === '/api/xingye/storage') {
        return {
          ok: false,
          statusText: 'Internal Server Error',
          json: async () => ({ error: 'disk full' }),
        } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });

    fireEvent.click(screen.getByRole('button', { name: /保存/ }));

    await waitFor(() => {
      expect(screen.getByText(/保存失败：disk full/)).toBeInTheDocument();
    });
  });
});
