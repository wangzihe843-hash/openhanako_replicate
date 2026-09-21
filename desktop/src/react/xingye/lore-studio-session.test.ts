/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyStudioSession, loadStudioSession, saveStudioSession } from './lore-studio-session';
import { postXingyeStorage } from './xingye-storage-api';
const state = vi.hoisted(() => ({ key: 'server-a', connected: true }));
vi.mock('./xingye-storage-api', () => ({ postXingyeStorage: vi.fn() }));
vi.mock('../stores', () => ({ useStore: { getState: () => ({}) } }));
vi.mock('../services/server-connection', () => ({ hasServerConnection: () => state.connected }));
vi.mock('./xingye-profile-store', () => ({ xingyeProfileConnectionKey: () => state.key }));
vi.mock('./xingye-lore-store', () => ({ XINGYE_LORE_CATEGORIES: ['background'] }));
beforeEach(() => { state.key = 'server-a'; state.connected = true; vi.mocked(postXingyeStorage).mockReset(); });
describe('studio rehearsal persistence boundary', () => {
  it('round-trips draft sessions under the same per-agent path and preserves existing planning data', async () => {
    let stored: unknown;
    vi.mocked(postXingyeStorage).mockImplementation(async body => {
      if (body.action === 'writeJson') stored = body.data;
      return { data: stored };
    });
    const session = { ...emptyStudioSession('a'), backgroundStory: '原设定草稿', rehearsal: { scene: 'daily' as const, mode: 'scene' as const, inputs: { daily: '散步', conflict: '冲突', boundary: '边界' }, feedback: '', selectedId: '', variants: [] } };
    await saveStudioSession(session, { strict: true, expectedConnectionKey: 'server-a' });
    expect(postXingyeStorage).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'a', relativePath: 'lore-studio/session.json' }));
    expect(await loadStudioSession('a')).toMatchObject({ backgroundStory: '原设定草稿', rehearsal: { inputs: { daily: '散步' } } });
  });
  it('serializes writes across workshop instances and waits before reopening', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let stored: unknown;
    let writes = 0;
    vi.mocked(postXingyeStorage).mockImplementation(async body => {
      if (body.action === 'writeJson') {
        writes += 1;
        if (writes === 1) await gate;
        stored = body.data;
      }
      return { data: stored };
    });
    const first = saveStudioSession({ ...emptyStudioSession('a'), backgroundStory: 'old' }, { strict: true });
    const last = saveStudioSession({ ...emptyStudioSession('a'), backgroundStory: 'latest' }, { strict: true });
    const reopen = loadStudioSession('a');
    await Promise.resolve(); await Promise.resolve();
    expect(writes).toBe(1);
    release(); await Promise.all([first, last]);
    expect(await reopen).toMatchObject({ backgroundStory: 'latest' });
  });
  it('throws strict write failures and refuses a changed connection before sending anything', async () => {
    vi.mocked(postXingyeStorage).mockRejectedValue(new Error('disk full'));
    await expect(saveStudioSession(emptyStudioSession('a'), { strict: true, expectedConnectionKey: 'server-a' })).rejects.toThrow('disk full');
    vi.mocked(postXingyeStorage).mockClear(); state.key = 'server-b';
    await expect(saveStudioSession(emptyStudioSession('a'), { strict: true, expectedConnectionKey: 'server-a' })).rejects.toThrow('连接已切换');
    expect(postXingyeStorage).not.toHaveBeenCalled();
  });
  it('never pretends disconnected strict saves succeeded', async () => {
    state.connected = false;
    await expect(saveStudioSession(emptyStudioSession('a'), { strict: true })).rejects.toThrow('尚未保存');
    expect(postXingyeStorage).not.toHaveBeenCalled();
  });
});