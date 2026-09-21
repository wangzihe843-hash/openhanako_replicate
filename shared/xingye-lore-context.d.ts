export type XingyeLoreDecision = {
  id: string;
  title: string;
  reason: 'selected' | 'truncated' | 'budget' | 'disabled' | 'visibility' | 'mode' | 'empty' | 'no-keywords' | 'no-query' | 'no-match';
  matchedKeywords: string[];
  blockChars: number;
};
type LoreOptions = {
  entries?: unknown;
  agentId?: string;
  maxChars?: number;
  onDecision?: (decision: XingyeLoreDecision) => void;
};
type LoreMetadata = { id: string; title: string; category: string; priority: number; insertionMode: string };
export function buildXingyeStableLoreMemoryContext(options?: LoreOptions): { text: string; entries: LoreMetadata[] };
export function buildXingyeRuntimeLoreContext(options?: LoreOptions & { userText?: string; recentMessages?: unknown[] }): { text: string; entries: Array<LoreMetadata & { matchedKeywords: string[] }> };
