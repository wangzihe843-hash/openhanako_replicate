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
        const parsed = lines.map((line: string) => JSON.parse(line) as JsonlRow);
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

const secretStoreHoisted = vi.hoisted(() => {
  type StagedQuote = { text: string; sourceTitle: string; charCount: number; updatedAt?: number };
  const state: {
    currentAgentId: string;
    agentName: string;
    serverPort: string;
    activeServerConnection: null;
    agents: { id: string }[];
    stagedChatQuote: StagedQuote | null;
    stageChatQuote: (sel: StagedQuote) => void;
  } = {
    currentAgentId: 'agent-secret-1',
    agentName: 'Test',
    serverPort: '17333',
    activeServerConnection: null,
    agents: [],
    stagedChatQuote: null,
    stageChatQuote: () => {},
  };
  state.stageChatQuote = (sel) => {
    state.stagedChatQuote = sel;
  };
  return { state };
});

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

/**
 * 草稿模块改用 vi.mock 直接桩，避免和现有 hanaFetch 走真实流。
 * 现有 describe 不读 drafts，默认 mockResolvedValue([]) 对它们无影响。
 */
const secretSpaceDraftsMock = vi.hoisted(() => ({
  confirmSecretSpaceDraft: vi.fn(),
  discardSecretSpaceDraft: vi.fn(),
  listSecretSpaceDrafts: vi.fn().mockResolvedValue([]),
  SECRET_SPACE_DRAFT_ALLOWED_CATEGORIES: ['state', 'dream', 'saved_item', 'draft_reply', 'unsent_moment'] as const,
}));
vi.mock('./xingye-secret-space-drafts', () => secretSpaceDraftsMock);

/**
 * memory_candidate 待确认草稿区物理上挂在 SecretSpacePanel 的 memory_fragment 视图里
 * （pendingMemoryCandidateDrafts），不在 MemoryCandidatePanel.tsx 里。这里桩出
 * confirm/discard/list 三件套，由下方 memory-candidate draft 测试段消费。
 */
const memoryCandidateDraftsMock = vi.hoisted(() => ({
  confirmMemoryCandidateDraft: vi.fn(),
  discardMemoryCandidateDraft: vi.fn(),
  listMemoryCandidateDrafts: vi.fn().mockResolvedValue([]),
  XINGYE_MEMORY_CANDIDATE_DRAFTS_JSONL: 'memory-candidate/drafts.jsonl',
}));
vi.mock('./xingye-memory-candidate-drafts', () => memoryCandidateDraftsMock);

/**
 * 独家专访意图草稿三件套 + 生成入口。专访是重型结构化生成，确认草稿时 UI 会现跑
 * generateSecretInterviewWithAI，所以这里把 AI 入口也桩掉。
 */
const interviewAiMock = vi.hoisted(() => ({
  generateSecretInterviewWithAI: vi.fn(),
}));
vi.mock('./xingye-secret-space-interview-ai', () => interviewAiMock);

