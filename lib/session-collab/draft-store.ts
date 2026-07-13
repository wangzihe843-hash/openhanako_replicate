// 跨 session 协作草稿卡的 one-shot 存储。对齐 AutomationSuggestionStore 语义：
// apply 成功才删除条目；闭包抛错条目保留，用户可直接重试（投递不幂等，靠即删防双发）。
export type SessionCollabDraftKind = "send" | "create";

export interface SessionCollabDraftInput {
  kind: SessionCollabDraftKind;
  sourceSessionId: string;
  draft: Record<string, unknown>;
  apply: (editedDraft?: Record<string, unknown>) => unknown;
}

export class SessionCollabDraftStore {
  declare _entries: Map<string, any>;
  declare _sequence: number;

  constructor() {
    this._entries = new Map();
    this._sequence = 0;
  }

  create(input: SessionCollabDraftInput) {
    if (!input || typeof input.apply !== "function") {
      throw new Error("session collab draft apply function is required");
    }
    if (typeof input.sourceSessionId !== "string" || !input.sourceSessionId.trim()) {
      throw new Error("session collab draft sourceSessionId is required");
    }
    const suggestionId = `session_${Date.now().toString(36)}_${(++this._sequence).toString(36)}`;
    const stored = {
      suggestionId,
      kind: input.kind === "create" ? "create" : "send",
      sourceSessionId: input.sourceSessionId.trim(),
      draft: JSON.parse(JSON.stringify(input.draft || {})),
      apply: input.apply,
      createdAt: Date.now(),
    };
    this._entries.set(suggestionId, stored);
    return this._publicEntry(stored);
  }

  get(suggestionId: string) {
    const entry = this._entries.get(suggestionId);
    return entry ? this._publicEntry(entry) : null;
  }

  listForSession(sourceSessionId: string) {
    return [...this._entries.values()]
      .filter((e) => e.sourceSessionId === sourceSessionId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((e) => this._publicEntry(e));
  }

  discard(suggestionId: string) {
    const entry = this._entries.get(suggestionId);
    if (!entry || entry._applying) return null;
    this._entries.delete(suggestionId);
    return this._publicEntry(entry);
  }

  async apply(suggestionId: string, editedDraft?: Record<string, unknown>) {
    const entry = this._entries.get(suggestionId);
    if (!entry) return { ok: false as const, reason: "not-found" as const };
    if (entry._applying) return { ok: false as const, reason: "in-flight" as const };
    entry._applying = true;
    try {
      // 闭包抛错时不删条目：让用户可重试（对齐 AutomationSuggestionStore）
      const result = await entry.apply(editedDraft);
      this._entries.delete(suggestionId);
      return { ok: true as const, result };
    } finally {
      // 失败路径清标记让用户可重试；成功路径条目已删，清标记无副作用
      entry._applying = false;
    }
  }

  _publicEntry(entry: any) {
    const { apply: _apply, _applying: _inFlight, ...rest } = entry;
    return { ...rest, draft: JSON.parse(JSON.stringify(entry.draft)) };
  }
}
