/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../hooks/use-hana-fetch', () => ({
  hanaFetch: vi.fn(),
}));

vi.mock('./xingye-storage-api', () => ({
  postXingyeStorage: vi.fn(async () => ({ missing: true })),
}));

import { hanaFetch } from '../hooks/use-hana-fetch';
import {
  generateDivinationReadingWithAI,
  normalizeDivinationReadingResult,
} from './xingye-divination-ai';

const goodReadingPayload = {
  title: '蓝线之外',
  agentQuestion: '我想确认这阵预感是不是又在提醒我回头。',
  content: [
    '【标题】',
    '蓝线之外',
    '【行动签象】',
    '我把哨声压在牙后，没让它冲出来。',
    '【正文】',
    '我看着掌心的影子，慢慢把急意压下去。',
    '【行动签】',
    '先确认风从哪边来。',
  ].join('\n'),
};

describe('normalizeDivinationReadingResult', () => {
  it('accepts title/agentQuestion/content shape', () => {
    const r = normalizeDivinationReadingResult(goodReadingPayload);
    expect(r).not.toBeNull();
    expect(r?.title).toBe('蓝线之外');
    expect(r?.agentQuestion).toContain('回头');
    expect(r?.content).toMatch(/【正文】/);
  });

  it('falls back to legacy question field if agentQuestion missing', () => {
    const r = normalizeDivinationReadingResult({
      title: 't',
      question: '我想确认这阵预感。',
      content: goodReadingPayload.content,
    });
    expect(r?.agentQuestion).toContain('预感');
  });

  it('substitutes safe-fallback when raw content is missing or too short to sanitize', () => {
    const r = normalizeDivinationReadingResult({
      title: 't',
      agentQuestion: '我想确认一下。',
      content: '太短',
    });
    expect(r).not.toBeNull();
    expect(r?.content).toMatch(/【行动签】/);
    expect(r?.agentQuestion).toContain('确认');
  });

  it('returns null when agentQuestion missing entirely', () => {
    expect(
      normalizeDivinationReadingResult({
        title: 't',
        content: goodReadingPayload.content,
      }),
    ).toBeNull();
  });

  it('uses agentQuestion as title fallback when title absent', () => {
    const r = normalizeDivinationReadingResult({
      agentQuestion: 'AAAAA',
      content: goodReadingPayload.content,
    });
    expect(r?.title).toBe('AAAAA');
  });

  it('parses fortuneScore / omens / luckyDirection / luckyColor when present', () => {
    const r = normalizeDivinationReadingResult({
      ...goodReadingPayload,
      fortuneScore: { overall: 73, career: 77, love: 82, wealth: 62 },
      omens: { good: '靠近自己确认过的事', bad: '在路口反复折返' },
      luckyDirection: '东南',
      luckyColor: '古书纸的赭石色',
    });
    expect(r?.fortuneScore).toEqual({ overall: 73, career: 77, love: 82, wealth: 62 });
    expect(r?.omens).toEqual({ good: '靠近自己确认过的事', bad: '在路口反复折返' });
    expect(r?.luckyDirection).toBe('东南');
    expect(r?.luckyColor).toBe('古书纸的赭石色');
  });

  it('rejects luckyColor that came back as a bare CSS color code (hex / rgb / hsl)', () => {
    /** 渲染端不再画色卡，光秃秃的 #RRGGBB 没语义价值——拒绝。 */
    for (const noisy of ['#D4C5A9', 'd4c5a9', 'rgb(122, 162, 200)', 'hsl(210, 40%, 60%)']) {
      const r = normalizeDivinationReadingResult({ ...goodReadingPayload, luckyColor: noisy });
      expect(r?.luckyColor, `luckyColor "${noisy}" should be rejected`).toBeUndefined();
    }
  });

  it('clamps fortuneScore values to [0,100] integers', () => {
    const r = normalizeDivinationReadingResult({
      ...goodReadingPayload,
      fortuneScore: { overall: 150, career: -20, love: 73.6, wealth: '40' },
    });
    expect(r?.fortuneScore).toEqual({ overall: 100, career: 0, love: 74, wealth: 40 });
  });

  it('drops fortuneScore entirely if any field is missing or non-numeric', () => {
    const partial = normalizeDivinationReadingResult({
      ...goodReadingPayload,
      fortuneScore: { overall: 73, career: 77, love: 82 },
    });
    expect(partial?.fortuneScore).toBeUndefined();

    const garbage = normalizeDivinationReadingResult({
      ...goodReadingPayload,
      fortuneScore: { overall: 'lots', career: 77, love: 82, wealth: 62 },
    });
    expect(garbage?.fortuneScore).toBeUndefined();
  });

  it('drops omens when good or bad is missing', () => {
    const r = normalizeDivinationReadingResult({
      ...goodReadingPayload,
      omens: { good: '靠近自己确认过的事' },
    });
    expect(r?.omens).toBeUndefined();
  });

  it('returns result without optional fortune fields when AI omits them (back-compat)', () => {
    const r = normalizeDivinationReadingResult(goodReadingPayload);
    expect(r).not.toBeNull();
    expect(r?.fortuneScore).toBeUndefined();
    expect(r?.omens).toBeUndefined();
    expect(r?.luckyDirection).toBeUndefined();
    expect(r?.luckyColor).toBeUndefined();
  });
});

