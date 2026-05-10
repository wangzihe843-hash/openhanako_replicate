/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../types';
import { RoleDetailPanel } from './RoleDetailPanel';

vi.mock('../settings/api', () => ({
  hanaFetch: vi.fn(async () => ({
    json: async () => ({ ok: true }),
  })),
}));

const { hanaFetch } = await import('../settings/api');

describe('RoleDetailPanel OpenHanako sync', () => {
  const agent: Agent = {
    id: 'agent-1',
    name: 'Hanako',
    yuan: 'hanako',
    isPrimary: true,
    hasAvatar: true,
  };

  beforeEach(() => {
    window.localStorage.clear();
    vi.mocked(hanaFetch).mockClear();
  });

  afterEach(() => {
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

    fireEvent.change(screen.getByLabelText('星野昵称'), { target: { value: '星野花子' } });
    fireEvent.change(screen.getByLabelText('简介'), { target: { value: '会认真记住用户偏好的搭子。' } });
    fireEvent.change(screen.getByLabelText('关系标签'), { target: { value: '同伴' } });
    fireEvent.change(screen.getByLabelText('说话风格'), { target: { value: '温柔直接，回答简短。' } });

    expect(screen.getByText('同步到 OpenHanako Agent 预览')).toBeTruthy();
    expect(screen.getAllByText(/星野花子/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/温柔直接，回答简短。/).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: '同步到 OpenHanako Agent' }));

    await waitFor(() => {
      expect(hanaFetch).toHaveBeenCalledTimes(2);
    });
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
});
