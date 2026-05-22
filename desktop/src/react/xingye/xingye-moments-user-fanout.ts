/**
 * 用户朋友圈的「角色围观扇出」。
 *
 * 用户以自己身份发了一条朋友圈后（authorAgentId = XINGYE_MOMENT_USER_AUTHOR_ID），
 * 遍历花名册里每个角色，按各自对 user 的关系档位**确定性地**决定是否点赞 / 是否评论 /
 * 评论语气，再对要评论的角色逐个调用 AI 生成评论文本，写回该帖子的点赞 / 评论区。
 *
 * 设计要点：
 * - 决策（点不点赞、评不评论、什么语气）是本地确定性计算——只有评论**正文**才动用 LLM。
 *   这符合「LLM 只回定性核心，批量 / 数值决策本地生成」的约定。
 * - 编排是**串行**的：toggleLike / addComment 都是对同一个 posts.jsonl 的
 *   read-modify-write，并发执行会丢更新；串行同时带来「评论陆续冒出来」的自然观感，
 *   且后发评论能看到先发评论、避免复读。
 * - 单个角色失败被隔离（仅 warn），不影响其余角色。
 */
import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import { getXingyePersistenceStorage } from './xingye-persistence';
import { getRelationshipState, type XingyeRelationshipStage } from './xingye-state-store';
import { generateXingyeMomentCommentForUserPostWithAI } from './xingye-moments-ai';
import {
  XINGYE_MOMENT_USER_AUTHOR_ID,
  addXingyeMomentComment,
  listXingyeMomentPosts,
  toggleXingyeMomentLike,
} from './xingye-moments-store';

/** 角色对一条用户朋友圈的评论意向：不评论 / 友善评论 / 冷嘲热讽。 */
export type XingyeUserPostReactionComment = 'none' | 'friendly' | 'sarcastic';

export type XingyeUserPostReactionDecision = {
  like: boolean;
  comment: XingyeUserPostReactionComment;
};

type ReactionRule = {
  likeProb: number;
  commentProb: number;
  /** 该档位决定评论时采用的语气。 */
  commentTone: Exclude<XingyeUserPostReactionComment, 'none'>;
};

/**
 * 关系档位 → 互动倾向。概率与语气均可调。
 * - enemy（关系很差）：绝不点赞；大概率留一条冷嘲热讽的评论。
 * - estranged（关系有点不好）：低频互动——多数情况点赞、评论都不做。
 * - stranger 及以上：点赞 / 友善评论概率随关系升高。
 */
export const XINGYE_USER_POST_REACTION_RULES: Record<XingyeRelationshipStage, ReactionRule> = {
  enemy: { likeProb: 0.0, commentProb: 0.85, commentTone: 'sarcastic' },
  estranged: { likeProb: 0.1, commentProb: 0.1, commentTone: 'friendly' },
  stranger: { likeProb: 0.45, commentProb: 0.3, commentTone: 'friendly' },
  friend: { likeProb: 0.82, commentProb: 0.68, commentTone: 'friendly' },
  close_friend: { likeProb: 0.95, commentProb: 0.88, commentTone: 'friendly' },
  lover: { likeProb: 0.97, commentProb: 0.92, commentTone: 'friendly' },
  bond: { likeProb: 0.97, commentProb: 0.93, commentTone: 'friendly' },
};

/** 没有关系状态记录时的默认档位——伴侣类应用里角色对用户默认偏友好。 */
export const XINGYE_USER_POST_DEFAULT_STAGE: XingyeRelationshipStage = 'friend';

/**
 * 按关系档位确定性地决定一个角色对用户朋友圈的反应。
 * 固定先抽 like 再抽 comment，两次 rand() 调用顺序稳定，便于注入 rand 做确定性测试。
 */
