/**
 * Durable, fail-closed provenance for explicit memory scopes.
 *
 * Legacy aggregates are deliberately not imported: their mixed provenance cannot
 * be recovered reliably. Invalid artifacts remain on disk for audit/recovery but
 * can never be returned as active context. Every mutation re-reads the manifest so
 * separate ticker/context instances share the same invalidation fence.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { atomicWriteSync } from "../../shared/safe-fs.ts";
import {
  normalizeMemoryScope,
  normalizeMemoryScopeContext,
  memoryScopeKey,
  sameMemoryScope,
  canReadMemoryScope,
  type MemoryScope,
} from "../../shared/memory-scope.ts";
import { scrubPII } from "../pii-guard.ts";
import { normalizeCompiledSectionBody } from "./compiled-memory-state.ts";

export type SourceDependency = {
  type: "source";
  sessionId: string;
  revision: string;
  hash: string;
  generation: number;
  writeFence?: number;
  entryId?: string;
};
export type ArtifactDependency = { type: "artifact"; artifactId: string; hash: string };
export type MemoryDependency = SourceDependency | ArtifactDependency;
export type ScopedArtifactKind = "summary" | "day" | "today" | "week" | "longterm" | "facts" | "deep-facts";
export type ScopedSourceMessage = { role?: string; content?: unknown; timestamp?: string | null; entryId?: string; id?: string };
export type ScopedArtifact = {
  id: string;
  key: string;
  slot: string;
  kind: ScopedArtifactKind;
  memoryScope: MemoryScope;
  body: string;
  hash: string;
  dependencies: MemoryDependency[];
  status: "active" | "stale" | "superseded";
  createdAt: string;
  invalidatedAt?: string;
  invalidationReason?: string;
};
type SourceInput = { sessionId: string; memoryScope: unknown; revision: string; hash?: string; entryId?: string; message?: ScopedSourceMessage };
type SourceRecord = SourceDependency & {
  memoryScope: MemoryScope;
  status: "active" | "stale";
  updatedAt: string;
  invalidationReason?: string;
  message?: ScopedSourceMessage;
};
type ScopedRollbackCheckpoint = { state: Manifest; fingerprint: string };
type Manifest = {
  version: 1;
  sources: Record<string, SourceRecord>;
  artifacts: Record<string, ScopedArtifact>;
  heads: Record<string, string>;
};
const EMPTY = (): Manifest => ({ version: 1, sources: {}, artifacts: {}, heads: {} });
const digest = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
export function hashScopedSourceMessage(message: ScopedSourceMessage): string {
  return digest(JSON.stringify({ role: message.role, content: message.content, timestamp: message.timestamp || null }));
}
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

export class ScopedDerivationStore {
  readonly memoryDir: string;
  readonly agentId: string;
  readonly manifestPath: string;

  constructor(memoryDir: string, opts: { agentId?: string } = {}) {
    this.memoryDir = memoryDir;
    this.agentId = opts.agentId || "__legacy__";
    this.manifestPath = path.join(memoryDir, "scoped-derivations.v1.json");
  }

  private read(): Manifest {
    let text: string;
    try { text = fs.readFileSync(this.manifestPath, "utf8"); }
    catch (error) { if (error?.code === "ENOENT") return EMPTY(); throw error; }
    const state = JSON.parse(text);
    if (state?.version !== 1 || !state.sources || !state.artifacts || !state.heads
      || Array.isArray(state.sources) || Array.isArray(state.artifacts) || Array.isArray(state.heads)) {
      throw new Error("invalid scoped memory manifest; refusing unverified context");
    }
    return state;
  }

  private write(state: Manifest) {
    fs.mkdirSync(this.memoryDir, { recursive: true });
    atomicWriteSync(this.manifestPath, JSON.stringify(state, null, 2) + "\n");
  }

  createRollbackCheckpoint(): ScopedRollbackCheckpoint {
    const state = this.read();
    return { state, fingerprint: digest(JSON.stringify(state)) };
  }

  getStateFingerprint(): string { return digest(JSON.stringify(this.read())); }

  /**
   * Restore a failed synchronous cross-store operation only if no later manifest
   * write occurred. Content generations are restored so facts and pins keep their
   * valid provenance; write fences and replacement artifact IDs prevent pending
   * computations from reusing tokens captured before the failed invalidation.
   */
  restoreRollbackCheckpoint(checkpoint: ScopedRollbackCheckpoint, expectedFingerprint: string) {
    const current = this.read();
    const fingerprint = digest(JSON.stringify(current));
    if (fingerprint !== expectedFingerprint) {
      throw Object.assign(new Error("scoped memory changed concurrently; refusing to overwrite newer provenance"), { code: "scoped_memory_rollback_conflict" });
    }
    if (fingerprint === checkpoint.fingerprint) return;
    const before = checkpoint.state;
    const restored = clone(current);
    for (const [key, source] of Object.entries(restored.sources)) {
      if (!own(before.sources, key)) {
        source.status = "stale";
        source.generation = Math.max(source.generation, source.writeFence || 0) + 1;
        source.writeFence = source.generation;
        source.invalidationReason = "source creation rolled back";
      }
    }
    for (const [key, original] of Object.entries(before.sources)) {
      const latest = current.sources[key];
      const changed = JSON.stringify(original) !== JSON.stringify(latest);
      restored.sources[key] = { ...clone(original), ...(changed ? {
        writeFence: Math.max(original.generation, original.writeFence || 0, latest?.generation || 0, latest?.writeFence || 0) + 1,
      } : {}) };
    }
    // Audit records from the failed operation stay invalid. Recreate the valid
    // checkpoint graph in dependency order, retaining unchanged unrelated IDs.
    for (const artifact of Object.values(restored.artifacts)) {
      if (artifact.status === "active" && !before.artifacts[artifact.id]) {
        artifact.status = "stale";
        artifact.invalidationReason = "artifact creation rolled back";
      }
    }
    const remapped = new Map<string, ScopedArtifact>();
    const restoreArtifact = (original: ScopedArtifact): ScopedArtifact => {
      if (remapped.has(original.id)) return remapped.get(original.id);
      const dependencies = original.dependencies.map((dependency): MemoryDependency => {
        if (dependency.type === "source") {
          const source = restored.sources[this.sourceKey(dependency.sessionId, dependency.entryId)];
          return this.sourceToken(source);
        }
        const upstream = restoreArtifact(before.artifacts[dependency.artifactId]);
        return this.artifactDependency(upstream);
      });
      const latest = current.artifacts[original.id];
      if (latest?.status === "active" && current.heads[original.key] === original.id
        && JSON.stringify(dependencies) === JSON.stringify(original.dependencies)) {
        remapped.set(original.id, latest);
        return latest;
      }
      if (restored.artifacts[original.id]) {
        restored.artifacts[original.id].status = "stale";
        restored.artifacts[original.id].invalidationReason = "replaced by rollback restoration";
      }
      const artifact = { ...clone(original), id: crypto.randomUUID(), dependencies,
        hash: digest(JSON.stringify({ body: original.body, dependencies })), status: "active" as const };
      delete artifact.invalidatedAt;
      delete artifact.invalidationReason;
      restored.artifacts[artifact.id] = artifact;
      restored.heads[artifact.key] = artifact.id;
      remapped.set(original.id, artifact);
      return artifact;
    };
    for (const artifact of Object.values(before.artifacts)) {
      if (this.artifactCurrent(before, artifact)) restoreArtifact(artifact);
    }
    this.invalidateBrokenArtifacts(restored, "failed operation rolled back");
    this.write(restored);
  }

  /** Rebase only dependencies that match the restored content generation. */
  rebaseRollbackDependencies(dependencies: MemoryDependency[]): MemoryDependency[] {
    const state = this.read();
    return (dependencies || []).map((dependency) => {
      if (dependency.type !== "source") return dependency;
      const source = state.sources[this.sourceKey(dependency.sessionId, dependency.entryId)];
      return source?.status === "active" && source.revision === dependency.revision
        && source.hash === dependency.hash && source.generation === dependency.generation ? this.sourceToken(source) : dependency;
    });
  }

  /** Only trusted transcript/session code may register a current source snapshot. */
  registerSource(input: SourceInput): SourceDependency {
    const state = this.read();
    const result = this.upsertSource(state, input);
    if (result.changed) {
      this.invalidateBrokenArtifacts(state, "source snapshot changed");
      this.write(state);
    }
    return result.dependency;
  }

  private upsertSource(state: Manifest, input: SourceInput): { dependency: SourceDependency; changed: boolean } {
    const sessionId = String(input.sessionId || "").trim();
    const revision = String(input.revision || "").trim();
    if (!sessionId || !revision) throw new Error("scoped source requires sessionId and revision");
    const memoryScope = normalizeMemoryScope(input.memoryScope, this.agentId);
    if (memoryScope.realm === "legacy") throw new Error("legacy sources use the legacy aggregate pipeline");
    const sourceKey = this.sourceKey(sessionId, input.entryId);
    const old = own(state.sources, sourceKey) ? state.sources[sourceKey] : null;
    const hash = input.hash || digest(revision);
    if (old?.status === "active" && old.revision === revision && old.hash === hash && sameMemoryScope(old.memoryScope, memoryScope)) {
      return { dependency: this.sourceToken(old), changed: false };
    }
    const source: SourceRecord = {
      type: "source", sessionId, revision, hash, memoryScope,
      ...(input.entryId ? { entryId: input.entryId } : {}),
      ...(input.message ? { message: clone(input.message) } : {}),
      generation: Math.max(old?.generation || 0, old?.writeFence || 0) + 1,
      writeFence: Math.max(old?.generation || 0, old?.writeFence || 0) + 1,
      status: "active", updatedAt: new Date().toISOString(),
    };
    Object.defineProperty(state.sources, sourceKey, { value: source, enumerable: true, writable: true, configurable: true });
    return { dependency: this.sourceToken(source), changed: true };
  }

  private sourceToken(source: SourceRecord): SourceDependency {
    const { type, sessionId, revision, hash, generation, entryId } = source;
    return { type, sessionId, revision, hash, generation, writeFence: source.writeFence ?? generation, ...(entryId ? { entryId } : {}) };
  }

  private sourceKey(sessionId: string, entryId?: string) {
    return JSON.stringify([sessionId, entryId || null]);
  }

  getSourceDependency(sessionId: string, entryId?: string): SourceDependency | null {
    const state = this.read();
    const key = this.sourceKey(sessionId, entryId);
    const source = own(state.sources, key) ? state.sources[key] : null;
    return source?.status === "active" ? this.sourceToken(source) : null;
  }

  /**
   * Refresh actual active transcript entries before compiling or injecting.
   * Appending an entry does not invalidate earlier entry-sized derivations. An
   * edit/retraction invalidates only changed/removed entries and their DAG.
   */
  syncSessionSourceSnapshot(sessionId: string, memoryScope: unknown, messages: ScopedSourceMessage[]): SourceDependency {
    const scope = normalizeMemoryScope(memoryScope, this.agentId);
    if (scope.realm === "legacy") throw new Error("legacy sources use the legacy aggregate pipeline");
    const active = (messages || []).filter((message) => message?.role === "user" || message?.role === "assistant");
    const snapshots = active.map((message, index) => ({
      entryId: String(message.entryId || message.id || `position-${index}`),
      message: { role: message.role, content: message.content, timestamp: message.timestamp || null },
    }));
    const aggregateRevision = digest(JSON.stringify(snapshots));
    const state = this.read();
    const aggregate = this.upsertSource(state, { sessionId, memoryScope: scope, revision: aggregateRevision });
    const activeIds = new Set(snapshots.map((snapshot) => snapshot.entryId));
    // A complete transcript snapshot and its invalidations commit atomically.
    let changed = aggregate.changed;
    for (const source of Object.values(state.sources)) {
      if (source.sessionId !== sessionId || !source.entryId || source.status !== "active") continue;
      if (!activeIds.has(source.entryId) || !sameMemoryScope(source.memoryScope, scope)) {
        source.status = "stale";
        source.generation += 1;
        source.invalidationReason = "transcript entry removed or re-scoped";
        source.updatedAt = new Date().toISOString();
        changed = true;
      }
    }
    for (const snapshot of snapshots) {
      const hash = hashScopedSourceMessage(snapshot.message);
      const result = this.upsertSource(state, { sessionId, memoryScope: scope, entryId: snapshot.entryId,
        revision: hash, hash, message: snapshot.message });
      changed = changed || result.changed;
    }
    if (changed) { this.invalidateBrokenArtifacts(state, "transcript snapshot changed"); this.write(state); }
    return aggregate.dependency;
  }

  getSessionSourceSnapshots(sessionId: string, memoryScope: unknown) {
    const scope = normalizeMemoryScope(memoryScope, this.agentId);
    return Object.values(this.read().sources)
      .filter((source) => source.sessionId === sessionId && source.entryId && source.message
        && source.status === "active" && sameMemoryScope(source.memoryScope, scope))
      .map((source) => ({ dependency: this.sourceToken(source), message: clone(source.message) }));
  }

  getSessionDependencies(sessionId: string, memoryScope: unknown): SourceDependency[] {
    const scope = normalizeMemoryScope(memoryScope, this.agentId);
    return Object.values(this.read().sources).filter((source) => source.sessionId === sessionId
      && source.status === "active" && sameMemoryScope(source.memoryScope, scope)).map((source) => this.sourceToken(source));
  }

  /** Persist invalidation before returning. Entry fences can be deferred only to a trusted immediate transcript refresh. */
  invalidateSource(sessionId: string, opts: { reason?: string; revision?: string; preserveEntries?: boolean } = {}) {
    const state = this.read();
    let changed = false;
    for (const source of Object.values(state.sources)) {
      if (source.sessionId !== sessionId || (opts.preserveEntries && source.entryId)
        || (opts.revision && source.revision !== opts.revision)) continue;
      source.status = "stale";
      source.generation += 1;
      source.updatedAt = new Date().toISOString();
      source.invalidationReason = opts.reason || "source invalidated";
      changed = true;
    }
    if (!changed) return 0;
    const count = this.invalidateBrokenArtifacts(state, opts.reason || "source invalidated");
    this.write(state);
    return count;
  }

  invalidateAll(reason = "compiled memory reset") {
    const state = this.read();
    if (!Object.keys(state.sources).length && !Object.keys(state.artifacts).length) return 0;
    for (const source of Object.values(state.sources)) {
      source.status = "stale";
      source.generation += 1;
      source.updatedAt = new Date().toISOString();
      source.invalidationReason = reason;
    }
    const count = this.invalidateBrokenArtifacts(state, reason);
    this.write(state);
    return count;
  }

  private dependencyCurrent(state: Manifest, dependency: MemoryDependency, scope: MemoryScope, visiting: Set<string>, forWrite = false): boolean {
    if (dependency?.type === "source") {
      const key = this.sourceKey(dependency.sessionId, dependency.entryId);
      const source = own(state.sources, key) ? state.sources[key] : null;
      return !!source && source.status === "active"
        && source.revision === dependency.revision && source.hash === dependency.hash
        && source.generation === dependency.generation && sameMemoryScope(source.memoryScope, scope)
        && (!forWrite || (dependency.writeFence ?? dependency.generation) === (source.writeFence ?? source.generation));
    }
    if (dependency?.type === "artifact") {
      const artifact = own(state.artifacts, dependency.artifactId) ? state.artifacts[dependency.artifactId] : null;
      return !!artifact && artifact.hash === dependency.hash && sameMemoryScope(artifact.memoryScope, scope)
        && this.artifactCurrent(state, artifact, visiting, forWrite);
    }
    return false;
  }

  private artifactCurrent(state: Manifest, artifact: ScopedArtifact, visiting = new Set<string>(), forWrite = false): boolean {
    if (artifact.status !== "active" || state.heads[artifact.key] !== artifact.id || visiting.has(artifact.id)
      || !Array.isArray(artifact.dependencies) || artifact.dependencies.length === 0) return false;
    visiting.add(artifact.id);
    const current = artifact.dependencies.every((dependency) => this.dependencyCurrent(state, dependency, artifact.memoryScope, visiting, forWrite));
    visiting.delete(artifact.id);
    return current;
  }

  private invalidateBrokenArtifacts(state: Manifest, reason: string) {
    let count = 0;
    for (const artifact of Object.values(state.artifacts)) {
      if (artifact.status === "active" && !this.artifactCurrent(state, artifact)) {
        artifact.status = "stale";
        artifact.invalidatedAt = new Date().toISOString();
        artifact.invalidationReason = reason;
        count += 1;
      }
    }
    return count;
  }

  areDependenciesCurrent(dependencies: MemoryDependency[], memoryScope: unknown): boolean {
    const scope = normalizeMemoryScope(memoryScope, this.agentId);
    const state = this.read();
    return Array.isArray(dependencies) && dependencies.length > 0
      && dependencies.every((dependency) => this.dependencyCurrent(state, dependency, scope, new Set(), true));
  }

  /** Compare-and-commit after asynchronous LLM work; stale work returns null. */
  commitArtifact(input: {
    kind: ScopedArtifactKind; slot: string; memoryScope: unknown; body: string;
    dependencies: MemoryDependency[]; expectedHead?: string | null;
  }): ScopedArtifact | null {
    const memoryScope = normalizeMemoryScope(input.memoryScope, this.agentId);
    if (memoryScope.realm === "legacy") throw new Error("scoped artifacts require an explicit realm");
    const state = this.read();
    const dependencies = clone(input.dependencies || []);
    if (!dependencies.length || !dependencies.every((dependency) => this.dependencyCurrent(state, dependency, memoryScope, new Set(), true))) return null;
    const key = JSON.stringify([memoryScopeKey(memoryScope), input.kind, input.slot]);
    const previousId = state.heads[key] || null;
    if (input.expectedHead !== undefined && input.expectedHead !== previousId) return null;
    const body = input.kind === "summary" || input.kind === "deep-facts" ? String(input.body || "").trim() : normalizeCompiledSectionBody(input.body);
    const hash = digest(JSON.stringify({ body, dependencies }));
    const previous = previousId ? state.artifacts[previousId] : null;
    if (previous && previous.hash === hash && this.artifactCurrent(state, previous)) return clone(previous);
    if (previous?.status === "active") previous.status = "superseded";
    const artifact: ScopedArtifact = {
      id: crypto.randomUUID(), key, slot: String(input.slot), kind: input.kind, memoryScope, body, hash, dependencies,
      status: "active", createdAt: new Date().toISOString(),
    };
    state.artifacts[artifact.id] = artifact;
    state.heads[key] = artifact.id;
    this.invalidateBrokenArtifacts(state, "upstream artifact superseded");
    this.write(state);
    return clone(artifact);
  }

  artifactDependency(artifact: ScopedArtifact): ArtifactDependency {
    return { type: "artifact", artifactId: artifact.id, hash: artifact.hash };
  }

  getArtifact(kind: ScopedArtifactKind, slot: string, memoryScope: unknown): ScopedArtifact | null {
    const scope = normalizeMemoryScope(memoryScope, this.agentId);
    const state = this.read();
    const key = JSON.stringify([memoryScopeKey(scope), kind, slot]);
    const artifact = state.artifacts[state.heads[key]];
    return artifact && this.artifactCurrent(state, artifact) ? clone(artifact) : null;
  }

  listArtifacts(memoryScope: unknown, opts: { kind?: ScopedArtifactKind; includeInvalid?: boolean } = {}): ScopedArtifact[] {
    const context = normalizeMemoryScopeContext(memoryScope, this.agentId);
    const state = this.read();
    return Object.values(state.artifacts)
      .filter((artifact) => canReadMemoryScope(artifact.memoryScope, context))
      .filter((artifact) => !opts.kind || artifact.kind === opts.kind)
      .filter((artifact) => opts.includeInvalid || this.artifactCurrent(state, artifact))
      .sort((a, b) => a.slot.localeCompare(b.slot) || a.createdAt.localeCompare(b.createdAt))
      .map(clone);
  }

  readCompiledSections(memoryScope: unknown): Record<string, string> {
    const artifacts = this.listArtifacts(memoryScope);
    return Object.fromEntries(["facts", "today", "week", "longterm"].map((kind) => [kind,
      // Old caches can predate write-time scrubbing. Sanitize the read projection
      // before any clipping without rewriting historical bodies or their hashes.
      scrubPII(artifacts.filter((artifact) => artifact.kind === kind && artifact.body).map((artifact) => artifact.body).join("\n\n")).cleaned,
    ]));
  }

  /** Never falls back to the historical unscoped memory.md. */
  readCompiledContext(memoryScope: unknown, opts: { maxChars?: number } = {}): string {
    const sections = this.readCompiledSections(memoryScope);
    const labels = { facts: "Key facts", today: "Today", week: "Earlier this week", longterm: "Long-term context" };
    const limits = { facts: 1600, today: 1800, week: 2200, longterm: 2400 };
    const context = Object.entries(sections).filter(([, body]) => body).map(([key, body]) => {
      const clipped = body.length > limits[key] ? `${body.slice(0, limits[key])}\n[More scoped memory omitted]` : body;
      return `## ${labels[key]}\n\n${clipped}`;
    }).join("\n\n");
    return context.slice(0, Math.max(0, opts.maxChars ?? 8400));
  }
}
