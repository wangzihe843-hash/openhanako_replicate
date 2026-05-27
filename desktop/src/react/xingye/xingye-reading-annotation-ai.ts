import { hanaFetch } from '../hooks/use-hana-fetch';
import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import { listAppEntries } from './xingye-app-entry-store';
import { peekDeskHeartbeatUiOutcome } from './xingye-desk-heartbeat-memory';
import { XINGYE_LORE_CATEGORY_LABELS, listLoreEntries } from './xingye-lore-store';
import { getXingyePersistenceStorage } from './xingye-persistence';
import {
  buildAnnotationContinuityAnchorBlock,
  type AnnotationLike,
} from './xingye-reading-annotation-dedupe';
import {
  collectRecentContextForAgent,
  describeRecentContextForPrompt,
} from './xingye-recent-context';
import type { WikiquoteSourceCitation } from './xingye-wikiquote-adapter';

export type ReadingAnnotationBookContext = {
  title: string;
  authors: string[];
  subjects?: string[];
  description?: string;
};

export type InferReadingAnnotationParams = {
  agent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  book: ReadingAnnotationBookContext;
  /** 用户已选定的原文 — 不允许由模型生成。 */
  passage: string;
  /** 可选：原文出处（来自 Wikiquote 等）。仅用于 prompt 上下文与最终落盘溯源。 */
  passageCitation?: WikiquoteSourceCitation;
  /**
   * 用于"反重复"anchor block 的 bookId（与 reading_notes entry 的 metadata.bookId 对齐）。
   * 调用方传入当前正在批注的那本书的 bookId；ai 会拉同一本书已有的批注列表喂给模型，
   * 让它避免在同一本书里反复写相似批注。缺省 / 空 → 不做 anchor。
   */
  bookId?: string;
  timeoutMs?: number;
};

export type XingyeReadingAnnotation = {
  title: string;
  annotation: string;
  mood?: string;
};

const MAX_ANNOTATION_CHARS = 300;
const MAX_TITLE_CHARS = 32;

