/**
 * 把 event log 里属于「本次巡检」的事件归并成一行中文摘要，
 * 供 PhoneHome「立即巡检」写入 desk-heartbeat-memory，再由 9 个 AI prompt 弱引用。
 *
 * - 只读 event log，不再单独标记 consumedBy；服务端 'xingye.heartbeat' consumer 是唯一消费者。
 * - 「本次巡检」= 该 agent 下尚未被 xingye.heartbeat 消费 OR 被它在 triggerTime 之后消费过的事件，
 *   消除了渲染端与服务端之间的竞态。
 */

import {
  listXingyeEvents,
  type XingyeEvent,
  type XingyeEventType,
} from './xingye-event-log';

export const HEARTBEAT_CONSUMER_NAME = 'xingye.heartbeat';

const TYPE_LABEL: Record<XingyeEventType, string> = {
  'recent_chat.observed': '最近对话',
  'phone.contact_changed': '通讯录变更',
  'phone.sms_appended': '短信',
  'mm_chat.turns_appended': '私信对话',
  'mail.messages_appended': '邮件',
  'mail.message_deleted': '邮件删除',
  'journal.entry_appended': '日记新增',
  'journal.entry_deleted': '日记删除',
  'schedule.entry_appended': '日程新增',
  'schedule.entry_deleted': '日程删除',
  'file.entry_appended': '文件新增',
  'file.entry_deleted': '文件删除',
  'divination.entry_appended': '占卜记录',
  'divination.entry_deleted': '占卜删除',
  'shopping.entry_appended': '购物记录',
  'shopping.entry_deleted': '购物删除',
  'reading_notes.entry_appended': '读书批注',
  'reading_notes.entry_deleted': '读书批注删除',
  'secret_space.record_appended': '秘密空间新增',
  'secret_space.record_deleted': '秘密空间删除',
  'pinned_memory.changed': '固定记忆变更',
  'memory_candidate.created': '新记忆候选',
  'memory_candidate.written': '记忆已固化',
  'relationship_state.suggested': '关系建议',
  'relationship_state.applied': '关系更新',
  'moment.created': '朋友圈新增',
  'moment.deleted': '朋友圈删除',
};

const TYPE_ORDER: XingyeEventType[] = [
  'phone.contact_changed',
  'phone.sms_appended',
  'mm_chat.turns_appended',
  'mail.messages_appended',
  'mail.message_deleted',
  'recent_chat.observed',
  'journal.entry_appended',
  'journal.entry_deleted',
  'schedule.entry_appended',
  'schedule.entry_deleted',
  'file.entry_appended',
  'file.entry_deleted',
  'divination.entry_appended',
  'divination.entry_deleted',
  'shopping.entry_appended',
  'shopping.entry_deleted',
  'reading_notes.entry_appended',
  'reading_notes.entry_deleted',
  'moment.created',
  'moment.deleted',
  'secret_space.record_appended',
  'secret_space.record_deleted',
  'memory_candidate.created',
  'memory_candidate.written',
  'pinned_memory.changed',
  'relationship_state.suggested',
  'relationship_state.applied',
];

const TYPE_ORDER_INDEX = new Map<string, number>(
  TYPE_ORDER.map((type, index) => [type, index]),
);

/**
 * 纯函数：把事件按类型聚合为「自上次巡检以来：A×2、B×5（共 7 条）」格式。
 * 没有事件时返回空字符串，由调用方决定是否落到 UI/prompt。
 */
export function summarizeXingyeEventsForHeartbeat(events: readonly XingyeEvent[]): string {
  if (events.length === 0) return '';
  const counts = new Map<string, number>();
  for (const event of events) {
    counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
  }
  const parts = Array.from(counts.entries())
    .sort((a, b) => {
      const ai = TYPE_ORDER_INDEX.get(a[0]) ?? Number.MAX_SAFE_INTEGER;
      const bi = TYPE_ORDER_INDEX.get(b[0]) ?? Number.MAX_SAFE_INTEGER;
      if (ai !== bi) return ai - bi;
      return a[0].localeCompare(b[0]);
    })
    .map(([type, count]) => `${TYPE_LABEL[type as XingyeEventType] ?? type}×${count}`);
  return `自上次巡检以来：${parts.join('、')}（共 ${events.length} 条）`;
}

export type HeartbeatEventConsumeResult = {
  summary: string;
  consumedCount: number;
};

/**
 * 读取该 agent 「本次巡检」涉及的事件并汇总为一行中文摘要。
 * 不标记 consumedBy——服务端 xingye.heartbeat consumer 是唯一标记方。
 *
 * triggerTime 应在调用 /api/desk/heartbeat 之前捕获，用于过滤出
 * 「上次巡检之后产生 / 本次被服务端 consumer 标记」的事件，跨进程竞态安全。
 */
export async function consumeXingyeEventLogForHeartbeat(
  agentId: string,
  triggerTime?: string,
): Promise<HeartbeatEventConsumeResult> {
  const aid = agentId.trim();
  if (!aid) return { summary: '', consumedCount: 0 };

  const since = (typeof triggerTime === 'string' && triggerTime)
    ? triggerTime
    : new Date().toISOString();

  const all = await listXingyeEvents(aid);
  const events = all.filter((event) => {
    const consumedAt = event.consumedBy?.[HEARTBEAT_CONSUMER_NAME];
    return !consumedAt || consumedAt >= since;
  });
  if (events.length === 0) return { summary: '', consumedCount: 0 };

  return {
    summary: summarizeXingyeEventsForHeartbeat(events),
    consumedCount: events.length,
  };
}
