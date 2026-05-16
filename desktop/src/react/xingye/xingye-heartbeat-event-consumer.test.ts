import { beforeEach, describe, expect, it, vi } from 'vitest';

const jsonStore = vi.hoisted(() => new Map<string, unknown>());
const postMock = vi.hoisted(() => vi.fn(async (body: Record<string, unknown>) => {
  const agentId = typeof body.agentId === 'string' ? body.agentId : '';
  const relativePath = typeof body.relativePath === 'string' ? body.relativePath : '';
  const key = `${agentId}|${relativePath}`;
  if (body.action === 'readJson') {
    return { ok: true, data: jsonStore.get(key) ?? null };
  }
  if (body.action === 'writeJson') {
    jsonStore.set(key, body.data);
    return { ok: true };
  }
  throw new Error(`unexpected action: ${String(body.action)}`);
}));

vi.mock('./xingye-storage-api', () => ({
  postXingyeStorage: postMock,
}));

import { XINGYE_EVENT_TYPES, appendXingyeEvent, listUnconsumedXingyeEvents } from './xingye-event-log';
import {
  HEARTBEAT_CONSUMER_NAME,
  consumeXingyeEventLogForHeartbeat,
  summarizeXingyeEventsForHeartbeat,
} from './xingye-heartbeat-event-consumer';

function makeEvent(
  type: Parameters<typeof appendXingyeEvent>[1]['type'],
  payload: Record<string, unknown> = {},
) {
  return {
    id: `${type}-${Math.random().toString(36).slice(2, 8)}`,
    agentId: 'agent-a',
    type,
    source: 'test',
    createdAt: '2026-05-16T00:00:00.000Z',
    payload,
  };
}

describe('summarizeXingyeEventsForHeartbeat (pure)', () => {
  it('returns empty string when there are no events', () => {
    expect(summarizeXingyeEventsForHeartbeat([])).toBe('');
  });

  it('groups by type and orders by the canonical type order', () => {
    const events = [
      makeEvent('moment.created'),
      makeEvent('phone.sms_appended'),
      makeEvent('phone.contact_changed'),
      makeEvent('phone.sms_appended'),
      makeEvent('memory_candidate.created'),
    ];
    // Canonical order: phone.* → ... → moment.* → secret_space.* → memory_candidate.*
    expect(summarizeXingyeEventsForHeartbeat(events))
      .toBe('自上次巡检以来：通讯录变更×1、短信×2、朋友圈新增×1、新记忆候选×1（共 5 条）');
  });

  it('uses friendly Chinese labels for every declared event type', () => {
    const events = [
      makeEvent('recent_chat.observed'),
      makeEvent('pinned_memory.changed'),
      makeEvent('relationship_state.suggested'),
      makeEvent('relationship_state.applied'),
      makeEvent('secret_space.record_appended'),
      makeEvent('secret_space.record_deleted'),
      makeEvent('memory_candidate.written'),
      makeEvent('moment.deleted'),
    ];
    const summary = summarizeXingyeEventsForHeartbeat(events);
    for (const label of [
      '最近对话', '固定记忆变更',
      '关系建议', '关系更新',
      '秘密空间新增', '秘密空间删除',
      '记忆已固化', '朋友圈删除',
    ]) {
      expect(summary).toContain(label);
    }
    expect(summary).toContain('（共 8 条）');
  });

  it('has a Chinese label for every type declared in XINGYE_EVENT_TYPES', () => {
    // 每个枚举类型都必须出现在摘要里（按 1 条事件分别测）；缺失会导致 prompt 摘要回退到事件类型字符串。
    for (const type of XINGYE_EVENT_TYPES) {
      const summary = summarizeXingyeEventsForHeartbeat([makeEvent(type)]);
      expect(summary, `missing label for ${type}`).not.toMatch(new RegExp(`(^|：)${type}×`));
      expect(summary, `summary for ${type}`).toContain('×1');
    }
  });

  it('orders 小手机 app events before relational / memory categories', () => {
    const events = [
      makeEvent('relationship_state.applied'),
      makeEvent('moment.created'),
      makeEvent('mm_chat.turns_appended'),
      makeEvent('mail.messages_appended'),
      makeEvent('journal.entry_appended'),
      makeEvent('schedule.entry_appended'),
      makeEvent('file.entry_appended'),
      makeEvent('divination.entry_appended'),
      makeEvent('shopping.entry_appended'),
      makeEvent('reading_notes.entry_appended'),
    ];
    const summary = summarizeXingyeEventsForHeartbeat(events);
    expect(summary).toBe(
      '自上次巡检以来：私信对话×1、邮件×1、日记新增×1、日程新增×1、文件新增×1、'
      + '占卜记录×1、购物记录×1、读书批注×1、朋友圈新增×1、关系更新×1（共 10 条）',
    );
  });
});

describe('consumeXingyeEventLogForHeartbeat (IO)', () => {
  beforeEach(() => {
    jsonStore.clear();
    postMock.mockClear();
  });

  it('returns empty summary and zero count when nothing is pending', async () => {
    const result = await consumeXingyeEventLogForHeartbeat('agent-a');
    expect(result).toEqual({ summary: '', consumedCount: 0 });
  });

  it('summarizes unconsumed events and marks them consumed by heartbeat', async () => {
    await appendXingyeEvent('agent-a', {
      type: 'phone.contact_changed', source: 't', payload: { id: 'c1' },
    });
    await appendXingyeEvent('agent-a', {
      type: 'phone.sms_appended', source: 't', payload: { id: 's1' },
    });
    await appendXingyeEvent('agent-a', {
      type: 'memory_candidate.created', source: 't', payload: { id: 'm1' },
    });

    const first = await consumeXingyeEventLogForHeartbeat('agent-a');
    expect(first.consumedCount).toBe(3);
    expect(first.summary).toBe('自上次巡检以来：通讯录变更×1、短信×1、新记忆候选×1（共 3 条）');

    // A second call should see nothing — heartbeat already consumed them.
    const second = await consumeXingyeEventLogForHeartbeat('agent-a');
    expect(second).toEqual({ summary: '', consumedCount: 0 });

    // Other consumers (e.g. a hypothetical 'moments') still see them.
    const stillForOthers = await listUnconsumedXingyeEvents('agent-a', 'moments');
    expect(stillForOthers).toHaveLength(3);
  });

  it('ignores blank agentId', async () => {
    const result = await consumeXingyeEventLogForHeartbeat('   ');
    expect(result).toEqual({ summary: '', consumedCount: 0 });
    expect(postMock).not.toHaveBeenCalled();
  });

  it('keeps per-agent isolation', async () => {
    await appendXingyeEvent('agent-a', {
      type: 'moment.created', source: 't', payload: { id: 'a' },
    });
    await appendXingyeEvent('agent-b', {
      type: 'moment.created', source: 't', payload: { id: 'b' },
    });

    const a = await consumeXingyeEventLogForHeartbeat('agent-a');
    expect(a.consumedCount).toBe(1);

    // agent-b still has its own pending event.
    const remainingForB = await listUnconsumedXingyeEvents('agent-b', HEARTBEAT_CONSUMER_NAME);
    expect(remainingForB).toHaveLength(1);
  });
});
