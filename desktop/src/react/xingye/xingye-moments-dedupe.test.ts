import { describe, expect, it } from 'vitest';
import {
  MOMENTS_ANCHOR_SAMPLE_LIMIT,
  buildMomentsContinuityAnchorBlock,
  detectMomentContentDuplicate,
  filterDuplicateMomentDrafts,
  type MomentForAnchor,
} from './xingye-moments-dedupe';

function mkMoment(partial: Partial<MomentForAnchor> & { content: string }): MomentForAnchor {
  return {
    authorAgentId: 'hanako',
    authorName: 'Hanako',
    createdAt: '2026-05-20T03:00:00.000Z',
    ...partial,
  };
}

describe('buildMomentsContinuityAnchorBlock', () => {
  it('空数组 → 空字符串', () => {
    expect(buildMomentsContinuityAnchorBlock([])).toBe('');
  });

  it('null / undefined → 空字符串（不抛）', () => {
    expect(buildMomentsContinuityAnchorBlock(undefined as never)).toBe('');
    expect(buildMomentsContinuityAnchorBlock(null as never)).toBe('');
  });

  it('全部 content 为空 → 空字符串', () => {
    const block = buildMomentsContinuityAnchorBlock([
      mkMoment({ content: '   ' }),
      mkMoment({ content: '' }),
    ]);
    expect(block).toBe('');
  });

  it('正常输出 ≥ 1 行（header + 至少一条样本）', () => {
    const block = buildMomentsContinuityAnchorBlock([
      mkMoment({
        content: '凌晨三点的便利店，泡面味混着冷气。',
        createdAt: '2026-05-25T03:00:00.000Z',
      }),
    ]);
    const lines = block.split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines[0]).toContain('近期朋友圈开头样本');
    expect(block).toContain('Hanako');
    expect(block).toContain('凌晨三点的便利店');
    expect(block).toContain('2026-05-25');
  });

  it('按 createdAt 倒序排列（最近的在前）', () => {
    const block = buildMomentsContinuityAnchorBlock([
      mkMoment({ content: '旧条', createdAt: '2026-05-01T00:00:00.000Z' }),
      mkMoment({ content: '新条', createdAt: '2026-05-25T00:00:00.000Z' }),
    ]);
    const idxOld = block.indexOf('旧条');
    const idxNew = block.indexOf('新条');
    expect(idxNew).toBeGreaterThan(-1);
    expect(idxOld).toBeGreaterThan(-1);
    expect(idxNew).toBeLessThan(idxOld);
  });

  it('限制条数：超过 limit 的部分被丢弃', () => {
    const moments: MomentForAnchor[] = [];
    for (let i = 0; i < MOMENTS_ANCHOR_SAMPLE_LIMIT + 5; i += 1) {
      moments.push(
        mkMoment({
          content: `第${i}条内容`,
          createdAt: `2026-05-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
        }),
      );
    }
    const block = buildMomentsContinuityAnchorBlock(moments);
    const sampleLines = block.split('\n').filter((l) => l.startsWith('  · '));
    expect(sampleLines.length).toBe(MOMENTS_ANCHOR_SAMPLE_LIMIT);
  });

  it('按句号 / 换行截「第一句」并截 30 字', () => {
    const long = '今天天气真好。然后又下雨了，泡汤了。';
    const block = buildMomentsContinuityAnchorBlock([mkMoment({ content: long })]);
    expect(block).toContain('今天天气真好');
    expect(block).not.toContain('然后又下雨了');
  });
});

describe('detectMomentContentDuplicate', () => {
  it('完全相同正文开头 → 命中', () => {
    const existing = [
      mkMoment({
        authorAgentId: 'hanako',
        content: '凌晨三点的便利店，泡面味混着冷气。',
      }),
    ];
    const result = detectMomentContentDuplicate(
      { authorAgentId: 'hanako', content: '凌晨三点的便利店，泡面味混着冷气。' },
      existing,
    );
    expect(result.kind).toBe('similar');
    if (result.kind === 'similar') {
      expect(result.score).toBeGreaterThanOrEqual(0.75);
    }
  });

  it('主题相似（局部改写）→ 命中', () => {
    const existing = [
      mkMoment({
        authorAgentId: 'hanako',
        content: '凌晨三点的便利店，泡面味混着冷气',
      }),
    ];
    const result = detectMomentContentDuplicate(
      // 几乎同样的开头，仅尾标点 / 助词差异
      { authorAgentId: 'hanako', content: '凌晨三点的便利店，泡面味又混着冷气' },
      existing,
    );
    expect(result.kind).toBe('similar');
  });

  it('不同作者发相似内容 → 不命中（按 author 分桶）', () => {
    const existing = [
      mkMoment({
        authorAgentId: 'hanako',
        content: '凌晨三点的便利店，泡面味混着冷气。',
      }),
    ];
    const result = detectMomentContentDuplicate(
      { authorAgentId: 'linwu', content: '凌晨三点的便利店，泡面味混着冷气。' },
      existing,
    );
    expect(result.kind).toBe('unique');
  });

  it('主题完全不同 → 不命中', () => {
    const existing = [
      mkMoment({
        authorAgentId: 'hanako',
        content: '凌晨三点的便利店，泡面味混着冷气。',
      }),
    ];
    const result = detectMomentContentDuplicate(
      { authorAgentId: 'hanako', content: '今天去爬山了，山顶云海特别美。' },
      existing,
    );
    expect(result.kind).toBe('unique');
  });

  it('空 content → unique', () => {
    expect(
      detectMomentContentDuplicate(
        { authorAgentId: 'hanako', content: '   ' },
        [mkMoment({ authorAgentId: 'hanako', content: '随便什么' })],
      ).kind,
    ).toBe('unique');
  });

  it('空 authorAgentId → unique', () => {
    expect(
      detectMomentContentDuplicate(
        { authorAgentId: '', content: '凌晨三点的便利店' },
        [mkMoment({ authorAgentId: 'hanako', content: '凌晨三点的便利店' })],
      ).kind,
    ).toBe('unique');
  });

  it('多条 existing 同时命中时取分数最高的', () => {
    const existing = [
      mkMoment({
        authorAgentId: 'hanako',
        content: '凌晨三点的便利店，泡面味混着冷气',
        createdAt: '2026-05-10T00:00:00.000Z',
      }),
      mkMoment({
        authorAgentId: 'hanako',
        // 与 candidate 几乎完全相同——分数应该更高
        content: '凌晨三点的便利店，泡面味混着冷气啊',
        createdAt: '2026-05-20T00:00:00.000Z',
      }),
    ];
    const result = detectMomentContentDuplicate(
      { authorAgentId: 'hanako', content: '凌晨三点的便利店，泡面味混着冷气啊' },
      existing,
    );
    expect(result.kind).toBe('similar');
    if (result.kind === 'similar') {
      expect(result.existing.createdAt).toBe('2026-05-20T00:00:00.000Z');
    }
  });
});

describe('filterDuplicateMomentDrafts', () => {
  it('与 existing 重复 → 拦截', () => {
    const existing = [
      mkMoment({ authorAgentId: 'hanako', content: '凌晨三点的便利店，泡面味混着冷气。' }),
    ];
    const { kept, dropped } = filterDuplicateMomentDrafts(
      [{ authorAgentId: 'hanako', content: '凌晨三点的便利店，泡面味混着冷气。' }],
      existing,
    );
    expect(kept).toHaveLength(0);
    expect(dropped).toHaveLength(1);
  });

  it('本批 candidates 互相去重（第二条与第一条重复 → 第二条被丢）', () => {
    const { kept, dropped } = filterDuplicateMomentDrafts(
      [
        { authorAgentId: 'hanako', content: '凌晨三点的便利店，泡面味混着冷气。' },
        { authorAgentId: 'hanako', content: '凌晨三点的便利店，泡面味混着冷气啊。' },
        { authorAgentId: 'hanako', content: '今天爬山看云海。' }, // 不同主题，保留
      ],
      [],
    );
    expect(kept).toHaveLength(2);
    expect(kept.map((k) => k.content)).toEqual([
      '凌晨三点的便利店，泡面味混着冷气。',
      '今天爬山看云海。',
    ]);
    expect(dropped).toHaveLength(1);
  });

  it('不同作者发相似内容 → 都保留', () => {
    const { kept, dropped } = filterDuplicateMomentDrafts(
      [
        { authorAgentId: 'hanako', content: '凌晨三点的便利店，泡面味混着冷气。' },
        { authorAgentId: 'linwu', content: '凌晨三点的便利店，泡面味混着冷气。' },
      ],
      [],
    );
    expect(kept).toHaveLength(2);
    expect(dropped).toHaveLength(0);
  });
});
