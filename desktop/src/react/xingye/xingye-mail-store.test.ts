/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const postMock = vi.hoisted(() => vi.fn());

vi.mock('./xingye-storage-api', () => ({
  postXingyeStorage: postMock,
}));

import {
  appendMailMessage,
  appendMailMessages,
  buildXingyeMailAddress,
  deleteMailMessage,
  ensureMailProfile,
  getMailProfile,
  listMailMessages,
  listMailMessagesByMailbox,
  setMailMessageStar,
  updateMailMessage,
  XINGYE_MAIL_DOMAIN,
  XINGYE_MAIL_MESSAGES_JSONL,
  XINGYE_MAIL_PROFILE_JSON,
} from './xingye-mail-store';

type Call = {
  action: string;
  agentId?: string;
  relativePath?: string;
  data?: unknown;
  recordId?: string;
};

function lastCall(action: string): Call {
  const calls = postMock.mock.calls.map((c) => c[0] as Call);
  const found = [...calls].reverse().find((c) => c.action === action);
  if (!found) throw new Error(`No call with action ${action} (had: ${calls.map((c) => c.action).join(',')})`);
  return found;
}

describe('xingye-mail-store', () => {
  beforeEach(() => {
    postMock.mockReset();
  });

  it('buildXingyeMailAddress produces an agent-style local part on the simulated domain', () => {
    const address = buildXingyeMailAddress({
      agentId: 'linwu',
      displayName: '林雾',
      agentName: '林雾',
    });
    expect(address.endsWith(`@${XINGYE_MAIL_DOMAIN}`)).toBe(true);
    // 中文显示名会被剥成 ascii 安全后缀，回退到 agentId
    expect(address.startsWith('linwu.')).toBe(true);
  });

  it('getMailProfile returns null when the file is missing', async () => {
    postMock.mockResolvedValueOnce({ ok: true, missing: true });
    const profile = await getMailProfile('linwu');
    expect(profile).toBeNull();
    expect(postMock).toHaveBeenCalledWith({
      action: 'readJson',
      agentId: 'linwu',
      relativePath: XINGYE_MAIL_PROFILE_JSON,
    });
  });

  it('ensureMailProfile writes a new profile when none exists and returns it', async () => {
    postMock
      .mockResolvedValueOnce({ ok: true, missing: true })
      .mockResolvedValueOnce({ ok: true });
    const profile = await ensureMailProfile('linwu', { displayName: '林雾' });
    expect(profile.agentId).toBe('linwu');
    expect(profile.address.endsWith(`@${XINGYE_MAIL_DOMAIN}`)).toBe(true);
    expect(profile.displayName).toBe('林雾');
    const writeCall = lastCall('writeJson');
    expect(writeCall.relativePath).toBe(XINGYE_MAIL_PROFILE_JSON);
    expect((writeCall.data as { agentId: string }).agentId).toBe('linwu');
  });

  it('ensureMailProfile does not overwrite when a profile already exists', async () => {
    postMock.mockResolvedValueOnce({
      ok: true,
      data: {
        agentId: 'linwu',
        address: 'linwu.abcd@hana.mail',
        displayName: '林雾',
        createdAt: '2026-05-10T10:00:00.000Z',
        updatedAt: '2026-05-10T10:00:00.000Z',
      },
    });
    const profile = await ensureMailProfile('linwu', { displayName: '林雾(new)' });
    expect(profile.address).toBe('linwu.abcd@hana.mail');
    expect(postMock.mock.calls.filter((c) => (c[0] as Call).action === 'writeJson')).toHaveLength(0);
  });

  it('ensureMailProfile rejects invalid agentId before calling backend', async () => {
    await expect(ensureMailProfile('bad id', { displayName: '林雾' })).rejects.toThrow(/agentId/);
    expect(postMock).not.toHaveBeenCalled();
  });

  it('appendMailMessage stores normalized message and id===key', async () => {
    postMock.mockResolvedValueOnce({ ok: true });
    const message = await appendMailMessage('linwu', {
      mailbox: 'inbox',
      from: { name: '系统', address: 'system@hana.mail', kind: 'system' },
      to: [{ name: '林雾', address: 'linwu.abcd@hana.mail' }],
      subject: '欢迎',
      body: '这是一封模拟邮件',
      autoStarred: true,
      labels: ['系统'],
    });
    expect(message.id).toBeTruthy();
    expect(message.key).toBe(message.id);
    expect(message.mailbox).toBe('inbox');
    expect(message.autoStarred).toBe(true);
    const append = lastCall('appendJsonl');
    expect(append.relativePath).toBe(XINGYE_MAIL_MESSAGES_JSONL);
    const data = append.data as { id: string; key: string; agentId: string; mailbox: string };
    expect(data.id).toBe(data.key);
    expect(data.agentId).toBe('linwu');
    expect(data.mailbox).toBe('inbox');
  });

  it('appendMailMessage rejects when subject and body are both empty', async () => {
    await expect(
      appendMailMessage('linwu', {
        mailbox: 'inbox',
        from: { name: '系统', address: 'system@hana.mail', kind: 'system' },
        to: [],
        subject: '   ',
        body: '',
      }),
    ).rejects.toThrow(/标题与正文/);
    expect(postMock).not.toHaveBeenCalled();
  });

  it('listMailMessages returns normalized rows sorted by createdAt desc and ignores other agents', async () => {
    postMock.mockResolvedValueOnce({
      ok: true,
      records: [
        {
          id: 'm1', agentId: 'linwu', mailbox: 'inbox',
          from: { name: '同事', address: 'a@hana.mail', kind: 'virtual_contact' },
          to: [], subject: '旧邮件', body: 'old',
          isRead: true, isStarred: false, labels: [],
          createdAt: '2026-05-10T10:00:00.000Z', updatedAt: '2026-05-10T10:00:00.000Z',
        },
        {
          id: 'm2', agentId: 'linwu', mailbox: 'promotions',
          from: { name: '推广', address: 'p@hana.mail', kind: 'promotion' },
          to: [], subject: '新推广', body: 'new',
          isRead: false, isStarred: false, labels: ['促销'],
          createdAt: '2026-05-15T10:00:00.000Z', updatedAt: '2026-05-15T10:00:00.000Z',
        },
        { bad: 1 },
        {
          id: 'm3', agentId: 'other', mailbox: 'inbox',
          from: { name: '别人', address: 'o@hana.mail', kind: 'agent' },
          to: [], subject: 'leak', body: 'leak',
          isRead: false, isStarred: false, labels: [],
          createdAt: '2026-05-15T10:00:00.000Z',
        },
      ],
    });
    const rows = await listMailMessages('linwu');
    expect(rows.map((r) => r.id)).toEqual(['m2', 'm1']);
    expect(rows[0].mailbox).toBe('promotions');
  });

  it('listMailMessagesByMailbox filters by mailbox', async () => {
    postMock.mockResolvedValueOnce({
      ok: true,
      records: [
        {
          id: 'a', agentId: 'linwu', mailbox: 'inbox',
          from: { name: 'a', address: 'a@hana.mail', kind: 'system' },
          to: [], subject: 'A', body: 'a',
          isRead: false, isStarred: false, labels: [],
          createdAt: '2026-05-15T10:00:00.000Z',
        },
        {
          id: 'b', agentId: 'linwu', mailbox: 'spam',
          from: { name: 'b', address: 'b@spam.junk', kind: 'spam' },
          to: [], subject: 'B', body: 'b',
          isRead: false, isStarred: false, labels: [],
          createdAt: '2026-05-15T11:00:00.000Z',
        },
      ],
    });
    const inbox = await listMailMessagesByMailbox('linwu', 'inbox');
    expect(inbox.map((r) => r.id)).toEqual(['a']);
  });

  it('appendMailMessages writes drafts in order with monotonically increasing timestamps', async () => {
    postMock.mockResolvedValue({ ok: true });
    const drafts = [
      {
        mailbox: 'inbox' as const,
        from: { name: 'a', address: 'a@hana.mail', kind: 'system' as const },
        to: [{ name: 'linwu', address: 'linwu.abcd@hana.mail' }],
        subject: 'first', body: 'first body',
      },
      {
        mailbox: 'inbox' as const,
        from: { name: 'b', address: 'b@hana.mail', kind: 'system' as const },
        to: [{ name: 'linwu', address: 'linwu.abcd@hana.mail' }],
        subject: 'second', body: 'second body',
      },
    ];
    const stored = await appendMailMessages('linwu', drafts);
    expect(stored.map((m) => m.subject)).toEqual(['first', 'second']);
    const ts0 = Date.parse(stored[0].createdAt);
    const ts1 = Date.parse(stored[1].createdAt);
    expect(ts1).toBeGreaterThan(ts0);
  });

  it('setMailMessageStar updates the message by deleting and re-appending it', async () => {
    postMock
      // listJsonl
      .mockResolvedValueOnce({
        ok: true,
        records: [
          {
            id: 'm1', agentId: 'linwu', mailbox: 'inbox',
            from: { name: '系统', address: 'system@hana.mail', kind: 'system' },
            to: [], subject: '欢迎', body: 'hello',
            isRead: false, isStarred: false, labels: [],
            createdAt: '2026-05-15T10:00:00.000Z', updatedAt: '2026-05-15T10:00:00.000Z',
          },
        ],
      })
      // deleteJsonlRecord
      .mockResolvedValueOnce({ ok: true, deleted: true })
      // appendJsonl
      .mockResolvedValueOnce({ ok: true });
    const updated = await setMailMessageStar('linwu', 'm1', true);
    expect(updated?.isStarred).toBe(true);
    const del = lastCall('deleteJsonlRecord');
    expect(del.recordId).toBe('m1');
    const append = lastCall('appendJsonl');
    const data = append.data as { id: string; isStarred: boolean };
    expect(data.id).toBe('m1');
    expect(data.isStarred).toBe(true);
  });

  it('updateMailMessage returns null when message does not exist', async () => {
    postMock.mockResolvedValueOnce({ ok: true, records: [] });
    const result = await updateMailMessage('linwu', 'missing', { isStarred: true });
    expect(result).toBeNull();
  });

  it('deleteMailMessage forwards recordId to deleteJsonlRecord', async () => {
    postMock.mockResolvedValueOnce({ ok: true, deleted: true });
    await expect(deleteMailMessage('linwu', 'm1')).resolves.toBe(true);
    expect(postMock).toHaveBeenCalledWith({
      action: 'deleteJsonlRecord',
      agentId: 'linwu',
      relativePath: XINGYE_MAIL_MESSAGES_JSONL,
      recordId: 'm1',
    });
  });
});
