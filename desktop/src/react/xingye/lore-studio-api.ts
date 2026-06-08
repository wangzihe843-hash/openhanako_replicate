/**
 * 「角色设定工坊」客户端 API：调用 server 的 lore-studio/turn 端点跑一轮对话。
 * 仿 RoleDetailPanel.handleExtractProfile 的 hanaFetch 用法（含 timeout 字段）。
 */
import { hanaFetch } from '../hooks/use-hana-fetch';
import type { XingyeLoreEntry } from './xingye-lore-store';
import type {
  StudioFineTuneEntry,
  StudioLoreAnchor,
  StudioMessage,
  StudioTurnRequest,
  StudioTurnResponse,
  StudioWireMessage,
} from './lore-studio-types';

export class LoreStudioError extends Error {
  raw?: string;
  details?: unknown;
  constructor(message: string, opts?: { raw?: string; details?: unknown }) {
    super(message);
    this.name = 'LoreStudioError';
    this.raw = opts?.raw;
    this.details = opts?.details;
  }
}

/** 把本地 transcript 压成传输用的紧凑形态（assistant 轮序列化为 JSON 字符串）。 */
export function toWireTranscript(messages: StudioMessage[]): StudioWireMessage[] {
  return messages.map((m) =>
    m.role === 'user'
      ? { role: 'user', content: m.text }
      : { role: 'assistant', content: JSON.stringify(m.turn) },
  );
}

/** 既有 lore → 去重锚点（只标题/分类/注入方式，不含正文）。 */
export function toLoreAnchors(entries: XingyeLoreEntry[]): StudioLoreAnchor[] {
  return entries.map((e) => ({
    title: e.title,
    category: e.category,
    insertionMode: e.insertionMode,
  }));
}

/** 已带来的世界观 / 关系条目（带正文）→ 供 peer 微调首轮喂给模型。 */
export function toFineTuneEntries(entries: XingyeLoreEntry[]): StudioFineTuneEntry[] {
  return entries
    .filter((e) => e.category === 'worldview' || e.category === 'relationship')
    .map((e) => ({ title: e.title, content: e.content, category: e.category, insertionMode: e.insertionMode }));
}

export async function postLoreStudioTurn(
  req: StudioTurnRequest,
): Promise<{ turn: StudioTurnResponse; modelTier?: string }> {
  const response = await hanaFetch('/api/xingye/lore-studio/turn', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // 端点上限 90s（含三层模型降级），客户端再宽放一点。
    timeout: 100_000,
    body: JSON.stringify(req),
  } as RequestInit & { timeout?: number });

  let data: {
    ok?: boolean;
    turn?: StudioTurnResponse;
    modelTier?: string;
    error?: string;
    raw?: string;
    details?: unknown;
  };
  try {
    data = await response.json();
  } catch (err) {
    throw new LoreStudioError('解析模型响应失败', { details: err instanceof Error ? err.message : String(err) });
  }

  if (!data || data.error || !data.turn) {
    throw new LoreStudioError(typeof data?.error === 'string' && data.error ? data.error : '模型未返回有效结果', {
      raw: data?.raw,
      details: data?.details,
    });
  }
  return { turn: data.turn, modelTier: data.modelTier };
}
