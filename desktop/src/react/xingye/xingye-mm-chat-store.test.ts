/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const postMock = vi.hoisted(() => vi.fn());

vi.mock('./xingye-storage-api', () => ({
  postXingyeStorage: postMock,
}));

import {
  appendMmChatTurnsToSession,
  createMmChatSession,
  deleteMmChatSession,
  readMmChatPersistence,
  saveMmChatPersistence,
  sortMmChatSessionsByUpdatedAtDesc,
  XINGYE_MM_CHAT_SESSIONS_JSON,
} from './xingye-mm-chat-store';

describe('xingye-mm-chat-store', () => {
  beforeEach(() => {
    postMock.mockReset();
  });

  it('readMmChatPersistence preserves turn meta.followUpUserHint', async () => {
    postMock.mockResolvedValueOnce({
      data: {
        version: 1,
        activeSessionId: '',
        sessions: [
          {
            id: 's1',
            title: 'T',
            preview: 'P',
            messages: [
              {
                id: 'm1',
                role: 'ta',
                text: '角色生成的完整追问句',
                meta: { followUpUserHint: '想要更委婉' },
              },
            ],
          },
        ],
      },
    });
    const row = await readMmChatPersistence('agent-x');
    expect(row?.sessions[0]?.messages[0]?.text).toBe('角色生成的完整追问句');
    expect(row?.sessions[0]?.messages[0]?.meta?.followUpUserHint).toBe('想要更委婉');
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

  it('appendMmChatTurnsToSession merges messages and writes', async () => {
    const sid = 'sess-1';
    postMock
      .mockResolvedValueOnce({
        data: {
          version: 1,
          activeSessionId: '',
          sessions: [
            {
              id: sid,
              title: '睡眠',
              preview: '旧摘要',
              messages: [
                { id: 'm1', role: 'ta', text: 'Q1', createdAt: '2026-01-01T00:00:00.000Z' },
                { id: 'm2', role: 'ai', text: 'A1', createdAt: '2026-01-01T00:00:00.000Z' },
              ],
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        },
      })
      .mockResolvedValueOnce({ ok: true });
    const out = await appendMmChatTurnsToSession(
      'agent-x',
      sid,
      [
        { id: 'm3', role: 'ta', text: 'Q2' },
        { id: 'm4', role: 'ai', text: '新的助手回答若干字' },
      ],
      { preview: '自定义预览' },
    );
    expect(out?.messages).toHaveLength(4);
    expect(out?.preview).toBe('自定义预览');
    const writeCall = postMock.mock.calls.find((c) => (c[0] as { action?: string }).action === 'writeJson');
    expect(writeCall).toBeDefined();
    const payload = (writeCall![0] as { data: { sessions: { id: string; messages: unknown[] }[] } }).data;
    expect(payload.sessions[0]!.id).toBe(sid);
    expect(payload.sessions[0]!.messages).toHaveLength(4);
  });

  it('appendMmChatTurnsToSession returns null when session id not found', async () => {
    postMock.mockResolvedValueOnce({
      data: { version: 1, activeSessionId: '', sessions: [] },
    });
    await expect(
      appendMmChatTurnsToSession('agent-x', 'missing', [{ id: 'x', role: 'ta', text: 'a' }]),
    ).resolves.toBeNull();
  });

  describe('initializedAt preservation', () => {
    const INIT_AT = '2026-05-20T08:00:00.000Z';

    it('readMmChatPersistence parses initializedAt from disk', async () => {
      postMock.mockResolvedValueOnce({
        data: {
          version: 1,
          activeSessionId: '',
          sessions: [],
          initializedAt: INIT_AT,
        },
      });
      const row = await readMmChatPersistence('agent-x');
      expect(row?.initializedAt).toBe(INIT_AT);
    });

    it('readMmChatPersistence drops invalid initializedAt silently', async () => {
      postMock.mockResolvedValueOnce({
        data: {
          version: 1,
          activeSessionId: '',
          sessions: [],
          initializedAt: 'not-a-date',
        },
      });
      const row = await readMmChatPersistence('agent-x');
      expect(row?.initializedAt).toBeUndefined();
    });

    it('createMmChatSession preserves initializedAt from disk', async () => {
      postMock
        .mockResolvedValueOnce({
          data: { version: 1, activeSessionId: '', sessions: [], initializedAt: INIT_AT },
        })
        .mockResolvedValueOnce({ ok: true });
      await createMmChatSession('agent-x', {
        title: 'T',
        preview: 'P',
        messages: [{ id: 'm1', role: 'ta', text: 'q' }, { id: 'm2', role: 'ai', text: 'a' }],
      });
      const writeCall = postMock.mock.calls.find((c) => (c[0] as { action?: string }).action === 'writeJson');
      const payload = (writeCall![0] as { data: { initializedAt?: string } }).data;
      expect(payload.initializedAt).toBe(INIT_AT);
    });

    it('appendMmChatTurnsToSession preserves initializedAt from disk', async () => {
      const sid = 's1';
      postMock
        .mockResolvedValueOnce({
          data: {
            version: 1,
            activeSessionId: '',
            sessions: [
              {
                id: sid,
                title: 'T',
                preview: 'P',
                messages: [
                  { id: 'm1', role: 'ta', text: 'Q', createdAt: '2026-01-01T00:00:00.000Z' },
                  { id: 'm2', role: 'ai', text: 'A', createdAt: '2026-01-01T00:00:00.000Z' },
                ],
              },
            ],
            initializedAt: INIT_AT,
          },
        })
        .mockResolvedValueOnce({ ok: true });
      await appendMmChatTurnsToSession('agent-x', sid, [
        { id: 'm3', role: 'ta', text: 'Q2' },
        { id: 'm4', role: 'ai', text: 'A2' },
      ]);
      const writeCall = postMock.mock.calls.find((c) => (c[0] as { action?: string }).action === 'writeJson');
      const payload = (writeCall![0] as { data: { initializedAt?: string } }).data;
      expect(payload.initializedAt).toBe(INIT_AT);
    });

    it('deleteMmChatSession preserves initializedAt even after deleting all sessions', async () => {
      const sid = 's-only';
      postMock
        .mockResolvedValueOnce({
          data: {
            version: 1,
            activeSessionId: '',
            sessions: [
              { id: sid, title: 'T', preview: 'P', messages: [{ id: 'm1', role: 'ta', text: 'q' }] },
            ],
            initializedAt: INIT_AT,
          },
        })
        .mockResolvedValueOnce({ ok: true });
      await deleteMmChatSession('agent-x', sid);
      const writeCall = postMock.mock.calls.find((c) => (c[0] as { action?: string }).action === 'writeJson');
      const payload = (writeCall![0] as { data: { initializedAt?: string; sessions: unknown[] } }).data;
      expect(payload.sessions).toHaveLength(0);
      // 删光后仍保留 initializedAt → 防止"删光 → 自动重 bootstrap"。
      expect(payload.initializedAt).toBe(INIT_AT);
    });
  });
});
