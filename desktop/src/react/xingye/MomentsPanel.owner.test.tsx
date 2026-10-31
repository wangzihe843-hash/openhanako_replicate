/** @vitest-environment jsdom */
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../types';
import type { XingyeStorageBackend } from './xingye-storage-backend';
import type { XingyePendingMomentDraft } from './xingye-moments-store';

const mocks = vi.hoisted(() => ({
  list: vi.fn(), confirm: vi.fn(), discard: vi.fn(), create: vi.fn(),
  generate: vi.fn(), feed: vi.fn(), retry: vi.fn(), fanout: vi.fn(),
  backend: null as unknown as XingyeStorageBackend,
}));
vi.mock('../stores', async () => {
  const { create } = await import('zustand');
  return { useStore: create(() => ({ userName: '我', agents: [], currentAgentId: null })) };
});
vi.mock('./xingye-profile-store', () => ({
  useXingyeRoleProfiles: () => ({}),
  getXingyeRoleProfileDisplay: (agent: Agent) => ({ displayName: agent.name, relationshipLabel: 'friend' }),
}));
vi.mock('./xingye-moments-feed', async importOriginal => ({
  ...await importOriginal<typeof import('./xingye-moments-feed')>(),
  useAggregatedXingyeMoments: mocks.feed,
}));
vi.mock('./xingye-moments-ai', () => ({ generateXingyeMomentDraftWithAI: mocks.generate }));
vi.mock('./xingye-moments-user-fanout', () => ({ fanOutAgentReactionsToUserPost: mocks.fanout }));
vi.mock('./xingye-event-log', () => ({ appendXingyeEvent: vi.fn(async () => undefined) }));
vi.mock('./xingye-storage-backend', async importOriginal => {
  const actual = await importOriginal<typeof import('./xingye-storage-backend')>();
  // The actual store runs unchanged; only its IO boundary is an isolated memory backend.
  return { ...actual, createAgentXingyeStorageBackend: () => new Proxy({}, {
    get: (_target, method: keyof XingyeStorageBackend) => mocks.backend[method]?.bind(mocks.backend),
  }) };
});
vi.mock('./xingye-moments-store', async importOriginal => ({
  ...await importOriginal<object>(),
  listMomentDrafts: mocks.list,
  confirmMomentDraft: mocks.confirm,
  discardMomentDraft: mocks.discard,
  createXingyeMomentPost: mocks.create,
}));
vi.mock('./XingyeAgentAvatar', () => ({ XingyeAgentAvatar: ({ alt }: { alt: string }) => <span>{alt}</span> }));
vi.mock('./MomentCard', () => ({ MomentCard: ({ post }: { post: { id: string } }) => <div data-testid={`post-${post.id}`} /> }));
// Unrelated shell tabs are inert. MomentsPanel and MomentComposer stay real and mounted.
vi.mock('./xingye-shell-fonts', () => ({}));
vi.mock('./xingye-persistence', () => ({ refreshXingyeAgentPersistence: vi.fn(async () => undefined) }));
vi.mock('./xingye-chat-actions', () => ({ enterXingyeAgentChat: vi.fn() }));
vi.mock('./xingye-scene-navigation', () => ({ navigateXingyeSceneSource: vi.fn() }));
vi.mock('./AgentPhonePanel', () => ({ AgentPhonePanel: () => null }));
vi.mock('./ChatEntryPanel', () => ({ ChatEntryPanel: () => null }));
vi.mock('./GroupChatPanel', () => ({ GroupChatPanel: () => null }));
vi.mock('./SecretSpacePanel', () => ({ SecretSpacePanel: () => null }));
vi.mock('./GiftPanel', () => ({ GiftPanel: () => null }));
vi.mock('./RoleDetailPanel', () => ({ RoleDetailPanel: () => null }));
vi.mock('./RoleListPanel', () => ({ RoleListPanel: () => null }));

