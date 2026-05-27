/**
 * 服务端「待确认短信草稿」入库前的硬去重。
 *
 * 渲染端 desktop/src/react/xingye/xingye-sms-dedupe.ts 的 server 端镜像——
 * 心跳路径（propose-draft-tool → appendSmsDraftServer）不经过渲染端的
 * detectSmsDraftDuplicate，所以这里要兜一层一样的硬过滤，避免 LLM 在
 * 一次心跳里反复给同一个对方提同样的草稿。
 *
 * 与 TS 版的行为对齐：
 *   - 分桶维度：targetType + (targetId 优先 / 否则 matchName)
 *   - 24h 窗口：6 个月前的同句不算重
 *   - 命中规则：normalize 后完全相等 → exact_dup；bigramJaccard ≥ 0.7 → similar
 *
 * 归一化与 bigram 阈值与 desktop/src/react/xingye/xingye-files-dedupe.ts 同步
 * （没法直接共享代码：renderer 是 TS bundled，server 是 JS ESM）。
 */

/** Bigram Jaccard 阈值：SMS content 通常比 title 长，阈值降一档允许更细的判重。 */
export const SMS_DUPLICATE_JACCARD_THRESHOLD = 0.7;

/** "同日"窗口（毫秒）；只在 24h 内的草稿对子做相似度判重。 */
export const SMS_DUPLICATE_SAME_DAY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * 归一化字符串用于比较——与 xingye-files-dedupe.normalizeTitleForDedup 行为同步：
 *   1. trim
 *   2. 全角标点 → 半角
 *   3. 中英文常见包裹符号（《》「」""''）整体删掉
 *   4. 多个连续空白 → 单个空格
 *   5. 英文部分小写
 */
function normalizeContentForDedup(content) {
  if (typeof content !== "string") return "";
  let s = content.trim();
  if (!s) return "";
  s = s.replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  s = s.replace(/[《》「」『』"'""'']/g, "");
  s = s.replace(/\s+/g, " ");
  s = s.toLowerCase();
  return s;
}

/**
 * Bigram 集合。长度 < 2 → 单元素集合（让单字也能比较）。
 */
function toBigramSet(text) {
  if (!text) return new Set();
  if (text.length < 2) return new Set([text]);
  const out = new Set();
  for (let i = 0; i < text.length - 1; i += 1) {
    out.add(text.slice(i, i + 2));
  }
  return out;
}

/**
 * Jaccard 相似度。空集合相比为 0（不当作"完全相同"——那是 exact_dup 的活）。
 */
function bigramJaccard(a, b) {
  const A = toBigramSet(normalizeContentForDedup(a));
  const B = toBigramSet(normalizeContentForDedup(b));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const ch of A) if (B.has(ch)) inter += 1;
  const union = A.size + B.size - inter;
  if (union === 0) return 0;
  return inter / union;
}

/**
 * 主决策：candidate 是否与同对方的近 24h 内已有草稿形成「重复 / 高度相似」。
 *
 * @param {{targetType: string, targetId?: string, matchName?: string, content: string}} candidate
 * @param {Array<{id: string, targetType: string, targetId?: string, matchName?: string, content: string, createdAt: string}>} existingDrafts
 * @param {Date} [now=new Date()]
 * @returns {{kind: 'unique'} | {kind: 'exact_dup', draft: object} | {kind: 'similar', draft: object, score: number}}
 *
 * 命中规则：
 *   1. normalize 后字符串完全相等 → exact_dup
 *   2. bigramJaccard ≥ SMS_DUPLICATE_JACCARD_THRESHOLD → similar
 *   3. 否则 → unique
 *
 * 分桶维度：targetType 必须相同；且 (candidate.targetId 与 draft.targetId 相等)
 * 或 (candidate.matchName 与 draft.matchName 相等)。两者都没匹配上 → 不同对方，跳过。
 */
export function detectSmsDraftDuplicate(candidate, existingDrafts, now = new Date()) {
  const candContent = normalizeContentForDedup(candidate?.content ?? "");
  if (!candContent) return { kind: "unique" };

  const candTargetType = typeof candidate?.targetType === "string" ? candidate.targetType : "";
  if (!candTargetType) return { kind: "unique" };

  const candTargetId = typeof candidate?.targetId === "string" ? candidate.targetId.trim() : "";
  const candMatchName = typeof candidate?.matchName === "string" ? candidate.matchName.trim() : "";
  if (!candTargetId && !candMatchName) return { kind: "unique" };

  const nowMs = now.getTime();
  let bestSimilar = null;

  for (const draft of existingDrafts ?? []) {
    if (!draft || typeof draft !== "object") continue;
    if (draft.targetType !== candTargetType) continue;

    const draftTargetId = typeof draft.targetId === "string" ? draft.targetId.trim() : "";
    const draftMatchName = typeof draft.matchName === "string" ? draft.matchName.trim() : "";
    const sameTargetId = candTargetId && draftTargetId && draftTargetId === candTargetId;
    const sameMatchName = candMatchName && draftMatchName && draftMatchName === candMatchName;
    if (!sameTargetId && !sameMatchName) continue;

    /** 24h 窗口（解析失败的旧草稿放过，最稳）。 */
    const ts = Date.parse(draft.createdAt);
    if (Number.isFinite(ts) && nowMs - ts > SMS_DUPLICATE_SAME_DAY_WINDOW_MS) continue;

    const draftContent = normalizeContentForDedup(draft.content ?? "");
    if (!draftContent) continue;
    if (draftContent === candContent) {
      return { kind: "exact_dup", draft };
    }
    const score = bigramJaccard(draft.content, candidate.content);
    if (score >= SMS_DUPLICATE_JACCARD_THRESHOLD) {
      if (!bestSimilar || score > bestSimilar.score) {
        bestSimilar = { draft, score };
      }
    }
  }
  if (bestSimilar) return { kind: "similar", draft: bestSimilar.draft, score: bestSimilar.score };
  return { kind: "unique" };
}
