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

  it('extracts layered role fields from enabled lore without saving or syncing the agent', async () => {
    window.localStorage.setItem(XINGYE_LORE_ENTRIES_STORAGE_KEY, JSON.stringify({
      lore1: {
        id: 'lore1',
        agentId: 'agent-1',
        title: '边境医生',
        content: '林雾长期在边境救治伤患，幼年经历过战乱，因此不轻易信任他人。',
        category: 'background',
        keywords: [],
        enabled: true,
        priority: 80,
        insertionMode: 'manual',
        visibility: 'canonical',
        createdAt: '2026-05-10T00:00:00.000Z',
        updatedAt: '2026-05-10T00:00:00.000Z',
      },
      lore2: {
        id: 'lore2',
        agentId: 'agent-1',
        title: '草稿',
        content: '这条禁用内容不应作为提取输入。',
        category: 'background',
        keywords: [],
        enabled: false,
        priority: 20,
        insertionMode: 'manual',
        visibility: 'canonical',
        createdAt: '2026-05-10T00:00:00.000Z',
        updatedAt: '2026-05-10T00:00:00.000Z',
      },
    }));

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
    vi.mocked(hanaFetch).mockClear();

    fireEvent.change(screen.getByLabelText('星野昵称'), { target: { value: '林雾' } });
    fireEvent.change(screen.getByLabelText('关系标签'), { target: { value: '朋友' } });
    fireEvent.click(screen.getByRole('button', { name: 'AI 提取设定' }));

    await waitFor(() => {
      expect(screen.getByLabelText('身份摘要')).toHaveValue('林雾是一名边境医生，长期在动荡地区救治伤患。');
    });

    expect(screen.getByLabelText('简介')).toHaveValue('边境医生，冷静可靠。');
    expect(screen.getByLabelText('背景摘要')).toHaveValue('幼年经历过战乱，因此不轻易信任他人。');
    expect(screen.getByLabelText('行为逻辑')).toHaveValue('先判断问题本质，再给出务实建议。');

    expect(hanaFetch).toHaveBeenCalledTimes(1);
    expect(hanaFetch).toHaveBeenCalledWith('/api/xingye/extract-profile', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('林雾长期在边境救治伤患'),
    }));
    expect(JSON.stringify(vi.mocked(hanaFetch).mock.calls)).not.toContain('/api/agents/agent-1/identity');
    expect(JSON.stringify(vi.mocked(hanaFetch).mock.calls)).not.toContain('/api/agents/agent-1/ishiki');
    expect(window.localStorage.getItem('xingye.roleProfiles')).toBeNull();
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
