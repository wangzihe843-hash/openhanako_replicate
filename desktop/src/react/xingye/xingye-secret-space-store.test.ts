/**
 * @vitest-environment jsdom
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const { postMock, eventMock } = vi.hoisted(() => ({ postMock: vi.fn(), eventMock: vi.fn() }));
vi.mock('./xingye-storage-api', () => ({ postXingyeStorage: postMock }));
vi.mock('./xingye-event-log', () => ({ appendXingyeEvent: eventMock }));
import { deleteSecretSpaceRecord } from './xingye-secret-space-store';

describe('deleteSecretSpaceRecord', () => {
  beforeEach(() => {
    postMock.mockReset().mockResolvedValue({ ok: true, deleted: true });
    eventMock.mockReset().mockResolvedValue(null);
  });
  afterEach(() => vi.restoreAllMocks());

  it('uses one atomic stable-ID delete request and publishes the success event', async () => {
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    await expect(deleteSecretSpaceRecord(' agent-z ', 'dream', ' drop-me ')).resolves.toBe(true);
    expect(postMock).toHaveBeenCalledExactlyOnceWith({
      action: 'deleteSecretSpaceRecord', agentId: 'agent-z',
      relativePath: 'secret-space/dream.jsonl', recordId: 'drop-me',
    });
    expect(eventMock).toHaveBeenCalledExactlyOnceWith('agent-z', {
      type: 'secret_space.record_deleted', source: 'xingye-secret-space-store', subjectId: 'dream',
      payload: { category: 'dream', recordId: 'drop-me' },
    });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0][0]).toMatchObject({
      type: 'xingye-secret-space-changed', detail: { agentId: 'agent-z', category: 'dream' },
    });
  });

  it('keeps the interview deletion event semantics', async () => {
    expect(await deleteSecretSpaceRecord('agent-z', 'interview', 'one')).toBe(true);
    expect(eventMock).toHaveBeenCalledWith('agent-z', expect.objectContaining({
      type: 'interview.entry_deleted', subjectId: 'one',
    }));
  });

  it('returns false without notifications for an already deleted or missing record', async () => {
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    postMock.mockResolvedValue({ ok: true, deleted: false });
    expect(await deleteSecretSpaceRecord('agent-z', 'saved_item', 'missing')).toBe(false);
    expect(eventMock).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled();
    expect(postMock).toHaveBeenCalledOnce();
  });

  it.each([
    ['unsupported', new Error('invalid action'), /升级服务端/],
    ['server failure', new Error('synthetic EIO'), /synthetic EIO/],
    ['cancelled transport', new DOMException('synthetic cancel', 'AbortError'), /synthetic cancel/],
  ])('rejects %s without fallback or success notifications', async (_name, error, message) => {
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    postMock.mockRejectedValue(error);
    await expect(deleteSecretSpaceRecord('agent-z', 'dream', 'one')).rejects.toThrow(message as RegExp);
    expect(postMock).toHaveBeenCalledOnce();
    expect(postMock.mock.calls[0][0].action).toBe('deleteSecretSpaceRecord');
    expect(eventMock).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled();
  });

  it.each([undefined, {}, { ok: true }, { ok: true, deleted: 'true' }, { deleted: true }, { ok: false, deleted: true }])(
    'rejects an unconfirmed response: %j', async (response) => {
      postMock.mockResolvedValue(response);
      await expect(deleteSecretSpaceRecord('agent-z', 'dream', 'one')).rejects.toThrow(/未确认删除结果/);
      expect(postMock).toHaveBeenCalledOnce(); expect(eventMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['', 'rid', /agentId/], ['no spaces!', 'rid', /agentId/], ['agent-z', '  ', /recordId/],
  ])('rejects invalid input before the API: %j', async (agentId, recordId, error) => {
    await expect(deleteSecretSpaceRecord(agentId as string, 'dream', recordId as string)).rejects.toThrow(error as RegExp);
    expect(postMock).not.toHaveBeenCalled();
  });

  it('keeps a committed delete successful if its best-effort event append fails', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    eventMock.mockRejectedValue(new Error('synthetic event error'));
    expect(await deleteSecretSpaceRecord('agent-z', 'dream', 'one')).toBe(true);
    expect(postMock).toHaveBeenCalledOnce(); expect(warning).toHaveBeenCalledOnce();
  });
});
