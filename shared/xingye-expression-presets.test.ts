import { describe, expect, it } from 'vitest';
import { normalizeXingyeExpressionPresets, resolveXingyeExpressionPresets, formatXingyeExpressionPresets } from './xingye-expression-presets';

describe('expression presets', () => {
  it('rejects unknown values, duplicate arrays, inherited keys, and model parameters', () => {
    expect(normalizeXingyeExpressionPresets({ length: ['concise', 'detailed'], perspective: 'omniscient', innerThought: 'brief', temperature: 2 })).toEqual({ innerThought: 'brief' });
    expect(normalizeXingyeExpressionPresets(['first'])).toEqual({});
    expect(normalizeXingyeExpressionPresets(Object.create({ length: 'concise' }))).toEqual({});
    expect(normalizeXingyeExpressionPresets(null)).toEqual({});
  });

  it('resolves exactly one value per group without mutating the base', () => {
    const base = { length: 'concise', perspective: 'first' };
    const rows = resolveXingyeExpressionPresets(base, { length: 'detailed' });
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ value: 'detailed', source: 'scene' });
    expect(rows[1]).toMatchObject({ value: 'first', source: 'preset' });
    expect(rows[2]).toMatchObject({ value: undefined, source: 'character' });
    expect(base.length).toBe('concise');
    expect(resolveXingyeExpressionPresets(base, null)[0]).toMatchObject({ value: 'concise', source: 'preset' });
  });

  it('formats only effective choices and restores the base after scene expiry', () => {
    const base = { length: 'concise' };
    const active = formatXingyeExpressionPresets(base, { length: 'detailed' });
    expect(active).toContain('篇幅较长');
    expect(active).not.toContain('篇幅简短');
    expect(active).toContain('临时场景覆盖');
    expect(active).toContain('不得替用户决定行动');
    expect(formatXingyeExpressionPresets(base)).toContain('篇幅简短');
    expect(formatXingyeExpressionPresets({ temperature: 2 })).toBe('');
  });
});
