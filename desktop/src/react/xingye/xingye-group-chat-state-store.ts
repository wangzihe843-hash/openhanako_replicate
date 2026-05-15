/**
 * xingye-group-chat-state-store.ts — 星野群聊「手动提醒直接回复」MVP 的本地运行记录。
 *
 * 落盘位置：`HANA_HOME/agents/{agentId}/xingye/group-chat/runs.jsonl`
 * 每条记录代表一次手动触发的执行结果（replied / skipped / error）。
 *
 * 用途：
 * - 防止同一 agent 对同一 channel 同一 latestMessageId 重复回复
 * - 刷新 / 重启后仍能识别历史触发，避免连续点击导致刷屏
 *
 * 注意：
 * - 这是 agent 私有视角的运行日志，不是群聊消息本身。
 * - 不存 user 消息或其他 agent 消息。
 * - 不与 OpenHanako Channel 文件耦合，仅作 dedupe 索引。
 */

import {
  createXingyeStore,
  generateXingyeId,
  nowIso,
  requireSafeXingyeAgentId,
} from './xingye-store-utils';
import type { XingyeStorageBackend } from './xingye-storage-backend';

export const XINGYE_GROUP_CHAT_RUNS_PATH = 'group-chat/runs.jsonl';

export type XingyeGroupChatRunStatus = 'replied' | 'skipped' | 'error';

export type XingyeGroupChatRun = {
  id: string;
  agentId: string;
  channelId: string;
  /** sender@timestamp 形式，用于 dedupe 与 UI 展示。 */
  sourceMessageIds: string[];
  latestMessageId?: string;
  /** `${agentId}::${channelId}::${latestMessageId}` —— 同一组合不会重复回复 */
  dedupeKey: string;
  status: XingyeGroupChatRunStatus;
  replyMessageId?: string;
  replyContent?: string;
  reason?: string;
  createdAt: string;
};

export type XingyeGroupChatRunInput = {
  agentId: string;
  channelId: string;
  sourceMessageIds: string[];
  latestMessageId?: string;
  status: XingyeGroupChatRunStatus;
  replyMessageId?: string;
  replyContent?: string;
  reason?: string;
};

export function makeGroupChatDedupeKey(args: {
  agentId: string;
  channelId: string;
  latestMessageId?: string | null;
}): string {
  const aid = String(args.agentId ?? '').trim();
  const cid = String(args.channelId ?? '').trim();
  const mid = String(args.latestMessageId ?? '').trim();
  if (!aid || !cid) throw new Error('agentId and channelId are required');
  return `${aid}::${cid}::${mid || '__empty__'}`;
}

