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
export type XingyeLoreSourceEntry = {
  id: string; agentId: string; title?: string; content: string; category?: string;
  keywords?: string[]; enabled: boolean; visibility: string; insertionMode: string;
  priority?: number; updatedAt?: string;
};
export function selectXingyeLoreEntries<T extends XingyeLoreSourceEntry>(options: {
  entries?: T[] | Record<string, T>;
  agentId?: string;
  mode?: 'always' | 'keyword' | 'all' | 'none';
  queryText?: string;
  explicitKeywords?: string[];
  maxChars?: number;
  formatBlock?: (entry: T, matchedKeywords: string[], content: string) => string;
  compose?: (blocks: string[]) => string;
  priorityBoostCategories?: string[];
  onDecision?: (decision: XingyeLoreDecision) => void;
}): {
  selected: Array<{ entry: T; matchedKeywords: string[]; block: string; content: string; truncated: boolean }>;
  candidateCount: number;
  usedChars: number;
  truncated: boolean;
};
export function buildXingyeStableLoreMemoryContext(options?: LoreOptions): { text: string; entries: LoreMetadata[] };
export function buildXingyeRuntimeLoreContext(options?: LoreOptions & { userText?: string; recentMessages?: unknown[] }): { text: string; entries: Array<LoreMetadata & { matchedKeywords: string[] }> };
