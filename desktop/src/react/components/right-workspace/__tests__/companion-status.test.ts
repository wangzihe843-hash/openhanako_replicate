import { describe, expect, it } from 'vitest';
import {
  latestCompanionTerminalChange,
  resolveCompanionState,
  terminalCompanionState,
} from '../companion-status';

describe('companion status projection', () => {
  it('uses the last task transition so canceled never flashes as failed or completed', () => {
    const now = 100_000;
    const latest = latestCompanionTerminalChange([
      { taskId: 'a', status: 'aborted', sequence: 11, updatedAt: now - 200 },
      { taskId: 'a', status: 'canceled', sequence: 12, updatedAt: now - 100 },
      { taskId: 'old', status: 'completed', sequence: 13, updatedAt: now - 60_000 },
    ], now);
    expect(latest?.status).toBe('canceled');
    expect(terminalCompanionState(latest?.status ?? '')).toBe('canceled');
  });

  it('keeps approval and blocked states distinct and never treats stream end as completion', () => {
    const base = {
      tasks: [], streaming: false, awaitingApproval: false,
      inlineError: false, feedback: null, unavailable: false,
    } as const;
    expect(resolveCompanionState(base)).toBe('idle');
    expect(resolveCompanionState({ ...base, streaming: true })).toBe('busy');
    expect(resolveCompanionState({ ...base, awaitingApproval: true })).toBe('waiting');
    expect(resolveCompanionState({ ...base, tasks: [{ taskId: 'a', status: 'blocked', updatedAt: 1 }] })).toBe('blocked');
    expect(resolveCompanionState({ ...base, feedback: 'failed' })).toBe('failed');
    expect(resolveCompanionState({ ...base, feedback: 'completed' })).toBe('completed');
  });
});
