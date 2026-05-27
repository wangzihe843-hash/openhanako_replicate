import { describe, expect, it } from 'vitest';
import {
  buildHealthContinuityAnchorBlock,
  detectHealthSlot,
  detectHealthSlots,
  filterSameDayHealthSlotDuplicates,
} from './xingye-health-dedupe';
import type { XingyeHealthDay } from './xingye-health-data';

function day(partial: Partial<XingyeHealthDay> & { isoDate: string }): XingyeHealthDay {
  return {
    isoDate: partial.isoDate,
    scenario: 'calm',
    advice: partial.advice ?? null,
    generatedAt: partial.generatedAt ?? new Date(0).toISOString(),
    source: partial.source ?? 'ai',
  };
}

describe('detectHealthSlots / detectHealthSlot', () => {
  it('识别睡眠 slot——含「深睡」「入睡」「失眠」等关键词', () => {
    expect(detectHealthSlot('今日分析', '昨晚睡了 7 小时，深睡比例不错。')).toBe('sleep');
    expect(detectHealthSlot('今日分析', '入睡有点困难，建议睡前关闭手机。')).toBe('sleep');
    expect(detectHealthSlot('今日分析', '最近熬夜偏多。')).toBe('sleep');
  });

  it('识别喝水 slot——「8 杯水」「补水」「喝够」', () => {
    expect(detectHealthSlot('今日分析', '今天喝够 8 杯水了，棒。')).toBe('water');
    expect(detectHealthSlot('今日分析', '建议下午多喝水补水。')).toBe('water');
  });

  it('识别运动 slot——「跑步」「锻炼」「健身」', () => {
    expect(detectHealthSlot('今日分析', '今天跑步 30 分钟，状态很好。')).toBe('exercise');
    expect(detectHealthSlot('今日分析', '建议晚上做一段拉伸。')).toBe('exercise');
  });

  it('识别步数 slot——「步数」「走了 N 步」', () => {
    expect(detectHealthSlot('今日分析', '今天步数达标。')).toBe('steps');
    expect(detectHealthSlot('今日分析', '走了 12000 步，超过目标。')).toBe('steps');
  });

  it('识别压力 slot——「压力」「焦虑」「紧绷」', () => {
    expect(detectHealthSlot('今日分析', '今天压力偏高，建议放松。')).toBe('stress');
    expect(detectHealthSlot('今日分析', '情绪起伏明显，注意减压。')).toBe('stress');
  });

  it('slot 不识别 → null（综合性 advice / 无关键词）', () => {
    expect(detectHealthSlot('今日分析', '保持现在的节律就好。')).toBeNull();
    expect(detectHealthSlot('', '')).toBeNull();
  });

  it('多 slot 命中 → detectHealthSlot 返回 null（避免误判为单 slot）；detectHealthSlots 返回完整集合', () => {
    const text = '昨晚睡了 7 小时，今天压力偏高。';
    expect(detectHealthSlot('今日分析', text)).toBeNull();
    const hits = detectHealthSlots('今日分析', text);
    expect(hits.has('sleep')).toBe(true);
    expect(hits.has('stress')).toBe(true);
    expect(hits.size).toBe(2);
  });
});

describe('filterSameDayHealthSlotDuplicates', () => {
  it('同日同 slot 命中 → 丢弃 draft', () => {
    const drafts = [
      { isoDate: '2026-05-27', title: '今日分析', body: '今天喝够 8 杯水了。' },
    ];
    const existing = [
      { isoDate: '2026-05-27', title: '今日分析', body: '今天补水充足，已经喝了 8 杯水。' },
    ];
    expect(filterSameDayHealthSlotDuplicates(drafts, existing)).toHaveLength(0);
  });

  it('同 slot 但不同日 → 保留', () => {
    const drafts = [
      { isoDate: '2026-05-28', title: '今日分析', body: '今天喝够 8 杯水。' },
    ];
    const existing = [
      { isoDate: '2026-05-27', title: '今日分析', body: '今天补水充足。' },
    ];
    expect(filterSameDayHealthSlotDuplicates(drafts, existing)).toHaveLength(1);
  });

  it('同日不同 slot → 保留（睡眠不挡掉喝水）', () => {
    const drafts = [
      { isoDate: '2026-05-27', title: '今日分析', body: '今天喝够 8 杯水。' },
    ];
    const existing = [
      { isoDate: '2026-05-27', title: '今日分析', body: '昨晚睡得很好，深睡充足。' },
    ];
    expect(filterSameDayHealthSlotDuplicates(drafts, existing)).toHaveLength(1);
  });

  it('slot 不识别（综合 advice）→ 一律放过，不参与去重', () => {
    const drafts = [
      { isoDate: '2026-05-27', title: '今日分析', body: '保持当前节律。' },
      { isoDate: '2026-05-27', title: '今日分析', body: '继续这样就好。' },
    ];
    expect(filterSameDayHealthSlotDuplicates(drafts, [])).toHaveLength(2);
  });

  it('本批内部去重（drafts 里两条同日同 slot 只保留第一条）', () => {
    const drafts = [
      { isoDate: '2026-05-27', title: 'A', body: '今天喝够 8 杯水。' },
      { isoDate: '2026-05-27', title: 'B', body: '今天补水充足。' },
    ];
    const out = filterSameDayHealthSlotDuplicates(drafts, []);
    expect(out.map((d) => d.title)).toEqual(['A']);
  });

  it('缺 isoDate → 直接放过（无法判断同日）', () => {
    const drafts = [
      { title: '今日分析', body: '今天喝够 8 杯水。' },
    ];
    expect(filterSameDayHealthSlotDuplicates(drafts, [
      { isoDate: '2026-05-27', title: '今日分析', body: '今天喝了 8 杯水。' },
    ])).toHaveLength(1);
  });
});

describe('buildHealthContinuityAnchorBlock', () => {
  it('空记录 → 返回空字符串', () => {
    expect(buildHealthContinuityAnchorBlock([])).toBe('');
  });

  it('多天 advice → 输出 slot 覆盖清单 + 摘录列表', () => {
    const records: XingyeHealthDay[] = [
      day({
        isoDate: '2026-05-27',
        advice: { title: '今日分析', body: '今天喝够 8 杯水，补水充足。', generatedAt: '10:00' },
      }),
      day({
        isoDate: '2026-05-26',
        advice: { title: '今日分析', body: '昨晚睡了 7 小时，深睡比例不错。', generatedAt: '10:00' },
      }),
    ];
    const block = buildHealthContinuityAnchorBlock(records);
    expect(block).toContain('喝水');
    expect(block).toContain('睡眠');
    expect(block).toContain('2026-05-27');
    expect(block).toContain('2026-05-26');
    expect(block).toContain('请换角度');
  });

  it('respects recentDays cap', () => {
    const records: XingyeHealthDay[] = Array.from({ length: 10 }, (_, i) => day({
      isoDate: `2026-05-${String(20 + i).padStart(2, '0')}`,
      advice: { title: '今日分析', body: `第 ${i} 天关于睡眠的话题。`, generatedAt: '10:00' },
    }));
    const block = buildHealthContinuityAnchorBlock(records, { recentDays: 3 });
    // 只挑前 3 条，第 4–9 条应被截断
    const lines = block.split('\n').filter((line) => line.includes('  · 2026-'));
    expect(lines).toHaveLength(3);
  });

  it('records without advice 被忽略', () => {
    const records: XingyeHealthDay[] = [day({ isoDate: '2026-05-27', advice: null })];
    expect(buildHealthContinuityAnchorBlock(records)).toBe('');
  });
});
