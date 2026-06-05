import { hanaFetch } from '../hooks/use-hana-fetch';
import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import { parseChineseTimeHint } from './xingye-app-history-state';
import {
  buildXingyeLoreRuntimeQueryText,
  collectXingyeLoreRuntimeContext,
  formatXingyeLoreRuntimeContextBlock,
} from './xingye-lore-runtime-context';
import { XINGYE_LORE_CATEGORY_LABELS, listLoreEntries } from './xingye-lore-store';
import { getXingyePersistenceStorage } from './xingye-persistence';
import {
  detectAnnotationDuplicate,
  type AnnotationLike,
} from './xingye-reading-annotation-dedupe';
import {
  formatXingyeSpeakerContextForPrompt,
  resolveXingyeSpeakerUserName,
} from './xingye-speaker-context';

/**
 * 「首次打开阅读笔记 app」时的历史批量生成（init bootstrap）。
 *
 * 与 inferReadingAnnotationWithAI（单条批注）的关键区别：
 *  - 一次产出 3–5 本 TA "过去读过的书" + 每本 1–3 条批注；
 *  - **不需要用户提供原文**：init 是凭 lore 给 TA 铺一段读书史，模型自己挑书；
 *  - 但仍然守「模型不伪造逐字原文引文」这条护栏——init 批注是 TA 自己的读后感 /
 *    批注本体（reading_note，无 quote 对象），不编造书里的逐字引用 + 出处；
 *  - 时间不设上限（背景故事可能跨年），每条批注自带 occurredAt；解析不出来的
 *    **不编造日期**——标记 dateSmudged + occurredAt=null（落盘 storage 存 null、UI 显示
 *    「字迹模糊」类短语，与日记 dateSmudged 同理），**绝不因时间字段丢条目**；
 *  - 唯一会丢条目的情形是「同一本书内批注内容高度重复」（detectAnnotationDuplicate
 *    命中 exact_dup），similar 不拦截（让用户自己看）。
 */

const MAX_BOOKS = 5;
/**
 * 每本书批注的**安全阀**（防模型异常 dump，几十条灌爆首开）。
 * 注意：这不是「1–3 条」的形态约束——那个由 prompt 负责（大概 1–3）。正常输出 1–3
 * （甚至偶尔 4–5）都远低于这个上限、不会被截断；真正的内容丢弃只走查重（exact_dup）。
 * 用户明确要求「drop 只能出现在查重过高的情况」，所以这里刻意设得很高。
 */
const MAX_ANNOTATIONS_PER_BOOK = 8;
const MAX_ANNOTATION_CHARS = 300;
const MAX_NOTE_TITLE_CHARS = 32;
const MAX_BOOK_TITLE_CHARS = 120;
const MAX_MOOD_CHARS = 8;