/** sender@timestamp — 用作 channel message 的唯一稳定 id（channel-store 用 ts+sender 作 dedupe）。 */
export function buildChannelMessageId(message: { sender: string; timestamp: string }): string {
  return `${message.sender}@${message.timestamp}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeStatus(value: unknown): XingyeGroupChatRunStatus | null {
  return value === 'replied' || value === 'skipped' || value === 'error' ? value : null;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function normalizeGroupChatRun(value: unknown): XingyeGroupChatRun | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === 'string' && value.id.trim() ? value.id.trim() : '';
  const agentId = typeof value.agentId === 'string' && value.agentId.trim() ? value.agentId.trim() : '';
  const channelId = typeof value.channelId === 'string' && value.channelId.trim() ? value.channelId.trim() : '';
  const dedupeKey = typeof value.dedupeKey === 'string' && value.dedupeKey.trim() ? value.dedupeKey.trim() : '';
  const status = normalizeStatus(value.status);
  const createdAt = typeof value.createdAt === 'string' && value.createdAt.trim()
    ? value.createdAt.trim()
    : '';
  if (!id || !agentId || !channelId || !dedupeKey || !status || !createdAt) return null;
  const sourceMessageIds = normalizeStringArray(value.sourceMessageIds);
  const latestMessageId = typeof value.latestMessageId === 'string' && value.latestMessageId.trim()
    ? value.latestMessageId.trim()
    : undefined;
  const replyMessageId = typeof value.replyMessageId === 'string' && value.replyMessageId.trim()
    ? value.replyMessageId.trim()
    : undefined;
  const replyContent = typeof value.replyContent === 'string' ? value.replyContent : undefined;
  const reason = typeof value.reason === 'string' && value.reason.trim() ? value.reason.trim() : undefined;
  return {
    id,
    agentId,
    channelId,
    sourceMessageIds,
    latestMessageId,
    dedupeKey,
    status,
    replyMessageId,
    replyContent,
    reason,
    createdAt,
  };
}

export type XingyeGroupChatStateStoreOptions = {
  idFactory?: () => string;
  now?: () => string;
};

export function createXingyeGroupChatStateStore(
  backend?: XingyeStorageBackend,
  options: XingyeGroupChatStateStoreOptions = {},
) {
  const store = createXingyeStore(backend);
  const idFactory = options.idFactory ?? (() => generateXingyeId('xy-gc-run'));
  const getNow = options.now ?? nowIso;

  return {
    async listRuns(agentId: string): Promise<XingyeGroupChatRun[]> {
      const aid = requireSafeXingyeAgentId(agentId);
      const rows = await store.listJsonl<unknown>(aid, XINGYE_GROUP_CHAT_RUNS_PATH);
      return rows
        .map((row) => normalizeGroupChatRun(row))
        .filter((row): row is XingyeGroupChatRun => row !== null && row.agentId === aid);
    },

    async findRunByDedupeKey(agentId: string, dedupeKey: string): Promise<XingyeGroupChatRun | null> {
      const aid = requireSafeXingyeAgentId(agentId);
      const key = String(dedupeKey ?? '').trim();
      if (!key) return null;
      const rows = await store.listJsonl<unknown>(aid, XINGYE_GROUP_CHAT_RUNS_PATH);
      for (const row of rows) {
        const normalized = normalizeGroupChatRun(row);
        if (normalized && normalized.agentId === aid && normalized.dedupeKey === key) {
          return normalized;
        }
      }
      return null;
    },

    async listRunsForChannel(agentId: string, channelId: string): Promise<XingyeGroupChatRun[]> {
      const aid = requireSafeXingyeAgentId(agentId);
      const cid = String(channelId ?? '').trim();
      if (!cid) return [];
      const all = await this.listRuns(aid);
      return all.filter((run) => run.channelId === cid);
    },

    async appendRun(input: XingyeGroupChatRunInput): Promise<XingyeGroupChatRun> {
      const aid = requireSafeXingyeAgentId(input.agentId);
      const cid = String(input.channelId ?? '').trim();
      if (!cid) throw new Error('channelId is required');
      const dedupeKey = makeGroupChatDedupeKey({
        agentId: aid,
        channelId: cid,
        latestMessageId: input.latestMessageId ?? null,
      });
      const run: XingyeGroupChatRun = {
        id: idFactory(),
        agentId: aid,
        channelId: cid,
        sourceMessageIds: input.sourceMessageIds.filter((value) => typeof value === 'string' && value.trim()),
        latestMessageId: input.latestMessageId?.trim() || undefined,
        dedupeKey,
        status: input.status,
        replyMessageId: input.replyMessageId?.trim() || undefined,
        replyContent: typeof input.replyContent === 'string' ? input.replyContent : undefined,
        reason: input.reason?.trim() || undefined,
        createdAt: getNow(),
      };
      await store.appendJsonl<XingyeGroupChatRun>(aid, XINGYE_GROUP_CHAT_RUNS_PATH, run);
      return run;
    },
  };
}

export type XingyeGroupChatStateStoreApi = ReturnType<typeof createXingyeGroupChatStateStore>;

const defaultStore = createXingyeGroupChatStateStore();

export const listGroupChatRuns = defaultStore.listRuns;
export const findGroupChatRunByDedupeKey = defaultStore.findRunByDedupeKey;
export const listGroupChatRunsForChannel = defaultStore.listRunsForChannel;
export const appendGroupChatRun = defaultStore.appendRun;