describe('generateDivinationReadingWithAI', () => {
  beforeEach(() => {
    vi.mocked(hanaFetch).mockReset();
    vi.mocked(hanaFetch).mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: goodReadingPayload }),
    } as Response);
  });

  it('posts phone-generate with kind divination_reading and returns normalized result', async () => {
    const agent = { id: 'ag-d', name: 'Lin', yuan: 'y' as const };
    const result = await generateDivinationReadingWithAI({
      agent,
      methodId: 'field_oracle',
      methodLabel: '战地直觉',
      symbols: ['☰', '☲'],
      agentLike: {
        displayName: '林雾',
        backgroundSummary: '边境战乱。',
      },
    });
    expect(result.title).toBe('蓝线之外');
    expect(result.agentQuestion).toContain('回头');
    expect(result.content).toMatch(/【正文】/);

    const call = vi.mocked(hanaFetch).mock.calls.find((c) => c[0] === '/api/xingye/phone-generate');
    expect(call).toBeDefined();
    const body = JSON.parse(String(call?.[1]?.body ?? '')) as Record<string, unknown>;
    expect(body.kind).toBe('divination_reading');
    expect(body.ownerAgentId).toBe('ag-d');
    expect(body.agentId).toBe('ag-d');
    expect(typeof body.prompt).toBe('string');
    expect(String(body.prompt)).toContain('field_oracle');
    expect(String(body.prompt)).toContain('战地直觉');
  });

  it('throws when server returns ok:false', async () => {
    vi.mocked(hanaFetch).mockResolvedValueOnce({
      ok: false,
      json: async () => ({
        ok: false,
        error: 'model call failed',
        details: [{ tier: 'utility', message: 'boom' }],
      }),
    } as Response);
    await expect(
      generateDivinationReadingWithAI({
        agent: { id: 'ag-d', name: 'Lin', yuan: 'y' as const },
        methodId: 'tarot',
        methodLabel: '塔罗',
        symbols: ['◇'],
        agentLike: { displayName: '林雾' },
      }),
    ).rejects.toThrow(/model call failed/);
  });

  it('forwards seedNarrative into the prompt so polish path can reuse draft', async () => {
    await generateDivinationReadingWithAI({
      agent: { id: 'ag-d', name: 'Lin', yuan: 'y' as const },
      methodId: 'oracle_generic',
      methodLabel: '通用神谕',
      symbols: ['※'],
      agentLike: { displayName: '林雾' },
      seedNarrative: {
        agentQuestion: '我是不是该听那阵风？',
        content: '风从北边来，桅杆轻轻晃。',
      },
    });
    const call = vi.mocked(hanaFetch).mock.calls.find((c) => c[0] === '/api/xingye/phone-generate');
    const body = JSON.parse(String(call?.[1]?.body ?? '')) as Record<string, unknown>;
    const prompt = String(body.prompt);
    expect(prompt).toContain('正式加工种子');
    expect(prompt).toContain('我是不是该听那阵风？');
    expect(prompt).toContain('风从北边来');
  });

  it('throws when response payload fails normalization', async () => {
    vi.mocked(hanaFetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, result: { title: 't', content: '太短' } }),
    } as Response);
    await expect(
      generateDivinationReadingWithAI({
        agent: { id: 'ag-d', name: 'Lin', yuan: 'y' as const },
        methodId: 'oracle_generic',
        methodLabel: '通用神谕',
        symbols: ['※'],
        agentLike: { displayName: '林雾' },
      }),
    ).rejects.toThrow(/模型返回无效/);
  });
});
