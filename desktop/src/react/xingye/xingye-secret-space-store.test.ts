/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const postMock = vi.hoisted(() => vi.fn());

vi.mock('./xingye-storage-api', () => ({
  postXingyeStorage: postMock,
}));

import { deleteSecretSpaceRecord } from './xingye-secret-space-store';

describe('deleteSecretSpaceRecord', () => {
  let listRows: Record<string, unknown>[];

  beforeEach(() => {
    postMock.mockReset();
    listRows = [];
    postMock.mockImplementation(async (body: Record<string, unknown>) => {
      if (body.action === 'listJsonl') {
        return { ok: true, records: listRows };
      }
      if (body.action === 'write') {
        return { ok: true };
      }
      throw new Error(`unexpected action: ${String(body.action)}`);
    });
  });

  it('does not call deleteJsonlRecord; uses listJsonl + write with UTF-8 content', async () => {
    listRows = [
      {
        recordId: 'keep-me',
        body: 'b',
        summary: 's',
        createdAt: '2026-01-02T00:00:00.000Z',
        kind: 'dream',
      },
      {
        recordId: 'drop-me',
        body: 'x',
        summary: 't',
        createdAt: '2026-01-01T00:00:00.000Z',
        kind: 'dream',
      },
    ];
    await expect(deleteSecretSpaceRecord('agent-z', 'dream', 'drop-me')).resolves.toBe(true);

    const actions = postMock.mock.calls.map((c) => (c[0] as { action?: string }).action);
    expect(actions).toContain('listJsonl');
    expect(actions).toContain('write');
    expect(actions).not.toContain('deleteJsonlRecord');

    const writeBody = postMock.mock.calls.find((c) => (c[0] as { action?: string }).action === 'write')?.[0] as {
      action: string;
      agentId: string;
      relativePath: string;
      content: string;
      encoding?: string;
    };
    expect(writeBody.agentId).toBe('agent-z');
    expect(writeBody.relativePath).toBe('secret-space/dream.jsonl');
    expect(writeBody.encoding).toBe('utf8');
    expect(writeBody.content).toContain('keep-me');
    expect(writeBody.content).not.toContain('drop-me');
  });

  it('returns false when recordId is not in list (no write)', async () => {
    listRows = [{ recordId: 'only', body: 'a', summary: 's', createdAt: '2026-01-01', kind: 'saved_item' }];
    await expect(deleteSecretSpaceRecord('agent-z', 'saved_item', 'missing')).resolves.toBe(false);
    expect(postMock.mock.calls.every((c) => (c[0] as { action?: string }).action !== 'write')).toBe(true);
  });

  it('rejects invalid agentId before calling API', async () => {
    await expect(deleteSecretSpaceRecord('no spaces!', 'dream', 'rid')).rejects.toThrow(/agentId/);
    expect(postMock).not.toHaveBeenCalled();
  });

  it('rejects empty recordId before calling API', async () => {
    await expect(deleteSecretSpaceRecord('agent-z', 'dream', '  ')).rejects.toThrow(/recordId/);
    expect(postMock).not.toHaveBeenCalled();
  });
});
