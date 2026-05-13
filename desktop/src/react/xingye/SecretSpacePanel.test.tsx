/**
 * @vitest-environment jsdom
 */

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../types';
import { SecretSpacePanel } from './SecretSpacePanel';

type JsonlRow = Record<string, unknown>;

function storeKey(agentId: string, relativePath: string): string {
  return `${agentId}|${relativePath}`;
}

const jsonlStore = vi.hoisted(() => new Map<string, JsonlRow[]>());

const hanaFetchMock = vi.hoisted(() => vi.fn(async (path: string, init?: RequestInit) => {
  if (typeof path === 'string' && path.includes('/pinned')) {
    return { ok: true, json: async () => ({ pins: [] }) } as Response;
  }
  if (typeof path === 'string' && path.includes('/api/xingye/storage')) {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const agentId = typeof body.agentId === 'string' ? body.agentId : '';
    const relativePath = typeof body.relativePath === 'string' ? body.relativePath : '';
    const key = storeKey(agentId, relativePath);

    if (body.action === 'listJsonl') {
      const records = jsonlStore.get(key) ?? [];
      return {
        ok: true,
        json: async () => ({ ok: true, records }),
      } as Response;
    }

    if (body.action === 'appendJsonl' && body.data && typeof body.data === 'object') {
      const next = [...(jsonlStore.get(key) ?? []), body.data as JsonlRow];
      jsonlStore.set(key, next);
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    }

    return { ok: true, json: async () => ({ ok: true, records: [] }) } as Response;
  }
  return { ok: true, json: async () => ({}) } as Response;
}));

vi.mock('../hooks/use-hana-fetch', () => ({
  hanaUrl: (path: string) => path,
  hanaFetch: hanaFetchMock,
}));

const secretStoreHoisted = vi.hoisted(() => ({
  state: {
    currentAgentId: 'agent-secret-1',
    agentName: 'Test',
    serverPort: '17333',
    activeServerConnection: null as null,
    agents: [] as { id: string }[],
  },
}));

vi.mock('../stores', () => ({
  useStore: Object.assign(
    (fn: (s: typeof secretStoreHoisted.state) => unknown) => fn(secretStoreHoisted.state),
    { getState: () => secretStoreHoisted.state },
  ),
}));

vi.mock('../settings/store', () => ({
  useSettingsStore: (fn: (s: { settingsAgentId: null; currentAgentId: string; ready: boolean }) => unknown) =>
    fn({ settingsAgentId: null, currentAgentId: 'agent-secret-1', ready: false }),
}));

const agent: Agent = {
  id: 'agent-secret-1',
  name: 'Test',
  yuan: 'test',
  isPrimary: true,
  hasAvatar: false,
};

const agentOther: Agent = {
  id: 'agent-secret-2',
  name: 'Other',
  yuan: 'other',
  isPrimary: false,
  hasAvatar: false,
};

