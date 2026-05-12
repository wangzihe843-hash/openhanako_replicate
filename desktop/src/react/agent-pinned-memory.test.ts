/**
 * @vitest-environment jsdom
 */

import { describe, expect, it, vi } from 'vitest';
import {
  emitAgentPinnedMemoryChanged,
  loadAgentPinnedMemory,
  OPENHANAKO_AGENT_PINNED_MEMORY_CHANGED,
  pinnedListContainsNormalizedContent,
  subscribeAgentPinnedMemoryChanged,
} from './agent-pinned-memory';

describe('agent-pinned-memory', () => {
  it('pinnedListContainsNormalizedContent matches whitespace-insensitive', () => {
    expect(pinnedListContainsNormalizedContent(['a', 'hello  world'], 'hello\nworld')).toBe(true);
    expect(pinnedListContainsNormalizedContent(['x'], 'y')).toBe(false);
  });

  it('loadAgentPinnedMemory parses pins array', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ pins: [' one ', 'two'] }),
    } as Response);
    const pins = await loadAgentPinnedMemory('aid', fetchImpl);
    expect(pins).toEqual(['one', 'two']);
    expect(fetchImpl).toHaveBeenCalledWith('/api/agents/aid/pinned');
  });

  it('subscribe receives emit payload', () => {
    const handler = vi.fn();
    const unsub = subscribeAgentPinnedMemoryChanged(handler);
    emitAgentPinnedMemoryChanged({ agentId: 'a1', source: 'settings', pinsCount: 2 });
    expect(handler).toHaveBeenCalledWith({ agentId: 'a1', source: 'settings', pinsCount: 2 });
    unsub();
    emitAgentPinnedMemoryChanged({ agentId: 'a2', source: 'unknown' });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('uses expected custom event name', () => {
    expect(OPENHANAKO_AGENT_PINNED_MEMORY_CHANGED).toBe('openhanako-agent-pinned-memory-changed');
  });
});
