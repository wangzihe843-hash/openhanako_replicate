/** @vitest-environment jsdom */
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../types';
import type { XingyeMomentPost } from './xingye-moments-store';

const mocks = vi.hoisted(() => ({ add: vi.fn(), list: vi.fn(), ai: vi.fn(), feed: vi.fn() }));
vi.mock('../stores', () => ({ useStore: (select: (s: {userName: string}) => unknown) => select({userName: '我'}) }));
vi.mock('./xingye-profile-store', () => ({
  useXingyeRoleProfiles: () => ({}),
  getXingyeRoleProfileDisplay: (a: Agent) => ({displayName: a.name, relationshipLabel: 'friend'}),
}));
vi.mock('./xingye-moments-feed', async importOriginal => ({
  ...await importOriginal<typeof import('./xingye-moments-feed')>(),
  useAggregatedXingyeMoments: mocks.feed,
}));
vi.mock('./xingye-moments-ai', () => ({generateXingyeMomentCommentReplyWithAI: mocks.ai, generateXingyeMomentDraftWithAI: vi.fn()}));
vi.mock('./xingye-moments-store', async original => ({
  ...await original<typeof import('./xingye-moments-store')>(),
  addXingyeMomentComment: mocks.add, listXingyeMomentPosts: mocks.list,
  listMomentDrafts: async () => [],
}));
vi.mock('./xingye-moments-user-fanout', () => ({fanOutAgentReactionsToUserPost: vi.fn()}));
vi.mock('./xingye-event-log', () => ({appendXingyeEvent: vi.fn(async () => undefined)}));
vi.mock('./XingyeAgentAvatar', () => ({XingyeAgentAvatar: () => <span/>}));
import { MomentsPanel } from './MomentsPanel';
import { createMemoryXingyeStorageBackend } from './xingye-storage-backend';
import { createXingyeMomentStore } from './xingye-moments-store';

const A: Agent = {id:'owner-a', name:'Role A',yuan:'hanako',isPrimary:false,hasAvatar:false};
const B: Agent = {...A,id:'owner-b',name:'Role B'};
const panel = (id=A.id) => <MomentsPanel agents={[A,B]} currentAgentId={id} selectedXingyeAgentId={id}/>;
const input = () => screen.getByPlaceholderText('以 我 的身份评论...');
const type = (body='same intentional comment') => fireEvent.change(input(), {target:{value:body}});
function pick(index=0) {
  fireEvent.click(screen.getByRole('button',{name:'让 TA 回复 ▾'}));
  fireEvent.click(screen.getAllByRole('menuitem')[index]);
}
function deferred<T>() { let resolve!: (v:T)=>void; let reject!: (e:Error)=>void; const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject}; }
let backend: ReturnType<typeof createMemoryXingyeStorageBackend>;
let store: ReturnType<typeof createXingyeMomentStore>;
let post: XingyeMomentPost;
const comments = async () => (await store.listPosts(A.id))[0]?.comments ?? [];
const count = async (kind: 'user'|'agent') => (await comments()).filter(c=>c.actorType===kind).length;
async function failVisible() { await screen.findByText(/synthetic failure/); }
async function success() { await waitFor(()=>expect(input()).toHaveValue('')); }

beforeEach(async () => {
  vi.clearAllMocks();
  backend=createMemoryXingyeStorageBackend(); store=createXingyeMomentStore(backend);
  post=(await store.createPost({authorAgentId:A.id,authorName:A.name,content:'ordinary post'}))!;
  mocks.add.mockImplementation(store.addComment); mocks.list.mockImplementation(store.listPosts);
  mocks.feed.mockReturnValue({posts:[post],loading:false,error:null,retry:vi.fn()});
  mocks.ai.mockReset().mockResolvedValue('AI reply');
});
afterEach(cleanup);

