import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { SessionManager } from '../lib/pi-sdk/index.ts';
import { applyStoredSessionBranchHead, syncSessionBranchHeadAfterAppend } from '../core/session-branch-head.ts';
import { createSessionsRoute } from '../server/routes/sessions.ts';
import { resolveXingyeSessionGreeting, seedXingyeSessionGreeting } from '../core/xingye-session-greeting.ts';

const roots: string[] = [];
function temporary() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xingye-greeting-')); roots.push(dir); return dir; }
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const profile = { displayName: '角色甲', firstMessage: '{{char}}向{{user}}问好。', alternateGreetings: ['备选开场'] };
const select = (overrides = {}) => resolveXingyeSessionGreeting({ agentId: 'a', index: 0, expectedText: profile.firstMessage,
  profile, character: '角色甲', user: '用户乙', ...overrides });

function sessionFixture() {
  const dir = temporary();
  const manager = SessionManager.create(dir, path.join(dir, 'sessions'));
  const session = { sessionManager: manager, agent: { state: { messages: [] as unknown[] } }, prompt: vi.fn(), sendCustomMessage: vi.fn() };
  return { manager, session };
}

describe('authored greeting lifecycle', () => {
  it('persists an actual assistant opening once, restores it, and keeps the live model transcript identical without generation', () => {
    const { manager, session } = sessionFixture();
    seedXingyeSessionGreeting(session, select(), 'a');
    let branchHead: unknown = null;
    const store = { getBranchHead: () => branchHead, setBranchHead: (_id: string, head: unknown) => { branchHead = head; return head; } };
    syncSessionBranchHeadAfterAppend({ store, sessionId: 'greeting-session', sessionManager: manager });
    expect(branchHead).toMatchObject({ leafId: manager.getLeafId(), observedTailLeafId: manager.getLeafId() });
    const reopened = SessionManager.open(manager.getSessionFile()!);
    applyStoredSessionBranchHead({ store, sessionId: 'greeting-session', sessionManager: reopened });
    expect(reopened.buildSessionContext().messages).toEqual(session.agent.state.messages);
    expect(session.agent.state.messages).toEqual([expect.objectContaining({ role: 'assistant', provider: 'hana', model: 'authored-greeting',
      content: [{ type: 'text', text: '角色甲向用户乙问好。' }], usage: expect.objectContaining({ totalTokens: 0 }) })]);
    expect(session.prompt).not.toHaveBeenCalled();
    expect(session.sendCustomMessage).not.toHaveBeenCalled();
    expect(() => seedXingyeSessionGreeting(session, select(), 'a')).toThrow('全新的空白聊天');
    expect(SessionManager.open(manager.getSessionFile()!).buildSessionContext().messages).toHaveLength(1);
  });

  it('handles explicit blank openings without adding empty assistant history', () => {
    const { manager, session } = sessionFixture();
    seedXingyeSessionGreeting(session, select({ index: -1, expectedText: '' }), 'a');
    expect(session.agent.state.messages).toEqual([]);
    expect(manager.buildSessionContext().messages).toEqual([]);
    expect(select({ index: 1, expectedText: '备选开场' }).text).toBe('备选开场');
    expect(select({ index: 101, expectedText: '备选101', profile: { alternateGreetings: Array.from({ length: 101 }, (_, i) => "备选" + (i + 1)) } }).text).toBe('备选101');
    expect(() => select({ profile: { firstMessage: '' }, expectedText: '' })).toThrow('为空');
  });

  it('rejects stale previews, invalid/oversized selections, another owner and preexisting history before any write', () => {
    for (const patch of [{ expectedText: '旧内容' }, { index: '0' }, { index: Number.MAX_SAFE_INTEGER + 1 }, { index: -2 }, { index: 3 },
      { profile: { firstMessage: '长'.repeat(16001) }, expectedText: '长'.repeat(16001) }]) expect(() => select(patch)).toThrow();
    const { manager, session } = sessionFixture();
    const append = vi.spyOn(manager, 'appendMessage');
    expect(() => seedXingyeSessionGreeting(session, select(), 'b')).toThrow('角色已变化');
    session.agent.state.messages = [{ role: 'user', content: '已有消息' }];
    expect(() => seedXingyeSessionGreeting(session, select(), 'a')).toThrow('全新的空白聊天');
    expect(append).not.toHaveBeenCalled();
  });

  it('does not change live state when persistence fails', () => {
    const { manager, session } = sessionFixture();
    vi.spyOn(manager, 'appendMessage').mockImplementation(() => { throw new Error('disk full'); });
    expect(() => seedXingyeSessionGreeting(session, select(), 'a')).toThrow('disk full');
    expect(session.agent.state.messages).toEqual([]);
  });
});

