/**
 * Split a divination reading body (4 sections marked with 【…】) into structured slots.
 *
 * Input is whatever the AI returned (already sanitized). Headers are matched
 * loosely so legacy entries and minor formatting drift still parse:
 *
 *   【标题】 / [标题] / 【标题：】 / 【TITLE】 → title
 *   【卦象】 / 【牌面】 / 【签象】 / 【行动签象】 → signFlavor (with the literal label preserved)
 *   【正文】 / 【BODY】 → body
 *   【行动签】 / 【ACTION】 / 【ACTION SIGN】 → actionSign
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
  /** Leading non-section text (only present when the model skipped 【标题】). */
  lead?: string;
};

const HEADER_RE = /^[【\[]\s*(.+?)\s*[:：]?\s*[】\]]\s*[:：]?\s*$/;

const TITLE_KEYS = new Set(['标题', 'title']);
const SIGN_KEYS = new Set(['卦象', '牌面', '签象', '行动签象', 'sign']);
const BODY_KEYS = new Set(['正文', 'body']);
const ACTION_KEYS = new Set(['行动签', 'action', 'action sign', 'actionsign']);

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
      else if (currentSlot === 'action' && !result.actionSign) result.actionSign = value;
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
