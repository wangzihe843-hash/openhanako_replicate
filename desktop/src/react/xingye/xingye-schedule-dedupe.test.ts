import { describe, expect, it } from 'vitest';
import {
  buildScheduleContinuityAnchorBlock,
  detectScheduleDuplicate,
  filterSameDayScheduleDuplicates,
  normalizeScheduleDateKey,
} from './xingye-schedule-dedupe';

describe('normalizeScheduleDateKey', () => {
  it('trims and lowercases', () => {
    expect(normalizeScheduleDateKey(' 周三 14:00 ')).toBe('周三 14:00');
    expect(normalizeScheduleDateKey('Tomorrow Morning')).toBe('tomorrow morning');
  });
  it('全角空格 / 全角标点 → 半角', () => {
    expect(normalizeScheduleDateKey('周三　14:00')).toBe('周三 14:00');
  });
  it('空 / 非字符串 → 空串', () => {
    expect(normalizeScheduleDateKey('')).toBe('');
    expect(normalizeScheduleDateKey(undefined)).toBe('');
  });
});

describe('detectScheduleDuplicate', () => {
  it('完全相等 → exact_dup', () => {
    const verdict = detectScheduleDuplicate(
      { title: '开周会', dateLabel: '周三 14:00' },
      [{ title: '开周会', dateLabel: '周三 14:00' }],
    );
    expect(verdict.kind).toBe('exact_dup');
  });

  it('Levenshtein ≤ 2 + 较短串 ≥ 3 字 → similar(via=edit)', () => {
    const verdict = detectScheduleDuplicate(
      { title: '开周会议', dateLabel: '周三 14:00' },
      [{ title: '开周会', dateLabel: '周三 14:00' }],
    );
    expect(verdict.kind).toBe('similar');
    if (verdict.kind === 'similar') {
      expect(verdict.via).toBe('edit');
    }
  });

  it('bigram Jaccard ≥ 0.75 + 长度差 ≤ 2 → similar(via=jaccard)', () => {
    // 「和阿言一起喝咖啡」 vs 「喝咖啡和阿言一起」：换序导致编辑距离>2，但
    // bigram 重叠 6/8 = 0.75 命中阈值
    const verdict = detectScheduleDuplicate(
      { title: '喝咖啡和阿言一起', dateLabel: '周五 15:00' },
      [{ title: '和阿言一起喝咖啡', dateLabel: '周五 15:00' }],
    );
    expect(verdict.kind).toBe('similar');
    if (verdict.kind === 'similar') {
      expect(verdict.via).toBe('jaccard');
    }
  });

  it('主题不同 → unique（即使同一天）', () => {
    const verdict = detectScheduleDuplicate(
      { title: '看演出', dateLabel: '周三 20:00' },
      [{ title: '开周会', dateLabel: '周三 14:00' }],
    );
    // dateLabel 不同 → unique
    expect(verdict.kind).toBe('unique');
  });

  it('同一天但完全不同标题 → unique', () => {
    const verdict = detectScheduleDuplicate(
      { title: '看牙医', dateLabel: '2026-05-30' },
      [{ title: '陪妈妈逛街', dateLabel: '2026-05-30' }],
    );
    expect(verdict.kind).toBe('unique');
  });

  it('不同 dateLabel → 一律 unique，即使标题相同', () => {
    const verdict = detectScheduleDuplicate(
      { title: '开周会', dateLabel: '周四 14:00' },
      [{ title: '开周会', dateLabel: '周三 14:00' }],
    );
    expect(verdict.kind).toBe('unique');
  });

  it('candidate title 为空 → unique（数据太薄不判）', () => {
    const verdict = detectScheduleDuplicate(
      { title: '   ', dateLabel: '周三 14:00' },
      [{ title: '开周会', dateLabel: '周三 14:00' }],
    );
    expect(verdict.kind).toBe('unique');
  });
});

describe('filterSameDayScheduleDuplicates', () => {
  it('同日同事件 → 丢弃', () => {
    const drafts = [
      { title: '开周会', dateLabel: '周三 14:00', content: 'x' },
    ];
    const existing = [{ title: '开周会', dateLabel: '周三 14:00' }];
    expect(filterSameDayScheduleDuplicates(drafts, existing)).toHaveLength(0);
  });

  it('同日不同事件 → 保留', () => {
    const drafts = [
      { title: '看演出', dateLabel: '周三 20:00' },
    ];
    const existing = [{ title: '开周会', dateLabel: '周三 14:00' }];
    expect(filterSameDayScheduleDuplicates(drafts, existing)).toHaveLength(1);
  });

  it('本批内部去重（两条同日同事件只保留第一条）', () => {
    const drafts = [
      { title: '开周会', dateLabel: '周三 14:00' },
      { title: '开周会', dateLabel: '周三 14:00' },
    ];
    expect(filterSameDayScheduleDuplicates(drafts, [])).toHaveLength(1);
  });

  it('缺 title / dateLabel → 放过', () => {
    const drafts = [
      { title: '', dateLabel: '周三 14:00' },
      { title: '开会', dateLabel: '' },
    ];
    expect(filterSameDayScheduleDuplicates(drafts, [])).toHaveLength(2);
  });

  it('保留 draft 的所有原始字段', () => {
    const drafts = [
      { title: '看演出', dateLabel: '周五 20:00', content: '南京路 livehouse', extra: 'xyz' },
    ];
    const out = filterSameDayScheduleDuplicates(drafts, []);
    expect(out[0]).toMatchObject({ content: '南京路 livehouse', extra: 'xyz' });
  });
});

describe('buildScheduleContinuityAnchorBlock', () => {
  it('空 → 返回空字符串', () => {
    expect(buildScheduleContinuityAnchorBlock([])).toBe('');
  });

  it('列出事件 + 标签 + timeText', () => {
    const block = buildScheduleContinuityAnchorBlock([
      { dateLabel: '2026-05-27', title: '开周会', timeText: '14:00' },
      { dateLabel: '2026-05-28', title: '看演出', timeText: '20:00' },
    ]);
    expect(block).toContain('2026-05-27');
    expect(block).toContain('开周会');
    expect(block).toContain('(14:00)');
    expect(block).toContain('看演出');
    expect(block).toContain('请不要再重复');
  });

  it('maxEntries 截断', () => {
    const events = Array.from({ length: 30 }, (_, i) => ({
      dateLabel: `2026-05-${String(i + 1).padStart(2, '0')}`,
      title: `事件${i}`,
    }));
    const block = buildScheduleContinuityAnchorBlock(events, { maxEntries: 5 });
    const eventLines = block.split('\n').filter((line) => line.includes('  · ['));
    expect(eventLines).toHaveLength(5);
  });

  it('跳过缺字段的 events', () => {
    const block = buildScheduleContinuityAnchorBlock([
      { dateLabel: '', title: '开会' },
      { dateLabel: '周三', title: '' },
      { dateLabel: '周五', title: '看戏' },
    ]);
    expect(block).toContain('看戏');
    expect(block).not.toContain('开会');
  });
});
