import { describe, expect, it } from 'vitest';
import { peekDeskHeartbeatUiOutcome, rememberDeskHeartbeatUiOutcome } from './xingye-desk-heartbeat-memory';

describe('xingye-desk-heartbeat-memory', () => {
  it('stores and reads last outcome per agent', () => {
    rememberDeskHeartbeatUiOutcome('a1', '巡检已触发');
    rememberDeskHeartbeatUiOutcome('a2', '另一条');
    expect(peekDeskHeartbeatUiOutcome('a1')).toBe('巡检已触发');
    expect(peekDeskHeartbeatUiOutcome('a2')).toBe('另一条');
    expect(peekDeskHeartbeatUiOutcome('unknown')).toBeNull();
  });
});
