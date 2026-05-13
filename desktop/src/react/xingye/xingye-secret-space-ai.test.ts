import { describe, expect, it } from 'vitest';
import { normalizeSecretSpaceAiResult } from './xingye-secret-space-ai';

describe('normalizeSecretSpaceAiResult', () => {
  it('returns null for empty content', () => {
    expect(normalizeSecretSpaceAiResult({ title: 'T', content: '  ' })).toBeNull();
    expect(normalizeSecretSpaceAiResult({ title: 'T' })).toBeNull();
    expect(normalizeSecretSpaceAiResult(null)).toBeNull();
  });

  it('derives title from content when title missing', () => {
    const long = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEF';
    const out = normalizeSecretSpaceAiResult({ content: long });
    expect(out?.title).toBe(long.slice(0, 48));
    expect(out?.content).toBe(long);
  });

  it('accepts explicit title', () => {
    const out = normalizeSecretSpaceAiResult({ title: 'Hello', content: 'body' });
    expect(out).toEqual({ title: 'Hello', content: 'body' });
  });
});
