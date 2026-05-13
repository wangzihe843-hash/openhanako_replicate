import { describe, expect, it } from 'vitest';
import { legacySecretSpaceRecordId, stableSecretSpaceRecordId } from './xingye-secret-space-record-id';

describe('stableSecretSpaceRecordId', () => {
  it('prefers recordId then key then id', () => {
    expect(
      stableSecretSpaceRecordId('draft_reply', {
        recordId: 'rr',
        key: 'kk',
        id: 'ii',
        body: 'b',
        summary: 's',
        createdAt: '2026-01-01',
      }),
    ).toBe('rr');
    expect(
      stableSecretSpaceRecordId('draft_reply', {
        key: 'kk',
        id: 'ii',
        body: 'b',
        summary: 's',
        createdAt: '2026-01-01',
      }),
    ).toBe('kk');
    expect(
      stableSecretSpaceRecordId('draft_reply', {
        id: 'ii',
        body: 'b',
        summary: 's',
        createdAt: '2026-01-01',
      }),
    ).toBe('ii');
  });

  it('is stable for the same legacy payload across reads', () => {
    const raw = {
      body: 'legacy',
      summary: 'sum',
      createdAt: '2026-05-12T12:00:00.000Z',
      kind: 'draft_reply',
    };
    const a = legacySecretSpaceRecordId('draft_reply', raw);
    const b = legacySecretSpaceRecordId('draft_reply', raw);
    expect(a).toBe(b);
    expect(a.startsWith('ss-leg-')).toBe(true);
  });
});
