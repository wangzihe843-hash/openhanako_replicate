import { createXingyeStore, requireSafeXingyeAgentId } from './xingye-store-utils';

/**
 * 购物 / 二手模块「评价」持久化层。
 *
 * 与买家聊天（xingye-secondhand-buyer-chat-store）同范式：
 * - 每条 entry 对应**一条** AppReviewRecord，按 `entryId` upsert。
 * - 懒生成：只有用户首次点开「已收到 / 已退掉」（购物）或「已售出」（二手）详情才请 LLM 生成一次；之后读缓存。
 * - **只读不可改**：和买家聊天不同，评价生成后不提供「换一段」，落盘即定稿（贴「翻看 TA 手机」的设定——
 *   现实里的评价也不会反复重写）。
 * - 与 entries.jsonl 解耦：评价是 entry 的附属物，不进 AppEntry 通用存储，避免污染记账聚合语义。
 *
 * 落盘路径按模块分文件：
 *   apps/shopping/reviews.jsonl   —— 购物：1 条 TA(买家) → 商品/店家 的评价（+ 差评时店家小作文回复）
 *   apps/secondhand/reviews.jsonl —— 二手：闲鱼式互评 2 条（卖家(TA)→买家、买家→卖家/商品）
 */

export type ReviewAppId = 'shopping' | 'secondhand';

/** 1–2 星 = 差评(bad)，3 星 = 中评(neutral)，4–5 星 = 好评(good)。 */
export type ReviewSentiment = 'good' | 'neutral' | 'bad';

/**
 * 一侧的评价。
 *
 * `by` 标识作者身份（决定 UI 文案）：
 *  - 'agent'        = TA 自己写的评价。购物里 = TA(买家) 评商品；二手里 = TA(卖家) 评买家。
 *  - 'counterparty' = 对方写的评价。仅二手有——买家评卖家(TA)/商品。
 */
export type AppReviewSide = {
  by: 'agent' | 'counterparty';
  /**
   * 是否作出了评价。false → UI 显示「该用户未作出评价，系统默认给出好评」，
   * 此时 stars 固定为 5（默认好评，不抖动），text 为空。
   */
  reviewed: boolean;
  /** 1–5 整数。reviewed=false 时固定 5。 */
  stars: number;
  /** reviewed=true 时的评价正文；reviewed=false 时为空字符串。 */
  text: string;
};

export type AppReviewRecord = {
  /** 关联的 entry.id；同时是 jsonl 行的主键。 */
  entryId: string;
  /** 生成时的商品名快照（避免详情数据漂移）。 */
  itemName: string;
  /** 生成时的状态快照（购物 received/returned；二手 sold）。 */
  itemStatus: string;
  /**
   * 评价侧：
   *  - 购物：长度 1 —— [agent]
   *  - 二手：长度 2 —— [agent(卖家→买家), counterparty(买家→卖家/商品)]
   */
  sides: AppReviewSide[];
  /**
   * 仅购物、且 agent(买家) 给出差评时存在：店家对差评的「小作文」回复（客服腔道歉）。
   * null / 缺省 → 不渲染。二手不用此字段。
   */
  sellerReply?: string | null;
  /** 整条记录的生成时间（ISO）。 */
  generatedAt: string;
};

/** 由星级推回评价档位。1–2=差评，3=中评，4–5=好评。 */
export function reviewSentimentFromStars(stars: number): ReviewSentiment {
  if (stars <= 2) return 'bad';
  if (stars === 3) return 'neutral';
  return 'good';
}

function relPath(appId: ReviewAppId): string {
  return `apps/${appId}/reviews.jsonl`;
}

const store = createXingyeStore();

export async function listAppReviews(
  agentId: string,
  appId: ReviewAppId,
): Promise<AppReviewRecord[]> {
  const aid = requireSafeXingyeAgentId(agentId);
  return store.listJsonl<AppReviewRecord>(aid, relPath(appId));
}

export async function readAppReview(
  agentId: string,
  appId: ReviewAppId,
  entryId: string,
): Promise<AppReviewRecord | null> {
  const eid = String(entryId ?? '').trim();
  if (!eid) return null;
  const all = await listAppReviews(agentId, appId);
  return all.find((r) => r.entryId === eid) ?? null;
}

/**
 * upsert：同 entryId 直接覆盖。
 *
 * 条目数量上限 = 用户已生成过评价的 entry 数（少则几条多则几十条），全量重写 jsonl 的开销可接受，
 * 换取实现上的简单性和原子性（与 buyer-chat store 一致）。
 */
export async function saveAppReview(
  agentId: string,
  appId: ReviewAppId,
  record: AppReviewRecord,
): Promise<void> {
  const aid = requireSafeXingyeAgentId(agentId);
  if (!record?.entryId) throw new Error('entryId is required');
  const list = await store.listJsonl<AppReviewRecord>(aid, relPath(appId));
  const next = list.filter((r) => r.entryId !== record.entryId);
  next.push(record);
  await store.writeJsonl<AppReviewRecord>(aid, relPath(appId), next);
}

export async function deleteAppReview(
  agentId: string,
  appId: ReviewAppId,
  entryId: string,
): Promise<boolean> {
  const aid = requireSafeXingyeAgentId(agentId);
  const eid = String(entryId ?? '').trim();
  if (!eid) return false;
  const list = await store.listJsonl<AppReviewRecord>(aid, relPath(appId));
  const next = list.filter((r) => r.entryId !== eid);
  if (next.length === list.length) return false;
  await store.writeJsonl<AppReviewRecord>(aid, relPath(appId), next);
  return true;
}
