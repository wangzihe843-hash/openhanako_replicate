import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMigrationStatus, runMigrations } from "../core/migrations.ts";
import { safeConversationStem } from "../lib/conversations/agent-phone-projection.ts";

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), "hana-phone32-")); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(home, { recursive: true, force: true }); });
function context() {
  const latest = getMigrationStatus({}).registryLatestId;
  let preferences = { _dataVersion: 31,
    _migrationState: { completedIds: Array.from({ length: latest - 32 }, (_, index) => 33 + index), lastFailedIds: [] as number[] },
  };
  const ctx = { hanakoHome: home, agentsDir: path.join(home, "agents"),
    prefs: { getPreferences: () => structuredClone(preferences), savePreferences: value => { preferences = structuredClone(value); } },
    log: vi.fn<(line: string) => void>(),
  };
  // Do not execute the restricted #37 or any other migration.
  expect(preferences._migrationState.completedIds).toContain(37);
  expect(getMigrationStatus(preferences).pendingIds).toEqual([32]);
  return ctx;
}
function fixture(lines: string[], existing?: unknown) {
  const agent = path.join(home, "agents", "directory-agent");
  const projection = path.join(agent, "phone", "conversations", "legacy.md");
  const runtime = path.join(agent, "phone", "session-runtime", `${safeConversationStem("dm:peer/名字")}.json`);
  fs.mkdirSync(path.dirname(projection), { recursive: true });
  const input = ["---", ...lines, "state: idle", "summary: retain", "---", "", "# Agent Phone", "body bytes", ""].join("\n");
  fs.writeFileSync(projection, input);
  if (existing !== undefined) {
    fs.mkdirSync(path.dirname(runtime), { recursive: true });
    fs.writeFileSync(runtime, typeof existing === "string" ? existing : JSON.stringify(existing));
  }
  return { agent, projection, runtime, input };
}
const fields = ["conversationId: dm:peer/名字", "phoneSessionFile: phone/sessions/old.jsonl",
  "lastPhoneSessionUsedAt: 2026-05-25T12:10:00.000Z", "phoneSessionStartedAt: 2026-05-25T12:00:00.000Z",
  `promptSnapshot: ${encodeURIComponent(JSON.stringify({ version: 1, systemPrompt: "old prompt" }))}`,
  "toolNames: obsolete", "lastRefreshedDate: obsolete"];

describe("migration #32 bounded publication behavior", () => {
  it("preserves identity precedence, unknown runtime fields, projection body and existing timestamp", () => {
    const ctx = context();
    const f = fixture(["agentId: explicit-agent", "conversationType: channel", ...fields], {
      agentId: "existing-agent", unknown: { keep: true }, updatedAt: "original-time", toolNames: ["stale"],
    });
    expect(runMigrations(ctx)).toMatchObject({ pendingIds: [], lastFailedIds: [] });
    expect(JSON.parse(fs.readFileSync(f.runtime, "utf8"))).toEqual({
      agentId: "explicit-agent", conversationId: "dm:peer/名字", conversationType: "channel",
      unknown: { keep: true }, updatedAt: "original-time", phoneSessionFile: "phone/sessions/old.jsonl",
      lastPhoneSessionUsedAt: "2026-05-25T12:10:00.000Z", phoneSessionStartedAt: "2026-05-25T12:00:00.000Z",
      promptSnapshot: { version: 1, systemPrompt: "old prompt" },
    });
    const projection = fs.readFileSync(f.projection, "utf8");
    expect(projection).toContain("state: idle\nsummary: retain\n---\n\n# Agent Phone\nbody bytes\n");
    for (const key of ["phoneSessionFile", "lastPhoneSessionUsedAt", "phoneSessionStartedAt", "promptSnapshot", "toolNames", "lastRefreshedDate"]) expect(projection).not.toContain(`${key}:`);
    expect(ctx.log.mock.calls.filter(([line]) => /#\d+ 完成/.test(line))).toEqual([["[migrations] #32 完成"]]);
    const before = [fs.readFileSync(f.projection), fs.readFileSync(f.runtime)];
    const write = vi.spyOn(fs, "writeFileSync");
    expect(runMigrations(ctx)).toMatchObject({ pendingIds: [] });
    expect(runMigrations(context())).toMatchObject({ pendingIds: [] });
    expect(write).not.toHaveBeenCalled();
    expect([fs.readFileSync(f.projection), fs.readFileSync(f.runtime)]).toEqual(before);
  });

  it.each([
    [{ agentId: "existing-agent", conversationType: "existing-type" }, "existing-agent", "existing-type"],
    [{}, "directory-agent", "dm"],
    ["broken json", "directory-agent", "dm"],
  ])("retains fallback behavior for runtime %j", (existing, agentId, conversationType) => {
    const ctx = context(); const f = fixture(fields, existing);
    expect(runMigrations(ctx)).toMatchObject({ pendingIds: [] });
    expect(JSON.parse(fs.readFileSync(f.runtime, "utf8"))).toMatchObject({ agentId, conversationType, conversationId: "dm:peer/名字" });
  });

  it.each(["no frontmatter", "---\nphoneSessionFile: old", "---\nstate: idle\n---\nbody"])("keeps malformed or unchanged projection %s", input => {
    const ctx = context(); const f = fixture([]); fs.writeFileSync(f.projection, input);
    const write = vi.spyOn(fs, "writeFileSync");
    expect(runMigrations(ctx)).toMatchObject({ pendingIds: [] });
    expect(fs.readFileSync(f.projection, "utf8")).toBe(input);
    expect(fs.existsSync(f.runtime)).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it("retains existing cleanup without runtime publication when conversationId is missing", () => {
    const ctx = context(); const f = fixture(["phoneSessionFile: old", "toolNames: stale"]);
    expect(runMigrations(ctx)).toMatchObject({ pendingIds: [] });
    expect(fs.readFileSync(f.projection, "utf8")).not.toContain("phoneSessionFile");
    expect(fs.existsSync(f.runtime)).toBe(false);
  });

  it.each(["write", "rename"])("documents existing partial cleanup and retry limitation after runtime %s failure", stage => {
    const ctx = context(); const f = fixture(fields, { original: "old runtime" });
    const original = fs.readFileSync(f.runtime);
    const error = Object.assign(new Error("injected phone publication failure"), { code: "EIO" });
    const method = stage === "write" ? "writeFileSync" : "renameSync";
    const real = fs[method];
    const failure = vi.spyOn(fs, method).mockImplementation(new Proxy(real, { apply(target, receiver, args) {
      if (String(args[stage === "write" ? 0 : 1]) === f.runtime + (stage === "write" ? ".tmp" : "")) throw error;
      return Reflect.apply(target, receiver, args);
    } }));
    expect(runMigrations(ctx)).toMatchObject({ pendingIds: [32], lastFailedIds: [32] });
    expect(fs.readFileSync(f.projection, "utf8")).not.toContain("phoneSessionFile");
    expect(fs.readFileSync(f.runtime)).toEqual(original);
    expect(fs.existsSync(f.runtime + ".tmp")).toBe(stage === "rename");
    failure.mockRestore();
    // Attribution preserves the original limitation: cleaned frontmatter no
    // longer supplies runtimePatch, so retry can finish without recovering it.
    expect(runMigrations(ctx)).toMatchObject({ pendingIds: [], lastFailedIds: [] });
    expect(fs.readFileSync(f.runtime)).toEqual(original);
  });
});
