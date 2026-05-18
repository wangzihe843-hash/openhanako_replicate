import { describe, expect, it } from 'vitest';
import { parseDivinationReading } from './phone-divination-parse';

describe('parseDivinationReading', () => {
  it('splits the four standard sections for field_oracle', () => {
    const raw = [
      '【标题】',
      '蓝线之外',
      '【行动签象】',
      '我把哨声压在牙后，没让它冲出来。',
      '【正文】',
      '我看着掌心的影子，慢慢把急意压下去。',
      '【行动签】',
      '先确认风从哪边来。',
    ].join('\n');
    const parsed = parseDivinationReading(raw);
    expect(parsed.title).toBe('蓝线之外');
    expect(parsed.signLabel).toBe('行动签象');
    expect(parsed.signFlavor).toContain('哨声');
    expect(parsed.body).toContain('掌心的影子');
    expect(parsed.actionSign).toContain('先确认风');
    expect(parsed.lead).toBeUndefined();
  });

  it('captures the literal sign label so themes can render it as-is', () => {
    const raw = [
      '【标题】',
      '一卦未落',
      '【卦象】',
      '震上巽下，初爻动。',
      '【正文】',
      '我把卦摆在面前。',
      '【行动签】',
      '先听一声雷。',
    ].join('\n');
    const parsed = parseDivinationReading(raw);
    expect(parsed.signLabel).toBe('卦象');
    expect(parsed.signFlavor).toContain('震上巽下');
  });

  it('tolerates ascii brackets and trailing colons', () => {
    const raw = [
      '[标题：]',
      'A',
      '[牌面：]',
      'B',
      '[正文：]',
      'C',
      '[行动签：]',
      'D',
    ].join('\n');
    const parsed = parseDivinationReading(raw);
    expect(parsed.title).toBe('A');
    expect(parsed.signLabel).toBe('牌面');
    expect(parsed.signFlavor).toBe('B');
    expect(parsed.body).toBe('C');
    expect(parsed.actionSign).toBe('D');
  });

  it('keeps leading prose as `lead` when no 【标题】 marker is present', () => {
    const raw = [
      '我先把牌面合上。',
      '风声很轻。',
      '【行动签】',
      '先听一声。',
    ].join('\n');
    const parsed = parseDivinationReading(raw);
    expect(parsed.lead).toContain('牌面合上');
    expect(parsed.lead).toContain('风声很轻');
    expect(parsed.title).toBeUndefined();
    expect(parsed.body).toBeUndefined();
    expect(parsed.actionSign).toBe('先听一声。');
  });

  it('ignores unknown headers and keeps the first occurrence of each slot', () => {
    const raw = [
      '【备注】',
      '不该出现的段落',
      '【标题】',
      '第一标题',
      '【标题】',
      '第二标题（应忽略）',
      '【正文】',
      '正文内容',
    ].join('\n');
    const parsed = parseDivinationReading(raw);
    expect(parsed.title).toBe('第一标题');
    expect(parsed.body).toBe('正文内容');
  });

  it('returns an empty object for empty input', () => {
    expect(parseDivinationReading('')).toEqual({});
    expect(parseDivinationReading('   \n   ')).toEqual({});
    expect(parseDivinationReading(undefined)).toEqual({});
  });

  it.each([
    ['行动签', 'field_oracle'],
    ['卦辞', 'iching_liuyao'],
    ['牌意指引', 'tarot'],
    ['影像提示', 'crystal_ball'],
    ['符意建议', 'runes'],
    ['星象建议', 'astrology'],
    ['心象提示', 'oracle_generic'],
  ])('recognizes 【%s】 as the action section (per-method action label, used by %s)', (actionLabel) => {
    const raw = [
      '【标题】',
      'T',
      '【签象】',
      'S',
      '【正文】',
      'B',
      `【${actionLabel}】`,
      '具体的小建议。',
    ].join('\n');
    const parsed = parseDivinationReading(raw);
    expect(parsed.actionSign).toBe('具体的小建议。');
    /** 保留字面 label 让 UI 渲染时不必再回退到 theme 默认。 */
    expect(parsed.actionLabel).toBe(actionLabel);
  });
});
