// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useStore } from '../stores';
import type { Agent, Session } from '../types';
const contactDraftsMock = vi.hoisted(() => ({
  confirmPhoneContactDraft: vi.fn(),
  discardPhoneContactDraft: vi.fn(),
  listPhoneContactDrafts: vi.fn(),
}));

const phoneStoreMock = vi.hoisted(() => ({
  blockPhoneContact: vi.fn(),
  deletePhoneContact: vi.fn(),
  getContactAiUpdateState: vi.fn(() => null),
  getPendingNewContacts: vi.fn(() => []),
  getPhoneContactGenerationState: vi.fn(() => null),
  getPhoneContacts: vi.fn(() => []),
  getVirtualContacts: vi.fn(() => []),
  getPhoneAiGenerationState: vi.fn(() => null),
  getPhoneProfileFingerprint: vi.fn(() => 'fp-1'),
  linkVirtualContactToAgent: vi.fn(),
  restorePhoneContact: vi.fn(),
  savePhoneContactMeta: vi.fn(),
  computePhoneContactGenerationInputHash: vi.fn(() => 'h-1'),
  shouldAutoSkipVirtualContactGeneration: vi.fn(() => false),
  unlinkVirtualContactFromAgent: vi.fn(),
  useXingyePhoneStorageVersion: vi.fn(() => 0),
}));

/**
 * 桩 AI helpers——PhoneContactsApp 在 mount 时若 virtualContacts 为空会主动调
 * generateVirtualContactsWithAI(...)，需要返回真实 Promise 否则 `.then` 报错。
 */
const phoneAiMock = vi.hoisted(() => ({
  enrichContactsWithAI: vi.fn(async () => ({ generatedBy: 'ai', notice: null })),
  generateSmsUpdatesForChangedContactsWithAI: vi.fn(async () => undefined),
  generateVirtualContactsWithAI: vi.fn(async () => ({ generatedBy: 'ai', notice: null })),
  regenerateAllContactsWithAI: vi.fn(async () => ({ generatedBy: 'ai', notice: null })),
  rollbackAndUpdateContactsWithAI: vi.fn(async () => ({ generatedBy: 'ai', notice: null })),
  updateContactsFromRecentContextWithAI: vi.fn(async () => ({ generatedBy: 'ai', notice: null })),
}));

const profileMock = vi.hoisted(() => ({
  useXingyeRoleProfile: vi.fn(() => null),
}));

vi.mock('./xingye-phone-contact-drafts', () => contactDraftsMock);
vi.mock('./xingye-phone-store', () => phoneStoreMock);
vi.mock('./xingye-phone-ai', () => phoneAiMock);
vi.mock('./xingye-profile-store', () => profileMock);
/** 子视图都桩成 noop——pending-draft 段在 home view 直接渲染。 */
vi.mock('./PhoneContactsSectionView', () => ({
  PhoneContactsBlockedView: () => null,
  PhoneContactsDeletedView: () => null,
  PhoneContactsFactionsHomeView: () => null,
  PhoneContactsFactionDetailView: () => null,
  PhoneContactsGroupsView: () => null,
  PhoneContactsNewFriendsView: () => null,
  PhoneContactsTagDetailView: () => null,
  PhoneContactsTagsHomeView: () => null,
}));
vi.mock('./PhoneContactDetail', () => ({ PhoneContactDetail: () => null }));
vi.mock('./PhoneContactSections', () => ({ PhoneContactSections: () => null }));

import { PhoneContactsApp } from './PhoneContactsApp';


const agent: Agent = { id: 'a', name: 'A', yuan: 'hanako', isPrimary: true, hasAvatar: false };
const session: Session = { path: '/a', sessionId: 'session-a', title: null, firstMessage: '', modified: '2026-09-13T00:00:00Z', messageCount: 1, agentId: 'a', agentName: 'A', cwd: null };
beforeEach(() => {
  window.t = ((key: string) => key) as typeof window.t;
  contactDraftsMock.listPhoneContactDrafts.mockResolvedValue([]);
  phoneStoreMock.shouldAutoSkipVirtualContactGeneration.mockReturnValue(true);
  useStore.setState({ agents: [agent], sessions: [session], currentSessionPath: '/a', currentSessionId: 'session-a', sessionLocatorsById: { 'session-a': { path: '/a' } }, activeServerConnection: null, activeServerConnectionId: null, serverConnections: {}, serverPort: '3210', chatSessions: { 'session-a': { items: [{ type: 'message', data: { id: 'm1', role: 'assistant', blocks: [], timestamp: 1 } }], hasMore: false, loadingMore: false } } });
});
afterEach(cleanup);
it('S3 refreshes the hint when a real store message gains text without changing item count', async () => {
  render(<PhoneContactsApp ownerAgent={agent} agents={[agent]} profiles={{}} channels={[]} onBack={vi.fn()} onOpenSms={vi.fn()} />);
  fireEvent.click(screen.getByText('AI 联系人管理'));
  expect(screen.getByText(/未从当前前端缓存读到最近聊天/)).toBeInTheDocument();
  act(() => { useStore.getState().updateMessageById('/a', 'm1', message => ({ ...message, blocks: [{ type: 'text', html: '<p>now present</p>' }] })); });
  expect(useStore.getState().chatSessions['session-a'].items).toHaveLength(1);
  expect(screen.getByText(/约 1 条/)).toBeInTheDocument();
});

it('S3 recomputes the selected latest session when ordering changes without changing total item count', () => {
  useStore.setState({ sessions: [session, { ...session, path: '/older', sessionId: 'session-older', modified: '2026-09-12T00:00:00Z' }],
    sessionLocatorsById: { 'session-a': { path: '/a' }, 'session-older': { path: '/older' } },
    chatSessions: { ...useStore.getState().chatSessions, 'session-older': { items: [
      { type: 'message', data: { id: 'u1', role: 'user', text: 'one', timestamp: 1 } },
      { type: 'message', data: { id: 'u2', role: 'user', text: 'two', timestamp: 2 } },
    ], hasMore: false, loadingMore: false } } });
  render(<PhoneContactsApp ownerAgent={agent} agents={[agent]} profiles={{}} channels={[]} onBack={vi.fn()} onOpenSms={vi.fn()} />);
  fireEvent.click(screen.getByText('AI 联系人管理'));
  expect(screen.getByText(/未从当前前端缓存读到最近聊天/)).toBeInTheDocument();
  act(() => useStore.setState(state => ({ sessions: state.sessions.map(item => item.path === '/older' ? { ...item, modified: '2026-09-14T00:00:00Z' } : item) })));
  expect(Object.values(useStore.getState().chatSessions).reduce((sum, cached) => sum + cached.items.length, 0)).toBe(3);
  expect(screen.getByText(/约 2 条/)).toBeInTheDocument();
});
