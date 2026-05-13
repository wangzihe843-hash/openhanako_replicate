/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const postMock = vi.hoisted(() => vi.fn());

vi.mock('./xingye-storage-api', () => ({
  postXingyeStorage: postMock,
}));

import {
  createMmChatSession,
  readMmChatPersistence,
  saveMmChatPersistence,
  sortMmChatSessionsByUpdatedAtDesc,
  XINGYE_MM_CHAT_SESSIONS_JSON,
} from './xingye-mm-chat-store';

describe('xingye-mm-chat-store', () => {
  beforeEach(() => {
    postMock.mockReset();
  });

  it('readMmChatPersistence uses readJson', async () => {
    postMock.mockResolvedValueOnce({
      data: {
        version: 1,
        activeSessionId: 's1',
        sessions: [
          { id: 's1', title: 'T', preview: 'P', messages: [{ id: 'm1', role: 'ta', text: 'hi' }] },
        ],
      },
    });
    const row = await readMmChatPersistence('agent-x');
    expect(postMock).toHaveBeenCalledWith({
      action: 'readJson',
      agentId: 'agent-x',
      relativePath: XINGYE_MM_CHAT_SESSIONS_JSON,
    });
    expect(row?.activeSessionId).toBe('s1');
    expect(row?.sessions).toHaveLength(1);
  });

  it('readMmChatPersistence accepts empty sessions list', async () => {
    postMock.mockResolvedValueOnce({
      data: { version: 1, activeSessionId: '', sessions: [] },
    });
    const row = await readMmChatPersistence('agent-x');
    expect(row?.sessions).toEqual([]);
    expect(row?.activeSessionId).toBe('');
  });

  it('saveMmChatPersistence posts writeJson', async () => {
    postMock.mockResolvedValueOnce({ ok: true });
    await saveMmChatPersistence('agent-x', {
      version: 1,
      activeSessionId: 's1',
      sessions: [{ id: 's1', title: 'T', preview: 'P', messages: [] }],
    });
    expect(postMock).toHaveBeenCalledWith({
      action: 'writeJson',
      agentId: 'agent-x',
      relativePath: XINGYE_MM_CHAT_SESSIONS_JSON,
      data: expect.objectContaining({ version: 1, activeSessionId: 's1' }),
    });
  });

  it('saveMmChatPersistence allows empty sessions with activeSessionId empty', async () => {
    postMock.mockResolvedValueOnce({ ok: true });
    await saveMmChatPersistence('agent-x', {
      version: 1,
      activeSessionId: '',
      sessions: [],
    });
    expect(postMock).toHaveBeenCalled();
  });

  it('rejects save when sessions empty but activeSessionId not empty', async () => {
    await expect(
      saveMmChatPersistence('agent-x', {
        version: 1,
        activeSessionId: 's1',
        sessions: [],
      }),
    ).rejects.toThrow(/activeSessionId/);
    expect(postMock).not.toHaveBeenCalled();
  });

  it('rejects invalid agentId on save', async () => {
    await expect(
      saveMmChatPersistence('bad id', {
        version: 1,
        activeSessionId: 's1',
        sessions: [{ id: 's1', title: 'T', preview: 'P', messages: [] }],
      }),
    ).rejects.toThrow(/agentId/);
    expect(postMock).not.toHaveBeenCalled();
  });

  it('createMmChatSession reads, appends, and writes', async () => {
    postMock
      .mockResolvedValueOnce({
        data: { version: 1, activeSessionId: '', sessions: [] },
      })
      .mockResolvedValueOnce({ ok: true });
    const created = await createMmChatSession('agent-x', {
      title: '咨询标题',
      preview: '摘要',
      messages: [
        { id: 'm1', role: 'ta', text: '问题？' },
        { id: 'm2', role: 'ai', text: '回答。' },
      ],
    });
    expect(created.title).toBe('咨询标题');
    expect(created.messages).toHaveLength(2);
    const writeCall = postMock.mock.calls.find((c) => (c[0] as { action?: string }).action === 'writeJson');
    expect(writeCall).toBeDefined();
    const payload = (writeCall![0] as { data: { sessions: { title: string }[] } }).data;
    expect(payload.sessions).toHaveLength(1);
    expect(payload.sessions[0]!.title).toBe('咨询标题');
  });

  it('sortMmChatSessionsByUpdatedAtDesc orders by updatedAt', () => {
    const a = {
      id: 'a',
      title: 'old',
      preview: 'p',
      messages: [],
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
    };
    const b = {
      id: 'b',
      title: 'new',
      preview: 'p',
      messages: [],
      createdAt: '2025-01-02T00:00:00.000Z',
      updatedAt: '2025-01-03T00:00:00.000Z',
    };
    expect(sortMmChatSessionsByUpdatedAtDesc([a, b]).map((s) => s.id)).toEqual(['b', 'a']);
  });
});
