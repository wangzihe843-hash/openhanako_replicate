import { describe, expect, it } from 'vitest';
import {
  assertXingyeMemoryTargetWritable,
  getXingyeMemoryTargetDescription,
  getXingyeMemoryTargetLabel,
  getXingyeMemoryCandidateConfirmBlockedReason,
  isXingyeMemoryTargetWritable,
  normalizeXingyeMemoryCandidateTarget,
  XINGYE_ENABLE_FACT_MEMORY_IMPORT,
} from './xingye-memory-target-policy';

describe('xingye-memory-target-policy', () => {
  it('pinned is writable; longterm and unknown are not', () => {
    expect(isXingyeMemoryTargetWritable('pinned')).toBe(true);
    expect(isXingyeMemoryTargetWritable('longterm')).toBe(false);
    expect(isXingyeMemoryTargetWritable('unknown')).toBe(false);
  });

  it('fact is not writable while XINGYE_ENABLE_FACT_MEMORY_IMPORT is false', () => {
    expect(XINGYE_ENABLE_FACT_MEMORY_IMPORT).toBe(false);
    expect(isXingyeMemoryTargetWritable('fact')).toBe(false);
    expect(() => assertXingyeMemoryTargetWritable('fact')).toThrow('fact import disabled');
  });

  it('normalize maps bogus to unknown and preserves canonical targets', () => {
    expect(normalizeXingyeMemoryCandidateTarget('bogus')).toBe('unknown');
    expect(normalizeXingyeMemoryCandidateTarget(null)).toBe('unknown');
    expect(normalizeXingyeMemoryCandidateTarget('pinned')).toBe('pinned');
    expect(normalizeXingyeMemoryCandidateTarget('fact')).toBe('fact');
    expect(normalizeXingyeMemoryCandidateTarget('longterm')).toBe('longterm');
  });

  it('getXingyeMemoryTargetDescription is non-empty for unknown', () => {
    const d = getXingyeMemoryTargetDescription('unknown');
    expect(d.length).toBeGreaterThan(0);
    expect(getXingyeMemoryTargetLabel('unknown')).toBeTruthy();
  });

  it('assertXingyeMemoryTargetWritable throws stable messages for longterm and unknown', () => {
    expect(() => assertXingyeMemoryTargetWritable('longterm')).toThrow(/longterm is compile output/);
    expect(() => assertXingyeMemoryTargetWritable('unknown')).toThrow('invalid memory target (unknown)');
  });

  it('getXingyeMemoryCandidateConfirmBlockedReason returns empty for pinned', () => {
    expect(getXingyeMemoryCandidateConfirmBlockedReason('pinned')).toBe('');
  });

  it('getXingyeMemoryCandidateConfirmBlockedReason is non-empty for non-writable targets', () => {
    expect(getXingyeMemoryCandidateConfirmBlockedReason('fact').length).toBeGreaterThan(0);
    expect(getXingyeMemoryCandidateConfirmBlockedReason('longterm').length).toBeGreaterThan(0);
    expect(getXingyeMemoryCandidateConfirmBlockedReason('unknown').length).toBeGreaterThan(0);
  });
});