import { useStore } from '../stores';
import { createMemoryXingyeStorageBackend } from './xingye-storage-backend';
import { MomentsPanel } from './MomentsPanel';
import { XingyeShell } from './XingyeShell';

const actual = await vi.importActual<typeof import('./xingye-moments-store')>('./xingye-moments-store');
const A: Agent = { id: 'owner-a', name: 'Role A', yuan: 'hanako', isPrimary: false, hasAvatar: false };
const B: Agent = { ...A, id: 'owner-b', name: 'Role B' };
const roster = [A, B];
const draft = (id: string, content = id): XingyePendingMomentDraft => ({ id, content, source: 'test', createdAt: '2026-10-31' });
const panel = (owner = A.id, agents = roster) => <MomentsPanel agents={agents} currentAgentId={owner} selectedXingyeAgentId={owner} />;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function openComposer() {
  fireEvent.click(screen.getByRole('button', { name: '发表新动态' }));
  fireEvent.click(screen.getByRole('radio', { name: '以角色发表' }));
}
const input = () => screen.getByPlaceholderText('写下这一刻的想法...');
const confirmButton = (id: string) => screen.getByTestId(`moments-draft-confirm-${id}`);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.backend = createMemoryXingyeStorageBackend();
  mocks.list.mockReset().mockImplementation(actual.listMomentDrafts);
  mocks.confirm.mockReset().mockImplementation(actual.confirmMomentDraft);
  mocks.discard.mockReset().mockImplementation(actual.discardMomentDraft);
  mocks.create.mockReset().mockImplementation(actual.createXingyeMomentPost);
  mocks.generate.mockReset().mockResolvedValue({ content: 'generated', seedLikes: [], seedComments: [] });
  mocks.feed.mockReturnValue({ posts: [], loading: false, error: null, retry: mocks.retry });
  mocks.fanout.mockResolvedValue(undefined);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  useStore.setState({ agents: roster, currentAgentId: A.id, userName: '我' });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('MomentsPanel owner and draft request lifetime', () => {
  it.each(['success', 'error'] as const)('ignores a late A list %s after B has loaded and been edited', async outcome => {
    const old = deferred<XingyePendingMomentDraft[]>();
    mocks.list.mockImplementation(owner => owner === A.id ? old.promise : Promise.resolve([draft('shared', 'B draft')]));
    const ui = render(panel());
    ui.rerender(panel(B.id));
    const edit = await screen.findByTestId('moments-draft-content-shared');
    fireEvent.change(edit, { target: { value: 'B new input' } });
    await act(async () => { if (outcome === 'success') old.resolve([draft('shared', 'A private')]); else old.reject(new Error('old A error')); });
    expect(edit).toHaveValue('B new input');
    expect(screen.queryByText('old A error')).not.toBeInTheDocument();
    fireEvent.click(confirmButton('shared'));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledWith(B.id, 'shared', expect.objectContaining({ content: 'B new input' })));
  });

  it('invalidates the first A list across A → B → A without remounting', async () => {
    const old = deferred<XingyePendingMomentDraft[]>();
    mocks.list.mockReturnValueOnce(old.promise).mockResolvedValueOnce([draft('b')]).mockResolvedValueOnce([draft('new-a')]);
    const ui = render(panel());
    openComposer();
    const originalInput = input();
    ui.rerender(panel(B.id));
    ui.rerender(panel(A.id));
    await screen.findByTestId('moments-draft-new-a');
    expect(input()).toBe(originalInput);
    await act(async () => old.resolve([draft('old-a')]));
    expect(screen.getByTestId('moments-draft-new-a')).toBeInTheDocument();
    expect(screen.queryByTestId('moments-draft-old-a')).not.toBeInTheDocument();
  });

  it.each(['success', 'error'] as const)('uses latest same-owner list when an earlier read ends with %s', async outcome => {
    const old = deferred<XingyePendingMomentDraft[]>();
    mocks.list.mockReturnValueOnce(old.promise).mockResolvedValueOnce([draft('latest')]);
    const ui = render(panel());
    ui.rerender(panel(A.id, [{ ...A }, B]));
    await screen.findByTestId('moments-draft-latest');
    await act(async () => { if (outcome === 'success') old.resolve([draft('old')]); else old.reject(new Error('old read')); });
    expect(screen.getByTestId('moments-draft-latest')).toBeInTheDocument();
    expect(screen.queryByTestId('moments-draft-old')).not.toBeInTheDocument();
  });

  it.each(['confirm', 'discard'] as const)('does not resurrect a handled draft from an in-flight list after %s', async operation => {
    const old = deferred<XingyePendingMomentDraft[]>();
    mocks.list.mockResolvedValueOnce([draft('handled')]).mockReturnValueOnce(old.promise);
    mocks.confirm.mockResolvedValue({ id: 'post' });
    mocks.discard.mockResolvedValue(true);
    const ui = render(panel());
    const edit = await screen.findByTestId('moments-draft-content-handled');
    fireEvent.change(edit, { target: { value: 'keep edit across roster refresh' } });
    ui.rerender(panel(A.id, [{ ...A }, B]));
    expect(edit).toHaveValue('keep edit across roster refresh');
    fireEvent.click(screen.getByTestId(`moments-draft-${operation}-handled`));
    await waitFor(() => expect(screen.queryByTestId('moments-draft-handled')).not.toBeInTheDocument());
    await act(async () => old.resolve([draft('handled'), draft('new')]));
    expect(screen.queryByTestId('moments-draft-handled')).not.toBeInTheDocument();
    expect(screen.getByTestId('moments-draft-new')).toBeInTheDocument();
  });

  it.each(['plain', 'combined', 'discard'].flatMap(kind => ['success', 'error'].map(outcome => ({ kind, outcome }))))('late $kind $outcome leaves B same-ID input and new busy operation alone', async ({ kind, outcome }) => {
    const a = deferred<{ id: string } | boolean>();
    const b = deferred<{ id: string } | boolean>();
    mocks.list.mockResolvedValue([draft('shared')]);
    const operation = kind === 'discard' ? mocks.discard : mocks.confirm;
    operation.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const ui = render(panel());
    await screen.findByTestId('moments-draft-shared');
    const testId = `moments-draft-${kind === 'combined' ? 'confirm-with-interactions' : kind === 'plain' ? 'confirm' : 'discard'}-shared`;
    fireEvent.click(screen.getByTestId(testId));
    await waitFor(() => expect(operation).toHaveBeenCalledTimes(1));
    ui.rerender(panel(B.id));
    const edit = await screen.findByTestId('moments-draft-content-shared');
    expect(edit).toBeEnabled();
    fireEvent.change(edit, { target: { value: 'B work' } });
    fireEvent.click(screen.getByTestId(testId));
    await waitFor(() => expect(operation).toHaveBeenCalledTimes(2));
    await act(async () => { if (outcome === 'success') a.resolve(kind === 'discard' ? true : { id: 'a-post' }); else a.reject(new Error('old A failure')); });
    expect(edit).toHaveValue('B work');
    expect(edit).toBeDisabled();
    expect(screen.queryByText('old A failure')).not.toBeInTheDocument();
    expect(mocks.retry).not.toHaveBeenCalled();
    await act(async () => b.reject(new Error('current B failure')));
    expect(edit).toBeEnabled();
    expect(screen.getByRole('alert')).toHaveTextContent('current B failure');
  });

  it.each(['success', 'error'] as const)('expires combined AI %s before starting a save for the old owner', async outcome => {
    const old = deferred<{ content: string }>();
    mocks.list.mockResolvedValue([draft('shared')]);
    mocks.generate.mockReturnValueOnce(old.promise);
    const ui = render(panel());
    fireEvent.click(await screen.findByTestId('moments-draft-confirm-with-interactions-shared'));
    ui.rerender(panel(B.id));
    const edit = await screen.findByTestId('moments-draft-content-shared');
    fireEvent.change(edit, { target: { value: 'B draft' } });
    await act(async () => { if (outcome === 'success') old.resolve({ content: 'A' }); else old.reject(new Error('old AI error')); });
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(edit).toHaveValue('B draft');
    expect(edit).toBeEnabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('clears the draft UI when the roster becomes empty and ignores a late read', async () => {
    const old = deferred<XingyePendingMomentDraft[]>();
    mocks.list.mockReturnValueOnce(old.promise);
    const ui = render(panel());
    ui.rerender(panel(A.id, []));
    await act(async () => old.resolve([draft('old-a')]));
    expect(screen.queryByTestId('moments-pending-drafts')).not.toBeInTheDocument();
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it('does not start old discard-false reload after A → B → A or unmount', async () => {
    const old = deferred<boolean>();
    mocks.list.mockResolvedValue([draft('shared')]);
    mocks.discard.mockReturnValueOnce(old.promise);
    const ui = render(panel());
    fireEvent.click(await screen.findByTestId('moments-draft-discard-shared'));
    ui.rerender(panel(B.id));
    ui.rerender(panel(A.id));
    await screen.findByTestId('moments-draft-shared');
    ui.unmount();
    render(panel(B.id));
    await screen.findByTestId('moments-draft-shared');
    const calls = mocks.list.mock.calls.length;
    await act(async () => old.resolve(false));
    expect(mocks.list).toHaveBeenCalledTimes(calls);
    expect(screen.getByTestId('moments-draft-shared')).toBeInTheDocument();
  });

  it('keeps the newer busy flag while removing an earlier successful same-owner draft', async () => {
    const one = deferred<{ id: string }>();
    const two = deferred<{ id: string }>();
    mocks.list.mockResolvedValue([draft('one'), draft('two')]);
    mocks.confirm.mockReturnValueOnce(one.promise).mockReturnValueOnce(two.promise);
    render(panel());
    fireEvent.click(await screen.findByTestId('moments-draft-confirm-one'));
    fireEvent.click(confirmButton('two'));
    await act(async () => one.resolve({ id: 'post-one' }));
    expect(screen.queryByTestId('moments-draft-one')).not.toBeInTheDocument();
    expect(confirmButton('two')).toBeDisabled();
    await act(async () => two.resolve({ id: 'post-two' }));
    expect(screen.queryByTestId('moments-pending-drafts')).not.toBeInTheDocument();
  });
});

describe('MomentsPanel original-owner persistence and real shell fallback', () => {
  it.each(['plain', 'combined'] as const)('finishes already-started %s confirm through the actual store only under A', async kind => {
    const proposed = await actual.appendMomentDraft(A.id, { content: 'A original draft', source: 'test' });
    const bDraft = await actual.appendMomentDraft(B.id, { content: 'B safe draft', source: 'test' });
    const gate = deferred<void>();
    mocks.confirm.mockImplementation(async (...args: Parameters<typeof actual.confirmMomentDraft>) => { await gate.promise; return actual.confirmMomentDraft(...args); });
    const ui = render(panel());
    fireEvent.click(await screen.findByTestId(`moments-draft-${kind === 'combined' ? 'confirm-with-interactions' : 'confirm'}-${proposed.id}`));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    ui.rerender(panel(B.id));
    const edit = await screen.findByTestId(`moments-draft-content-${bDraft.id}`);
    fireEvent.change(edit, { target: { value: 'B input' } });
    await act(async () => gate.resolve());
    expect(await actual.listXingyeMomentPosts(A.id)).toMatchObject([{ content: 'A original draft', authorAgentId: A.id }]);
    expect(await actual.listXingyeMomentPosts(B.id)).toEqual([]);
    expect(await actual.listMomentDrafts(A.id)).toEqual([]);
    expect(await actual.listMomentDrafts(B.id)).toHaveLength(1);
    expect(edit).toHaveValue('B input');
    expect(mocks.retry).not.toHaveBeenCalled();
  });

  it('finishes an A manual save without closing B composer and preserves B manual content without A seeds', async () => {
    const gate = deferred<void>();
    mocks.generate.mockResolvedValue({ content: 'A generated', seedLikes: [{ actorType: 'virtual_contact', actorId: 'owner-a:private', actorName: 'A contact' }] });
    mocks.create.mockImplementationOnce(async (...args: Parameters<typeof actual.createXingyeMomentPost>) => { await gate.promise; return actual.createXingyeMomentPost(...args); });
    const ui = render(panel());
    openComposer();
    fireEvent.click(screen.getByRole('button', { name: 'AI 生成' }));
    await waitFor(() => expect(input()).toHaveValue('A generated'));
    fireEvent.click(screen.getByRole('button', { name: '发表' }));
    ui.rerender(panel(B.id));
    expect(input()).toBeEnabled();
    fireEvent.change(input(), { target: { value: 'B manual' } });
    await act(async () => gate.resolve());
    expect(input()).toHaveValue('B manual');
    const aPosts = await actual.listXingyeMomentPosts(A.id);
    expect(aPosts).toMatchObject([{ authorAgentId: A.id, content: 'A generated', likes: [{ actorId: 'owner-a:private' }] }]);
    fireEvent.click(screen.getByRole('button', { name: '发表' }));
    await waitFor(() => expect(screen.queryByPlaceholderText('写下这一刻的想法...')).not.toBeInTheDocument());
    expect(await actual.listXingyeMomentPosts(B.id)).toMatchObject([{ authorAgentId: B.id, content: 'B manual', likes: [], comments: [] }]);
  });

  it('does not close a newly reopened same-owner composer when the unmounted submit completes', async () => {
    const gate = deferred<void>();
    mocks.create.mockImplementationOnce(async (...args: Parameters<typeof actual.createXingyeMomentPost>) => {
      await gate.promise;
      return actual.createXingyeMomentPost(...args);
    });
    render(panel());
    openComposer();
    fireEvent.change(input(), { target: { value: 'A submitted' } });
    fireEvent.click(screen.getByRole('button', { name: '发表' }));
    fireEvent.click(screen.getByRole('button', { name: '收起发布' }));
    fireEvent.click(screen.getByRole('button', { name: '发表新动态' }));
    fireEvent.change(input(), { target: { value: 'A next composer' } });
    await act(async () => gate.resolve());
    expect(input()).toHaveValue('A next composer');
    expect(await actual.listXingyeMomentPosts(A.id)).toMatchObject([{ content: 'A submitted' }]);
  });

  it('handles actual XingyeShell roster fallback in place and retains the aggregated feed scope', async () => {
    const old = deferred<{ content: string }>();
    mocks.generate.mockReturnValueOnce(old.promise);
    const ui = render(<XingyeShell onExit={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '朋友圈' }));
    openComposer();
    const originalInput = input();
    fireEvent.click(screen.getByRole('button', { name: 'AI 生成' }));
    expect(mocks.generate.mock.calls[0][0].agent.id).toBe(A.id);
    await act(async () => useStore.setState({ agents: [B], currentAgentId: B.id }));
    expect(input()).toBe(originalInput);
    expect(input()).toBeEnabled();
    fireEvent.change(input(), { target: { value: 'B roster input' } });
    await act(async () => old.resolve({ content: 'A late private content' }));
    expect(input()).toHaveValue('B roster input');
    expect(mocks.feed).toHaveBeenLastCalledWith([B.id, '__user__'], B.id);
    fireEvent.click(screen.getByRole('button', { name: '发表' }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ authorAgentId: B.id, content: 'B roster input', seedLikes: undefined })));
    expect(await actual.listXingyeMomentPosts(A.id)).toEqual([]);
    expect(await actual.listXingyeMomentPosts(B.id)).toMatchObject([{ content: 'B roster input', likes: [] }]);
    ui.unmount();
  });
});
