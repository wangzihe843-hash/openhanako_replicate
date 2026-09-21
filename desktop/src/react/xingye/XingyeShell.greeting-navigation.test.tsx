/** @vitest-environment jsdom */
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../stores';
import type { Session } from '../types';
import * as chatActions from './xingye-chat-actions';
import { XingyeShell } from './XingyeShell';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), load: vi.fn(), switch: vi.fn(), create: vi.fn(), ensure: vi.fn() }));
vi.mock('../hooks/use-hana-fetch', () => ({ hanaFetch: mocks.fetch, hanaUrl: (path: string) => path }));
vi.mock('../stores/session-actions', () => ({ loadSessions: mocks.load, switchSession: mocks.switch, createNewSession: mocks.create, ensureSession: mocks.ensure }));
vi.mock('../settings/actions', () => ({ browseAgent: vi.fn(), loadAgents: vi.fn() }));
vi.mock('./xingye-shell-fonts', () => ({}));
vi.mock('./xingye-persistence', async importOriginal => ({ ...await importOriginal<object>(), refreshXingyeAgentPersistence: vi.fn(async () => undefined) }));
vi.mock('./RoleListPanel', () => ({ RoleListPanel: ({ onShowDetails }: { onShowDetails: () => void }) => <button onClick={onShowDetails}>查看角色资料</button> }));
vi.mock('./ChatEntryPanel', () => ({ ChatEntryPanel: ({ selectedAgent, enterChatError }: { selectedAgent?: { id: string }; enterChatError: string | null }) => <div data-testid="created-chat-view">{selectedAgent?.id}{enterChatError}</div> }));
vi.mock('./AgentPhonePanel', () => ({ AgentPhonePanel: () => null }));
vi.mock('./GroupChatPanel', () => ({ GroupChatPanel: () => null }));
vi.mock('./MomentsPanel', () => ({ MomentsPanel: () => null }));
vi.mock('./SecretSpacePanel', () => ({ SecretSpacePanel: () => null }));
vi.mock('./GiftPanel', () => ({ GiftPanel: () => null }));
const freshPath = '/agents/a/sessions/fresh.jsonl';
beforeEach(() => {
  vi.clearAllMocks();
  (window as unknown as { __XINGYE_PERSISTENCE_DEV_LOCAL__?: boolean }).__XINGYE_PERSISTENCE_DEV_LOCAL__ = true;
  window.localStorage.clear();
  useStore.setState({ serverPort: '17333', activeServerConnection: null, currentAgentId: 'a', selectedAgentId: null,
    currentSessionId: 'old', currentSessionPath: '/old', sessions: [], agents: [{ id: 'a', name: 'Luna', yuan: 'hanako', isPrimary: true }] });
  mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/api/sessions/new-detached') return new Response(JSON.stringify({ path: freshPath, sessionId: 'fresh', agentId: 'a' }));
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (path === '/api/xingye/storage' && body.action === 'readJson' && body.relativePath === 'profile.json') {
      return new Response(JSON.stringify({ data: { agentId: 'a', firstMessage: 'Welcome!', updatedAt: 'now' } }));
    }
    return new Response(JSON.stringify({ ok: true }));
  });
  mocks.load.mockResolvedValue(undefined);
  mocks.switch.mockImplementation(async (path: string) => { useStore.setState({ currentSessionPath: path, currentSessionId: 'fresh' }); });
  mocks.create.mockResolvedValue(undefined);
  mocks.ensure.mockResolvedValue(true);
});
afterEach(() => {
  cleanup(); vi.restoreAllMocks();
  delete (window as unknown as { __XINGYE_PERSISTENCE_DEV_LOCAL__?: boolean }).__XINGYE_PERSISTENCE_DEV_LOCAL__;
});
describe('new greeting chat navigation across role detail and shell', () => {
  it.each(['future-old-session', 'missing-session-list'])('keeps the created session when %s would confuse the normal chat entry', async mode => {
    const enter = vi.spyOn(chatActions, 'enterXingyeAgentChat');
    if (mode === 'future-old-session') useStore.setState({ sessions: [{ sessionId: 'future', path: '/agents/a/sessions/future-old.jsonl', agentId: 'a', modified: '2099-01-01', title: 'Older chat', firstMessage: 'Existing history', messageCount: 2, agentName: 'Luna', cwd: null } satisfies Session] });
    render(<XingyeShell onExit={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '查看角色资料' }));
    fireEvent.click(await screen.findByRole('button', { name: '用此开场新建聊天' }));
    expect(await screen.findByTestId('created-chat-view')).toHaveTextContent('a');
    await waitFor(() => expect(mocks.switch).toHaveBeenCalledWith(freshPath));
    expect(enter).not.toHaveBeenCalled();
    expect(mocks.switch).toHaveBeenCalledTimes(1);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.ensure).not.toHaveBeenCalled();
    expect(mocks.fetch.mock.calls.filter(([path]) => path === '/api/sessions/new-detached')).toHaveLength(1);
    expect(useStore.getState().currentSessionPath).toBe(freshPath);
    expect(screen.getByRole('button', { name: '聊天' })).toHaveAttribute('aria-pressed', 'true');
  });
});