export function decideXingyeUserPostReaction(
  stage: XingyeRelationshipStage | null | undefined,
  rand: () => number = Math.random,
): XingyeUserPostReactionDecision {
  const rule =
    XINGYE_USER_POST_REACTION_RULES[stage ?? XINGYE_USER_POST_DEFAULT_STAGE] ??
    XINGYE_USER_POST_REACTION_RULES[XINGYE_USER_POST_DEFAULT_STAGE];
  const like = rand() < rule.likeProb;
  const comment: XingyeUserPostReactionComment = rand() < rule.commentProb ? rule.commentTone : 'none';
  return { like, comment };
}

/** 读取某角色对 user 的关系档位；无记录或读取失败时返回 null（调用方会回退到默认档位）。 */
export function resolveAgentRelationshipStage(agentId: string): XingyeRelationshipStage | null {
  try {
    const storage = getXingyePersistenceStorage();
    return getRelationshipState(agentId, storage)?.relationshipKey ?? null;
  } catch {
    return null;
  }
}

export type XingyeUserPostFanoutAgent = {
  agent: Agent;
  profile: XingyeRoleProfile | null;
  /** 角色展示名（落到 like.actorName / comment.actorName）。 */
  displayName: string;
};

type GenerateUserPostComment = (params: {
  commentAgent: Agent;
  commentProfile: XingyeRoleProfile | null;
  postContent: string;
  existingComments: ReadonlyArray<{ authorName: string; body: string }>;
  tone: Exclude<XingyeUserPostReactionComment, 'none'>;
}) => Promise<string>;

export type FanOutAgentReactionsOptions = {
  /** 用户帖子的 id（createXingyeMomentPost 返回值的 .id）。 */
  postId: string;
  agents: ReadonlyArray<XingyeUserPostFanoutAgent>;
  /** 注入随机源，便于测试。默认 Math.random。 */
  rand?: () => number;
  /** 注入评论生成器，便于测试。默认走真实 AI。 */
  generateComment?: GenerateUserPostComment;
};

/**
 * 对一条用户朋友圈执行角色围观扇出。串行处理每个角色：先点赞、再（若需要）生成并写入评论。
 * fire-and-forget 调用即可——每次 toggleLike / addComment 都会触发朋友圈刷新事件，
 * 评论会在 feed 里陆续出现。
 */
export async function fanOutAgentReactionsToUserPost(
  options: FanOutAgentReactionsOptions,
): Promise<void> {
  const { agents } = options;
  const rand = options.rand ?? Math.random;
  const generateComment: GenerateUserPostComment =
    options.generateComment ?? ((params) => generateXingyeMomentCommentForUserPostWithAI(params));
  const ownerId = XINGYE_MOMENT_USER_AUTHOR_ID;
  const pid = typeof options.postId === 'string' ? options.postId.trim() : '';
  if (!pid || !agents.length) return;

  for (const entry of agents) {
    const stage = resolveAgentRelationshipStage(entry.agent.id);
    const decision = decideXingyeUserPostReaction(stage, rand);
    if (!decision.like && decision.comment === 'none') continue;

    if (decision.like) {
      try {
        await toggleXingyeMomentLike(ownerId, pid, {
          actorType: 'agent',
          actorId: entry.agent.id,
          actorName: entry.displayName,
        });
      } catch (error) {
        console.warn('[xingye-moments-user-fanout] like failed for', entry.agent.id, error);
      }
    }

    if (decision.comment !== 'none') {
      try {
        // 每次重新读帖子：让后发评论看到先发评论、避免复读；帖子被用户删掉时直接收尾。
        const post = (await listXingyeMomentPosts(ownerId)).find((p) => p.id === pid);
        if (!post) break;
        const body = await generateComment({
          commentAgent: entry.agent,
          commentProfile: entry.profile,
          postContent: post.content,
          existingComments: post.comments.map((c) => ({
            authorName: c.actorName,
            body: c.body,
          })),
          tone: decision.comment,
        });
        await addXingyeMomentComment(
          ownerId,
          pid,
          {
            actorType: 'agent',
            actorId: entry.agent.id,
            actorName: entry.displayName,
          },
          body,
        );
      } catch (error) {
        console.warn('[xingye-moments-user-fanout] comment failed for', entry.agent.id, error);
      }
    }
  }
}
