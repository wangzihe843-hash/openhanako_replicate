import { createXingyeStore, requireSafeXingyeAgentId } from './xingye-store-utils';

/**
 * 二手模块「与买家的聊天记录」持久化层。
 *
 * 每条 secondhand entry（status === 'negotiating' / 'sold' 时才会触发生成）对应**一条**
 * SecondhandBuyerChat record，记录买卖双方的来回对话快照。
 *
 * 设计要点：
 * - 与 entries.jsonl 解耦：buyer chat 是 entry 的「附属物」，不进 AppEntry 通用存储，
 *   避免污染 listAppEntries 的统计语义（不该被记账模块按 category 聚合）。
 * - 懒生成：只有用户首次点开 sold/negotiating 详情页才请 LLM 生成一次；之后读缓存。
 * - upsert 主键 = entryId；重新生成走的是「同 entryId 覆盖」语义。
 */

const REL_PATH = 'apps/secondhand/buyer-chats.jsonl';

export type SecondhandBuyerChatRole = 'buyer' | 'seller';

export type SecondhandBuyerChatMessage = {
  id: string;
  role: SecondhandBuyerChatRole;
  text: string;
  /** ISO timestamp，仅作时间分隔/排序参考；生成时按对话节奏均匀分布 */
  at: string;
};

export type SecondhandBuyerChatStatus = 'negotiating' | 'sold';

export type SecondhandBuyerChat = {
  /** 关联的 SecondhandEntry.id；同时是 jsonl 行的主键。 */
  entryId: string;
  /** 买家口吻（从 entry.metadata.buyer 取；可空时本字段为空字符串）。 */
  buyerName: string;
  /** 生成时的商品名快照（用于聊天页顶部 banner，避免详情数据漂移） */
  itemName: string;
  /** 生成时的商品状态快照。状态变化时不会自动重生成——由用户手动触发。 */
  itemStatus: SecondhandBuyerChatStatus;
  /** 完整对话序列；约定 buyer 先开口。 */
  messages: SecondhandBuyerChatMessage[];
  /** 整条记录的生成时间（ISO）。 */
  generatedAt: string;
};

const store = createXingyeStore();

export async function listSecondhandBuyerChats(
  agentId: string,
): Promise<SecondhandBuyerChat[]> {
  const aid = requireSafeXingyeAgentId(agentId);
  return store.listJsonl<SecondhandBuyerChat>(aid, REL_PATH);
}

export async function readSecondhandBuyerChat(
  agentId: string,
  entryId: string,
): Promise<SecondhandBuyerChat | null> {
  const eid = String(entryId ?? '').trim();
  if (!eid) return null;
  const all = await listSecondhandBuyerChats(agentId);
  return all.find((c) => c.entryId === eid) ?? null;
}

/**
 * upsert：同 entryId 直接覆盖。
 *
 * 条目数量上限就是用户已生成过 chat 的 sold/negotiating entry 数（少则几条多则几十条），
 * 「全量重写 jsonl」的开销可以接受；换取实现上的简单性和原子性。
 */
export async function saveSecondhandBuyerChat(
  agentId: string,
  record: SecondhandBuyerChat,
): Promise<void> {
  const aid = requireSafeXingyeAgentId(agentId);
  if (!record?.entryId) throw new Error('entryId is required');
  const list = await store.listJsonl<SecondhandBuyerChat>(aid, REL_PATH);
  const next = list.filter((c) => c.entryId !== record.entryId);
  next.push(record);
  await store.writeJsonl<SecondhandBuyerChat>(aid, REL_PATH, next);
}

export async function deleteSecondhandBuyerChat(
  agentId: string,
  entryId: string,
): Promise<boolean> {
  const aid = requireSafeXingyeAgentId(agentId);
  const eid = String(entryId ?? '').trim();
  if (!eid) return false;
  const list = await store.listJsonl<SecondhandBuyerChat>(aid, REL_PATH);
  const next = list.filter((c) => c.entryId !== eid);
  if (next.length === list.length) return false;
  await store.writeJsonl<SecondhandBuyerChat>(aid, REL_PATH, next);
  return true;
}
