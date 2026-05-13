/**
 * @vitest-environment jsdom
 */

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../types';
import { SecretSpacePanel } from './SecretSpacePanel';
import { appendSecretSpaceRecord, deleteSecretSpaceRecord } from './xingye-secret-space-store';
import { stableSecretSpaceRecordId } from './xingye-secret-space-record-id';

type JsonlRow = Record<string, unknown>;

function storeKey(agentId: string, relativePath: string): string {
  return `${agentId}|${relativePath}`;
}

const jsonlStore = vi.hoisted(() => new Map<string, JsonlRow[]>());
const jsonStore = vi.hoisted(() => new Map<string, unknown>());
const pinnedStore = vi.hoisted(() => new Map<string, string[]>());

const hanaFetchMock = vi.hoisted(() => vi.fn(async (path: string, init?: RequestInit) => {
  if (typeof path === 'string' && path.includes('/pinned')) {
    const match = path.match(/^\/api\/agents\/([^/]+)\/pinned$/);
    const agentId = match?.[1] ?? null;
    if (!agentId) return { ok: false, status: 404, json: async () => ({ error: 'bad pinned path' }) } as Response;
    if (init?.method === 'PUT') {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const pins = Array.isArray(body.pins) ? body.pins.filter((p: unknown): p is string => typeof p === 'string') : [];
      pinnedStore.set(agentId, pins);
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    }
    return { ok: true, json: async () => ({ pins: pinnedStore.get(agentId) ?? [] }) } as Response;
  }
  if (typeof path === 'string' && path.includes('/api/xingye/phone-generate')) {
    const raw = init?.body ? JSON.parse(String(init.body)) : {};
    if (raw.kind === 'secret_space') {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          kind: 'secret_space',
          result: {
            title: 'AI generated title',
            content: 'unique-ai-draft-body-991',
          },
        }),
      } as Response;
    }
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

    if (body.action === 'readJson') {
      return {
        ok: true,
        json: async () => ({ ok: true, data: jsonStore.get(key) ?? null }),
      } as Response;
    }

    if (body.action === 'writeJson') {
      jsonStore.set(key, body.data);
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    }

    if (body.action === 'appendJsonl' && body.data && typeof body.data === 'object') {
      const next = [...(jsonlStore.get(key) ?? []), body.data as JsonlRow];
      jsonlStore.set(key, next);
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    }

    if (body.action === 'write') {
      const content = typeof body.content === 'string' ? body.content : '';
      if (!content.trim()) {
        jsonlStore.set(key, []);
      } else {
        const lines = content.trim().split('\n').filter(Boolean);
        const parsed = lines.map((line) => JSON.parse(line) as JsonlRow);
        jsonlStore.set(key, parsed);
      }
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
    jsonStore.clear();
    pinnedStore.clear();
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
    (window as unknown as { __XINGYE_PERSISTENCE_DEV_LOCAL__?: boolean }).__XINGYE_PERSISTENCE_DEV_LOCAL__ = true;
  });

  afterEach(() => {
    delete (window as unknown as { __XINGYE_PERSISTENCE_DEV_LOCAL__?: boolean }).__XINGYE_PERSISTENCE_DEV_LOCAL__;
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

  it('opens detail, confirms delete, returns to list with one fewer record', async () => {
    jsonlStore.set(storeKey('agent-secret-1', 'secret-space/draft_reply.jsonl'), [
      {
        key: 'row-a',
        id: 'row-a',
        title: 'first',
        createdAt: '2026-05-12T12:00:00.000Z',
        summary: 's1',
        body: 'body-a',
        kind: 'draft_reply',
      },
      {
        key: 'row-b',
        id: 'row-b',
        title: 'second',
        createdAt: '2026-05-11T12:00:00.000Z',
        summary: 's2',
        body: 'body-b',
        kind: 'draft_reply',
      },
    ]);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SecretSpacePanel agent={agent} />);
    fireEvent.click(screen.getByTestId('secret-space-entry-draft_reply'));
    await waitFor(() => {
      expect(screen.getByTestId('secret-space-record-row-row-a')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('secret-space-record-row-row-a'));
    fireEvent.click(screen.getByTestId('secret-space-delete-row-a'));
    await waitFor(() => {
      expect(screen.getByTestId('secret-space-record-row-row-b')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('secret-space-record-row-row-a')).not.toBeInTheDocument();
    const drKey = storeKey('agent-secret-1', 'secret-space/draft_reply.jsonl');
    expect(jsonlStore.get(drKey)?.some((r) => r.key === 'row-a')).toBe(false);
    expect(jsonlStore.get(drKey)?.some((r) => r.key === 'row-b')).toBe(true);
    confirmSpy.mockRestore();
  });

  it('does not remove another agent record that shares the same record key', async () => {
    jsonlStore.set(storeKey('agent-secret-1', 'secret-space/draft_reply.jsonl'), [
      {
        key: 'shared-key',
        id: 'shared-key',
        title: 'Agent 1',
        createdAt: '2026-05-12T12:00:00.000Z',
        summary: 's',
        body: 'b',
        kind: 'draft_reply',
      },
    ]);
    jsonlStore.set(storeKey('agent-secret-2', 'secret-space/draft_reply.jsonl'), [
      {
        key: 'shared-key',
        id: 'shared-key',
        title: 'Agent 2',
        createdAt: '2026-05-12T12:00:00.000Z',
        summary: 's',
        body: 'b',
        kind: 'draft_reply',
      },
    ]);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { rerender } = render(<SecretSpacePanel agent={agent} />);
    fireEvent.click(screen.getByTestId('secret-space-entry-draft_reply'));
    await waitFor(() => screen.getByTestId('secret-space-record-row-shared-key'));
    fireEvent.click(screen.getByTestId('secret-space-record-row-shared-key'));
    fireEvent.click(screen.getByTestId('secret-space-delete-shared-key'));
    await waitFor(() => expect(screen.getByTestId('secret-space-empty')).toBeInTheDocument());
    expect(jsonlStore.get(storeKey('agent-secret-2', 'secret-space/draft_reply.jsonl'))?.length).toBe(1);

    rerender(<SecretSpacePanel agent={agentOther} />);
    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    fireEvent.click(screen.getByTestId('secret-space-entry-draft_reply'));
    await waitFor(() => expect(screen.getByTestId('secret-space-record-row-shared-key')).toBeInTheDocument());
    confirmSpy.mockRestore();
  });

  it('deletes legacy JSONL row without key/id using deterministic legacy record id', async () => {
    const legacyRow = {
      body: 'legacy body without stable key',
      summary: 'sum',
      createdAt: '2026-05-12T12:00:00.000Z',
      kind: 'draft_reply',
    };
    const legacyId = stableSecretSpaceRecordId('draft_reply', legacyRow);
    jsonlStore.set(storeKey('agent-secret-1', 'secret-space/draft_reply.jsonl'), [legacyRow]);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SecretSpacePanel agent={agent} />);
    fireEvent.click(screen.getByTestId('secret-space-entry-draft_reply'));
    await waitFor(() => screen.getByTestId(`secret-space-record-row-${legacyId}`));
    fireEvent.click(screen.getByTestId(`secret-space-record-row-${legacyId}`));
    fireEvent.click(screen.getByTestId(`secret-space-delete-${legacyId}`));
    await waitFor(() => expect(screen.getByTestId('secret-space-empty')).toBeInTheDocument());
    expect(jsonlStore.get(storeKey('agent-secret-1', 'secret-space/draft_reply.jsonl'))?.length ?? 0).toBe(0);
    confirmSpy.mockRestore();
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
    expect(screen.queryByTestId('secret-space-manual-add-record')).not.toBeInTheDocument();
  });

  it('does not show manual append debug form in non-development environments', () => {
    render(<SecretSpacePanel agent={agent} />);
    fireEvent.click(screen.getByTestId('secret-space-entry-draft_reply'));
    expect(screen.queryByTestId('secret-space-manual-add-record')).not.toBeInTheDocument();
    expect(screen.getByTestId('secret-space-category-record-actions')).toBeInTheDocument();
  });

  it('appends draft_reply record and reloads list', async () => {
    render(<SecretSpacePanel agent={agent} />);
    fireEvent.click(screen.getByTestId('secret-space-entry-draft_reply'));

    await waitFor(() => {
      expect(screen.getByTestId('secret-space-record-row-stored-dr1')).toBeInTheDocument();
    });

    await appendSecretSpaceRecord(agent.id, 'draft_reply', {
      title: 'fresh title',
      body: 'new draft body text',
      summary: 'new draft body text',
    });

    await waitFor(() => {
      const rows = screen.getAllByTestId(/^secret-space-record-row-/);
      expect(rows.length).toBeGreaterThanOrEqual(2);
    });
    expect(screen.getByText('fresh title')).toBeInTheDocument();
  });

  it('append/delete secret space records append event-log entries and keep changed event', async () => {
    const changedEvents: Array<CustomEvent<{ agentId: string; category: string }>> = [];
    const onChanged = (event: Event) => changedEvents.push(event as CustomEvent<{ agentId: string; category: string }>);
    window.addEventListener('xingye-secret-space-changed', onChanged);

    await appendSecretSpaceRecord(agent.id, 'dream', {
      recordId: 'dream-event-1',
      title: 'event title',
      body: 'event body',
      source: 'manual',
    });
    await expect(deleteSecretSpaceRecord(agent.id, 'dream', 'dream-event-1')).resolves.toBe(true);

    window.removeEventListener('xingye-secret-space-changed', onChanged);

    const log = jsonStore.get(storeKey(agent.id, 'events/log.json')) as { events?: Array<Record<string, unknown>> };
    expect(log.events?.map((event) => event.type)).toEqual([
      'secret_space.record_appended',
      'secret_space.record_deleted',
    ]);
    expect(log.events?.[0]).toEqual(expect.objectContaining({
      agentId: agent.id,
      source: 'xingye-secret-space-store',
      subjectId: 'dream',
      payload: expect.objectContaining({
        category: 'dream',
        recordId: 'dream-event-1',
        title: 'event title',
        source: 'manual',
      }),
    }));
    expect(log.events?.[1]).toEqual(expect.objectContaining({
      payload: { category: 'dream', recordId: 'dream-event-1' },
    }));
    expect(changedEvents).toHaveLength(2);
    expect(changedEvents.every((event) => event.detail.agentId === agent.id && event.detail.category === 'dream')).toBe(true);
  });

  it('shows AI generate on plain categories but not state or memory_fragment', () => {
    render(<SecretSpacePanel agent={agent} />);

    fireEvent.click(screen.getByTestId('secret-space-entry-draft_reply'));
    expect(screen.getByTestId('secret-space-ai-generate')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    fireEvent.click(screen.getByTestId('secret-space-entry-state'));
    expect(screen.queryByTestId('secret-space-ai-generate')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    fireEvent.click(screen.getByTestId('secret-space-entry-memory_fragment'));
    expect(screen.queryByTestId('secret-space-ai-generate')).not.toBeInTheDocument();
  });

  it('AI generate on draft_reply appends source ai and does not appear in dream', async () => {
    render(<SecretSpacePanel agent={agent} />);

    fireEvent.click(screen.getByTestId('secret-space-entry-draft_reply'));
    await waitFor(() => {
      expect(screen.getByTestId('secret-space-ai-generate')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('secret-space-ai-generate'));

    await waitFor(() => {
      expect(screen.getByText('AI generated title')).toBeInTheDocument();
    });

    const drKey = storeKey('agent-secret-1', 'secret-space/draft_reply.jsonl');
    const rows = jsonlStore.get(drKey) ?? [];
    expect(rows.some((r) => r.source === 'ai' && r.body === 'unique-ai-draft-body-991')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    fireEvent.click(screen.getByTestId('secret-space-entry-dream'));

    await waitFor(() => {
      expect(screen.getByTestId('secret-space-empty')).toBeInTheDocument();
    });
    expect(screen.queryByText('AI generated title')).not.toBeInTheDocument();
    expect(screen.queryByText('unique-ai-draft-body-991')).not.toBeInTheDocument();
  });

  it('dream append does not appear in draft_reply list', async () => {
    render(<SecretSpacePanel agent={agent} />);
    fireEvent.click(screen.getByTestId('secret-space-entry-dream'));
    await waitFor(() => {
      expect(screen.getByTestId('secret-space-category-record-actions')).toBeInTheDocument();
    });

    await appendSecretSpaceRecord(agent.id, 'dream', {
      title: 'only in dream file',
      body: 'only in dream file',
      summary: 'only in dream file',
    });

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
    await waitFor(() => expect(screen.getByTestId('secret-space-category-record-actions')).toBeInTheDocument());
    await appendSecretSpaceRecord(agent.id, 'saved_item', {
      title: 'bookmark note',
      body: 'bookmark note',
      summary: 'bookmark note',
    });

    await waitFor(() => {
      expect(screen.queryAllByTestId(/^secret-space-record-row-/).length).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    fireEvent.click(screen.getByTestId('secret-space-entry-unsent_moment'));

    await waitFor(() => expect(screen.getByTestId('secret-space-category-record-actions')).toBeInTheDocument());
    await appendSecretSpaceRecord(agent.id, 'unsent_moment', {
      title: 'moment draft',
      body: 'moment draft',
      summary: 'moment draft',
    });

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

  it.each(['draft_reply', 'dream', 'saved_item', 'unsent_moment'] as const)(
    'keeps %s JSONL delete behavior working',
    async (category) => {
      jsonlStore.clear();
      const rowKey = `delete-${category}`;
      jsonlStore.set(storeKey('agent-secret-1', `secret-space/${category}.jsonl`), [
        {
          key: rowKey,
          id: rowKey,
          title: `${category} title`,
          createdAt: '2026-05-12T12:00:00.000Z',
          summary: `${category} summary`,
          body: `${category} body`,
          kind: category,
        },
      ]);
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

      render(<SecretSpacePanel agent={agent} />);
      fireEvent.click(screen.getByTestId(`secret-space-entry-${category}`));
      await waitFor(() => expect(screen.getByTestId(`secret-space-record-row-${rowKey}`)).toBeInTheDocument());

      fireEvent.click(screen.getByTestId(`secret-space-record-row-${rowKey}`));
      fireEvent.click(screen.getByTestId(`secret-space-delete-${rowKey}`));

      await waitFor(() => expect(screen.getByTestId('secret-space-empty')).toBeInTheDocument());
      expect(jsonlStore.get(storeKey('agent-secret-1', `secret-space/${category}.jsonl`)) ?? []).toHaveLength(0);
      confirmSpy.mockRestore();
    },
  );

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
    pinnedStore.clear();
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
    (window as unknown as { __XINGYE_PERSISTENCE_DEV_LOCAL__?: boolean }).__XINGYE_PERSISTENCE_DEV_LOCAL__ = true;
  });

  afterEach(() => {
    delete (window as unknown as { __XINGYE_PERSISTENCE_DEV_LOCAL__?: boolean }).__XINGYE_PERSISTENCE_DEV_LOCAL__;
    cleanup();
  });

  it('creates candidate from manual form without using record mocks', async () => {
    render(<SecretSpacePanel agent={agent} />);

    fireEvent.click(screen.getByTestId('secret-space-entry-memory_fragment'));

    const manualForm = screen.getByTestId('secret-space-manual-candidate');
    expect(screen.queryByTestId('secret-space-manual-add-record')).not.toBeInTheDocument();

    const contentInput = within(manualForm).getByPlaceholderText('输入一条你希望记住的要点');

    fireEvent.change(contentInput, {
      target: { value: 'manual note from secret space' },
    });
    fireEvent.click(within(manualForm).getByRole('button', { name: '创建候选记忆' }));

    await waitFor(() => {
      expect(contentInput).toHaveValue('');
    });
  });

  it('reads and displays pinned memory as the memory_fragment main list', async () => {
    pinnedStore.set('agent-secret-1', ['first pinned memory', 'second pinned memory']);

    render(<SecretSpacePanel agent={agent} />);
    fireEvent.click(screen.getByTestId('secret-space-entry-memory_fragment'));

    await waitFor(() => {
      expect(screen.getByTestId('secret-space-record-row-memory-fragment-pinned-0')).toBeInTheDocument();
      expect(screen.getByTestId('secret-space-record-row-memory-fragment-pinned-1')).toBeInTheDocument();
    });
    expect(screen.getByTestId('secret-space-record-row-memory-fragment-pinned-0')).toHaveTextContent(
      'first pinned memory',
    );
    expect(screen.getByTestId('secret-space-record-row-memory-fragment-pinned-1')).toHaveTextContent(
      'second pinned memory',
    );
    expect(screen.queryByTestId('secret-space-empty')).not.toBeInTheDocument();
  });

  it('shows an empty state when memory_fragment has no pinned memory', async () => {
    pinnedStore.set('agent-secret-1', []);

    render(<SecretSpacePanel agent={agent} />);
    fireEvent.click(screen.getByTestId('secret-space-entry-memory_fragment'));

    await waitFor(() => {
      expect(screen.getByTestId('secret-space-empty')).toBeInTheDocument();
    });
    expect(screen.queryByTestId(/^secret-space-record-row-memory-fragment-pinned-/)).not.toBeInTheDocument();
  });

  it('manual memory input creates a pending candidate in the candidate area', async () => {
    render(<SecretSpacePanel agent={agent} />);
    fireEvent.click(screen.getByTestId('secret-space-entry-memory_fragment'));

    const manualForm = screen.getByTestId('secret-space-manual-candidate');
    fireEvent.change(within(manualForm).getByTestId('secret-space-memory-candidate-content'), {
      target: { value: 'pending memory candidate from secret space' },
    });
    fireEvent.click(within(manualForm).getByTestId('secret-space-create-memory-candidate'));

    await waitFor(() => {
      expect(screen.getByTestId(/^memory-candidate-row-/)).toBeInTheDocument();
    });
    const row = screen.getByTestId(/^memory-candidate-row-/);
    expect(within(row).getByDisplayValue('pending memory candidate from secret space')).toBeInTheDocument();
    expect(within(row).getByTestId(/^memory-candidate-status-/)).toHaveTextContent('待定');
  });

  it('refreshes the memory_fragment main list after confirming a pending candidate to pinned', async () => {
    render(<SecretSpacePanel agent={agent} />);
    fireEvent.click(screen.getByTestId('secret-space-entry-memory_fragment'));

    const manualForm = screen.getByTestId('secret-space-manual-candidate');
    fireEvent.change(within(manualForm).getByTestId('secret-space-memory-candidate-content'), {
      target: { value: 'confirmed pinned from candidate' },
    });
    fireEvent.click(within(manualForm).getByTestId('secret-space-create-memory-candidate'));
    await waitFor(() => expect(screen.getByTestId(/^memory-candidate-row-/)).toBeInTheDocument());

    const candidateRow = screen.getByTestId(/^memory-candidate-row-/);
    const buttons = within(candidateRow).getAllByRole('button');
    fireEvent.click(buttons[buttons.length - 1]);

    await waitFor(() => {
      expect(screen.getByTestId('secret-space-record-row-memory-fragment-pinned-0')).toHaveTextContent(
        'confirmed pinned from candidate',
      );
    });
    expect(pinnedStore.get('agent-secret-1')).toEqual(['confirmed pinned from candidate']);
  });

  it('deletes one pinned memory while preserving the others', async () => {
    pinnedStore.set('agent-secret-1', ['delete this pinned', 'keep this pinned']);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<SecretSpacePanel agent={agent} />);
    fireEvent.click(screen.getByTestId('secret-space-entry-memory_fragment'));
    await waitFor(() => expect(screen.getByTestId('secret-space-record-row-memory-fragment-pinned-0')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('secret-space-record-row-memory-fragment-pinned-0'));
    fireEvent.click(screen.getByTestId('secret-space-delete-memory-fragment-pinned-0'));

    await waitFor(() => {
      expect(screen.queryByText('delete this pinned')).not.toBeInTheDocument();
      expect(screen.getByTestId('secret-space-record-row-memory-fragment-pinned-0')).toHaveTextContent('keep this pinned');
    });
    expect(pinnedStore.get('agent-secret-1')).toEqual(['keep this pinned']);
    confirmSpy.mockRestore();
  });

  it('does not show agent A pinned memory for agent B', async () => {
    pinnedStore.set('agent-secret-1', ['agent A private pinned']);
    pinnedStore.set('agent-secret-2', ['agent B private pinned']);

    const { rerender } = render(<SecretSpacePanel agent={agent} />);
    fireEvent.click(screen.getByTestId('secret-space-entry-memory_fragment'));
    await waitFor(() =>
      expect(screen.getByTestId('secret-space-record-row-memory-fragment-pinned-0')).toHaveTextContent(
        'agent A private pinned',
      ),
    );

    rerender(<SecretSpacePanel agent={agentOther} />);

    await waitFor(() =>
      expect(screen.getByTestId('secret-space-record-row-memory-fragment-pinned-0')).toHaveTextContent(
        'agent B private pinned',
      ),
    );
    expect(screen.getByTestId('secret-space-record-row-memory-fragment-pinned-0')).not.toHaveTextContent(
      'agent A private pinned',
    );
  });
});
