/**
 * fact-store.js — 深度记忆存储（元事实 + 标签）
 *
 * v2 记忆系统的 archival 层。每条记忆是一个"元事实"，
 * 附带标签和时间，通过标签匹配 + FTS5 全文搜索检索。
 *
 * 替代 v1 的 store.js（SQLite + sqlite-vec 向量搜索）。
 * 不使用 embedding / 向量 / score / decay / hit_count。
 */

import { createRequire } from "module";
import { scrubPII } from "../pii-guard.ts";
import { createModuleLogger } from "../debug-log.ts";
import {
  canReadMemoryScope,
  normalizeMemoryScope,
  normalizeMemoryScopeContext,
} from "../../shared/memory-scope.ts";
import {
  normalizeMemorySourceDependencies,
  type MemorySourceDependency,
} from "../../shared/memory-provenance.ts";

export type FactSourceDependency = MemorySourceDependency;
export interface FactRuntimeOptions {
  memoryScope?: unknown;
  sourceDependencies?: FactSourceDependency[];
  currentSourceDependencies?: FactSourceDependency[];
  sourceRevision?: string;
  sourceStatus?: 'active' | 'stale';
}
interface FactSearchOptions {
  scope?: { kind: 'channel'; channelId: string } | null;
  dateRange?: { from?: string; to?: string };
  memoryScope?: unknown;
}

function normalizeSourceDependencies(value: unknown): FactSourceDependency[] {
  // Retain hashes, source refs and generation fences as well as session/revision.
  // Losing those during export/reimport would erase the provenance evidence.
  const unique = new Map<string, FactSourceDependency>();
  for (const dependency of normalizeMemorySourceDependencies(value)) {
    unique.set(JSON.stringify(dependency), dependency);
  }
  return [...unique.values()];
}

const log = createModuleLogger("fact-store");

const require = createRequire(import.meta.url);
let BetterSqliteDatabase = null;

export function loadBetterSqliteDatabase() {
  if (!BetterSqliteDatabase) {
    const mod = require("better-sqlite3");
    BetterSqliteDatabase = mod?.default || mod;
  }
  return BetterSqliteDatabase;
}

/**
 * 当前 schema 版本。每次改表结构时递增，
 * 并在 _migrate() 里添加对应的迁移逻辑。
 */
const SCHEMA_VERSION = 4;

const CJK_RUN_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;

function normalizeSearchText(text) {
  return String(text || "").normalize("NFKC").trim();
}

function parseTags(rawTags) {
  try {
    const tags = Array.isArray(rawTags) ? rawTags : JSON.parse(rawTags || "[]");
    return Array.isArray(tags) ? tags.filter((tag) => typeof tag === "string") : [];
  } catch {
    return [];
  }
}

function cjkNgrams(text) {
  const tokens = [];
  CJK_RUN_RE.lastIndex = 0;
  for (const match of normalizeSearchText(text).matchAll(CJK_RUN_RE)) {
    const chars = Array.from(match[0]);
    for (const size of [2, 3]) {
      if (chars.length < size) continue;
      for (let i = 0; i <= chars.length - size; i++) {
        tokens.push(chars.slice(i, i + size).join(""));
      }
    }
  }
  return tokens;
}

