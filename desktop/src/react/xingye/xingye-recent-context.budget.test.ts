/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../stores';
import type { ChatListItem } from '../stores/chat-types';
import { hanaFetch } from '../hooks/use-hana-fetch';
import { createLoreEntry } from './xingye-lore-store';
import * as persistence from './xingye-persistence';
import { collectRecentContextForAgent } from './xingye-recent-context';
import { generateSecretSpaceRecordWithAI } from './xingye-secret-space-ai';

vi.mock('../hooks/use-hana-fetch', async importOriginal => ({
  ...await importOriginal<typeof import('../hooks/use-hana-fetch')>(),
  hanaFetch: vi.fn(),
}));

vi.mock('../hooks/use-config', async importOriginal => ({
  ...await importOriginal<typeof import('../hooks/use-config')>(),
  fetchConfig: vi.fn(async () => ({ user: { name: '测试用户' } })),
}));

vi.mock('./xingye-storage-api', () => ({
  postXingyeStorage: vi.fn(async () => ({ missing: true })),
}));

const correction = '最新修订：刚改到明天，地点改为紫藤站。';
const foreignMarker = 'FOREIGN_AGENT_CHAT';

function message(text: string, index: number): ChatListItem {
  return {
    type: 'message',
    data: {
      id: `message-${index}`,
      role: 'user',
      text,
      timestamp: Date.parse('2026-10-31T00:00:00.000Z') + index * 1000,
    },
  };
}

function cacheMessages(items: ChatListItem[]) {
  const session = {
    path: 'agents/hana/sessions/recent.jsonl',
    sessionId: 'hana-recent',
    title: null,
    firstMessage: '',
    modified: '2026-10-31T01:00:00.000Z',
    messageCount: items.length,
    agentId: 'hana',
    agentName: 'Hana',
    cwd: null,
  };
  const foreignSession = {
    ...session,
    path: 'agents/other/sessions/newer.jsonl',
    sessionId: 'other-newer',
    agentId: 'other',
    modified: '2026-10-31T02:00:00.000Z',
  };
  useStore.setState({
    sessions: [foreignSession, session],
    sessionLocatorsById: {
      'hana-recent': { path: session.path },
      'other-newer': { path: foreignSession.path },
    },
    chatSessions: {
      'hana-recent': { items, hasMore: false, loadingMore: false },
      'other-newer': { items: [message(foreignMarker, 31)], hasMore: false, loadingMore: false },
    },
  });
}

function longWindow(): ChatListItem[] {
  return Array.from({ length: 30 }, (_, index) => message(
    (index === 29 ? correction : `第${String(index).padStart(2, '0')}条：今天在旧站见。`).padEnd(500, '字'),
    index,
  ));
}

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(persistence, 'getXingyePersistenceStorage').mockReturnValue(localStorage);
  vi.mocked(hanaFetch).mockReset();
  vi.mocked(hanaFetch).mockResolvedValue({
    ok: true,
    json: async () => ({ ok: true, result: { title: '明天', content: '记住了新的约定。' } }),
  } as Response);
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  useStore.setState({
    sessions: [],
    sessionLocatorsById: {},
    currentSessionId: null,
    currentSessionPath: null,
    chatSessions: {},
  });
});

