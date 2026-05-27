import type { XingyeRoleGender } from './xingye-profile-store';

/**
 * 输错密码时 agent 对「不知道是谁的陌生人/小偷/窥探者」的反应。
 *
 * 设计原则：
 * - 固定几句话（用户明确说「可以是固定的几句话」），不要 LLM 调用。
 * - 口吻是「这是 TA 的私人东西，TA 在防你」——警惕、不耐烦、偶尔带点冷意，但不暴怒。
 * - 不要破第四墙（不要出现「这是隐藏文件夹」「请输入正确密码」这种字眼）。
 * - 性别可选地影响代词；agent 名字、user 名字、尝试次数都能注入。
 */

export type HiddenFolderReactionContext = {
  agentName: string;
  /** 第几次输错（从 1 开始）。用来在第 3+ 次时切换到更冷的口吻。 */
  attemptCount: number;
  gender?: XingyeRoleGender;
  randomSource?: () => number;
};

/**
 * 通用反应池——agent 视角的第一人称，对一个陌生人说话。
 * 模板里 `{agent}` 会被替换成 agent 的名字。
 */
const FIRST_ATTEMPT_LINES: ReadonlyArray<string> = [
  '……谁？这不是你该看的东西。',
  '手拿开。这是我的。',
  '你怎么知道这里要密码的？',
  '别试了，你猜不到的。',
  '这一格不对外开放。',
];

const SECOND_ATTEMPT_LINES: ReadonlyArray<string> = [
  '你还在试？我都说了不是你能看的。',
  '再错一次我就不当你是开玩笑了。',
  '这不是好奇心能解决的事，走开。',
  '你以为多试几次我会松口吗？',
];

const REPEATED_ATTEMPT_LINES: ReadonlyArray<string> = [
  '够了。你到底是谁。',
  '这已经不是好奇，是冒犯了。',
  '我不会让你看见的，死心吧。',
  '你再这样下去，我会记住你的。',
];

function pickFromPool(pool: ReadonlyArray<string>, rng: () => number): string {
  if (pool.length === 0) return '';
  const idx = Math.floor(rng() * pool.length) % pool.length;
  return pool[idx];
}

/**
 * 根据失败次数选语气：
 *  - 1 次：警惕但克制
 *  - 2 次：开始不耐烦
 *  - 3+ 次：冷下来 / 把对方当作敌意访问者
 */
function poolForAttempt(attempt: number): ReadonlyArray<string> {
  if (attempt <= 1) return FIRST_ATTEMPT_LINES;
  if (attempt === 2) return SECOND_ATTEMPT_LINES;
  return REPEATED_ATTEMPT_LINES;
}

export function getWrongPasswordReaction(ctx: HiddenFolderReactionContext): string {
  const rng = ctx.randomSource ?? Math.random;
  const pool = poolForAttempt(Math.max(1, ctx.attemptCount));
  return pickFromPool(pool, rng);
}

/** 测试用 / UI debug 用：暴露三个池，便于断言「不空 + 含某关键字」。 */
export const HIDDEN_FOLDER_REACTION_POOLS = {
  firstAttempt: FIRST_ATTEMPT_LINES,
  secondAttempt: SECOND_ATTEMPT_LINES,
  repeated: REPEATED_ATTEMPT_LINES,
} as const;
