/**
 * 服务端镜像:draft_reply 草稿上「TA 涂改的痕迹」结构归一化。
 *
 * 与 desktop/src/react/xingye/secret-space-draft-revisions.ts 同步;两边限制一致。
 * propose-draft 工具 + appendSecretSpaceDraftServer 调用本模块的 normalize,
 * 让 LLM 给出的脏 / 半结构化 revisions 进 jsonl 时是干净的。
 */

export const SECRET_SPACE_STRUCK_TEXT_MAX = 80;
export const SECRET_SPACE_STRUCK_REASON_MAX = 200;
export const SECRET_SPACE_STRUCK_MAX_ITEMS = 4;
export const SECRET_SPACE_PATCH_TEXT_MAX = 80;
export const SECRET_SPACE_PATCH_REASON_MAX = 200;
export const SECRET_SPACE_PATCH_MAX_ITEMS = 3;
export const SECRET_SPACE_MARGIN_NOTE_MAX = 40;
export const SECRET_SPACE_MARGIN_NOTES_MAX_ITEMS = 3;

function isRecordLike(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function trimOptional(value, max) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
}

function trimRequired(value, max) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

function normalizeStruck(value) {
  if (!Array.isArray(value)) return undefined;
  const out = [];
  for (const item of value) {
    if (out.length >= SECRET_SPACE_STRUCK_MAX_ITEMS) break;
    if (!isRecordLike(item)) continue;
    const text = trimRequired(item.text, SECRET_SPACE_STRUCK_TEXT_MAX);
    if (!text) continue;
    const reason = trimOptional(item.reason, SECRET_SPACE_STRUCK_REASON_MAX);
    out.push(reason ? { text, reason } : { text });
  }
  return out.length ? out : undefined;
}

function normalizePatches(value) {
  if (!Array.isArray(value)) return undefined;
  const out = [];
  for (const item of value) {
    if (out.length >= SECRET_SPACE_PATCH_MAX_ITEMS) break;
    if (!isRecordLike(item)) continue;
    const text = trimRequired(item.text, SECRET_SPACE_PATCH_TEXT_MAX);
    if (!text) continue;
    const idxRaw = item.afterParagraphIndex;
    const idx = typeof idxRaw === "number" && Number.isFinite(idxRaw)
      ? Math.max(0, Math.floor(idxRaw))
      : 0;
    const reason = trimOptional(item.reason, SECRET_SPACE_PATCH_REASON_MAX);
    out.push(reason
      ? { afterParagraphIndex: idx, text, reason }
      : { afterParagraphIndex: idx, text });
  }
  return out.length ? out : undefined;
}

function normalizeMarginNotes(value) {
  if (!Array.isArray(value)) return undefined;
  const out = [];
  for (const item of value) {
    if (out.length >= SECRET_SPACE_MARGIN_NOTES_MAX_ITEMS) break;
    const text = trimRequired(item, SECRET_SPACE_MARGIN_NOTE_MAX);
    if (!text) continue;
    out.push(text);
  }
  return out.length ? out : undefined;
}

/**
 * 归一化 draftRevisions。三段全空 → null,调用方可据此决定是否落字段。
 *
 * @param {unknown} value
 * @returns {{ struck?: {text:string,reason?:string}[], patches?: {afterParagraphIndex:number,text:string,reason?:string}[], marginNotes?: string[] } | null}
 */
export function normalizeSecretSpaceDraftRevisions(value) {
  if (!isRecordLike(value)) return null;
  const struck = normalizeStruck(value.struck);
  const patches = normalizePatches(value.patches);
  const marginNotes = normalizeMarginNotes(value.marginNotes);
  if (!struck && !patches && !marginNotes) return null;
  const out = {};
  if (struck) out.struck = struck;
  if (patches) out.patches = patches;
  if (marginNotes) out.marginNotes = marginNotes;
  return out;
}
