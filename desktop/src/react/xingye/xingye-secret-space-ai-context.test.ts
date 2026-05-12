import { describe, expect, it } from 'vitest';
import {
  buildSecretSpaceLoreRuntimeOptions,
  getSecretSpaceLorePurpose,
  type XingyeSecretSpaceLoreCategory,
} from './xingye-secret-space-ai-context';

describe('xingye-secret-space-ai-context', () => {
  it('maps each SecretSpace category to its reserved lore purpose', () => {
    const cases: Array<[XingyeSecretSpaceLoreCategory, string]> = [
      ['dream', 'secret_space_dream'],
      ['draft_reply', 'secret_space_draft_reply'],
      ['unsent_moment', 'secret_space_unsent_moment'],
      ['saved_item', 'secret_space_saved_item'],
      ['memory_fragment', 'secret_space_memory_fragment'],
    ];
    for (const [category, purpose] of cases) {
      expect(getSecretSpaceLorePurpose(category)).toBe(purpose);
    }
  });

  it('builds runtime options with the matching purpose and 2000 maxChars default', () => {
    const opts = buildSecretSpaceLoreRuntimeOptions('dream');
    expect(opts.purpose).toBe('secret_space_dream');
    expect(opts.maxChars).toBe(2_000);
    expect(opts.includeAlways).toBe(true);
    expect(opts.includeKeyword).toBe(true);
    expect(opts.queryText).toBe('');
  });

  it('uses seedText (whitespace-collapsed) as queryText when provided', () => {
    const opts = buildSecretSpaceLoreRuntimeOptions('memory_fragment', '  童年   旧屋  里   的   光  ');
    expect(opts.purpose).toBe('secret_space_memory_fragment');
    expect(opts.queryText).toBe('童年 旧屋 里 的 光');
  });

  it('is a pure helper: importing the module does not depend on a model or DOM', async () => {
    /** Smoke check: dynamic re-import doesn't throw and doesn't reach any storage globals. */
    const mod = await import('./xingye-secret-space-ai-context');
    expect(typeof mod.buildSecretSpaceLoreRuntimeOptions).toBe('function');
    expect(typeof mod.getSecretSpaceLorePurpose).toBe('function');
  });
});