describe('recent-context summary budget', () => {
  it('retains the latest correction in a full 30-message window, in chronological order', () => {
    cacheMessages(longWindow());

    const context = collectRecentContextForAgent({ agentId: 'hana' });

    expect(context.messages).toHaveLength(30);
    expect(context.messages.every(item => item.content.length === 500)).toBe(true);
    expect(context.messages[0].content).toContain('第00条');
    expect(context.messages[29].content).toContain(correction);
    expect(context.summaryText).toContain(correction);
    expect(context.summaryText).not.toContain('第00条');
    expect(context.summaryText).not.toContain(foreignMarker);
    expect(context.summaryText.length).toBeLessThanOrEqual(8_000);

    const lines = context.summaryText.split('\n');
    expect(lines.length).toBeLessThan(30);
    expect(lines).toEqual(context.messages.slice(-lines.length).map(item => `[用户] ${item.content}`));
  });

  it('delivers the correction and its keyword lore through the real secret-space consumer', async () => {
    cacheMessages(longWindow());
    const loreInput = {
      title: '仅末条关键词触发',
      content: '正确地点的候车室在东门。',
      category: 'worldview' as const,
      insertionMode: 'keyword' as const,
      keywords: ['紫藤站'],
      enabled: true,
      visibility: 'canonical' as const,
    };
    createLoreEntry('hana', loreInput, localStorage);
    createLoreEntry('other', { ...loreInput, content: 'FOREIGN_AGENT_LORE' }, localStorage);
    createLoreEntry('hana', { ...loreInput, keywords: ['未提及站点'], content: 'UNMATCHED_LORE' }, localStorage);

    await generateSecretSpaceRecordWithAI({
      agent: { id: 'hana', name: 'Hana', yuan: 'hanako', isPrimary: true },
      ownerProfile: null,
      category: 'state',
    });

    expect(hanaFetch).toHaveBeenCalledTimes(1);
    const [url, options] = vi.mocked(hanaFetch).mock.calls[0];
    const body = JSON.parse(String(options?.body)) as {
      kind: string; agentId: string; ownerAgentId: string; prompt: string;
    };
    expect(url).toBe('/api/xingye/phone-generate');
    expect(body).toMatchObject({ kind: 'secret_space', agentId: 'hana', ownerAgentId: 'hana' });
    expect(body.prompt).toContain(correction);
    expect(body.prompt).toContain(loreInput.content);
    expect(body.prompt).not.toContain('第00条');
    expect(body.prompt).not.toContain(foreignMarker);
    expect(body.prompt).not.toContain('FOREIGN_AGENT_LORE');
    expect(body.prompt).not.toContain('UNMATCHED_LORE');
    expect(body.prompt.indexOf('第28条')).toBeLessThan(body.prompt.indexOf(correction));
  });

  it('keeps a short window byte-for-byte, including assistant text cleanup and role labels', () => {
    cacheMessages([
      message(' 今天在旧站见。 ', 0),
      { type: 'message', data: { id: 'reply', role: 'assistant', blocks: [{ type: 'text', html: '<p>好，等你。</p>' }] } },
      message(correction, 2),
    ]);

    const context = collectRecentContextForAgent({ agentId: 'hana' });

    expect(context.summaryText).toBe(`[用户] 今天在旧站见。\n[角色] 好，等你。\n[用户] ${correction}`);
    expect(context.messages.map(item => item.role)).toEqual(['user', 'assistant', 'user']);
  });

  it.each([
    { maxTotalChars: 13, expected: '[用户] 乙\n[用户] 丙' },
    { maxTotalChars: 12, expected: '[用户] 丙' },
  ])('counts separators at the $maxTotalChars-character budget boundary', ({ maxTotalChars, expected }) => {
    cacheMessages([message('甲', 0), message('乙', 1), message('丙', 2)]);

    const context = collectRecentContextForAgent({ agentId: 'hana', maxTotalChars });

    expect(context.summaryText).toBe(expected);
    expect(context.summaryText.length).toBeLessThanOrEqual(maxTotalChars);
  });

  it('preserves the single-line soft-budget exception and existing 500-character content limit', () => {
    cacheMessages([message('较早消息', 0), message(correction + '字'.repeat(800), 1)]);

    const context = collectRecentContextForAgent({ agentId: 'hana', maxTotalChars: 100 });

    const latest = `${(correction + '字'.repeat(800)).slice(0, 499)}…`;
    expect(context.messages[1].content).toBe(latest);
    expect(context.summaryText).toBe(`[用户] ${latest}`);
  });

  it('keeps the configured message window and excludes a newer session belonging to another agent', () => {
    cacheMessages([message('窗口外旧消息', 0), message('上一条', 1), message(correction, 2)]);

    const context = collectRecentContextForAgent({ agentId: 'hana', maxMessages: 2 });

    expect(context.messages.map(item => item.content)).toEqual(['上一条', correction]);
    expect(context.summaryText).toBe(`[用户] 上一条\n[用户] ${correction}`);
    expect(collectRecentContextForAgent({ agentId: 'missing' }).hasOpenHanakoMessages).toBe(false);
  });
});