function routeFixture() {
  const dir = temporary();
  const profilePath = path.join(dir, 'agents', 'a', 'xingye', 'profile.json');
  fs.mkdirSync(path.dirname(profilePath), { recursive: true });
  fs.writeFileSync(profilePath, JSON.stringify(profile));
  const engine = { hanakoHome: dir, agentsDir: path.join(dir, 'agents'), cwd: dir, config: {},
    getAgent: vi.fn(id => id === 'a' ? { agentName: 'Agent A', userName: '用户乙' } : null),
    createDetachedSession: vi.fn(async (_options: Record<string, unknown>) => ({ sessionPath: path.join(dir, 'agents/a/sessions/new.jsonl'), sessionId: 'new', agentId: 'a' })),
    persistSessionMeta: vi.fn(), getSessionPermissionMode: () => 'ask' };
  const hub = { eventBus: { emit: vi.fn() } };
  const app = new Hono(); app.route('/api', createSessionsRoute(engine, hub));
  const post = (body: Record<string, unknown>) => app.request('/api/sessions/new-detached', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { engine, hub, post };
}

describe('new detached greeting selection', () => {
  it('binds the saved preview to the explicit owner, including blank opt-in, while ordinary creates remain unchanged', async () => {
    const { engine, post } = routeFixture();
    expect((await post({ agentId: 'a', xingyeGreetingIndex: 0, xingyeGreetingExpectedText: profile.firstMessage })).status).toBe(200);
    expect(engine.createDetachedSession).toHaveBeenLastCalledWith(expect.objectContaining({ initialXingyeGreeting: { agentId: 'a', text: '角色甲向用户乙问好。' } }));
    expect((await post({ agentId: 'a', xingyeGreetingIndex: -1, xingyeGreetingExpectedText: '' })).status).toBe(200);
    expect(engine.createDetachedSession).toHaveBeenLastCalledWith(expect.objectContaining({ initialXingyeGreeting: { agentId: 'a', text: '' } }));
    await post({ agentId: 'a' });
    expect(engine.createDetachedSession.mock.calls.at(-1)?.[0]).not.toHaveProperty('initialXingyeGreeting');
  });

  it('rejects changed preview/owner/work mode before creation and does not publish a failed create', async () => {
    const { engine, hub, post } = routeFixture();
    expect((await post({ agentId: 'a', xingyeGreetingIndex: 0, xingyeGreetingExpectedText: '旧内容' })).status).toBe(409);
    expect((await post({ agentId: 'b', xingyeGreetingIndex: -1, xingyeGreetingExpectedText: '' })).status).toBe(400);
    expect((await post({ agentId: 'a', workMode: true, xingyeGreetingIndex: -1, xingyeGreetingExpectedText: '' })).status).toBe(400);
    expect((await post({ agentId: 'a', xingyeGreetingIndex: 0, xingyeGreetingExpectedText: profile.firstMessage, xingyeGreetingExpectedRenderedText: '旧名称向用户问好' })).status).toBe(409);
    expect(engine.createDetachedSession).not.toHaveBeenCalled();
    engine.createDetachedSession.mockRejectedValueOnce(new Error('disk full'));
    expect((await post({ agentId: 'a', xingyeGreetingIndex: 0, xingyeGreetingExpectedText: profile.firstMessage })).status).toBe(500);
    expect(hub.eventBus.emit).not.toHaveBeenCalled();
  });
});
