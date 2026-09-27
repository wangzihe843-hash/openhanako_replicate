import { describe, expect, it } from 'vitest';
import { selectXingyeContextSections } from './xingye-context-selection.js';

const context = { agentId: 'a', sessionId: 's1' };
const section = (id, text, priority = 10, scope = context, source = 'lore') =>
  ({ id, source, scope, priority, text });

describe('selectXingyeContextSections', () => {
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