const interviewDraftsMock = vi.hoisted(() => ({
  confirmInterviewDraftWithEntry: vi.fn(),
  discardInterviewDraft: vi.fn(),
  listInterviewDrafts: vi.fn().mockResolvedValue([]),
}));
vi.mock('./xingye-interview-drafts', () => interviewDraftsMock);

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
    secretStoreHoisted.state.stagedChatQuote = null;
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

  it('「去和 TA 聊聊」stages the draft body for the next chat the user opens', async () => {
    render(<SecretSpacePanel agent={agent} />);

    fireEvent.click(screen.getByTestId('secret-space-entry-draft_reply'));
    await waitFor(() => {
      expect(screen.getByTestId('secret-space-record-row-stored-dr1')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('secret-space-record-row-stored-dr1'));

    expect(secretStoreHoisted.state.stagedChatQuote).toBeNull();
    fireEvent.click(screen.getByTestId('secret-space-share-to-chat-stored-dr1'));

    expect(secretStoreHoisted.state.stagedChatQuote).toMatchObject({
      text: 'storage body',
      sourceTitle: '秘密空间 · TA 的草稿箱',
    });
    expect(
      screen.getByTestId('secret-space-share-to-chat-notice-stored-dr1'),
    ).toBeInTheDocument();
  });

  it('does not show the share-to-chat button outside the draft_reply category', async () => {
    jsonlStore.set(storeKey('agent-secret-1', 'secret-space/dream.jsonl'), [
      {
        key: 'dream-1',
        title: 'a dream',
        createdAt: '2026-05-12T12:00:00.000Z',
        summary: 's',
        body: 'dream body',
        kind: 'dream',
      },
    ]);
    render(<SecretSpacePanel agent={agent} />);

    fireEvent.click(screen.getByTestId('secret-space-entry-dream'));
    await waitFor(() => {
      expect(screen.getByTestId('secret-space-record-row-dream-1')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('secret-space-record-row-dream-1'));

    expect(screen.queryByTestId('secret-space-share-to-chat-dream-1')).not.toBeInTheDocument();
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

  it('shows AI generate on plain categories and state but not memory_fragment', () => {
    render(<SecretSpacePanel agent={agent} />);

    fireEvent.click(screen.getByTestId('secret-space-entry-draft_reply'));
    expect(screen.getByTestId('secret-space-ai-generate')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    fireEvent.click(screen.getByTestId('secret-space-entry-state'));
    expect(screen.getByTestId('secret-space-ai-generate')).toBeInTheDocument();

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

  it('manual form writes to memory_fragment.jsonl (not pinned, not localStorage)', async () => {
    render(<SecretSpacePanel agent={agent} />);

    fireEvent.click(screen.getByTestId('secret-space-entry-memory_fragment'));
    expect(screen.queryByTestId('secret-space-manual-add-record')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('secret-space-open-memory-create'));

    const manualForm = screen.getByTestId('secret-space-manual-candidate');
    const contentInput = within(manualForm).getByPlaceholderText('输入一条你希望角色记住的回忆');

    fireEvent.change(contentInput, {
      target: { value: 'manual note from secret space' },
    });
    fireEvent.click(within(manualForm).getByRole('button', { name: '保存到私藏回忆' }));

    await waitFor(() => {
      expect(screen.queryByTestId('secret-space-manual-candidate')).not.toBeInTheDocument();
    });
    /** Record landed in jsonl, NOT in pinned, NOT in localStorage candidates. */
    const rows = jsonlStore.get(storeKey('agent-secret-1', 'secret-space/memory_fragment.jsonl')) ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ body: 'manual note from secret space' });
    expect(pinnedStore.get('agent-secret-1') ?? []).toEqual([]);
    expect(window.localStorage.getItem('xingye.memoryCandidates')).toBeNull();
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

  it('manual memory input appears in memory_fragment main list, without writing pinned', async () => {
    render(<SecretSpacePanel agent={agent} />);
    fireEvent.click(screen.getByTestId('secret-space-entry-memory_fragment'));
    fireEvent.click(screen.getByTestId('secret-space-open-memory-create'));

    const manualForm = screen.getByTestId('secret-space-manual-candidate');
    fireEvent.change(within(manualForm).getByTestId('secret-space-memory-candidate-content'), {
      target: { value: 'private memory from secret space' },
    });
    fireEvent.click(within(manualForm).getByTestId('secret-space-create-memory-candidate'));

    /**
     * After saving, the manual modal closes and the new memory_fragment record is loaded
     * back into the list. Pinned is untouched (parallel storage — user later decides
     * whether to also push this record into pinned).
     */
    await waitFor(() => {
      const row = screen.getAllByText(/private memory from secret space/i).find((el) =>
        el.closest('[data-testid^="secret-space-record-row-"]'),
      );
      expect(row).toBeTruthy();
    });
    expect(pinnedStore.get('agent-secret-1') ?? []).toEqual([]);
  });

  it('manual memory record exposes a "push to pinned" action that, once clicked, writes pinned', async () => {
    render(<SecretSpacePanel agent={agent} />);
    fireEvent.click(screen.getByTestId('secret-space-entry-memory_fragment'));
    fireEvent.click(screen.getByTestId('secret-space-open-memory-create'));

    const manualForm = screen.getByTestId('secret-space-manual-candidate');
    fireEvent.change(within(manualForm).getByTestId('secret-space-memory-candidate-content'), {
      target: { value: 'pushable private memory' },
    });
    fireEvent.click(within(manualForm).getByTestId('secret-space-create-memory-candidate'));

    /** Find the record row, open its detail, then click "push to pinned". */
    const recordRow = await waitFor(() => {
      const els = screen.getAllByText(/pushable private memory/i);
      const row = els
        .map((el) => el.closest('[data-testid^="secret-space-record-row-"]'))
        .find((el): el is HTMLElement => !!el);
      if (!row) throw new Error('record not found');
      return row;
    });
    fireEvent.click(recordRow);

    const pushBtn = await waitFor(() => {
      const btn = screen.queryAllByRole('button').find((b) =>
        b.textContent?.includes('推到 OpenHanako pinned'),
      );
      if (!btn) throw new Error('push button not found');
      return btn;
    });
    fireEvent.click(pushBtn);

    await waitFor(() => {
      expect(pinnedStore.get('agent-secret-1')).toEqual(['pushable private memory']);
    });
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

/**
 * 覆盖「心跳巡检 → 待确认秘密空间草稿」的 UI 链路。
 * SECRET_SPACE_DRAFT_ALLOWED_CATEGORIES = ['state', 'dream', 'saved_item', 'draft_reply', 'unsent_moment']
 * mustPropose ≥50 触发后，agent 经 `xingye_propose_draft` 向 secret_space 提议。
 */
describe('SecretSpacePanel · pending draft section', () => {
  beforeEach(() => {
    hanaFetchMock.mockClear();
    jsonlStore.clear();
    jsonStore.clear();
    pinnedStore.clear();
    secretSpaceDraftsMock.confirmSecretSpaceDraft.mockReset();
    secretSpaceDraftsMock.discardSecretSpaceDraft.mockReset();
    secretSpaceDraftsMock.listSecretSpaceDrafts.mockReset();
    secretSpaceDraftsMock.listSecretSpaceDrafts.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
  });

  it('renders a draft from listSecretSpaceDrafts and confirm forwards fields', async () => {
    secretSpaceDraftsMock.listSecretSpaceDrafts.mockResolvedValueOnce([
      {
        id: 'd-ss-1',
        category: 'state' as const,
        title: '此刻',
        body: '想一个人安静坐一会儿。',
        reason: '巡检里看到角色今天累了',
        source: 'xingye-heartbeat-tool',
        createdAt: '2026-05-17T12:00:00.000Z',
      },
    ]);
    secretSpaceDraftsMock.confirmSecretSpaceDraft.mockResolvedValueOnce({
      id: 'rec-1',
      agentId: 'agent-secret-1',
      kind: 'state',
      title: '此刻',
      summary: '想一个人安静坐一会儿。',
      createdAt: '2026-05-17T12:30:00.000Z',
    });

    render(<SecretSpacePanel agent={agent} />);

    const draftCard = await screen.findByTestId('secret-space-pending-draft-d-ss-1');
    expect(within(draftCard).getByText(/巡检里看到角色今天累了/)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('secret-space-pending-draft-confirm-d-ss-1'));

    await waitFor(() => {
      expect(secretSpaceDraftsMock.confirmSecretSpaceDraft).toHaveBeenCalledWith(
        'agent-secret-1',
        'd-ss-1',
        expect.objectContaining({
          body: '想一个人安静坐一会儿。',
        }),
      );
    });

    await waitFor(() => {
      expect(screen.queryByTestId('secret-space-pending-draft-d-ss-1')).not.toBeInTheDocument();
    });
  });

  it('discard calls discardSecretSpaceDraft and does not call confirm', async () => {
    secretSpaceDraftsMock.listSecretSpaceDrafts.mockResolvedValueOnce([
      {
        id: 'd-ss-2',
        category: 'saved_item' as const,
        title: '一句话',
        body: '"再过一阵子吧。"',
        source: 'xingye-heartbeat-tool',
        createdAt: '2026-05-17T12:00:00.000Z',
      },
    ]);
    secretSpaceDraftsMock.discardSecretSpaceDraft.mockResolvedValueOnce(true);
    vi.spyOn(window, 'confirm').mockReturnValueOnce(true);

    render(<SecretSpacePanel agent={agent} />);
    await screen.findByTestId('secret-space-pending-draft-d-ss-2');
    fireEvent.click(screen.getByTestId('secret-space-pending-draft-discard-d-ss-2'));

    await waitFor(() => {
      expect(secretSpaceDraftsMock.discardSecretSpaceDraft).toHaveBeenCalledWith('agent-secret-1', 'd-ss-2');
    });
    await waitFor(() => {
      expect(screen.queryByTestId('secret-space-pending-draft-d-ss-2')).not.toBeInTheDocument();
    });
    expect(secretSpaceDraftsMock.confirmSecretSpaceDraft).not.toHaveBeenCalled();
  });

  it('discard aborts when user cancels window.confirm', async () => {
    secretSpaceDraftsMock.listSecretSpaceDrafts.mockResolvedValueOnce([
      {
        id: 'd-ss-3',
        category: 'dream' as const,
        title: '梦',
        body: '一段水边的梦。',
        source: 'xingye-heartbeat-tool',
        createdAt: '2026-05-17T12:00:00.000Z',
      },
    ]);
    vi.spyOn(window, 'confirm').mockReturnValueOnce(false);

    render(<SecretSpacePanel agent={agent} />);
    await screen.findByTestId('secret-space-pending-draft-d-ss-3');
    fireEvent.click(screen.getByTestId('secret-space-pending-draft-discard-d-ss-3'));

    expect(secretSpaceDraftsMock.discardSecretSpaceDraft).not.toHaveBeenCalled();
    expect(screen.getByTestId('secret-space-pending-draft-d-ss-3')).toBeInTheDocument();
  });
});

/**
 * memory_candidate 模块对应的待确认草稿区——挂在 SecretSpacePanel 的 memory_fragment
 * 视图（不是独立 Panel），所以测试也写在这里。覆盖 confirmMemoryCandidateDraft 与
 * discardMemoryCandidateDraft 两条路径，配合 tests/xingye-propose-draft-coverage.test.js
 * 的 marker 不变量。
 */
describe('SecretSpacePanel · memory_candidate pending draft section', () => {
  beforeEach(() => {
    hanaFetchMock.mockClear();
    jsonlStore.clear();
    jsonStore.clear();
    pinnedStore.clear();
    window.localStorage.clear();
    (window as unknown as { __XINGYE_PERSISTENCE_DEV_LOCAL__?: boolean }).__XINGYE_PERSISTENCE_DEV_LOCAL__ = true;
    memoryCandidateDraftsMock.confirmMemoryCandidateDraft.mockReset();
    memoryCandidateDraftsMock.discardMemoryCandidateDraft.mockReset();
    memoryCandidateDraftsMock.listMemoryCandidateDrafts.mockReset();
    memoryCandidateDraftsMock.listMemoryCandidateDrafts.mockResolvedValue([]);
  });

  afterEach(() => {
    delete (window as unknown as { __XINGYE_PERSISTENCE_DEV_LOCAL__?: boolean }).__XINGYE_PERSISTENCE_DEV_LOCAL__;
    cleanup();
  });

  it('confirm forwards draft id and removes the card from the section', async () => {
    memoryCandidateDraftsMock.listMemoryCandidateDrafts.mockResolvedValueOnce([
      {
        id: 'd-mc-1',
        content: 'TA 反复提到那次航海',
        importanceLevel: 'high' as const,
        reason: '巡检看到最近三次对话都触及那次航海',
        source: 'xingye-heartbeat-tool',
        createdAt: '2026-05-17T12:00:00.000Z',
      },
    ]);
    memoryCandidateDraftsMock.confirmMemoryCandidateDraft.mockResolvedValueOnce(undefined);

    render(<SecretSpacePanel agent={agent} />);
    fireEvent.click(screen.getByTestId('secret-space-entry-memory_fragment'));
    await screen.findByTestId('memory-fragment-pending-draft-d-mc-1');

    fireEvent.click(screen.getByTestId('memory-fragment-pending-draft-confirm-d-mc-1'));

    await waitFor(() => {
      expect(memoryCandidateDraftsMock.confirmMemoryCandidateDraft).toHaveBeenCalledWith('agent-secret-1', 'd-mc-1');
    });
    await waitFor(() => {
      expect(screen.queryByTestId('memory-fragment-pending-draft-d-mc-1')).not.toBeInTheDocument();
    });
    /** confirm 不应该顺手调 discard。 */
    expect(memoryCandidateDraftsMock.discardMemoryCandidateDraft).not.toHaveBeenCalled();
  });

  it('discard calls discardMemoryCandidateDraft and does not call confirm', async () => {
    memoryCandidateDraftsMock.listMemoryCandidateDrafts.mockResolvedValueOnce([
      {
        id: 'd-mc-2',
        content: '记得给奶奶打电话',
        importanceLevel: 'medium' as const,
        source: 'xingye-heartbeat-tool',
        createdAt: '2026-05-17T12:00:00.000Z',
      },
    ]);
    memoryCandidateDraftsMock.discardMemoryCandidateDraft.mockResolvedValueOnce(true);
    /** 与 secret_space discard 同款 window.confirm 拦截。 */
    vi.spyOn(window, 'confirm').mockReturnValueOnce(true);

    render(<SecretSpacePanel agent={agent} />);
    fireEvent.click(screen.getByTestId('secret-space-entry-memory_fragment'));
    await screen.findByTestId('memory-fragment-pending-draft-d-mc-2');

    fireEvent.click(screen.getByTestId('memory-fragment-pending-draft-discard-d-mc-2'));

    await waitFor(() => {
      expect(memoryCandidateDraftsMock.discardMemoryCandidateDraft).toHaveBeenCalledWith('agent-secret-1', 'd-mc-2');
    });
    await waitFor(() => {
      expect(screen.queryByTestId('memory-fragment-pending-draft-d-mc-2')).not.toBeInTheDocument();
    });
    expect(memoryCandidateDraftsMock.confirmMemoryCandidateDraft).not.toHaveBeenCalled();
  });
});

/**
 * 覆盖「心跳巡检 → 待确认独家专访意图草稿」的 UI 链路。
 * 草稿只带 userQuestion/reason；确认时 UI 现跑 generateSecretInterviewWithAI 生成整期
 * 专访，再调 confirmInterviewDraftWithEntry 幂等落地。
 */
describe('SecretSpacePanel · interview pending draft section', () => {
  beforeEach(() => {
    hanaFetchMock.mockClear();
    jsonlStore.clear();
    jsonStore.clear();
    interviewAiMock.generateSecretInterviewWithAI.mockReset();
    interviewDraftsMock.confirmInterviewDraftWithEntry.mockReset();
    interviewDraftsMock.discardInterviewDraft.mockReset();
    interviewDraftsMock.listInterviewDrafts.mockReset();
    interviewDraftsMock.listInterviewDrafts.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
  });

  it('renders an interview draft and confirm runs generation then confirmInterviewDraftWithEntry', async () => {
    interviewDraftsMock.listInterviewDrafts.mockResolvedValueOnce([
      {
        id: 'd-iv-1',
        userQuestion: '关于那次离开，你后悔过吗',
        reason: '巡检里 TA 反复提起那年冬天',
        source: 'xingye-heartbeat-tool',
        createdAt: '2026-05-21T12:00:00.000Z',
      },
    ]);
    interviewAiMock.generateSecretInterviewWithAI.mockResolvedValueOnce({
      recordedAt: '2026-05-21T00:00:00.000Z',
      title: '专访 · 一个冬天',
      hostName: '本刊记者',
      hostIntro: '演播室里只点了一盏灯。',
      questions: [],
      backstage: '相机关了之后，TA 沉默了很久。',
    });
    interviewDraftsMock.confirmInterviewDraftWithEntry.mockResolvedValueOnce({
      recordId: 'from-draft-d-iv-1',
      title: '专访 · 一个冬天',
    });

    render(<SecretSpacePanel agent={agent} />);
    fireEvent.click(screen.getByTestId('secret-space-entry-interview'));

    const draftCard = await screen.findByTestId('secret-space-interview-draft-d-iv-1');
    expect(within(draftCard).getByText(/关于那次离开/)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('secret-space-interview-draft-confirm-d-iv-1'));

    await waitFor(() => {
      expect(interviewAiMock.generateSecretInterviewWithAI).toHaveBeenCalledWith(
        expect.objectContaining({ userQuestion: '关于那次离开，你后悔过吗' }),
      );
    });
    await waitFor(() => {
      expect(interviewDraftsMock.confirmInterviewDraftWithEntry).toHaveBeenCalledWith(
        'agent-secret-1',
        'd-iv-1',
        expect.objectContaining({ title: '专访 · 一个冬天' }),
      );
    });
    await waitFor(() => {
      expect(screen.queryByTestId('secret-space-interview-draft-d-iv-1')).not.toBeInTheDocument();
    });
  });

  it('discard calls discardInterviewDraft without running generation', async () => {
    interviewDraftsMock.listInterviewDrafts.mockResolvedValueOnce([
      { id: 'd-iv-2', source: 'xingye-heartbeat-tool', createdAt: '2026-05-21T12:00:00.000Z' },
    ]);
    interviewDraftsMock.discardInterviewDraft.mockResolvedValueOnce(true);

    render(<SecretSpacePanel agent={agent} />);
    fireEvent.click(screen.getByTestId('secret-space-entry-interview'));
    await screen.findByTestId('secret-space-interview-draft-d-iv-2');
    fireEvent.click(screen.getByTestId('secret-space-interview-draft-discard-d-iv-2'));

    await waitFor(() => {
      expect(interviewDraftsMock.discardInterviewDraft).toHaveBeenCalledWith('agent-secret-1', 'd-iv-2');
    });
    await waitFor(() => {
      expect(screen.queryByTestId('secret-space-interview-draft-d-iv-2')).not.toBeInTheDocument();
    });
    expect(interviewAiMock.generateSecretInterviewWithAI).not.toHaveBeenCalled();
    expect(interviewDraftsMock.confirmInterviewDraftWithEntry).not.toHaveBeenCalled();
  });
});
