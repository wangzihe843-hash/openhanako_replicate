import { describe, expect, it } from 'vitest';
import { emptyRehearsalDraft, normalizeRehearsalDraft } from './rehearsal-workshop-state';
describe('rehearsal saved drafts', () => {
  it('keeps edited inputs and versions while rejecting malformed or unauthorized fields', () => {
    const draft = normalizeRehearsalDraft({ scene: 'boundary', mode: 'greeting', inputs: { boundary: '编辑过的边界' }, selectedId: 'v2', variants: [
      null, { id: 'bad', text: 4 },
      { id: 'v1', text: '第一稿', scene: 'daily', profilePatch: [{ field: 'values', value: '守诺' }, { field: 'memory', value: '不准写' }] },
      { id: 'v2', text: '第二稿', scene: 'boundary', feedback: '再克制一些', mode: 'greeting', profilePatch: {} },
    ] });
    expect(draft).toMatchObject({ scene: 'boundary', mode: 'greeting', selectedId: 'v2', inputs: { boundary: '编辑过的边界' } });
    expect(draft.variants).toHaveLength(2);
    expect(draft.variants[0].profilePatch).toEqual([{ field: 'values', value: '守诺', rationale: '' }]);
    expect(draft.variants[1].profilePatch).toEqual([]);
  });
  it('loads older sessions with a new empty draft without inventing trial results', () => {
    expect(normalizeRehearsalDraft(undefined)).toEqual(emptyRehearsalDraft());
    expect(normalizeRehearsalDraft({ variants: 'broken', inputs: null }).variants).toEqual([]);
  });
});