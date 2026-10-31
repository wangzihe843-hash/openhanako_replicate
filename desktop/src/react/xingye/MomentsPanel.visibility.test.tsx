/** @vitest-environment jsdom */
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../types';
import type { XingyeStorageBackend } from './xingye-storage-backend';
import type { XingyeMomentPost } from './xingye-moments-store';

type ModelPayload = { kind: string; ownerAgentId: string; agentId: string; prompt: string };
const mocks = vi.hoisted(() => ({
  backend: null as XingyeStorageBackend | null,
  model: vi.fn<(payload: ModelPayload) => Promise<Response>>(),
  profiles: {},
}));

// Keep the real store, feed, Card, Composer, AI and prompt builder together.
// Only persistence transport and the model request leave this local DOM test.
vi.mock('./xingye-storage-backend', async original => ({
  ...await original<typeof import('./xingye-storage-backend')>(),
  createAgentXingyeStorageBackend: () => new Proxy({} as XingyeStorageBackend, {
    get(_target, key) {
      if (!mocks.backend) throw new Error('Synthetic backend is not initialized');
      const value: unknown = Reflect.get(mocks.backend, key);
      return typeof value === 'function' ? value.bind(mocks.backend) : value;
    },
  }),
}));
vi.mock('../hooks/use-hana-fetch', () => ({
  hanaFetch: async (url: string, options: { body?: string }) => {
    if (url !== '/api/xingye/phone-generate') throw new Error(`Unexpected request: ${url}`);
    return mocks.model(JSON.parse(options.body ?? '{}') as ModelPayload);
  },
}));
vi.mock('../stores', () => ({
  useStore: (select: (state: { userName: string }) => unknown) => select({ userName: '我' }),
}));
vi.mock('./xingye-profile-store', () => ({
  useXingyeRoleProfiles: () => mocks.profiles,
  getXingyeRoleProfileDisplay: (agent: Agent) => ({ displayName: agent.name, relationshipLabel: 'friend' }),
}));
vi.mock('./xingye-storage-api', () => ({ postXingyeStorage: async () => ({ missing: true }) }));
vi.mock('./xingye-event-log', () => ({ appendXingyeEvent: async () => undefined }));
vi.mock('./xingye-persistence', () => ({ getXingyePersistenceStorage: () => null }));
vi.mock('./xingye-state-store', () => ({ getRelationshipState: () => ({ relationshipKey: 'friend' }) }));
vi.mock('./xingye-desk-heartbeat-memory', () => ({ peekDeskHeartbeatUiOutcome: () => null }));
vi.mock('./xingye-lore-runtime-context', () => ({
  buildXingyeLoreRuntimeQueryText: () => '',
  collectXingyeLoreRuntimeContext: () => ({}),
  formatXingyeLoreRuntimeContextBlock: () => '',
}));
vi.mock('./xingye-lore-store', () => ({ XINGYE_LORE_CATEGORY_LABELS: {}, listLoreEntries: () => [] }));
vi.mock('./xingye-contact-lore-link', () => ({ buildContactLoreHints: () => [] }));
vi.mock('./xingye-phone-store', () => ({ getPhoneContactMeta: () => null }));
vi.mock('./xingye-recent-context', () => ({
  collectRecentContextForAgent: () => ({ summaryText: '' }),
  describeRecentContextForPrompt: () => '',
}));
vi.mock('./xingye-speaker-context', async original => ({
  ...await original<typeof import('./xingye-speaker-context')>(),
  resolveXingyeSpeakerUserName: async () => '我',
}));
vi.mock('./XingyeAgentAvatar', () => ({ XingyeAgentAvatar: () => <span /> }));

import { MomentsPanel } from './MomentsPanel';
import { createMemoryXingyeStorageBackend } from './xingye-storage-backend';
import {
  addXingyeMomentComment,
  createXingyeMomentPost,
  listXingyeMomentPosts,
  XINGYE_MOMENTS_POSTS_JSONL,
} from './xingye-moments-store';
import { fanOutAgentReactionsToUserPost } from './xingye-moments-user-fanout';