describe('SecretSpacePanel secret space navigation', () => {
  beforeEach(() => {
    hanaFetchMock.mockClear();
    jsonlStore.clear();
    jsonlStore.set(storeKey('agent-secret-1', 'secret-space/draft_reply.jsonl'), [
      {
        key: 'stored-dr1',
        title: 'stored draft reply',
        createdAt: '2026-05-12T12:00:00.000Z',
        summary: 'storage backed draft',
        body: 'storage body',
        kind: 'draft_reply',
      },
    ]);
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('shows six category entries on the home screen', () => {
    render(<SecretSpacePanel agent={agent} />);

    expect(screen.getByTestId('secret-space-home')).toBeInTheDocument();
    expect(screen.getByTestId('secret-space-entry-state')).toBeInTheDocument();
    expect(screen.getByTestId('secret-space-entry-draft_reply')).toBeInTheDocument();
    expect(screen.getByTestId('secret-space-entry-dream')).toBeInTheDocument();
    expect(screen.getByTestId('secret-space-entry-saved_item')).toBeInTheDocument();
    expect(screen.getByTestId('secret-space-entry-unsent_moment')).toBeInTheDocument();
    expect(screen.getByTestId('secret-space-entry-memory_fragment')).toBeInTheDocument();
  });

  it('opens the dream category view and returns home from back', () => {
    render(<SecretSpacePanel agent={agent} />);

    fireEvent.click(screen.getByTestId('secret-space-entry-dream'));

    expect(screen.getByTestId('secret-space-category-dream')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'TA 的梦境' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '返回' }));

    expect(screen.getByTestId('secret-space-home')).toBeInTheDocument();
    expect(screen.queryByTestId('secret-space-category-dream')).not.toBeInTheDocument();
  });

  it('shows category-specific empty state when records list is empty', () => {
    render(<SecretSpacePanel agent={agent} />);

    fireEvent.click(screen.getByTestId('secret-space-entry-state'));

    expect(screen.getByTestId('secret-space-empty')).toHaveTextContent('尚无额外的文字记录');
  });

  it('shows storage-backed text records in draft_reply category', async () => {
    render(<SecretSpacePanel agent={agent} />);

    fireEvent.click(screen.getByTestId('secret-space-entry-draft_reply'));

    await waitFor(() => {
      expect(screen.getByTestId('secret-space-record-row-stored-dr1')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('secret-space-empty')).not.toBeInTheDocument();
    expect(hanaFetchMock).toHaveBeenCalledWith(
      '/api/xingye/storage',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"agentId":"agent-secret-1"'),
      }),
    );
  });

  it('opens record detail and returns to list without leaving category', async () => {
    render(<SecretSpacePanel agent={agent} />);

    fireEvent.click(screen.getByTestId('secret-space-entry-draft_reply'));
    await waitFor(() => {
      expect(screen.getByTestId('secret-space-record-row-stored-dr1')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('secret-space-record-row-stored-dr1'));

    expect(screen.getByTestId('secret-space-record-detail-stored-dr1')).toBeInTheDocument();
    expect(screen.queryByTestId('secret-space-record-row-stored-dr1')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '返回记录列表' }));

    expect(screen.getByTestId('secret-space-record-row-stored-dr1')).toBeInTheDocument();
    expect(screen.queryByTestId('secret-space-record-detail-stored-dr1')).not.toBeInTheDocument();
    expect(screen.getByTestId('secret-space-category-draft_reply')).toBeInTheDocument();
  });

  it('shows RelationshipStatePanel content after opening the TA 的状态 category', () => {
    render(<SecretSpacePanel agent={agent} />);

    expect(screen.getByTestId('secret-space-entry-state')).toHaveAccessibleName(/TA 的状态/);

    fireEvent.click(screen.getByTestId('secret-space-entry-state'));

    expect(screen.getByTestId('secret-space-state-section')).toBeInTheDocument();
    expect(screen.getByTestId('secret-space-relationship-panel')).toBeInTheDocument();
  });

  it('does not show manual add form on state category', () => {
    render(<SecretSpacePanel agent={agent} />);
    fireEvent.click(screen.getByTestId('secret-space-entry-state'));
    expect(screen.queryByTestId('secret-space-add-record')).not.toBeInTheDocument();
  });

  it('appends draft_reply record and reloads list', async () => {
    render(<SecretSpacePanel agent={agent} />);
    fireEvent.click(screen.getByTestId('secret-space-entry-draft_reply'));

    await waitFor(() => {
      expect(screen.getByTestId('secret-space-record-row-stored-dr1')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId('secret-space-add-record-body'), {
      target: { value: 'new draft body text' },
    });
    fireEvent.change(screen.getByTestId('secret-space-add-record-title'), {
      target: { value: 'fresh title' },
    });
    fireEvent.click(screen.getByTestId('secret-space-add-record-submit'));

    await waitFor(() => {
      const rows = screen.getAllByTestId(/^secret-space-record-row-/);
      expect(rows.length).toBeGreaterThanOrEqual(2);
    });
    expect(screen.getByText('fresh title')).toBeInTheDocument();
  });

  it('dream append does not appear in draft_reply list', async () => {
    render(<SecretSpacePanel agent={agent} />);
    fireEvent.click(screen.getByTestId('secret-space-entry-dream'));
    await waitFor(() => {
      expect(screen.getByTestId('secret-space-add-record')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId('secret-space-add-record-body'), {
      target: { value: 'only in dream file' },
    });
    fireEvent.click(screen.getByTestId('secret-space-add-record-submit'));

    await waitFor(() => {
      expect(jsonlStore.get(storeKey('agent-secret-1', 'secret-space/dream.jsonl'))?.length).toBe(1);
    });

    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    fireEvent.click(screen.getByTestId('secret-space-entry-draft_reply'));

    await waitFor(() => {
      expect(screen.getByTestId('secret-space-record-row-stored-dr1')).toBeInTheDocument();
    });
    expect(screen.queryByText('only in dream file')).not.toBeInTheDocument();
  });

  it('saved_item and unsent_moment append are readable in their categories', async () => {
    render(<SecretSpacePanel agent={agent} />);

    fireEvent.click(screen.getByTestId('secret-space-entry-saved_item'));
    await waitFor(() => expect(screen.getByTestId('secret-space-add-record')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('secret-space-add-record-body'), { target: { value: 'bookmark note' } });
    fireEvent.click(screen.getByTestId('secret-space-add-record-submit'));

    await waitFor(() => {
      expect(screen.queryAllByTestId(/^secret-space-record-row-/).length).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    fireEvent.click(screen.getByTestId('secret-space-entry-unsent_moment'));

    await waitFor(() => expect(screen.getByTestId('secret-space-add-record')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('secret-space-add-record-body'), { target: { value: 'moment draft' } });
    fireEvent.click(screen.getByTestId('secret-space-add-record-submit'));

    await waitFor(() => {
      expect(screen.queryAllByTestId(/^secret-space-record-row-/).length).toBeGreaterThan(0);
    });
    expect(jsonlStore.get(storeKey('agent-secret-1', 'secret-space/saved_item.jsonl'))?.[0]).toMatchObject({
      body: 'bookmark note',
    });
    expect(jsonlStore.get(storeKey('agent-secret-1', 'secret-space/unsent_moment.jsonl'))?.[0]).toMatchObject({
      body: 'moment draft',
    });
  });

  it('does not mix records when switching agents', async () => {
    const { rerender } = render(<SecretSpacePanel agent={agent} />);
    fireEvent.click(screen.getByTestId('secret-space-entry-draft_reply'));
    await waitFor(() => {
      expect(screen.getByTestId('secret-space-record-row-stored-dr1')).toBeInTheDocument();
    });

    rerender(<SecretSpacePanel agent={agentOther} />);

    await waitFor(() => {
      expect(screen.getByTestId('secret-space-empty')).toHaveTextContent('草稿箱是空的');
    });
    expect(screen.queryByTestId('secret-space-record-row-stored-dr1')).not.toBeInTheDocument();
  });
});

describe('SecretSpacePanel memory candidate manual entry', () => {
  beforeEach(() => {
    hanaFetchMock.mockClear();
    jsonlStore.clear();
    jsonlStore.set(storeKey('agent-secret-1', 'secret-space/draft_reply.jsonl'), [
      {
        key: 'stored-dr1',
        title: 'stored draft reply',
        createdAt: '2026-05-12T12:00:00.000Z',
        summary: 'storage backed draft',
        body: 'storage body',
        kind: 'draft_reply',
      },
    ]);
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('creates candidate from manual form without using record mocks', async () => {
    render(<SecretSpacePanel agent={agent} />);

    fireEvent.click(screen.getByTestId('secret-space-entry-memory_fragment'));

    const manualForm = screen.getByTestId('secret-space-manual-candidate');
    expect(screen.queryByTestId('secret-space-add-record')).not.toBeInTheDocument();

    const contentInput = within(manualForm).getByPlaceholderText('输入一条你希望记住的要点');

    fireEvent.change(contentInput, {
      target: { value: 'manual note from secret space' },
    });
    fireEvent.click(within(manualForm).getByRole('button', { name: '创建候选记忆' }));

    await waitFor(() => {
      expect(contentInput).toHaveValue('');
    });
  });
});
