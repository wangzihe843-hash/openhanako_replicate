import { describe, expect, it, vi } from 'vitest';
import { cancelDesktopSessionSubmission, submitDesktopSessionMessage } from '../core/desktop-session-submit.ts';
/* eslint-disable @typescript-eslint/no-explicit-any -- focused runtime boundary test fixtures */
import {
  AgentReviewTurnCoordinator,
  buildReviewedTurnPrompt,
  buildReviewerPrompt,
  buildSessionReferenceBlock,
} from '../lib/agent-review/turn-coordinator.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

describe('AgentReviewTurnCoordinator', () => {
  function cancellationFixture(parentSubmit?: (engine: any, input: any) => Promise<any>) {
    const reviewer = Promise.withResolvers<{ text: string }>();
    const parent = Promise.withResolvers<void>();
    const committed = vi.fn();
    const engine = {
      emitEvent: vi.fn(), abortSession: vi.fn(async () => true),
      getSessionManifest: vi.fn(() => null),
      createDetachedSession: vi.fn(async () => ({ sessionId: 'sess_review', sessionPath: '/review.jsonl' })),
      getSessionByPath: vi.fn(() => ({ model: { id: 'synthetic-model', provider: 'mock' } })),
    };
    const submitSessionMessage = vi.fn(async (_engine, input) => {
      if (input.sessionId === 'sess_review') return reviewer.promise;
      if (parentSubmit) return parentSubmit(_engine, input);
      await parent.promise;
      input.beforeInputSideEffects?.();
      committed();
      return { text: 'parent reply' };
    });
    const statuses: any[] = [];
    const coordinator = new AgentReviewTurnCoordinator({ engine, submitSessionMessage, emitStatus: status => statuses.push(status) });
    const running = coordinator.start({ reviewedSessionId: 'sess_parent', reviewedSessionPath: '/parent.jsonl',
      reviewer: { agentId: 'critic' }, text: 'Review synthetic history' });
    return { coordinator, engine, submitSessionMessage, reviewer, parent, running, statuses, committed };
  }

  it('hands parent cancellation back after review, fencing a parent submit still awaiting preflight', async () => {
    const f = cancellationFixture();
    f.reviewer.resolve({ text: 'Findings' });
    await vi.waitFor(() => expect(f.submitSessionMessage).toHaveBeenCalledTimes(2));
    f.engine.emitEvent.mockClear();

    expect(await f.coordinator.cancelByParent('sess_parent')).toBe(false);
    expect(f.engine.abortSession).not.toHaveBeenCalled();
    expect(f.engine.emitEvent).not.toHaveBeenCalled();
    f.parent.resolve();
    await f.running;
    expect(f.committed).not.toHaveBeenCalled();
    expect(f.coordinator.hasPendingParent('sess_parent')).toBe(false);
    expect(f.statuses.at(-1).status).toBe('completed');
  });

  it('allows the normal stop path to cancel a real pending parent submission without late terminal events', async () => {
    const loading = Promise.withResolvers<any>();
    const f = cancellationFixture(submitDesktopSessionMessage);
    Object.assign(f.engine, {
      ensureSessionLoaded: vi.fn(() => loading.promise), promptSession: vi.fn(),
      getSessionManifest: () => ({ currentLocator: { path: '/parent.jsonl' } }),
    });
    f.reviewer.resolve({ text: 'Findings' });
    await vi.waitFor(() => expect(f.submitSessionMessage).toHaveBeenCalledTimes(2));
    f.engine.emitEvent.mockClear();
    const delegated = await f.coordinator.cancelByParent('sess_parent');
    if (!delegated) cancelDesktopSessionSubmission(f.engine, '/parent.jsonl');
    loading.resolve({ subscribe: vi.fn(() => vi.fn()) });
    await f.running;

    expect(delegated).toBe(false);
    expect(f.engine.abortSession).not.toHaveBeenCalled();
    expect((f.engine as any).promptSession).not.toHaveBeenCalled();
    expect(f.engine.emitEvent).not.toHaveBeenCalled();
  });

  it('does not mark a replacement parent stream idle after delayed reviewer cancellation', async () => {
    const f = cancellationFixture();
    await vi.waitFor(() => expect(f.submitSessionMessage).toHaveBeenCalledOnce());
    const stopped = Promise.withResolvers<boolean>();
    f.engine.abortSession.mockReturnValueOnce(stopped.promise);
    let ownsStream = true;
    const cancelling = f.coordinator.cancelByParent('sess_parent', 'user_abort', () => ownsStream);
    ownsStream = false;
    f.engine.emitEvent.mockClear();
    stopped.resolve(true);
    await cancelling;
    f.reviewer.reject(new Error('reviewer stopped'));
    await f.running;

    expect(f.engine.emitEvent).not.toHaveBeenCalled();
    expect(f.submitSessionMessage).toHaveBeenCalledOnce();
    expect(f.coordinator.hasPendingParent('sess_parent')).toBe(false);
  });

  it('ends a cancelled review only after reviewer stop settles', async () => {
    const f = cancellationFixture();
    await vi.waitFor(() => expect(f.submitSessionMessage).toHaveBeenCalledOnce());
    const stopped = Promise.withResolvers<boolean>();
    f.engine.abortSession.mockReturnValueOnce(stopped.promise);
    const cancelling = f.coordinator.cancelByParent('sess_parent');
    expect(f.engine.emitEvent.mock.calls.some(([event]) => event.isStreaming === false)).toBe(false);
    stopped.resolve(true);
    expect(await cancelling).toBe(true);
    f.reviewer.resolve({ text: 'late findings' });
    await f.running;
    expect(f.submitSessionMessage).toHaveBeenCalledOnce();
    expect(f.engine.emitEvent).toHaveBeenLastCalledWith({ type: 'session_status', isStreaming: false }, '/parent.jsonl');
  });

  it('holds the parent turn until the independent reviewer Session completes', async () => {
    const reviewer = deferred<{ text: string }>();
    const calls: any[] = [];
    const engine = {
      emitEvent: vi.fn(),
      getSessionManifest: vi.fn(() => ({ workspaceScope: { cwd: '/work', workspaceFolders: [], authorizedFolders: [] } })),
      createDetachedSession: vi.fn(async () => ({ sessionId: 'sess_review', sessionPath: '/review.jsonl' })),
      getSessionIdForPath: vi.fn(() => 'sess_review'),
      getSessionByPath: vi.fn(() => ({ model: { id: 'shared-model', provider: 'openai' } })),
    };
    const submitSessionMessage = vi.fn(async (_engine, input) => {
      calls.push(input);
      if (input.sessionId === 'sess_review') return reviewer.promise;
      return { text: 'parent reply' };
    });
    const statuses: any[] = [];
    const coordinator = new AgentReviewTurnCoordinator({
      engine,
      submitSessionMessage,
      emitStatus: status => statuses.push(status),
    });

    const running = coordinator.start({
      requestId: 'client-1',
      reviewedSessionId: 'sess_parent',
      reviewedSessionPath: '/parent.jsonl',
      reviewer: { agentId: 'critic', label: 'Critic' },
      text: 'Please inspect this @Critic',
      sessionRefs: [{ sessionId: 'sess_context', label: 'Context' }],
      clientMessageId: 'client-1',
      displayMessage: { text: 'Please inspect this @Critic' },
    });

    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(coordinator.hasPendingParent('sess_parent')).toBe(true);
    expect(calls[0].sessionId).toBe('sess_review');
    expect(calls[0].text).toContain('被审阅 Session ID：sess_parent');

    reviewer.resolve({ text: 'Independent findings' });
    await running;

    expect(calls).toHaveLength(2);
    expect(calls[1].sessionId).toBe('sess_parent');
    expect(calls[1].text).toContain('[另一位 Agent 的审阅结果]');
    expect(calls[1].text).toContain('审阅记录所在 Session ID：sess_review');
    expect(calls[1].text).toContain('Independent findings');
    expect(calls[1].displayMessage.agentReview).toMatchObject({
      reviewedSessionId: 'sess_parent',
      reviewerSessionId: 'sess_review',
      reviewerAgentId: 'critic',
    });
    expect(coordinator.hasPendingParent('sess_parent')).toBe(false);
    expect(statuses.map(status => status.status)).toContain('completed');
    expect(engine.createDetachedSession).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'critic', visibleInSessionList: true, permissionMode: 'read_only',
      model: { id: 'shared-model', provider: 'openai' },
    }));
  });

  it('fails visibly and never invokes the parent Agent when review fails', async () => {
    const statuses: any[] = [];
    const engine = {
      emitEvent: vi.fn(),
      getSessionManifest: vi.fn(() => null),
      createDetachedSession: vi.fn(async () => ({ sessionId: 'sess_review', sessionPath: '/review.jsonl' })),
      getSessionIdForPath: vi.fn(() => 'sess_review'),
      getSessionByPath: vi.fn(() => ({ model: { id: 'shared-model', provider: 'openai' } })),
    };
    const submitSessionMessage = vi.fn(async () => { throw new Error('resolver denied'); });
    const coordinator = new AgentReviewTurnCoordinator({
      engine,
      submitSessionMessage,
      emitStatus: status => statuses.push(status),
    });

    await coordinator.start({
      reviewedSessionId: 'sess_parent', reviewedSessionPath: '/parent.jsonl',
      reviewer: { agentId: 'critic' }, text: 'Review',
    });

    expect(submitSessionMessage).toHaveBeenCalledTimes(1);
    expect(statuses.at(-1)).toMatchObject({ status: 'failed', error: 'resolver denied' });
    expect(engine.emitEvent).toHaveBeenLastCalledWith(
      { type: 'session_status', isStreaming: false }, '/parent.jsonl',
    );
  });

  it('formats IDs as references without creating relationship fields', () => {
    expect(buildSessionReferenceBlock([{ sessionId: 'sess_a', label: 'A' }])).toContain('sess_a');
    expect(buildReviewerPrompt({ reviewedSessionId: 'sess_parent', userText: 'Check' })).toContain('自行决定');
    expect(buildReviewedTurnPrompt({
      userText: 'Check', reviewedSessionId: 'sess_parent', reviewerSessionId: 'sess_review',
      reviewerAgentId: 'critic', reviewerAgentName: 'Critic', reviewText: 'OK',
    })).not.toMatch(/parentSessionId|childSessionId|relationId/);
  });
});
