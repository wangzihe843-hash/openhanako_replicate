import { describe, expect, it, vi } from 'vitest';
import { dispatchStreamKey, hasStreamKeyListeners, subscribeStreamKey } from '../../services/stream-key-dispatcher';

describe('stream-key listener isolation', () => {
  it('reports a failed observer and continues delivering to other observers', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failure = new Error('observer failed');
    const next = vi.fn();
    const unsubscribeFirst = subscribeStreamKey('test-stream', () => { throw failure; });
    const unsubscribeNext = subscribeStreamKey('test-stream', next);
    try {
      const event = { type: 'delta', text: 'test' };
      expect(() => dispatchStreamKey('test-stream', event)).not.toThrow();
      expect(next).toHaveBeenCalledWith(event);
      expect(warn).toHaveBeenCalledWith('[stream-key] listener failed:', failure);
    } finally {
      unsubscribeFirst();
      unsubscribeNext();
      warn.mockRestore();
    }
    expect(hasStreamKeyListeners('test-stream')).toBe(false);
  });
});
