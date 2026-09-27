export type XingyeContextScope = { agentId: string; sessionId?: string; branchId?: string };
export type XingyeContextSection = {
  id: string;
  source: string;
  scope: XingyeContextScope;
  text: string;
  priority?: number;
  truncated?: boolean;
};
export type XingyeContextDecision = {
  id: string;
  source: string;
  scope: XingyeContextScope | null;
  reason: 'empty' | 'scope' | 'duplicate' | 'budget' | 'truncated' | 'selected';
  chars: number;
};
export function selectXingyeContextSections(options?: {
  sections?: XingyeContextSection[];
  context?: XingyeContextScope;
  maxChars?: number;
  sourceBudgets?: Record<string, number>;
  onDecision?: (decision: XingyeContextDecision) => void;
}): {
  sections: XingyeContextSection[];
  text: string;
  decisions: XingyeContextDecision[];
  usedChars: number;
  maxChars: number;
};