describe('comment reply operation retries with actual moment store',()=>{
  it('three AI failures retry only the reply, keeping one committed user ID and concurrent comments',async()=>{
    mocks.ai.mockRejectedValueOnce(new Error('synthetic failure 1')).mockRejectedValueOnce(new Error('synthetic failure 2')).mockRejectedValueOnce(new Error('synthetic failure 3')).mockResolvedValue('AI reply');
    render(panel()); type(); pick(); await failVisible();
    const userId=(await comments())[0].id;
    expect(await count('user')).toBe(1);
    expect(screen.getByText(/评论已发布/)).toBeInTheDocument();
    await createXingyeMomentStore(backend).addComment(A.id,post.id,{actorType:'user',actorId:'another',actorName:'another'},'concurrent new comment');
    for (let i=0;i<2;i++) { pick(); await failVisible(); expect((await comments()).filter(c=>c.id===userId)).toHaveLength(1); }
    pick(); await success();
    expect(await count('user')).toBe(2); expect(await count('agent')).toBe(1);
    expect(mocks.add.mock.calls.filter(c=>c[2].actorType==='user')).toHaveLength(1);
    expect(mocks.ai.mock.calls.at(-1)?.[0].existingComments).toContainEqual({authorName:'another',body:'concurrent new comment'});
  });

  it.each(['before','after'] as const)('initial user write %s commit failure is retried with its same operation ID and no premature AI',async phase=>{
    const cas=backend.compareAndSwapJsonlRecord.bind(backend);let first=true;
    backend.compareAndSwapJsonlRecord=async (...args)=>{
      if(first){first=false;if(phase==='after') await cas(...args);throw new Error('synthetic failure user write');}
      return cas(...args);
    };
    render(panel());type();pick();await failVisible();
    expect(await count('user')).toBe(phase==='after'?1:0);expect(mocks.ai).not.toHaveBeenCalled();
    pick();await success();expect(await count('user')).toBe(1);expect(await count('agent')).toBe(1);
    expect(mocks.add.mock.calls[0][4]).toEqual(mocks.add.mock.calls[1][4]);
  });

  it.each(['before','after'] as const)('agent write %s commit failure retries only the cached reply save',async phase=>{
    const cas=backend.compareAndSwapJsonlRecord.bind(backend);let failed=false;
    backend.compareAndSwapJsonlRecord=async (...args)=>{
      const row=args[4] as XingyeMomentPost;
      if(!failed && row.comments.some(c=>c.actorType==='agent')) {failed=true;if(phase==='after')await cas(...args);throw new Error('synthetic failure agent write');}
      return cas(...args);
    };
    render(panel());type();pick();await failVisible();
    expect(await count('user')).toBe(1);expect(await count('agent')).toBe(phase==='after'?1:0);
    pick();await success();expect(await count('user')).toBe(1);expect(await count('agent')).toBe(1);expect(mocks.ai).toHaveBeenCalledTimes(1);
  });

  it('cancel then deliberately resubmit identical text is an independent operation',async()=>{
    mocks.ai.mockRejectedValueOnce(new Error('synthetic failure'));
    render(panel());type();pick();await failVisible();
    fireEvent.click(screen.getByRole('button',{name:'取消回复'}));expect(input()).toHaveValue('');
    type();pick();await success();expect(await count('user')).toBe(2);expect(await count('agent')).toBe(1);
    expect(new Set((await comments()).map(c=>c.id)).size).toBe(3);
  });

  it('editing the draft starts a new comment without discarding the acknowledged one',async()=>{
    mocks.ai.mockRejectedValueOnce(new Error('synthetic failure'));render(panel());type('first');pick();await failVisible();
    type('second');pick();await success();
    expect((await comments()).filter(c=>c.actorType==='user').map(c=>c.body)).toEqual(['first','second']);
  });

  it('explicitly sending the same text as another plain comment remains allowed',async()=>{
    mocks.ai.mockRejectedValueOnce(new Error('synthetic failure'));render(panel());type();pick();await failVisible();
    fireEvent.click(screen.getByRole('button',{name:'另发评论'}));await success();
    expect(await count('user')).toBe(2);expect(await count('agent')).toBe(0);
  });

  it('changing the retry reply agent keeps the submitted user comment',async()=>{
    mocks.ai.mockRejectedValueOnce(new Error('synthetic failure'));render(panel());type();pick();await failVisible();pick(1);await success();
    expect(await count('user')).toBe(1);expect((await comments()).find(c=>c.actorType==='agent')?.actorId).toBe(B.id);
  });

  it('cancel while AI is pending permits a new same-text operation and discards the old AI result',async()=>{
    const old=deferred<string>();mocks.ai.mockReturnValueOnce(old.promise);render(panel());type();pick();
    await waitFor(()=>expect(mocks.ai).toHaveBeenCalledTimes(1));fireEvent.click(screen.getByRole('button',{name:'取消回复'}));
    type();pick();await success();await act(async()=>old.resolve('obsolete AI'));
    expect(await count('user')).toBe(2);expect((await comments()).filter(c=>c.actorType==='agent').map(c=>c.body)).toEqual(['AI reply']);expect(input()).toHaveValue('');
  });

  it.each(['success','error'] as const)('old owner AI %s cannot clear a new operation or publish after owner changes',async outcome=>{
    const old=deferred<string>();const current=deferred<string>();mocks.ai.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const ui=render(panel());type('old A');pick();await waitFor(()=>expect(mocks.ai).toHaveBeenCalledTimes(1));
    ui.rerender(panel(B.id));expect(input()).toHaveValue('');type('new B');pick();await waitFor(()=>expect(mocks.ai).toHaveBeenCalledTimes(2));
    await act(async()=>{if(outcome==='success')old.resolve('old result');else old.reject(new Error('old error'));});
    expect(input()).toHaveValue('new B');expect(input()).toBeDisabled();expect(screen.queryByText(/old error/)).not.toBeInTheDocument();expect(await count('agent')).toBe(0);
    await act(async()=>current.resolve('current result'));await success();expect(await count('user')).toBe(2);expect(await count('agent')).toBe(1);
  });

  it('A → B → A expires the first A operation even though the post stays in the aggregate feed',async()=>{
    const old=deferred<string>();mocks.ai.mockReturnValueOnce(old.promise);const ui=render(panel());type();pick();await waitFor(()=>expect(mocks.ai).toHaveBeenCalledTimes(1));
    ui.rerender(panel(B.id));ui.rerender(panel(A.id));type('new A draft');await act(async()=>old.resolve('stale'));expect(input()).toHaveValue('new A draft');expect(await count('agent')).toBe(0);
  });

  it('refresh/remount does not restore or resend a partially completed operation',async()=>{
    const old=deferred<string>();mocks.ai.mockReturnValueOnce(old.promise);const ui=render(panel());type();pick();await waitFor(()=>expect(mocks.ai).toHaveBeenCalledTimes(1));ui.unmount();
    render(panel());expect(input()).toHaveValue('');expect(screen.queryByRole('button',{name:'取消回复'})).not.toBeInTheDocument();
    await act(async()=>old.resolve('stale'));expect(await count('user')).toBe(1);expect(await count('agent')).toBe(0);expect(mocks.add).toHaveBeenCalledTimes(1);
  });

  it('cancel during an already-started user save keeps its original owner but starts no AI',async()=>{
    const save=deferred<void>();const add=store.addComment;
    mocks.add.mockImplementationOnce(async (...args: Parameters<typeof add>)=>{const result=await add(...args);await save.promise;return result;});
    render(panel());type();pick();await waitFor(()=>expect(mocks.add).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button',{name:'取消回复'}));type('independent draft');await act(async()=>save.resolve());
    expect(await count('user')).toBe(1);expect(mocks.ai).not.toHaveBeenCalled();expect(input()).toHaveValue('independent draft');expect(input()).toBeEnabled();
  });

  it.each([
    ['cancel','success'], ['cancel','error'], ['owner','success'], ['owner','error'],
  ] as const)('already-started agent save stays with its original post after %s and late %s does not clear a newer request',async (transition,outcome)=>{
    const saved=deferred<void>();const finish=deferred<void>();const nextAi=deferred<string>();
    const add=store.addComment;let intercepted=false;
    mocks.add.mockImplementation(async (...args: Parameters<typeof add>)=>{
      const result=await add(...args);
      if(args[2].actorType==='agent' && !intercepted){intercepted=true;saved.resolve();await finish.promise;}
      return result;
    });
    mocks.ai.mockResolvedValueOnce('old reply').mockReturnValueOnce(nextAi.promise);
    const ui=render(panel());type('old comment');pick();await act(async()=>saved.promise);
    if(transition==='cancel')fireEvent.click(screen.getByRole('button',{name:'取消回复'}));
    else ui.rerender(panel(B.id));
    type('new comment');pick();await waitFor(()=>expect(mocks.ai).toHaveBeenCalledTimes(2));
    await act(async()=>{if(outcome==='success')finish.resolve();else finish.reject(new Error('obsolete save receipt'));});
    expect(input()).toHaveValue('new comment');expect(input()).toBeDisabled();
    expect(screen.queryByText(/obsolete save receipt/)).not.toBeInTheDocument();
    expect((await comments()).filter(c=>c.actorType==='agent').map(c=>c.body)).toEqual(['old reply']);
    expect(await store.listPosts(B.id)).toEqual([]);
    await act(async()=>nextAi.resolve('new reply'));await success();
    expect(await count('user')).toBe(2);expect(await count('agent')).toBe(2);
  });

  it('a deleted post or failed retry read surfaces its error and never re-appends the user',async()=>{
    mocks.ai.mockRejectedValueOnce(new Error('synthetic failure'));render(panel());type();pick();await failVisible();
    mocks.list.mockRejectedValueOnce(new Error('synthetic failure retry read'));pick();await screen.findByText(/retry read/);expect(mocks.ai).toHaveBeenCalledTimes(1);
    await store.deletePost(A.id,post.id);pick();await screen.findByText(/评论不存在/);expect(mocks.ai).toHaveBeenCalledTimes(1);expect(mocks.add).toHaveBeenCalledTimes(1);
  });
});

describe('explicit comment ID CAS compatibility',()=>{
  it('same-ID concurrent retries append once, while distinct IDs with identical text both append',async()=>{
    const actor={actorType:'user' as const,actorId:'user',actorName:'我'};
    await Promise.all([store.addComment(A.id,post.id,actor,'same',{id:'operation-user'}),createXingyeMomentStore(backend).addComment(A.id,post.id,actor,'same',{id:'operation-user'})]);
    expect(await count('user')).toBe(1);
    await store.addComment(A.id,post.id,actor,'same',{id:'independent-user'});expect(await count('user')).toBe(2);
    await expect(store.addComment(A.id,post.id,actor,'different',{id:'operation-user'})).rejects.toThrow(/冲突/);
    await expect(store.addComment(A.id,post.id,{...actor,actorId:'other'},'same',{id:'operation-user'})).rejects.toThrow(/冲突/);
    expect(await count('user')).toBe(2);
  });
  it('legacy calls still allow intentional repeated text and generated IDs',async()=>{
    const actor={actorType:'user' as const,actorId:'user',actorName:'我'};
    await store.addComment(A.id,post.id,actor,'repeat');await store.addComment(A.id,post.id,actor,'repeat');
    expect(await count('user')).toBe(2);expect(new Set((await comments()).map(c=>c.id)).size).toBe(2);
  });
});