function truncateChars(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1))}…`;
}

function safeText(value: string | undefined | null): string {
  return value?.trim() ?? '';
}

/** 与 reading-topics-ai / reading-annotation-ai 同款：常驻（always）设定块。 */
function buildStableLoreBlock(agentId: string, maxChars: number): string {
  try {
    const storage = getXingyePersistenceStorage();
    const entries = listLoreEntries(agentId, storage).filter(
      (e) => e.enabled && e.visibility === 'canonical' && e.insertionMode === 'always',
    );
    if (!entries.length) return '';
    const lines: string[] = [];
    let used = 0;
    for (const entry of entries) {
      const label = XINGYE_LORE_CATEGORY_LABELS[entry.category] ?? entry.category;
      const block = `- 《${entry.title}》（${label}）\n${entry.content.trim()}`;
      if (used + block.length > maxChars && lines.length > 0) break;
      lines.push(block);
      used += block.length + 2;
      if (used >= maxChars) break;
    }
    return lines.join('\n\n');
  } catch {
    return '';
  }
}

function profileLines(profile: XingyeRoleProfile | null | undefined): string {
  if (!profile) return '';
  const candidates: Array<[string, string]> = [
    ['名字', safeText(profile.displayName)],
    ['关系', safeText(profile.relationshipLabel)],
    ['一句话画像', safeText(profile.shortBio)],
    ['身份', safeText(profile.identitySummary)],
    ['背景', safeText(profile.backgroundSummary)],
    ['性格', safeText(profile.personalitySummary)],
    ['行为逻辑', safeText(profile.behaviorLogic)],
    ['价值观', safeText(profile.values)],
    ['禁忌', safeText(profile.taboos)],
    ['说话风格', safeText(profile.speakingStyle)],
  ];
  return candidates
    .filter((pair): pair is [string, string] => Boolean(pair[1]))
    .map(([k, v]) => `- ${k}: ${truncateChars(v, 200)}`)
    .join('\n');
}

function profilePartsForQuery(profile: XingyeRoleProfile | null | undefined): string[] {
  if (!profile) return [];
  return [
    safeText(profile.displayName),
    safeText(profile.shortBio),
    safeText(profile.identitySummary),
    safeText(profile.backgroundSummary),
    safeText(profile.personalitySummary),
    safeText(profile.values),
    safeText(profile.relationshipLabel),
  ];
}

function todayYmdLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export type ReadingHistoryBookDraft = {
  title: string;
  authors: string[];
  subjects?: string[];
  description?: string;
};

export type ReadingHistoryAnnotationDraft = {
  title: string;
  annotation: string;
  mood?: string;
  /**
   * 模型给的合法时间（ISO）；解析失败 / 缺失 → null（不编造日期）。
   * null 时 dateSmudged=true，落盘 storage 存 null、UI 显示「字迹模糊」类短语（与日记 dateSmudged 同理）。
   */
  occurredAt: string | null;
  /** 时间不可考；occurredAt 为 null 时为 true。 */
  dateSmudged?: boolean;
};

export type ReadingHistoryBookWithAnnotations = {
  book: ReadingHistoryBookDraft;
  annotations: ReadingHistoryAnnotationDraft[];
};

export function buildReadingHistoryPrompt(args: {
  agent: Pick<Agent, 'id' | 'name' | 'yuan'>;
  userName?: string;
  profile: XingyeRoleProfile | null | undefined;
  stableLoreBlock: string;
  keywordLoreBlock: string;
  /** 3–5；调用方截到这个范围。 */
  desiredBookCount: number;
  todayYmd: string;
}): string {
  const {
    agent,
    profile,
    stableLoreBlock,
    keywordLoreBlock,
    desiredBookCount,
    todayYmd,
  } = args;
  const bookCount = Math.max(3, Math.min(MAX_BOOKS, Math.floor(desiredBookCount)));
  const name = safeText(profile?.displayName) || safeText(agent.name) || 'TA';
  const speakerContextBlock = formatXingyeSpeakerContextForPrompt({
    userName: args.userName,
    agentName: profile?.displayName ?? agent.name,
    gender: profile?.gender,
  });

  return [
    '你是星野模式「小手机阅读笔记 · 初始化历史」生成器。只返回严格 JSON，不要 Markdown，不要解释。',
    '',
    `场景：「${name}」刚把阅读笔记 app 打开。请凭 TA 的身份 / 经历 / 性格 / 世界观，铺出 ${bookCount} 本「TA 过去真的会读、读过的书」，`,
    '每本配 1–3 条「TA 在书上留下的批注」——就像 TA 自己的读书笔记本里那些随手写下的感想。',
    '',
    '【选书】',
    `- ${bookCount} 本书要贴合 TA 的画像与设定：身份、职业、价值观、世界观、喜好都可以是选书依据。`,
    '- 可以是真实存在的书，也可以是符合世界观的书；书名 / 作者要像真的，不要写成占位符。',
    '- 书与书之间错开：不同题材 / 不同作者，不要 5 本全是同一类。',
    '- 每本书给 title（书名）、authors（作者数组，可 1 个）、subjects（2–4 个主题词，可中文）、description（≤80 字，一句话简介或 TA 为什么读它）。',
    '',
    '【批注】',
    '- 每本 1–3 条。每条是 TA 自己的批注本体（读后感 / 共鸣 / 反驳 / 联想 / 自言自语），站在 TA 的视角、贴 TA 的语气和价值观。',
    '- **不要伪造书里的逐字原文或引文**：只写 TA 自己的话，不要编造"书中写道：……"这种逐字引用，也不要编出处。',
    '- 不要复述书名简介；不要出现「作为AI」「用户」「prompt」「模型」等元词。',
    `- 每条：title（≤${MAX_NOTE_TITLE_CHARS} 字中文小标题，不是书名）、annotation（≤${MAX_ANNOTATION_CHARS} 字中文批注本体）、mood（可省略，≤${MAX_MOOD_CHARS} 字情绪短语）、occurredAt。`,
    '- 同一本书里几条批注要换切口 / 换感受，不要把同一句话换皮重写。',
    '',
    '【时间 · occurredAt】',
    `今天是 ${todayYmd}（YYYY-MM-DD）。每条批注自带 occurredAt，表示 TA 大概什么时候写下这条批注。`,
    '时间跨度**不设上限**——可以是几周前、几个月前、几年前 TA 读这本书的时候；请跨期分布，不要全堆在最近。',
    'occurredAt 尽量给合法 YYYY-MM-DD（早于今天）；给不准也没关系，但不要留空。',
    '',
    '输出 JSON schema（仅此结构）：一个对象 { "books": [ ... ] }，books 数组长度 = ' + bookCount + '。每个元素：',
    JSON.stringify(
      {
        title: 'string（书名）',
        authors: ['string'],
        subjects: ['string'],
        description: 'string（≤80 字，可省略）',
        annotations: [
          {
            title: 'string（批注小标题）',
            annotation: 'string（TA 的批注本体）',
            mood: 'string（可省略）',
            occurredAt: 'YYYY-MM-DD（早于今天）',
          },
        ],
      },
      null,
      2,
    ),
    '',
    '当前角色（基础身份）：',
    JSON.stringify(
      {
        id: agent.id,
        name: agent.name,
        yuan: agent.yuan,
        profile: profile ?? null,
      },
      null,
      2,
    ),
    '',
    speakerContextBlock,
    '',
    '【角色画像摘要】',
    profileLines(profile) || '（无可用 profile）',
    '',
    '【星野核心设定摘录（常驻设定；是判断 TA 读什么书的主要依据；勿逐字复述）】',
    stableLoreBlock.trim() || '（无）',
    '',
    '【按需命中的设定库关键词条目（仅命中项；勿逐字复述）】',
    keywordLoreBlock.trim() || '（无）',
    '',
    `记住：只输出 { "books": [...] } 一个 JSON 对象；books 长度 = ${bookCount}；每本 1–3 条批注；每条批注都不伪造书中逐字原文，且带 occurredAt（尽量是早于 ${todayYmd} 的 YYYY-MM-DD）。`,
  ].join('\n');
}

function normalizeBookDraft(raw: unknown): ReadingHistoryBookDraft | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const title = typeof record.title === 'string' ? truncateChars(record.title, MAX_BOOK_TITLE_CHARS) : '';
  if (!title) return null;
  const authors = Array.isArray(record.authors)
    ? record.authors
      .map((a) => (typeof a === 'string' ? a.trim() : ''))
      .filter((a): a is string => Boolean(a))
      .slice(0, 6)
    : [];
  const subjectsRaw = Array.isArray(record.subjects) ? record.subjects : [];
  const subjects = subjectsRaw
    .map((s) => (typeof s === 'string' ? s.trim() : ''))
    .filter((s): s is string => Boolean(s))
    .slice(0, 6);
  const descRaw = typeof record.description === 'string' ? record.description.trim() : '';
  const book: ReadingHistoryBookDraft = { title, authors };
  if (subjects.length) book.subjects = subjects;
  if (descRaw) book.description = truncateChars(descRaw, 240);
  return book;
}

function normalizeAnnotationDraft(raw: unknown): { title: string; annotation: string; mood?: string; rawOccurredAt: unknown } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const annotationRaw = record.annotation ?? record.body ?? record.content;
  const annotation = typeof annotationRaw === 'string' ? annotationRaw.trim() : '';
  if (!annotation) return null;
  const titleRaw = typeof record.title === 'string' ? record.title.trim() : '';
  const title = titleRaw
    ? truncateChars(titleRaw, MAX_NOTE_TITLE_CHARS)
    : truncateChars(annotation, Math.min(20, MAX_NOTE_TITLE_CHARS));
  const moodRaw = typeof record.mood === 'string' ? record.mood.trim() : '';
  return {
    title,
    annotation: truncateChars(annotation, MAX_ANNOTATION_CHARS),
    ...(moodRaw ? { mood: truncateChars(moodRaw, MAX_MOOD_CHARS) } : {}),
    rawOccurredAt: record.occurredAt ?? record.dayKey ?? record.date,
  };
}

/** 解析模型给的时间：先 ISO，再中文时间感词；都不行 → null（不编造，交给 dateSmudged）。 */
function parseOccurredAt(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;
  const direct = Date.parse(text);
  if (Number.isFinite(direct)) return new Date(direct).toISOString();
  return parseChineseTimeHint(text) ?? null;
}

/**
 * 规范化首次打开 app 时模型给出的「书 + 批注」批量。
 *
 * 丢弃规则（**只在内容层面**）：
 *  - 书：title 为空 → 丢（无法建书）；超过 MAX_BOOKS 的截断（贴合「3–5 本」的需求形态）。
 *  - 批注：annotation 为空 → 丢；同一本书内命中 detectAnnotationDuplicate 的 exact_dup → 丢
 *    （这是用户要的"查重过高才 drop"）；similar 不丢；每本超过 MAX_ANNOTATIONS_PER_BOOK 的截断。
 *
 * **时间从不导致丢弃**：occurredAt 解析成功 → ISO；解析失败 / 缺失 → **不编造日期**，
 * 标记 dateSmudged=true + occurredAt=null（落盘存 null、UI 显示「字迹模糊」短语，与日记同理）。
 */
export function normalizeReadingHistoryResults(
  raw: unknown,
): ReadingHistoryBookWithAnnotations[] {
  let items: unknown[] = [];
  if (Array.isArray(raw)) {
    items = raw;
  } else if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    if (Array.isArray(record.books)) items = record.books;
    else if (Array.isArray(record.entries)) items = record.entries;
    else if (Array.isArray(record.items)) items = record.items;
  }

  const out: ReadingHistoryBookWithAnnotations[] = [];

  for (const item of items) {
    if (out.length >= MAX_BOOKS) break;
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const book = normalizeBookDraft(record);
    if (!book) continue;

    const bucketId = `__book_${out.length}`;
    const accepted: AnnotationLike[] = [];
    const annotations: ReadingHistoryAnnotationDraft[] = [];

    const rawAnnotations = Array.isArray(record.annotations)
      ? record.annotations
      : Array.isArray(record.notes)
        ? record.notes
        : [];
    for (const rawAnnotation of rawAnnotations) {
      if (annotations.length >= MAX_ANNOTATIONS_PER_BOOK) break;
      const norm = normalizeAnnotationDraft(rawAnnotation);
      if (!norm) continue;
      // 同书内容查重：exact_dup 才丢（用户要求"查重过高才 drop"）；similar 放过。
      const dup = detectAnnotationDuplicate(
        { bookId: bucketId, title: norm.title, annotation: norm.annotation },
        accepted,
      );
      if (dup.kind === 'exact_dup') continue;

      const occurredAt = parseOccurredAt(norm.rawOccurredAt);
      const entry: ReadingHistoryAnnotationDraft = {
        title: norm.title,
        annotation: norm.annotation,
        ...(norm.mood ? { mood: norm.mood } : {}),
        occurredAt, // ISO 或 null
        ...(occurredAt === null ? { dateSmudged: true } : {}),
      };
      annotations.push(entry);
      accepted.push({ bookId: bucketId, title: norm.title, annotation: norm.annotation });
    }

    out.push({ book, annotations });
  }

  return out;
}

/**
 * 调用 `POST /api/xingye/phone-generate`（`kind: reading_history`），按 lore 给 TA 铺一段读书史。
 * 不写入存储；由调用方（PhoneReadingNotesApp init bootstrap）把书写进书库、把批注 append 进 entries。
 *
 * 任意单本/单条解析失败不会让整批失败；最终一本书都没有则抛错（调用方据此不写 initializedAt，
 * 下次打开重试）。
 */
export async function generateReadingHistoryWithAI(params: {
  agent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  /** 期望生成几本书（3–5；越界会被夹紧）。 */
  desiredBookCount: number;
  timeoutMs?: number;
}): Promise<ReadingHistoryBookWithAnnotations[]> {
  const { agent, ownerProfile } = params;
  const timeoutMs = params.timeoutMs ?? 120_000;
  const desiredBookCount = Math.max(3, Math.min(MAX_BOOKS, Math.floor(params.desiredBookCount ?? 4)));

  const stableLoreBlock = buildStableLoreBlock(agent.id, 1800);
  const userName = await resolveXingyeSpeakerUserName();

  const queryText = buildXingyeLoreRuntimeQueryText([
    ...profilePartsForQuery(ownerProfile ?? null),
    stableLoreBlock.slice(0, 2000),
  ]);
  const keywordCtx = collectXingyeLoreRuntimeContext(agent.id, {
    purpose: 'reading_history',
    queryText,
    maxChars: 1800,
    includeAlways: false,
    includeKeyword: true,
  });
  const keywordLoreBlock = formatXingyeLoreRuntimeContextBlock(keywordCtx);

  const todayYmd = todayYmdLocal();
  const prompt = buildReadingHistoryPrompt({
    agent,
    userName,
    profile: ownerProfile,
    stableLoreBlock,
    keywordLoreBlock,
    desiredBookCount,
    todayYmd,
  });

  const response = await hanaFetch('/api/xingye/phone-generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeout: timeoutMs,
    body: JSON.stringify({
      kind: 'reading_history',
      ownerAgentId: agent.id,
      agentId: agent.id,
      prompt,
      timeoutMs,
    }),
  });

  let data: { ok?: boolean; error?: string; result?: unknown; details?: unknown };
  try {
    data = await response.json();
  } catch {
    throw new Error('解析服务器响应失败');
  }

  if (!response.ok || data?.ok === false || data?.error) {
    const details = Array.isArray(data?.details)
      ? `：${(data.details as { message?: string }[]).map((item) => item.message ?? '').filter(Boolean).join('；')}`
      : '';
    throw new Error(`${data?.error || '模型调用失败'}${details}`);
  }

  const books = normalizeReadingHistoryResults(data?.result);
  if (books.length === 0) {
    throw new Error('模型返回无效：未生成可用的读书历史');
  }
  return books;
}