function uniqueTokens(tokens) {
  const seen = new Set();
  const out = [];
  for (const token of tokens) {
    const normalized = normalizeSearchText(token);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function buildFactSearchText(fact, tags = []) {
  const base = [fact, ...tags].map(normalizeSearchText).filter(Boolean).join(" ");
  const grams = cjkNgrams(base);
  return uniqueTokens([base, ...grams]).join(" ");
}

function buildFtsQuery(query) {
  const normalized = normalizeSearchText(query);
  if (!normalized) return "";

  const lexicalTokens = normalized.split(/\s+/);
  const grams = cjkNgrams(normalized);
  return uniqueTokens([...lexicalTokens, ...grams])
    .map((w) => `"${w.replace(/"/g, '""')}"`)
    .join(" OR ");
}

function hasCjk(text) {
  CJK_RUN_RE.lastIndex = 0;
  return CJK_RUN_RE.test(normalizeSearchText(text));
}

export class FactStore {
  declare _stmts: any;
  declare _tagSearchCache: any;
  declare _ftsSearchCache: Map<string, { all: (params: Record<string, string | number>) => unknown[] }>;
  declare db: any;
  declare agentId: string;
  /**
   * @param {string} dbPath - facts.db 的路径
   * @param {{ Database?: import("better-sqlite3") }} [opts]
   */
  constructor(dbPath, opts: any = {}) {
    const Database = opts.Database || loadBetterSqliteDatabase();
    this.agentId = normalizeMemoryScope(undefined, opts.agentId).agentId;
    this.db = new Database(dbPath);
    this.db.function('memory_scope_can_read', { deterministic: true }, (record, context) => {
      try {
        const stored = record == null ? null : JSON.parse(record);
        if (record != null && stored == null) return 0; // JSON null is not an old SQL NULL row.
        return canReadMemoryScope(stored, JSON.parse(context), this.agentId) ? 1 : 0;
      } catch { return 0; }
    });
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("cache_size = -16000");     // 16MB（默认 ~2MB）
    this.db.pragma("temp_store = MEMORY");
    this.db.pragma("mmap_size = 30000000");    // 30MB mmap I/O
    this._initSchema();
    this._migrate();
    this._createFtsTriggers();
    this._prepareStatements();
    this._tagSearchCache = new Map();          // tag 数量、日期条件、作用域 → prepared statement
    this._ftsSearchCache = new Map();
  }

  _initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS facts (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        fact       TEXT NOT NULL,
        search_text TEXT NOT NULL DEFAULT '',
        tags       TEXT NOT NULL DEFAULT '[]',
        time       TEXT,
        session_id TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_facts_time ON facts(time);
      CREATE INDEX IF NOT EXISTS idx_facts_session ON facts(session_id);
    `);
    this._ensureSearchTextColumn();

    // FTS5 全文搜索：fact 保留原文，search_text 存储跨语言检索 token。
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE facts_fts USING fts5(
          fact,
          search_text,
          content=facts,
          content_rowid=id,
          tokenize='unicode61'
        );
      `);
    } catch {
      // 表已存在
    }

  }

  _createFtsTriggers() {
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
        INSERT INTO facts_fts(rowid, fact, search_text) VALUES (new.id, new.fact, new.search_text);
      END;
      CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
        INSERT INTO facts_fts(facts_fts, rowid, fact, search_text) VALUES ('delete', old.id, old.fact, old.search_text);
      END;
      CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts BEGIN
        INSERT INTO facts_fts(facts_fts, rowid, fact, search_text) VALUES ('delete', old.id, old.fact, old.search_text);
        INSERT INTO facts_fts(rowid, fact, search_text) VALUES (new.id, new.fact, new.search_text);
      END;
    `);
  }

  _ensureSearchTextColumn() {
    const columns = this.db.pragma("table_info(facts)");
    if (!columns.some((col) => col.name === "search_text")) {
      this.db.exec("ALTER TABLE facts ADD COLUMN search_text TEXT NOT NULL DEFAULT ''");
    }
  }

  /**
   * Schema 迁移：读取 user_version，逐级执行迁移函数。
   * 每次改表结构时：
   *   1. SCHEMA_VERSION += 1
   *   2. 在 switch 里加一个 case
   */
  _migrate() {
    const current = this.db.pragma("user_version", { simple: true });
    if (current >= SCHEMA_VERSION) return;

    this.db.transaction(() => {
      let v = current;
      while (v < SCHEMA_VERSION) {
        switch (v) {
          case 0:
            // v0 → v1：初始 schema 标记（无实际变更，仅打版本戳）
            break;
          case 1:
            // v1 → v2：补充 CJK 友好的搜索文本，并重建 FTS 表到双列 schema。
            this._migrateToSearchText();
            break;
          case 2:
            // One durable acknowledgement per session, committed with its facts.
            this.db.exec(`CREATE TABLE IF NOT EXISTS session_fact_commits (
              session_id TEXT PRIMARY KEY,
              revision TEXT NOT NULL
            )`);
            break;
          case 3:
            // Additive migration: unclassified historical rows remain legacy.
            this.db.exec(`
              ALTER TABLE facts ADD COLUMN memory_scope TEXT;
              ALTER TABLE facts ADD COLUMN source_dependencies TEXT NOT NULL DEFAULT '[]';
              ALTER TABLE facts ADD COLUMN source_revision TEXT;
              ALTER TABLE facts ADD COLUMN source_status TEXT NOT NULL DEFAULT 'active';
              ALTER TABLE facts ADD COLUMN source_invalidated_reason TEXT;
              CREATE INDEX IF NOT EXISTS idx_facts_source_status ON facts(source_status);
            `);
            break;
        }
        v++;
      }
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    })();

    log.log(`schema migrated: v${current} → v${SCHEMA_VERSION}`);
  }

  _migrateToSearchText() {
    this._ensureSearchTextColumn();

    const rows = this.db.prepare("SELECT id, fact, tags FROM facts").all();
    const update = this.db.prepare("UPDATE facts SET search_text = ? WHERE id = ?");
    for (const row of rows) {
      update.run(buildFactSearchText(row.fact, parseTags(row.tags)), row.id);
    }

    this.db.exec(`
      DROP TRIGGER IF EXISTS facts_ai;
      DROP TRIGGER IF EXISTS facts_ad;
      DROP TRIGGER IF EXISTS facts_au;
      DROP TABLE IF EXISTS facts_fts;
      CREATE VIRTUAL TABLE facts_fts USING fts5(
        fact,
        search_text,
        content=facts,
        content_rowid=id,
        tokenize='unicode61'
      );
    `);
    this._createFtsTriggers();
    this.db.exec("INSERT INTO facts_fts(facts_fts) VALUES ('rebuild')");
  }

  _prepareStatements() {
    this._stmts = {
      insert: this.db.prepare(`
        INSERT INTO facts (fact, search_text, tags, time, session_id, created_at,
          memory_scope, source_dependencies, source_revision, source_status)
        VALUES (@fact, @searchText, @tags, @time, @sessionId, @createdAt,
          @memoryScope, @sourceDependencies, @sourceRevision, @sourceStatus)
      `),
      getAll: this.db.prepare(`SELECT * FROM facts WHERE source_status = 'active'
        AND memory_scope_can_read(memory_scope, @memoryContext) ORDER BY time DESC`),
      getById: this.db.prepare(`SELECT * FROM facts WHERE id = @id AND source_status = 'active'
        AND memory_scope_can_read(memory_scope, @memoryContext)`),
      getBySession: this.db.prepare(`SELECT * FROM facts WHERE session_id = @sessionId AND source_status = 'active'
        AND memory_scope_can_read(memory_scope, @memoryContext) ORDER BY time DESC`),
      deleteBySession: this.db.prepare(`DELETE FROM facts WHERE session_id = ?`),
      count: this.db.prepare(`SELECT COUNT(*) as cnt FROM facts`),
      deleteById: this.db.prepare(`DELETE FROM facts WHERE id = ?`),
      deleteAll: this.db.prepare(`DELETE FROM facts`),
      getSessionCommit: this.db.prepare(`SELECT revision FROM session_fact_commits WHERE session_id = ?`),
      setSessionCommit: this.db.prepare(`INSERT INTO session_fact_commits (session_id, revision) VALUES (?, ?)
        ON CONFLICT(session_id) DO UPDATE SET revision = excluded.revision`),
      deleteSessionCommit: this.db.prepare(`DELETE FROM session_fact_commits WHERE session_id = ?`),
    };
  }

  /**
   * 新增一条元事实
   * @param {{ fact: string, tags: string[], time?: string, session_id?: string }} entry
   * @returns {{ id: number }}
   */
  add(entry, runtimeOptions: FactRuntimeOptions = {}) {
    // Explicit runtime metadata always wins over data returned by an extractor.
    const memoryScope = normalizeMemoryScope(
      Object.hasOwn(runtimeOptions, 'memoryScope') ? runtimeOptions.memoryScope : entry.memoryScope,
      this.agentId,
    );
    const sourceDependencies = normalizeSourceDependencies(
      runtimeOptions.sourceDependencies ?? entry.sourceDependencies,
    );
    const sourceStatus = runtimeOptions.sourceStatus ?? entry.sourceStatus ?? 'active';
    if (sourceStatus !== 'active' && sourceStatus !== 'stale') throw new TypeError('invalid fact sourceStatus');
    const sourceRevision = runtimeOptions.sourceRevision ?? entry.sourceRevision ?? null;
    if (sourceRevision !== null && (typeof sourceRevision !== 'string' || !sourceRevision)) {
      throw new TypeError('invalid fact sourceRevision');
    }
    const { cleaned, detected } = scrubPII(entry.fact);
    if (detected.length > 0) {
      log.warn(`PII detected (${detected.join(", ")}), redacted before storage`);
    }

    const now = new Date().toISOString();
    const result = this._stmts.insert.run({
      fact: cleaned,
      searchText: buildFactSearchText(cleaned, entry.tags || []),
      tags: JSON.stringify(entry.tags || []),
      time: entry.time || null,
      sessionId: entry.session_id || null,
      createdAt: now,
      memoryScope: JSON.stringify(memoryScope),
      sourceDependencies: JSON.stringify(sourceDependencies),
      sourceRevision,
      sourceStatus,
    });
    return { id: Number(result.lastInsertRowid) };
  }

  /**
   * 批量新增（事务）
   * @param {Array<{ fact: string, tags: string[], time?: string, session_id?: string }>} entries
   * @returns {number} 写入条数
   */
  addBatch(entries, runtimeOptions: FactRuntimeOptions = {}) {
    const run = this.db.transaction(() => {
      for (const entry of entries) {
        this.add(entry, runtimeOptions);
      }
    });
    run();
    return entries.length;
  }

  getSessionCommitRevision(sessionId) {
    return this._stmts.getSessionCommit.get(sessionId)?.revision ?? null;
  }

  /** Facts and their source revision commit together; text is never a dedupe key. */
  commitSessionRevision(sessionId, revision, entries, options: FactRuntimeOptions & { replace?: boolean } = {}) {
    const { replace = false } = options;
    if (Object.hasOwn(options, 'memoryScope')) normalizeMemoryScope(options.memoryScope, this.agentId);
    const owner = typeof sessionId === "string" ? sessionId.trim() : "";
    if (!owner || typeof revision !== "string" || !revision) throw new Error("fact commit requires sessionId and revision");
    if (!Array.isArray(entries)) throw new Error("fact commit requires an entries array");
    return this.db.transaction(() => {
      if (this.getSessionCommitRevision(owner) === revision) return 0;
      if (replace) {
        this.replaceBySession(owner, entries, { ...options, sourceRevision: revision });
      } else {
        for (const entry of entries) this.add({ ...entry, session_id: owner }, { ...options, sourceRevision: revision });
      }
      this._stmts.setSessionCommit.run(owner, revision);
      return entries.length;
    }).immediate();
  }

  /**
   * Replace every fact owned by one stable session in a single transaction.
   * FTS stays consistent through the existing delete/insert triggers.
   */
  replaceBySession(sessionId, entries, runtimeOptions: FactRuntimeOptions = {}) {
    if (Object.hasOwn(runtimeOptions, 'memoryScope')) normalizeMemoryScope(runtimeOptions.memoryScope, this.agentId);
    const stableSessionId = typeof sessionId === "string" ? sessionId.trim() : "";
    if (!stableSessionId) throw new Error("replaceBySession requires sessionId");
    if (!Array.isArray(entries)) throw new Error("replaceBySession requires an entries array");

    const run = this.db.transaction(() => {
      if (runtimeOptions.currentSourceDependencies !== undefined) {
        this.invalidateSourceEntries(stableSessionId, runtimeOptions.currentSourceDependencies);
      } else {
        this.invalidateSource(stableSessionId, { reason: 'source replaced' });
      }
      this._stmts.deleteBySession.run(stableSessionId);
      this._stmts.deleteSessionCommit.run(stableSessionId);
      for (const entry of entries) {
        if (typeof entry?.fact !== "string" || !entry.fact.trim()) {
          throw new Error("replacement fact must be a non-empty string");
        }
        this.add({
          ...entry,
          session_id: stableSessionId,
        }, runtimeOptions);
      }
    });
    run();
    return entries.length;
  }

  /**
   * 按标签搜索（精确匹配，OR 逻辑，按匹配数降序）
   *
   * 使用 json_each 精确匹配标签值，避免 LIKE 子串误匹配
   *
   * @param {string[]} queryTags - 查询标签
   * @param {{ from?: string, to?: string }} [dateRange] - 可选日期范围（YYYY-MM-DD 或 YYYY-MM-DDTHH:MM）
   * @param {number} [limit=20] - 最大返回数
   * @param {{ kind: 'channel', channelId: string } | null} [scope] - SQL LIMIT 前过滤频道作用域
   * @returns {Array<{ id, fact, tags, time, session_id, created_at, matchCount }>}
   */
  searchByTags(queryTags, dateRange, limit = 20, scope: { kind: 'channel'; channelId: string } | null = null, memoryScope?: unknown) {
    if (!queryTags || queryTags.length === 0) return [];

    const stmt = this._getTagSearchStmt(queryTags.length, dateRange, scope);

    const params: Record<string, string | number> = { limit, memoryContext: this._memoryContext(memoryScope) };
    for (let i = 0; i < queryTags.length; i++) {
      params[`tag${i}`] = queryTags[i];
    }
    if (dateRange?.from) params.dateFrom = dateRange.from;
    if (dateRange?.to) params.dateTo = dateRange.to;
    if (scope?.kind === "channel" && scope.channelId) params.channelSession = `channel-${scope.channelId}`;

    const rows = stmt.all(params);
    return rows.map((row) => this._rowToFact(row));
  }

  /** 按 (tagCount, dateRangeType, scoped) 缓存 prepared statement */
  _getTagSearchStmt(tagCount, dateRange, scope: { kind: 'channel'; channelId: string } | null = null) {
    // dateRange 类型编码：0=无, 1=from, 2=to, 3=both
    const dateKey = (dateRange?.from ? 1 : 0) | (dateRange?.to ? 2 : 0);
    const scoped = scope?.kind === "channel" && !!scope.channelId;
    const cacheKey = `${tagCount}:${dateKey}:${scoped ? 1 : 0}`;

    let stmt = this._tagSearchCache.get(cacheKey);
    if (stmt) return stmt;

    const placeholders = Array.from({ length: tagCount }, (_, i) => `@tag${i}`).join(", ");
    let dateWhere = "";
    if (dateKey & 1) dateWhere += ` AND (f.time IS NULL OR f.time >= @dateFrom)`;
    if (dateKey & 2) dateWhere += ` AND (f.time IS NULL OR f.time <= @dateTo)`;
    const scopeWhere = scoped
      ? " AND (f.session_id IS NULL OR substr(f.session_id, 1, 8) <> 'channel-' OR f.session_id = @channelSession)"
      : "";

    const sql = `
      SELECT f.*, COUNT(DISTINCT je.value) as matchCount
      FROM facts f, json_each(f.tags) je
      WHERE je.value IN (${placeholders})${dateWhere}${scopeWhere}
        AND f.source_status = 'active' AND memory_scope_can_read(f.memory_scope, @memoryContext)
      GROUP BY f.id
      ORDER BY matchCount DESC, f.time DESC
      LIMIT @limit
    `;

    stmt = this.db.prepare(sql);
    this._tagSearchCache.set(cacheKey, stmt);
    return stmt;
  }

  /**
   * 全文搜索（FTS5）
   *
   * @param {string} query - 搜索查询
   * @param {number} [limit=20]
   * @param {{scope?: {kind:'channel', channelId:string}, dateRange?: {from?:string, to?:string}}} [opts]
   * @returns {Array<{ id, fact, tags, time, session_id, created_at }>}
   */
  searchFullText(query, limit = 20, opts: FactSearchOptions = {}) {
    if (!query || !query.trim()) return [];
    // Validate outside the FTS fallback: malformed scope must not become legacy.
    const memoryContext = this._memoryContext(opts.memoryScope);

    try {
      const ftsQuery = buildFtsQuery(query);
      if (!ftsQuery) return [];

      const scope = opts?.scope;
      const dateRange = opts?.dateRange;
      const scoped = scope?.kind === "channel" && !!scope.channelId;
      const where = ["facts_fts MATCH @query", "f.source_status = 'active'", "memory_scope_can_read(f.memory_scope, @memoryContext)"];
      const params: Record<string, string | number> = { query: ftsQuery, limit, memoryContext };
      if (scoped) {
        where.push("(f.session_id IS NULL OR substr(f.session_id, 1, 8) <> 'channel-' OR f.session_id = @channelSession)");
        params.channelSession = `channel-${scope.channelId}`;
      }
      if (dateRange?.from) {
        where.push("(f.time IS NULL OR f.time >= @dateFrom)");
        params.dateFrom = dateRange.from;
      }
      if (dateRange?.to) {
        where.push("(f.time IS NULL OR f.time <= @dateTo)");
        params.dateTo = dateRange.to;
      }
      const cacheKey = `${scoped ? 1 : 0}:${dateRange?.from ? 1 : 0}:${dateRange?.to ? 1 : 0}`;
      let stmt = this._ftsSearchCache.get(cacheKey);
      if (!stmt) {
        stmt = this.db.prepare(`
          SELECT f.*, rank FROM facts_fts fts
          JOIN facts f ON f.id = fts.rowid
          WHERE ${where.join(" AND ")}
          ORDER BY rank LIMIT @limit
        `);
        this._ftsSearchCache.set(cacheKey, stmt);
      }
      const rows = stmt.all(params);
      if (rows.length === 0 && hasCjk(query)) {
        return this._likeFallback(query, limit, opts);
      }
      return rows.map((row) => this._rowToFact(row));
    } catch {
      // FTS 查询语法错误时降级为 LIKE
      return this._likeFallback(query, limit, opts);
    }
  }

  /**
   * LIKE 降级搜索（FTS 失败时使用）
   */
  _likeFallback(query, limit, opts: FactSearchOptions = {}) {
    const scope = opts?.scope;
    const dateRange = opts?.dateRange;
    const where = ["fact LIKE '%' || @query || '%'", "source_status = 'active'", "memory_scope_can_read(memory_scope, @memoryContext)"];
    const params: Record<string, string | number> = { query, limit, memoryContext: this._memoryContext(opts.memoryScope) };
    if (scope?.kind === "channel" && scope.channelId) {
      where.push("(session_id IS NULL OR substr(session_id, 1, 8) <> 'channel-' OR session_id = @channelSession)");
      params.channelSession = `channel-${scope.channelId}`;
    }
    if (dateRange?.from) {
      where.push("(time IS NULL OR time >= @dateFrom)");
      params.dateFrom = dateRange.from;
    }
    if (dateRange?.to) {
      where.push("(time IS NULL OR time <= @dateTo)");
      params.dateTo = dateRange.to;
    }
    const rows = this.db
      .prepare(`SELECT * FROM facts WHERE ${where.join(" AND ")} ORDER BY time DESC LIMIT @limit`)
      .all(params);
    return rows.map((row) => this._rowToFact(row));
  }

  /** 获取所有元事实（按时间降序） */
  getAll(memoryScope?: unknown) {
    return this._stmts.getAll.all({ memoryContext: this._memoryContext(memoryScope) }).map((row) => this._rowToFact(row));
  }

  /** 按 session_id 查询 */
  getBySession(sessionId, memoryScope?: unknown) {
    return this._stmts.getBySession.all({ sessionId, memoryContext: this._memoryContext(memoryScope) }).map((row) => this._rowToFact(row));
  }

  /** 删除一个 session 派生出的全部深度记忆事实。FTS 由 facts_ad trigger 同步。 */
  deleteBySession(sessionId) {
    const normalized = typeof sessionId === "string" ? sessionId.trim() : "";
    if (!normalized) throw new Error("fact invalidation requires sessionId");
    return this.db.transaction(() => {
      this.invalidateSource(normalized, { reason: 'source deleted' });
      this._stmts.deleteSessionCommit.run(normalized);
      return this._stmts.deleteBySession.run(normalized).changes;
    })();
  }

  /** 按 id 查询 */
  getById(id, memoryScope?: unknown) {
    const row = this._stmts.getById.get({ id, memoryContext: this._memoryContext(memoryScope) });
    return row ? this._rowToFact(row) : null;
  }

  get size() {
    return this._stmts.count.get().cnt;
  }

  /** 删除单条 */
  delete(id) {
    return this._stmts.deleteById.run(id).changes > 0;
  }

  /** 清空所有 */
  clearAll() {
    this.db.transaction(() => {
      this._stmts.deleteAll.run();
      this.db.exec("DELETE FROM session_fact_commits");
      // 重建 FTS 索引
      this.db.exec("INSERT INTO facts_fts(facts_fts) VALUES ('rebuild')");
    })();
  }

  /** 导出所有（不含内部字段），供 API 使用 */
  exportAll() {
    // Administrative backup only; retrieval and prompt paths must use getAll(context).
    return this.db.prepare('SELECT * FROM facts ORDER BY time DESC').all().map((row) => this._rowToFact(row));
  }

  /**
   * 批量导入
   * @param {Array<{ fact, tags, time?, session_id? }>} entries
   */
  importAll(entries) {
    const run = this.db.transaction(() => {
      for (const entry of entries) {
        this.add({
          fact: entry.fact,
          tags: entry.tags || [],
          time: entry.time || null,
          session_id: entry.session_id || null,
          memoryScope: entry.memoryScope,
          sourceDependencies: entry.sourceDependencies,
          sourceRevision: entry.sourceRevision,
          sourceStatus: entry.sourceStatus,
        });
      }
    });
    run();
  }

  /** Mark provenance stale without deleting historical evidence. */
  invalidateSource(sessionId, { revision, reason = 'source invalidated' }: { revision?: string; reason?: string } = {}) {
    const owner = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!owner || (revision !== undefined && (typeof revision !== 'string' || !revision))) {
      throw new TypeError('fact invalidation requires a source session and valid revision');
    }
    return this.db.transaction(() => {
      const result = this.db.prepare(`UPDATE facts SET source_status = 'stale', source_invalidated_reason = @reason
        WHERE source_status = 'active' AND (
          (session_id = @sessionId AND (@revision IS NULL OR source_revision IS NULL OR source_revision = @revision))
          OR EXISTS (SELECT 1 FROM json_each(facts.source_dependencies) source
            WHERE json_extract(source.value, '$.sessionId') = @sessionId
              AND (@revision IS NULL OR json_extract(source.value, '$.revision') IS NULL
                OR json_extract(source.value, '$.revision') = @revision))
        )`).run({ sessionId: owner, revision: revision ?? null, reason: String(reason) });
      if (revision === undefined || this.getSessionCommitRevision(owner) === revision) {
        this._stmts.deleteSessionCommit.run(owner);
      }
      return result.changes;
    })();
  }

  /**
   * Revalidate only facts depending on this source against its current entry
   * tokens. A changed/deleted A must not evict a fact supported solely by B.
   */
  invalidateSourceEntries(sessionId: string, currentDependencies: FactSourceDependency[]): number {
    const owner = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!owner) throw new TypeError('entry invalidation requires source sessionId');
    if (!Array.isArray(currentDependencies)) throw new TypeError('current source dependencies must be an array');
    // Per-fact provenance is bounded, but a whole transcript may exceed that
    // bound. Validate individual tokens without truncating the active snapshot.
    const active = new Map<string | null, FactSourceDependency>();
    for (const raw of currentDependencies) {
      const source = normalizeSourceDependencies([raw])[0];
      if (source.sessionId !== owner) continue;
      const key = source.entryId ?? null;
      const previous = active.get(key);
      if (previous && JSON.stringify(previous) !== JSON.stringify(source)) throw new TypeError('conflicting current source entry tokens');
      active.set(key, source);
    }
    const aggregate = active.get(null);
    const stillCurrent = (source: FactSourceDependency): boolean => {
      const token = active.get(source.entryId ?? null);
      if (!token || (source.revision === undefined && source.hash === undefined && source.generation === undefined)) return false;
      return (source.revision === undefined || source.revision === token.revision)
        && (source.hash === undefined || source.hash === token.hash)
        && (source.generation === undefined || source.generation === token.generation);
    };
    return this.db.transaction(() => {
      const rows = this.db.prepare(`SELECT id, session_id, source_revision, source_dependencies FROM facts
        WHERE source_status = 'active' AND (session_id = @sessionId OR EXISTS (
          SELECT 1 FROM json_each(CASE WHEN json_valid(source_dependencies) THEN source_dependencies ELSE '[]' END) source
          WHERE json_extract(source.value, '$.sessionId') = @sessionId
        ))`).all({ sessionId: owner });
      const stale = this.db.prepare("UPDATE facts SET source_status = 'stale', source_invalidated_reason = 'source entry changed' WHERE id = ?");
      let count = 0;
      for (const row of rows) {
        let dependencies: FactSourceDependency[];
        try { dependencies = normalizeSourceDependencies(JSON.parse(row.source_dependencies)); }
        catch { count += stale.run(row.id).changes; continue; }
        const ownedDependencies = dependencies.filter(source => source.sessionId === owner);
        // Explicit entry tokens supersede the old aggregate receipt on a fact.
        const valid = ownedDependencies.length
          ? ownedDependencies.every(stillCurrent)
          : row.session_id === owner && !!aggregate && !!row.source_revision && row.source_revision === aggregate.revision;
        if (!valid) count += stale.run(row.id).changes;
      }
      // Commit receipts contain summary revisions, not source-token revisions.
      // Leave an unchanged receipt alone; new summaries already have new keys.
      if (count > 0) this._stmts.deleteSessionCommit.run(owner);
      return count;
    })();
  }

  _memoryContext(value?: unknown): string {
    return JSON.stringify(normalizeMemoryScopeContext(value, this.agentId));
  }

  /** 关闭数据库连接 */
  close() {
    if (this.db?.open) this.db.close();
  }

  /** 行 → 对象 */
  _rowToFact(row) {
    const storedScope = row.memory_scope == null ? null : JSON.parse(row.memory_scope);
    if (row.memory_scope != null && storedScope == null) throw new TypeError('invalid persisted memory scope');
    return {
      id: row.id,
      fact: row.fact,
      tags: (() => {
        try { return JSON.parse(row.tags); } catch { return []; }
      })(),
      time: row.time,
      session_id: row.session_id,
      created_at: row.created_at,
      matchCount: row.matchCount ?? undefined,
      // Never export corrupt explicit scope as null: reimporting that would
      // silently reclassify it as legacy. A corrupt administrative export fails.
      memoryScope: normalizeMemoryScope(storedScope, this.agentId),
      sourceDependencies: normalizeSourceDependencies(JSON.parse(row.source_dependencies || '[]')),
      sourceRevision: row.source_revision ?? null,
      sourceStatus: row.source_status ?? 'active',
      sourceInvalidatedReason: row.source_invalidated_reason ?? null,
    };
  }
}
