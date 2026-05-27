/**
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import {
  HIDDEN_FOLDER_REACTION_POOLS,
  getWrongPasswordReaction,
} from './xingye-files-secret-reactions';

describe('xingye-files-secret-reactions', () => {
  it('三个池都至少有一条文案', () => {
    expect(HIDDEN_FOLDER_REACTION_POOLS.firstAttempt.length).toBeGreaterThan(0);
    expect(HIDDEN_FOLDER_REACTION_POOLS.secondAttempt.length).toBeGreaterThan(0);
    expect(HIDDEN_FOLDER_REACTION_POOLS.repeated.length).toBeGreaterThan(0);
  });

  it('每条文案都非空字符串', () => {
    for (const pool of Object.values(HIDDEN_FOLDER_REACTION_POOLS)) {
      for (const line of pool) {
        expect(line.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('attemptCount 决定取哪个池', () => {
    const r1 = getWrongPasswordReaction({
      agentName: 'TA',
      attemptCount: 1,
      randomSource: () => 0,
    });
    const r2 = getWrongPasswordReaction({
      agentName: 'TA',
      attemptCount: 2,
      randomSource: () => 0,
    });
    const r3 = getWrongPasswordReaction({
      agentName: 'TA',
      attemptCount: 5,
      randomSource: () => 0,
    });
    expect(HIDDEN_FOLDER_REACTION_POOLS.firstAttempt).toContain(r1);
    expect(HIDDEN_FOLDER_REACTION_POOLS.secondAttempt).toContain(r2);
    expect(HIDDEN_FOLDER_REACTION_POOLS.repeated).toContain(r3);
  });

  it('attemptCount<=0 视为 1', () => {
    const r = getWrongPasswordReaction({
      agentName: 'TA',
      attemptCount: 0,
      randomSource: () => 0,
    });
    expect(HIDDEN_FOLDER_REACTION_POOLS.firstAttempt).toContain(r);
  });

  it('randomSource 0 / 0.99 在同一池里选不同条', () => {
    const r0 = getWrongPasswordReaction({
      agentName: 'TA',
      attemptCount: 1,
      randomSource: () => 0,
    });
    const r99 = getWrongPasswordReaction({
      agentName: 'TA',
      attemptCount: 1,
      randomSource: () => 0.999,
    });
    if (HIDDEN_FOLDER_REACTION_POOLS.firstAttempt.length > 1) {
      expect(r0).not.toBe(r99);
    }
  });
});
