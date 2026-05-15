/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../hooks/use-hana-fetch', () => ({
  hanaFetch: vi.fn(),
}));

vi.mock('./xingye-storage-api', () => ({
  postXingyeStorage: vi.fn(),
}));

import { hanaFetch } from '../hooks/use-hana-fetch';
import { postXingyeStorage } from './xingye-storage-api';
import {
  generateFilesDraftWithAI,
  normalizeFilesDraftResult,
} from './xingye-files-ai';

describe('normalizeFilesDraftResult', () => {
  it('requires folderName / title / body', () => {
    expect(normalizeFilesDraftResult({ folderName: 'A', title: 'B', body: 'C' })).toEqual({
      folderName: 'A',
      title: 'B',
      body: 'C',
    });
    expect(normalizeFilesDraftResult({ folderName: '', title: 'B', body: 'C' })).toBeNull();
    expect(normalizeFilesDraftResult({ folderName: 'A', title: '', body: 'C' })).toBeNull();
    expect(normalizeFilesDraftResult({ folderName: 'A', title: 'B', body: '' })).toBeNull();
    expect(normalizeFilesDraftResult(null)).toBeNull();
    expect(normalizeFilesDraftResult([])).toBeNull();
  });

  it('clamps long bodies and dedupes/normalizes tags', () => {
    const long = '字'.repeat(2500);
    const r = normalizeFilesDraftResult({
      folderName: 'F',
      title: 'T',
      body: long,
      summary: '一句话',
      tags: ['  设定  ', '', null, '关系', '城市', '物品', '人物', '时间', '另一个', '溢出'],
    });
    expect(r?.body.length).toBeLessThanOrEqual(2000);
    expect(r?.body.endsWith('…')).toBe(true);
    expect(r?.tags?.length).toBeGreaterThan(0);
    expect(r?.tags?.length).toBeLessThanOrEqual(8);
    expect(r?.summary).toBe('一句话');
  });
});

describe('generateFilesDraftWithAI', () => {
  beforeEach(() => {
    vi.mocked(postXingyeStorage).mockReset();
    vi.mocked(hanaFetch).mockReset();
    vi.mocked(postXingyeStorage).mockResolvedValue({ missing: true } as never);
    vi.mocked(hanaFetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        result: {
          folderName: '关于 user',
          title: 'user 的偏好',
          body: 'user 喜欢深色配色，并希望我主动记下细节。',
          tags: ['user', '偏好'],
        },
      }),
    } as Response);
  });

  it('posts phone-generate with kind files_draft and a first-person agent prompt', async () => {
    const agent = { id: 'agent-f', name: 'Lin', yuan: 'y' as const };
    const folderOptions = [
      { id: 'f1', name: '世界观整理', description: '世界设定。' },
      { id: 'f2', name: '关于 user', description: '关于 user 的资料。' },
    ];
    const result = await generateFilesDraftWithAI({
      agent: agent as never,
      ownerProfile: null,
      targetFolder: folderOptions[1],
      folderOptions,
      userIntent: '今天聊到的偏好',
    });
    expect(result.folderName).toBe('关于 user');
    expect(result.title).toBe('user 的偏好');
    expect(hanaFetch).toHaveBeenCalledWith(
      '/api/xingye/phone-generate',
      expect.objectContaining({ method: 'POST' }),
    );
    const call = vi.mocked(hanaFetch).mock.calls.find((c) => c[0] === '/api/xingye/phone-generate');
    const body = JSON.parse(String(call?.[1]?.body ?? '')) as { kind?: string; prompt?: string };
    expect(body.kind).toBe('files_draft');
    expect(body.prompt).toContain('资料柜');
    expect(body.prompt).toContain('第一人称');
    expect(body.prompt).toContain('关于 user');
    expect(body.prompt).toContain('世界观整理');
    expect(body.prompt).toContain('今天聊到的偏好');
  });

  it('gracefully degrades when no recent chat / heartbeat / lore is available', async () => {
    const agent = { id: 'agent-empty', name: 'Lin', yuan: 'y' as const };
    await expect(
      generateFilesDraftWithAI({
        agent: agent as never,
        ownerProfile: null,
        targetFolder: null,
        folderOptions: [],
        userIntent: '',
      }),
    ).resolves.toMatchObject({ folderName: '关于 user' });
    const call = vi.mocked(hanaFetch).mock.calls.find((c) => c[0] === '/api/xingye/phone-generate');
    const body = JSON.parse(String(call?.[1]?.body ?? '')) as { prompt?: string };
    expect(body.prompt).toContain('（无）');
    expect(body.prompt).toContain('资料柜里目前还没有文件夹');
  });

  it('throws on server error envelopes', async () => {
    vi.mocked(hanaFetch).mockResolvedValueOnce({
      ok: false,
      json: async () => ({ ok: false, error: 'model call failed' }),
    } as Response);
    const agent = { id: 'agent-err', name: 'Lin', yuan: 'y' as const };
    await expect(
      generateFilesDraftWithAI({ agent: agent as never, ownerProfile: null }),
    ).rejects.toThrow(/model call failed/);
  });
});
