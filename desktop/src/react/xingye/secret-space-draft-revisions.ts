/**
 * draft_reply 记录上「TA 涂改的痕迹」结构化字段。
 *
 * 落点:`record.metadata.draftRevisions`(metadata 是 SecretSpaceSampleRecord 上
 * 通用的结构化扩展字段,interview 也是这么用的,不需要改 store schema)。
 *
 * 三种成分(都可选;LLM 不确定时省略,阅读器对缺失会回退到装饰池):
 *
 *  - `struck`:写在正文前、被划掉的开场白。表达 TA 起了几次头都没能写下去。
 *    每条带可选 `reason`(TA 自己的内心活动,第一人称视角)。
 *  - `patches`:夹在某段后面的「改稿批注」(↑ 这里改了三遍 …)。`afterParagraphIndex`
 *    指插在第几段后(0 = 第一段后)。
 *  - `marginNotes`:右侧空白处的竖排小字(…… / ? / 不知道)。
 *
 * 服务端有同名 normalizer(lib/xingye/secret-space-draft-revisions.js),
 * 两边限制必须保持一致;改了这边记得同步改那边。
 */

export interface SecretSpaceStruckLine {
  text: string;
  reason?: string;
}

export interface SecretSpaceDraftPatch {
  afterParagraphIndex: number;
  text: string;
  reason?: string;
}

export interface SecretSpaceDraftRevisions {
  struck?: SecretSpaceStruckLine[];
  patches?: SecretSpaceDraftPatch[];
  marginNotes?: string[];
}

/** 单条划掉行的字数限制(text 段)。 */
export const SECRET_SPACE_STRUCK_TEXT_MAX = 80;
/** 划掉行原因的字数限制。 */
export const SECRET_SPACE_STRUCK_REASON_MAX = 200;
/** 划掉行最多几条(数据上限,LLM 可少不可多)。 */
export const SECRET_SPACE_STRUCK_MAX_ITEMS = 4;

/** 段间补丁字数 / 数量限制。 */
export const SECRET_SPACE_PATCH_TEXT_MAX = 80;
export const SECRET_SPACE_PATCH_REASON_MAX = 200;
export const SECRET_SPACE_PATCH_MAX_ITEMS = 3;

/** 边角小批注(单条 / 总数)限制。 */
export const SECRET_SPACE_MARGIN_NOTE_MAX = 40;
export const SECRET_SPACE_MARGIN_NOTES_MAX_ITEMS = 3;

function trimOptional(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
}

function trimRequired(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeStruck(value: unknown): SecretSpaceStruckLine[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: SecretSpaceStruckLine[] = [];
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

function normalizePatches(value: unknown): SecretSpaceDraftPatch[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: SecretSpaceDraftPatch[] = [];
  for (const item of value) {
    if (out.length >= SECRET_SPACE_PATCH_MAX_ITEMS) break;
    if (!isRecordLike(item)) continue;
    const text = trimRequired(item.text, SECRET_SPACE_PATCH_TEXT_MAX);
    if (!text) continue;
    const idxRaw = item.afterParagraphIndex;
    const idx = typeof idxRaw === 'number' && Number.isFinite(idxRaw) ? Math.max(0, Math.floor(idxRaw)) : 0;
    const reason = trimOptional(item.reason, SECRET_SPACE_PATCH_REASON_MAX);
    out.push(reason ? { afterParagraphIndex: idx, text, reason } : { afterParagraphIndex: idx, text });
  }
  return out.length ? out : undefined;
}

function normalizeMarginNotes(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (out.length >= SECRET_SPACE_MARGIN_NOTES_MAX_ITEMS) break;
    const text = trimRequired(item, SECRET_SPACE_MARGIN_NOTE_MAX);
    if (!text) continue;
    out.push(text);
  }
  return out.length ? out : undefined;
}

/**
 * 把任意可能来自 LLM / heartbeat / jsonl 的 revisions 归一化。
 * 空对象 / 全字段缺失 → 返回 null(调用方可借此决定是否落盘)。
 */
export function normalizeSecretSpaceDraftRevisions(
  value: unknown,
): SecretSpaceDraftRevisions | null {
  if (!isRecordLike(value)) return null;
  const struck = normalizeStruck(value.struck);
  const patches = normalizePatches(value.patches);
  const marginNotes = normalizeMarginNotes(value.marginNotes);
  if (!struck && !patches && !marginNotes) return null;
  const out: SecretSpaceDraftRevisions = {};
  if (struck) out.struck = struck;
  if (patches) out.patches = patches;
  if (marginNotes) out.marginNotes = marginNotes;
  return out;
}

/** 从 record.metadata 里读 draftRevisions,空 / 无效 → null。 */
export function extractDraftRevisionsFromMetadata(
  metadata: Record<string, unknown> | undefined | null,
): SecretSpaceDraftRevisions | null {
  if (!metadata) return null;
  const raw = (metadata as Record<string, unknown>).draftRevisions;
  return normalizeSecretSpaceDraftRevisions(raw);
}