function truncateChars(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1))}…`;
}

function safeText(value: string | undefined | null): string {
  return value?.trim() ?? '';
}

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
    ['说话风格', safeText(profile.speakingStyle)],
  ];
  return candidates
    .filter((pair): pair is [string, string] => Boolean(pair[1]))
    .map(([k, v]) => `- ${k}: ${truncateChars(v, 200)}`)
    .join('\n');
}

function bookBlock(book: ReadingAnnotationBookContext): string {
  const parts: string[] = [];
  parts.push(`- 书名: ${safeText(book.title) || '未填写'}`);
  if (book.authors?.length) parts.push(`- 作者: ${book.authors.join(' / ')}`);
  if (book.subjects?.length) parts.push(`- 主题: ${book.subjects.slice(0, 8).join(' · ')}`);
  if (safeText(book.description)) parts.push(`- 备注: ${truncateChars(book.description!, 300)}`);
  return parts.join('\n');
}

export function buildReadingAnnotationPrompt(args: {
  agent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  book: ReadingAnnotationBookContext;
  passage: string;
  passageCitation?: WikiquoteSourceCitation;
  recentSceneBlock: string;
  stableLoreBlock: string;
  heartbeatBlock: string;
  /**
   * 同书已有批注 anchor block，由 buildAnnotationContinuityAnchorBlock 生成。
   * 让模型在同一本书里换切口/换感受。无历史 → 空字符串。
   */
  continuityAnchorBlock?: string;
}): string {
  const {
    agent, ownerProfile, book, passage, passageCitation,
    recentSceneBlock, stableLoreBlock, heartbeatBlock,
    continuityAnchorBlock,
  } = args;
  const name = safeText(ownerProfile?.displayName) || safeText(agent.name) || 'TA';
  const passageBlock = truncateChars(passage, 600);
  const citationLine = passageCitation
    ? `原文出处：${passageCitation.provider}（${passageCitation.pageTitle}）`
    : '原文出处：用户手动录入';

  return [
    `你要替虚拟角色「${name}」给一段书里的原文写一条中文批注，模拟 TA 在自己的阅读笔记本上写字的语气。`,
    '',
    '硬性要求：',
    `1) 输出严格 JSON：{"title":"...","annotation":"...","mood":"..."}（mood 可省略）。不要 markdown、不要解释。`,
    `2) title ≤ ${MAX_TITLE_CHARS} 字中文，是 TA 给这条笔记起的小标题，不要直接复述原文。`,
    `3) annotation ≤ ${MAX_ANNOTATION_CHARS} 字中文，是 TA 的批注本体。要求：`,
    '   - 是「批注」不是「复述」：不要把原文重复一遍。',
    '   - 站在 TA 的视角，结合 TA 的身份/经历/最近发生的事/心情。',
    '   - 可以是反驳、共鸣、联想、自言自语、追问，但要符合 TA 的语气和价值观。',
    '   - 不要出现"作为AI"、"作为助手"、"用户"、"prompt"等元词。',
    '   - 不要在批注里再创造新的原文引用——只能回应给定的这段原文。',
    '4) mood 可选，≤ 8 字中文，描述写这条批注时 TA 的情绪。',
    '',
    '【角色画像】',
    profileLines(ownerProfile) || '（无可用 profile）',
    '',
    '【最近聊天/场景】',
    recentSceneBlock?.trim() ? truncateChars(recentSceneBlock, 1800) : '（暂无最近聊天）',
    '',
    '【常驻 lore】',
    stableLoreBlock?.trim() ? truncateChars(stableLoreBlock, 1500) : '（暂无 lore）',
    '',
    '【最近巡检/心跳记录】',
    heartbeatBlock || '（无）',
    '',
    '【这本书的元信息】',
    bookBlock(book),
    '',
    '【你在这本书上已经写过的批注（请明确避免重复同样的话；尽量换切口/换感受）】',
    (continuityAnchorBlock ?? '').trim() || '（无；这是 TA 在这本书上的第一条批注）',
    '',
    '【要批注的原文】',
    `「${passageBlock}」`,
    citationLine,
  ].join('\n');
}

export function normalizeReadingAnnotationResult(raw: unknown): XingyeReadingAnnotation | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const annotationRaw = record.annotation ?? record.body ?? record.content;
  const annotation = typeof annotationRaw === 'string' ? annotationRaw.trim() : '';
  if (!annotation) return null;
  const titleRaw = typeof record.title === 'string' ? record.title.trim() : '';
  const title = titleRaw
    ? truncateChars(titleRaw, MAX_TITLE_CHARS)
    : truncateChars(annotation, Math.min(20, MAX_TITLE_CHARS));
  const moodRaw = typeof record.mood === 'string' ? record.mood.trim() : '';
  const out: XingyeReadingAnnotation = {
    title,
    annotation: truncateChars(annotation, MAX_ANNOTATION_CHARS),
  };
  if (moodRaw) out.mood = truncateChars(moodRaw, 8);
  return out;
}

/**
 * 调用 `POST /api/xingye/phone-generate`（`kind: reading_annotation`），让模型站在 TA 的视角
 * 给一段用户已选定的原文写中文批注。
 *
 * 不写入存储；不抓书摘；原文必须由调用方提供，模型不允许创造新引用。
 */
export async function inferReadingAnnotationWithAI(
  params: InferReadingAnnotationParams,
): Promise<XingyeReadingAnnotation> {
  const { agent, ownerProfile, book, passage, passageCitation, bookId } = params;
  const timeoutMs = params.timeoutMs ?? 60_000;

  const recentContext = collectRecentContextForAgent({ agentId: agent.id });
  const recentSceneBlock = describeRecentContextForPrompt(recentContext);
  const stableLoreBlock = buildStableLoreBlock(agent.id, 1500);
  const heartbeatLine = peekDeskHeartbeatUiOutcome(agent.id);
  const heartbeatBlock = heartbeatLine ? heartbeatLine.trim() : '';

  // 同书已有批注 anchor：让模型看到自己在这本书上写过哪些批注，避免反复写相似的话。
  // 拉 listAppEntries 失败 / 无 bookId → 空字符串，prompt 端会渲染「（无；这是 TA
  // 在这本书上的第一条批注）」，不阻断生成主流程。
  let continuityAnchorBlock = '';
  if (bookId && bookId.trim()) {
    try {
      const entries = await listAppEntries(agent.id, 'reading_notes');
      const annotations: AnnotationLike[] = entries
        .filter((e) => {
          const meta = e.metadata ?? {};
          // 只看 AI 写过的批注（不要把 want_to_read/question 等非批注 noteType 当作历史）
          const isAnnotation = (meta.annotationSource === 'ai')
            || (meta.noteType === 'reading_note' && meta.quote);
          return Boolean(isAnnotation) && typeof meta.bookId === 'string';
        })
        .map((e) => ({
          bookId: (e.metadata?.bookId as string) ?? '',
          title: e.title,
          annotation: e.content,
        }))
        .filter((a) => a.bookId);
      continuityAnchorBlock = buildAnnotationContinuityAnchorBlock(annotations, bookId);
    } catch {
      continuityAnchorBlock = '';
    }
  }

  const prompt = buildReadingAnnotationPrompt({
    agent,
    ownerProfile,
    book,
    passage,
    passageCitation,
    recentSceneBlock,
    stableLoreBlock,
    heartbeatBlock,
    continuityAnchorBlock,
  });

  const response = await hanaFetch('/api/xingye/phone-generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeout: timeoutMs,
    body: JSON.stringify({
      kind: 'reading_annotation',
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
    throw new Error(data?.error || '模型调用失败');
  }
  const normalized = normalizeReadingAnnotationResult(data?.result);
  if (!normalized) {
    throw new Error('模型返回无效：缺少 annotation');
  }
  return normalized;
}
