/**
 * Split a divination reading body (4 sections marked with 【…】) into structured slots.
 *
 * Input is whatever the AI returned (already sanitized). Headers are matched
 * loosely so legacy entries and minor formatting drift still parse:
 *
 *   【标题】 / [标题] / 【标题：】 / 【TITLE】 → title
 *   【卦象】 / 【牌面】 / 【签象】 / 【行动签象】 → signFlavor (with the literal label preserved)
 *   【正文】 / 【BODY】 → body
 *   【行动签】 / 【卦辞】 / 【牌意指引】 / 【影像提示】 / 【符意建议】 / 【星象建议】 /
 *     【心象提示】 / 【ACTION】 / 【ACTION SIGN】 → actionSign（label 也保留）
 *
 * ACTION 组扩充原因：本仓库为每种占法定义了专属 actionSectionLabel
 * （见 xingye-divination-themes.ts）；AI prompt 端按 method 写入对应 label。
 * parse 端必须能识别全部 7 种 + 历史的「行动签」，否则新 method 的 action 段
 * 会被当成 unknown 丢掉。
 *
 * Any text appearing before the first recognized header lands in `lead`,
 * so detail rendering can still show something when the model omits markers.
 */

export type ParsedDivinationReading = {
  title?: string;
  /** Literal text used between 【】 for the sign block (preserved for theme rendering). */
  signLabel?: string;
  signFlavor?: string;
  body?: string;
  actionSign?: string;
  /**
   * Literal text used between 【】 for the action block. UI 优先用它显示小标题；
   * 缺省时回退到 theme.actionSectionLabel。
   */
  actionLabel?: string;
  /** Leading non-section text (only present when the model skipped 【标题】). */
  lead?: string;
};

const HEADER_RE = /^[【\[]\s*(.+?)\s*[:：]?\s*[】\]]\s*[:：]?\s*$/;

const TITLE_KEYS = new Set(['标题', 'title']);
const SIGN_KEYS = new Set(['卦象', '牌面', '签象', '行动签象', 'sign']);
const BODY_KEYS = new Set(['正文', 'body']);
const ACTION_KEYS = new Set([
  '行动签', '卦辞', '牌意指引', '影像提示', '符意建议', '星象建议', '心象提示',
  'action', 'action sign', 'actionsign',
]);

type Slot = 'title' | 'sign' | 'body' | 'action' | 'unknown';

function classifyHeader(label: string): Slot {
  const normalized = label.trim().toLowerCase();
  if (TITLE_KEYS.has(normalized)) return 'title';
  if (SIGN_KEYS.has(normalized)) return 'sign';
  if (BODY_KEYS.has(normalized)) return 'body';
  if (ACTION_KEYS.has(normalized)) return 'action';
  return 'unknown';
}

function trimSectionBody(lines: string[]): string {
  const out = [...lines];
  while (out.length && out[0]!.trim() === '') out.shift();
  while (out.length && out[out.length - 1]!.trim() === '') out.pop();
  return out.join('\n');
}

export function parseDivinationReading(raw: unknown): ParsedDivinationReading {
  const text = typeof raw === 'string' ? raw.replace(/\r\n?/g, '\n') : '';
  if (!text.trim()) return {};

  const lines = text.split('\n');
  const result: ParsedDivinationReading = {};
  const leadLines: string[] = [];
  let currentSlot: Slot | null = null;
  let currentLabel = '';
  let buffer: string[] = [];

  const flush = () => {
    if (currentSlot == null) {
      // Lines before any header — preserved as `lead`
      for (const line of buffer) leadLines.push(line);
      buffer = [];
      return;
    }
    const value = trimSectionBody(buffer);
    if (value) {
      if (currentSlot === 'title' && !result.title) result.title = value;
      else if (currentSlot === 'sign' && !result.signFlavor) {
        result.signFlavor = value;
        if (currentLabel) result.signLabel = currentLabel;
      } else if (currentSlot === 'body' && !result.body) result.body = value;
      else if (currentSlot === 'action' && !result.actionSign) {
        result.actionSign = value;
        if (currentLabel) result.actionLabel = currentLabel;
      }
    }
    buffer = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const headerMatch = trimmed && HEADER_RE.exec(trimmed);
    if (headerMatch) {
      flush();
      const label = headerMatch[1]!;
      const slot = classifyHeader(label);
      if (slot === 'unknown') {
        currentSlot = null;
        currentLabel = '';
        continue;
      }
      currentSlot = slot;
      currentLabel = label.trim();
      continue;
    }
    buffer.push(line);
  }
  flush();

  const lead = trimSectionBody(leadLines);
  if (lead) result.lead = lead;
  return result;
}
