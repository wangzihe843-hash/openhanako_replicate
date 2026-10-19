import { describe, expect, it } from 'vitest';
import { selectXingyeContextSections } from './xingye-context-selection.js';

const context = { agentId: 'a', sessionId: 's1' };
const section = (id, text, priority = 10, scope = context, source = 'lore') =>
  ({ id, source, scope, priority, text });

describe('selectXingyeContextSections', () => {
  it.each(['ASCII words '.repeat(12).trim(), '中文BMP文字。'.repeat(16), '🌙'.repeat(70), 'English中文🌙🧪'.repeat(12)])(
    'preserves UTF-16 source and total caps at every cut: %s', (text) => {
      const omission = '\n…（本段超出上下文预算，后续内容未选入）';
      const original = section('entry', text);
      const before = JSON.stringify(original);
      for (let budget = 0; budget <= text.length + omission.length; budget += 1) {
        for (const sourceCap of [false, true]) {
          const result = selectXingyeContextSections({
            context, sections: [original],
            maxChars: sourceCap ? text.length + omission.length : budget,
            sourceBudgets: sourceCap ? { lore: budget } : {},
          });
          let expected = text;
          if (text.length > budget) {
            expected = '';
            if (budget >= omission.length + 24) {
              for (const point of text) {
                if (expected.length + point.length > budget - omission.length) break;
                expected += point;
              }
              expected = expected.trimEnd() + omission;
            }
          }
          expect(result.text).toBe(expected);
          expect(result.text.isWellFormed()).toBe(true);
          expect(result.usedChars).toBe(expected.length);
          expect(result.usedChars).toBeLessThanOrEqual(budget);
          expect(result.decisions[0].reason).toBe(!expected ? 'budget' : text.length <= budget ? 'selected' : 'truncated');
        }
      }
      expect(JSON.stringify(original)).toBe(before);
    },
  );

  it('backs off only the split unit without re-trimming or refilling the saved space', () => {
    const omission = '\n…（本段超出上下文预算，后续内容未选入）';
    const result = selectXingyeContextSections({
      context, maxChars: omission.length + 30,
      sections: [
        section('long', `${'x'.repeat(22)} 🌙${'z'.repeat(100)}`, 100),
        section('deferred', '🌙'.repeat(100), 90),
        section('short-a', '甲', 20),
        section('short-b', '乙', 10),
      ],
    });
    expect(result.sections.map((item) => item.id)).toEqual(['long', 'short-a', 'short-b']);
    expect(result.sections[0].text).toBe(`${'x'.repeat(22)} ${omission}`);
    expect(result.usedChars).toBe(omission.length + 29);
    expect(result.decisions.map((row) => row.reason)).toEqual(['truncated', 'budget', 'selected', 'selected']);
  });

  it('keeps source and session boundaries while explaining exclusions without leaking text', () => {
    const result = selectXingyeContextSections({
      context,
      maxChars: 200,
      sections: [
        section('own', 'allowed'),
        section('other-session', 'SECRET', 10, { agentId: 'a', sessionId: 's2' }),
        section('other-agent', 'ANOTHER_SECRET', 10, { agentId: 'b' }),
        section('own', 'DUPLICATE_SECRET'),
      ],
    });
    expect(result.text).toBe('allowed');
    expect(result.decisions.map((row) => row.reason)).toEqual(['scope', 'scope', 'duplicate', 'selected']);
    expect(JSON.stringify(result.decisions)).not.toContain('SECRET');
    expect(JSON.stringify(result.decisions)).not.toContain('DUPLICATE_SECRET');
  });

  it('reserves room for later short sections before shortening a large one', () => {
    const result = selectXingyeContextSections({
      context,
      maxChars: 100,
      sourceBudgets: { lore: 80, scene: 30 },
      sections: [
        section('long', 'A'.repeat(200), 100),
        section('scene', 'scene survives', 90, context, 'scene'),
        section('short', 'short fact', 80),
      ],
    });
    expect(result.text).toContain('scene survives');
    expect(result.text).toContain('short fact');
    expect(result.text.length).toBeLessThanOrEqual(100);
    expect(result.decisions.find((row) => row.id === 'long')?.reason).toBe('truncated');
  });

  it('does not emit a partial fragment when an entry cannot fit usefully', () => {
    const result = selectXingyeContextSections({
      context,
      maxChars: 12,
      sections: [section('oversized', 'X'.repeat(100)), section('small', 'fact')],
    });
    expect(result.text).toBe('fact');
    expect(result.decisions.find((row) => row.id === 'oversized')?.reason).toBe('budget');
  });
});
