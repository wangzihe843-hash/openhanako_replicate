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
import { generateJournalDraftWithAI, normalizeJournalDraftResult } from './xingye-journal-ai';

describe('normalizeJournalDraftResult', () => {
  it('accepts body or legacy content', () => {
    expect(normalizeJournalDraftResult({ title: 'A', body: '正文' })).toEqual({ title: 'A', body: '正文' });
    expect(normalizeJournalDraftResult({ content: '仅正文' })).toEqual({ title: '仅正文', body: '仅正文' });
  });

  it('clamps long unicode bodies', () => {
    const long = '字'.repeat(600);
    const r = normalizeJournalDraftResult({ title: 't', body: long });
    expect(r?.body.length).toBeLessThanOrEqual(521);
    expect(r?.body.endsWith('…')).toBe(true);
  });
});

describe('generateJournalDraftWithAI', () => {
  beforeEach(() => {
    vi.mocked(postXingyeStorage).mockReset();
    vi.mocked(hanaFetch).mockReset();
    vi.mocked(postXingyeStorage).mockResolvedValue({ missing: true } as never);
    vi.mocked(hanaFetch).mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { title: '夜路', body: '有点累，但还好。' } }),
    } as Response);
  });

  it('posts phone-generate with kind journal_draft', async () => {
    const agent = { id: 'agent-j', name: 'Lin', yuan: 'y' as const };
    await expect(generateJournalDraftWithAI({ agent: agent as never, ownerProfile: null })).resolves.toEqual({
      title: '夜路',
      body: '有点累，但还好。',
    });
    expect(hanaFetch).toHaveBeenCalledWith(
      '/api/xingye/phone-generate',
      expect.objectContaining({
        method: 'POST',
      }),
    );
    const generateCall = vi.mocked(hanaFetch).mock.calls.find((call) => call[0] === '/api/xingye/phone-generate');
    const bodyStr = String(generateCall?.[1]?.body ?? '');
    const body = JSON.parse(bodyStr) as { kind?: string; prompt?: string };
    expect(body.kind).toBe('journal_draft');
    expect(body.prompt).toContain('私人日记');
    expect(body.prompt).toContain('第一人称');
  });
});