const A: Agent = { id: 'role-a', name: 'Role A', yuan: 'hanako', isPrimary: false, hasAvatar: false };
const B: Agent = { ...A, id: 'role-b', name: 'Role B' };
const C: Agent = { ...A, id: 'role-c', name: 'Role C' };
const AGENTS = [A, B, C];
const POST_A = 'Published post by A';
const POST_B = 'Published post by B';
const C_COMMENT = 'Public comment from C';
const USER_COMMENT = 'Public comment from the user';
const VC_COMMENT = 'Private virtual contact comment';
const panel = (viewer: string) => <MomentsPanel agents={AGENTS} currentAgentId={viewer} selectedXingyeAgentId={viewer} />;
const response = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), {
  status: 200, headers: { 'Content-Type': 'application/json' },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function card(content = POST_A) {
  const article = screen.getByText(content, { exact: true }).closest('article');
  if (!article) throw new Error(`Missing published card: ${content}`);
  return within(article);
}
function input(content = POST_A) {
  return card(content).getByPlaceholderText('以 我 的身份评论...');
}
function typeComment(body: string, content = POST_A) {
  fireEvent.change(input(content), { target: { value: body } });
}
function pickReply(agent: Agent, content = POST_A) {
  const current = card(content);
  fireEvent.click(current.getByRole('button', { name: '让 TA 回复 ▾' }));
  fireEvent.click(current.getByRole('menuitem', { name: new RegExp(agent.name) }));
}
async function feedReady() {
  await screen.findByText(POST_A, { exact: true });
  await screen.findByText(POST_B, { exact: true });
}
async function viewerReady(viewer: Agent) {
  await waitFor(() => {
    const privateComment = card().queryByText(VC_COMMENT, { exact: true });
    if (viewer.id === A.id) expect(privateComment).toBeInTheDocument();
    else expect(privateComment).not.toBeInTheDocument();
  });
}
async function comments(author = A.id, postId = 'shared-id') {
  return (await listXingyeMomentPosts(author)).find(post => post.id === postId)?.comments ?? [];
}
async function appendConcurrentComment(body: string, actor = C) {
  await act(async () => {
    await addXingyeMomentComment(A.id, 'shared-id', {
      actorType: 'agent', actorId: actor.id, actorName: actor.name,
    }, body);
  });
}
async function expectSharedComments(...bodies: string[]) {
  await waitFor(() => {
    for (const body of bodies) expect(card().getByText(body, { exact: true })).toBeInTheDocument();
  });
}

beforeEach(async () => {
  mocks.backend = createMemoryXingyeStorageBackend();
  mocks.model.mockReset().mockImplementation(async () => response({ reply: 'Public reply from B' }));
  await createXingyeMomentPost({
    id: 'shared-id', authorAgentId: A.id, authorName: A.name, content: POST_A,
    seedComments: [
      { actorType: 'agent', actorId: C.id, actorName: C.name, body: C_COMMENT },
      { actorType: 'user', actorId: 'user', actorName: '我', body: USER_COMMENT },
      { actorType: 'virtual_contact', actorId: `${A.id}:vc`, actorName: 'A contact', body: VC_COMMENT },
    ],
  });
  await createXingyeMomentPost({ id: 'shared-id', authorAgentId: B.id, authorName: B.name, content: POST_B });
});
afterEach(cleanup);

describe('published moments stay shared through real feed, storage and model payload', () => {
  it('A → B → A retains both authors and all agent/user comments while resetting only unpublished input', async () => {
    const ui = render(panel(A.id));
    await feedReady();
    await viewerReady(A);
    expect(card().getByRole('heading', { name: A.name })).toBeInTheDocument();
    expect(card(POST_B).getByRole('heading', { name: B.name })).toBeInTheDocument();
    typeComment('Unpublished A input');
    for (const viewer of [B, A]) {
      ui.rerender(panel(viewer.id));
      await viewerReady(viewer);
      expect(input()).toHaveValue('');
      await expectSharedComments(C_COMMENT, USER_COMMENT);
      expect(card(POST_B).getByText(POST_B)).toBeInTheDocument();
    }
    expect((await comments()).map(comment => comment.body)).toEqual([C_COMMENT, USER_COMMENT, VC_COMMENT]);
    expect(mocks.model).not.toHaveBeenCalled();
  });

  it.each([
    { viewer: A, replyAgent: A, seesContact: true },
    { viewer: A, replyAgent: B, seesContact: true },
    { viewer: B, replyAgent: A, seesContact: false },
    { viewer: B, replyAgent: B, seesContact: false },
  ])('viewer $viewer.id choosing $replyAgent.id uses latest public comments and the existing viewer contact rule', async ({ viewer, replyAgent, seesContact }) => {
    render(panel(viewer.id));
    await feedReady();
    await viewerReady(viewer);
    typeComment('Target unique operation');
    pickReply(replyAgent);
    await waitFor(() => expect(mocks.model).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(input()).toHaveValue(''));
    const payload = mocks.model.mock.calls[0][0];
    expect(payload).toMatchObject({ kind: 'moments', ownerAgentId: replyAgent.id, agentId: replyAgent.id });
    expect(payload.prompt).toContain(POST_A);
    expect(payload.prompt).toContain(`${C.name}：${C_COMMENT}`);
    expect(payload.prompt).toContain(`我：${USER_COMMENT}`);
    expect(payload.prompt.includes(VC_COMMENT)).toBe(seesContact);
    expect(payload.prompt.split('Target unique operation')).toHaveLength(2);
    const saved = await comments();
    expect(saved.filter(comment => comment.body === 'Target unique operation')).toHaveLength(1);
    expect(saved.find(comment => comment.body === 'Public reply from B')).toMatchObject({ actorType: 'agent', actorId: replyAgent.id });
    expect(await comments(B.id)).toEqual([]);
    await expectSharedComments('Target unique operation', 'Public reply from B');
  });

  it('AI failure retry rereads concurrent C/user comments without reappending the target or exposing hidden contact comments', async () => {
    mocks.model.mockRejectedValueOnce(new Error('Synthetic model failure'));
    const ui = render(panel(B.id));
    await feedReady();
    await viewerReady(B);
    typeComment('Retry target');
    pickReply(B);
    await card().findByText(/Synthetic model failure/);
    const targetId = (await comments()).find(comment => comment.body === 'Retry target')?.id;
    await appendConcurrentComment('Concurrent C after failure');
    await act(async () => {
      await addXingyeMomentComment(A.id, 'shared-id', { actorType: 'user', actorId: 'another-user', actorName: 'Another user' }, 'Concurrent user after failure');
    });
    pickReply(B);
    await waitFor(() => expect(input()).toHaveValue(''));
    expect(mocks.model).toHaveBeenCalledTimes(2);
    for (const [payload] of mocks.model.mock.calls) {
      expect(payload.prompt).not.toContain(VC_COMMENT);
      expect(payload.prompt).toContain(C_COMMENT);
      expect(payload.prompt).toContain(USER_COMMENT);
    }
    const retryPayload = mocks.model.mock.calls[1][0];
    expect(retryPayload.prompt).toContain('Concurrent C after failure');
    expect(retryPayload.prompt).toContain('Concurrent user after failure');
    expect(retryPayload.prompt.split('Retry target')).toHaveLength(2);
    expect((await comments()).filter(comment => comment.id === targetId)).toHaveLength(1);
    expect((await comments()).filter(comment => comment.actorType === 'agent' && comment.actorId === B.id)).toHaveLength(1);
    for (const viewer of [A, B]) {
      ui.rerender(panel(viewer.id));
      await viewerReady(viewer);
      await expectSharedComments('Retry target', 'Concurrent C after failure', 'Concurrent user after failure', 'Public reply from B');
    }
    typeComment('Retry target');
    fireEvent.click(card().getByRole('button', { name: /^评论$/ }));
    await waitFor(() => expect(input()).toHaveValue(''));
    expect((await comments()).filter(comment => comment.body === 'Retry target')).toHaveLength(2);
  });

  it('author-view retry keeps visible contact comments and the latest C comment even when B is selected to reply', async () => {
    mocks.model.mockRejectedValueOnce(new Error('Synthetic model failure'));
    render(panel(A.id));
    await feedReady();
    await viewerReady(A);
    typeComment('Author view retry');
    pickReply(B);
    await card().findByText(/Synthetic model failure/);
    await appendConcurrentComment('New public C on author retry');
    pickReply(B);
    await waitFor(() => expect(input()).toHaveValue(''));
    expect(mocks.model).toHaveBeenCalledTimes(2);
    for (const [payload] of mocks.model.mock.calls) {
      expect(payload.agentId).toBe(B.id);
      expect(payload.prompt).toContain(VC_COMMENT);
    }
    expect(mocks.model.mock.calls[1][0].prompt).toContain('New public C on author retry');
    expect((await comments()).filter(comment => comment.body === 'Author view retry')).toHaveLength(1);
  });

  it('two authors sharing a post ID keep independent pending replies through A → B → A and reverse model completion', async () => {
    const oldA = deferred<Response>();
    const oldB = deferred<Response>();
    const newB = deferred<Response>();
    const newA = deferred<Response>();
    mocks.model.mockReturnValueOnce(oldA.promise).mockReturnValueOnce(oldB.promise)
      .mockReturnValueOnce(newB.promise).mockReturnValueOnce(newA.promise);
    const ui = render(panel(A.id));
    await feedReady();
    await viewerReady(A);
    typeComment('Old operation on A'); pickReply(B);
    typeComment('Old operation on B', POST_B); pickReply(A, POST_B);
    await waitFor(() => expect(mocks.model).toHaveBeenCalledTimes(2));
    ui.rerender(panel(B.id));
    await viewerReady(B);
    ui.rerender(panel(A.id));
    await viewerReady(A);
    typeComment('New operation on B', POST_B); pickReply(A, POST_B);
    typeComment('New operation on A'); pickReply(B);
    await waitFor(() => expect(mocks.model).toHaveBeenCalledTimes(4));
    await act(async () => newA.resolve(response({ reply: 'Current reply on A' })));
    await waitFor(() => expect(input()).toHaveValue(''));
    expect(input(POST_B)).toHaveValue('New operation on B');
    expect(input(POST_B)).toBeDisabled();
    await act(async () => oldB.resolve(response({ reply: 'Obsolete reply on B' })));
    await act(async () => oldA.resolve(response({ reply: 'Obsolete reply on A' })));
    expect(input(POST_B)).toHaveValue('New operation on B');
    expect(input(POST_B)).toBeDisabled();
    await act(async () => newB.resolve(response({ reply: 'Current reply on B' })));
    await waitFor(() => expect(input(POST_B)).toHaveValue(''));
    const savedA = await comments();
    const savedB = await comments(B.id);
    expect(savedA.filter(comment => comment.actorType === 'agent' && comment.actorId === B.id).map(comment => comment.body)).toEqual(['Current reply on A']);
    expect(savedB.filter(comment => comment.actorType === 'agent').map(comment => [comment.actorId, comment.body])).toEqual([[A.id, 'Current reply on B']]);
    for (const viewer of [B, A]) {
      ui.rerender(panel(viewer.id));
      await viewerReady(viewer);
      expect(card().getByText('Current reply on A')).toBeInTheDocument();
      expect(card(POST_B).getByText('Current reply on B')).toBeInTheDocument();
      expect(screen.queryByText(/Obsolete reply/)).not.toBeInTheDocument();
    }
  });

  it('late unpublished AI cannot overwrite B while an already-started A post keeps its B/C seed comments shared', async () => {
    const generated = { content: 'AI draft for A', comments: [
      { ref: `agent:${B.id}`, body: 'B seed on A post' },
      { ref: `agent:${C.id}`, body: 'C seed on A post' },
    ], likes: [] };
    const lateDraft = deferred<Response>();
    mocks.model.mockResolvedValueOnce(response(generated)).mockReturnValueOnce(lateDraft.promise);
    const ui = render(panel(A.id));
    await feedReady();
    fireEvent.click(screen.getByRole('button', { name: '发表新动态' }));
    fireEvent.click(screen.getByRole('radio', { name: '以角色发表' }));
    fireEvent.click(screen.getByRole('button', { name: /^AI 生成$/ }));
    await waitFor(() => expect(screen.getByPlaceholderText('写下这一刻的想法...')).toHaveValue('AI draft for A'));
    const started = deferred<void>();
    const finish = deferred<void>();
    const backend = mocks.backend;
    if (!backend) throw new Error('Missing synthetic backend');
    const append = backend.appendJsonl.bind(backend);
    backend.appendJsonl = async <T,>(author: string, path: string, record: T) => {
      await append(author, path, record);
      if (path === XINGYE_MOMENTS_POSTS_JSONL && (record as XingyeMomentPost).content === generated.content) {
        started.resolve();
        await finish.promise;
      }
    };
    fireEvent.click(screen.getByRole('button', { name: /^发表$/ }));
    await act(async () => started.promise);
    ui.rerender(panel(B.id));
    await viewerReady(B);
    fireEvent.click(screen.getByRole('button', { name: /^AI 生成$/ }));
    await waitFor(() => expect(mocks.model).toHaveBeenCalledTimes(2));
    ui.rerender(panel(A.id));
    await viewerReady(A);
    ui.rerender(panel(B.id));
    await viewerReady(B);
    fireEvent.change(screen.getByPlaceholderText('写下这一刻的想法...'), { target: { value: 'Current B unpublished draft' } });
    await act(async () => lateDraft.resolve(response({ content: 'Obsolete B generated draft', comments: [], likes: [] })));
    await act(async () => finish.resolve());
    expect(screen.getByPlaceholderText('写下这一刻的想法...')).toHaveValue('Current B unpublished draft');
    const published = (await listXingyeMomentPosts(A.id)).find(post => post.content === generated.content);
    expect(published?.comments.map(comment => [comment.actorId, comment.body])).toEqual([
      [B.id, 'B seed on A post'], [C.id, 'C seed on A post'],
    ]);
    expect((await listXingyeMomentPosts(B.id)).some(post => post.content === generated.content)).toBe(false);
    for (const viewer of [A, B]) {
      ui.rerender(panel(viewer.id));
      await viewerReady(viewer);
      await waitFor(() => {
        expect(card(generated.content).getByText('B seed on A post')).toBeInTheDocument();
        expect(card(generated.content).getByText('C seed on A post')).toBeInTheDocument();
      });
    }
  });

  it('user-post fanout reads earlier agent comments into the next real model payload and survives viewer changes', async () => {
    await createXingyeMomentPost({ id: 'user-post', authorAgentId: '__user__', authorName: '我', content: 'User published post' });
    const first = deferred<Response>();
    mocks.model.mockReturnValueOnce(first.promise).mockResolvedValueOnce(response({ reply: 'B fanout public comment' }));
    const ui = render(panel(A.id));
    await feedReady();
    const fanout = fanOutAgentReactionsToUserPost({
      postId: 'user-post', rand: () => 0,
      agents: [A, B].map(agent => ({ agent, profile: null, displayName: agent.name })),
    });
    await waitFor(() => expect(mocks.model).toHaveBeenCalledTimes(1));
    ui.rerender(panel(B.id));
    await viewerReady(B);
    await act(async () => {
      first.resolve(response({ reply: 'A fanout public comment' }));
      await fanout;
    });
    expect(mocks.model).toHaveBeenCalledTimes(2);
    expect(mocks.model.mock.calls[1][0]).toMatchObject({ agentId: B.id, ownerAgentId: B.id });
    expect(mocks.model.mock.calls[1][0].prompt).toContain('User published post');
    expect(mocks.model.mock.calls[1][0].prompt).toContain('A fanout public comment');
    const saved = await comments('__user__', 'user-post');
    expect(saved.map(comment => [comment.actorId, comment.body])).toEqual([
      [A.id, 'A fanout public comment'], [B.id, 'B fanout public comment'],
    ]);
    for (const viewer of [A, B]) {
      ui.rerender(panel(viewer.id));
      await viewerReady(viewer);
      await waitFor(() => {
        expect(card('User published post').getByText('A fanout public comment')).toBeInTheDocument();
        expect(card('User published post').getByText('B fanout public comment')).toBeInTheDocument();
      });
    }
  });
});
