import { describe, expect, it } from 'vitest';
import {
  canReadMemoryScope, memoryScopeKey, normalizeMemoryScope,
  normalizeMemoryScopeContext, sameMemoryScope,
} from '../shared/memory-scope.ts';

const story = { version: 1, agentId: 'hana', realm: 'story', worldId: 'world-a', branchId: 'branch-a', knowledge: 'shared' };

describe('L1 canonical memory scope', () => {
  it('keeps absent metadata legacy and never promotes it into reality/story', () => {
    expect(normalizeMemoryScope(undefined, 'hana')).toEqual({ version: 1, agentId: 'hana', realm: 'legacy', knowledge: 'shared' });
    expect(canReadMemoryScope(undefined, undefined)).toBe(true);
    expect(canReadMemoryScope(undefined, story, 'hana')).toBe(false);
    expect(canReadMemoryScope(undefined, { agentId: 'hana', realm: 'reality' }, 'hana')).toBe(false);
    expect(canReadMemoryScope(story, undefined, 'hana')).toBe(false);
  });

  it.each([
    {}, 'story', [], { ...story, version: 2 }, { ...story, realm: 'guess' },
    { ...story, worldId: '' }, { ...story, branchId: null }, { ...story, agentId: '' },
    { ...story, knowledge: 'character' }, { ...story, knowledge: 'omniscient' },
    { agentId: 'hana', realm: 'reality', worldId: 'world-a' },
  ])('fails closed for invalid explicit scope %j', (input) => {
    expect(() => normalizeMemoryScope(input, 'hana')).toThrow();
    expect(canReadMemoryScope(input, story)).toBe(false);
    expect(canReadMemoryScope(story, input)).toBe(false);
  });

  it('requires matching agent, world, branch and realm even for author viewpoint', () => {
    for (const change of [{ agentId: 'other' }, { worldId: 'world-b' }, { branchId: 'branch-b' }]) {
      expect(canReadMemoryScope({ ...story, ...change }, { ...story, viewpoint: 'author' })).toBe(false);
    }
    expect(canReadMemoryScope({ agentId: 'hana', realm: 'reality' }, { ...story, viewpoint: 'author' })).toBe(false);
  });

  it('separates character secrets, author notes and shared world knowledge', () => {
    const alice = { ...story, knowledge: 'character', characterId: 'alice' };
    const bob = { ...story, knowledge: 'character', characterId: 'bob' };
    const author = { ...story, knowledge: 'author' };
    expect(canReadMemoryScope(story, alice)).toBe(true);
    expect(canReadMemoryScope(alice, alice)).toBe(true);
    expect(canReadMemoryScope(bob, alice)).toBe(false);
    expect(canReadMemoryScope(author, alice)).toBe(false);
    expect(canReadMemoryScope(author, author)).toBe(false); // scope alone grants no author authority
    expect(canReadMemoryScope(bob, { ...story, viewpoint: 'author' })).toBe(true);
    expect(canReadMemoryScope(author, { ...story, viewpoint: 'author' })).toBe(true);
    expect(canReadMemoryScope(alice, { ...story, characterId: 'alice' })).toBe(true);
    expect(normalizeMemoryScopeContext({ ...story, characterId: 'alice' }).characterId).toBe('alice');
  });

  it('uses stable, collision-resistant canonical keys without granting extra authority', () => {
    expect(memoryScopeKey(story)).toBe(memoryScopeKey({ ...story, extra: 'ignored' }));
    expect(sameMemoryScope(story, { ...story, viewpoint: 'author' })).toBe(true);
    expect(sameMemoryScope(story, { ...story, branchId: 'branch-b' })).toBe(false);
    expect(sameMemoryScope({}, {})).toBe(false);
    expect(memoryScopeKey({ ...story, worldId: 'a:b', branchId: 'c' }))
      .not.toBe(memoryScopeKey({ ...story, worldId: 'a', branchId: 'b:c' }));
  });
});
