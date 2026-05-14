import type { XingyeDivinationMethodId } from './xingye-divination-method-resolver';
import { getDivinationMethodLabel } from './xingye-divination-method-resolver';

export function titleForDivinationEntry(methodId: XingyeDivinationMethodId, agentQuestion: string): string {
  const label = getDivinationMethodLabel(methodId);
  const q = agentQuestion.trim();
  const short = q.length > 28 ? `${q.slice(0, 27)}…` : q;
  return `【${label}】${short || '自占'}`;
}

export function summarizeDivinationContextSources(sources: readonly string[]): string {
  void sources;
  return '';
}

const DIVINATION_SAFE_FALLBACK =
  '【标题】\n合上的牌\n【签象】\n牌面只留下一点风声。\n【正文】\n我把牌面合上。今天的结果很短：别急着把空白填满。先确认风是从哪边来的，再决定要不要开门。\n【行动签】\n先把手伸向能确认的地方。';

const INTERNAL_LINE_RE =
  /(?:xingye\.|\.jsonl?\b|HANA_HOME|agents[\\/]|<agentId>|上下文摘要|上下文线索|用来掂量此刻|你是当前角色本人|不是别人替你发问|根据你的背景|近期状态|用户没有替你提问|不要让叙事读成|对方并没有替你发问|对方没有替你填|角色侧叙事模拟|真实术数|写作参考|\b(?:prompt|context|system|developer|instruction|source|debug)\b)/i;

const PERSPECTIVE_POLLUTION_LINE_RE =
  /(?:用户|如果用户|建议用户|林雾会|她会|TA\s*会|该角色|这个角色|角色设定|根据人设|根据背景|从设定来看|性格分析|她对用户|角色会以|角色分析器|用户建议助手)/i;

const CONTEXT_BLOCK_RE = /(?:上下文摘要|上下文线索|用来掂量此刻)/;
const RULE_REPLAY_RE = /(?:你是当前角色本人|不是别人替你发问|根据你的背景|用户在替你问卜|用户没有替你提问)/;

function normalizeOutputLines(raw: string): string[] {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  const kept: string[] = [];
  let skippingContextBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (kept.length && kept[kept.length - 1] !== '') kept.push('');
      continue;
    }

    if (CONTEXT_BLOCK_RE.test(trimmed)) {
      skippingContextBlock = true;
      continue;
    }

    if (skippingContextBlock) {
      if (INTERNAL_LINE_RE.test(trimmed)) continue;
      skippingContextBlock = false;
    }

    if (RULE_REPLAY_RE.test(trimmed) || INTERNAL_LINE_RE.test(trimmed) || PERSPECTIVE_POLLUTION_LINE_RE.test(trimmed)) continue;
    kept.push(trimmed);
  }

  while (kept[0] === '') kept.shift();
  while (kept[kept.length - 1] === '') kept.pop();
  return kept;
}

export function sanitizeDivinationReadingContent(raw: unknown): string {
  const input = typeof raw === 'string' ? raw : '';
  const cleaned = normalizeOutputLines(input).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (cleaned.length < 16) return DIVINATION_SAFE_FALLBACK;
  if (INTERNAL_LINE_RE.test(cleaned) || PERSPECTIVE_POLLUTION_LINE_RE.test(cleaned)) return DIVINATION_SAFE_FALLBACK;
  return cleaned;
}
