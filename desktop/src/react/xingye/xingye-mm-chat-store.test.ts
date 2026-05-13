/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const postMock = vi.hoisted(() => vi.fn());

vi.mock('./xingye-storage-api', () => ({
  postXingyeStorage: postMock,
}));

import {
  readMmChatPersistence,
  saveMmChatPersistence,
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
});
