import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const repository = path.resolve(import.meta.dirname, "..");
const temporary: string[] = [];

// The Windows process budget covers multiple serial file-lock operations and
// cold child starts. Upstream 15-second refresh and per-case watchdogs stay fixed.
const fixtureTimeoutMs = process.platform === "win32" ? 180_000 : 60_000;
const fixtureTestTimeoutMs = fixtureTimeoutMs + 5_000;

afterEach(() => {
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function runFixture(filename: string, nodeOptions: string[] = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-oauth-cancel-"));
  temporary.push(dir);
  for (const subdirectory of ["tmp", "home", "evidence"]) {
    fs.mkdirSync(path.join(dir, subdirectory));
  }
  // Never inherit model keys, provider configuration, or a developer's real home.
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const home = path.join(dir, "home");
  Object.assign(env, {
    HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    HANA_HOME: home, HANAKO_HOME: home, PI_CODING_AGENT_DIR: path.join(home, "pi"),
    TMPDIR: path.join(dir, "tmp"), TMP: path.join(dir, "tmp"), TEMP: path.join(dir, "tmp"),
    HANA_OAUTH_FIXTURE_ROOT: dir, TZ: "UTC", CI: "true",
  });
  const result = spawnSync(process.execPath, [
    ...nodeOptions, path.join(repository, "tests/fixtures", filename),
  ], { cwd: repository, env, encoding: "utf8", timeout: fixtureTimeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  const output = result.stdout + result.stderr;
  expect(result.error, output).toBeUndefined();
  expect(result.status, output).toBe(0);
  return { dir, output };
}

describe("Pi OAuth refresh cancellation and provider compatibility", () => {
  // These isolated fixtures include the actual upstream 15-second refresh timeout.
  // The suite-wide 10-second default stays unchanged.
  it("passes nine cancellation/failure/timeout cases through Hana's real runtime", () => {
    const { output } = runFixture("pi-oauth-cancellation.fixture.js", [
      "--test", "--test-concurrency=1", "--test-reporter=tap",
    ]);
    expect(output).toContain("# tests 9");
    expect(output).toContain("# pass 9");
    expect(output).toContain("# fail 0");
  }, fixtureTestTimeoutMs);

  it("serializes processes, persists across cold reopen, and preserves catalog cancellation", () => {
    // Plain Node is intentional: IPC workers must not inherit --test in execArgv.
    const { dir } = runFixture("pi-oauth-concurrency.fixture.js");
    const evidence = JSON.parse(fs.readFileSync(path.join(dir, "evidence/concurrent-oauth-regression.json"), "utf8"));
    expect(evidence).toMatchObject({ passed: true, networkAttempts: 0, syntheticCredentialsOnly: true });
    expect(evidence.observations).toHaveLength(5);
  }, fixtureTestTimeoutMs);

  it("preserves configured Azure routes, legacy identities, and persisted Hana history", () => {
    const { dir } = runFixture("pi-azure-compatibility.fixture.js");
    const evidence = JSON.parse(fs.readFileSync(path.join(dir, "evidence/azure-compatibility.json"), "utf8"));
    expect(evidence).toMatchObject({ version: "1.0.3", networkAttempts: 0, mockFetchCalls: 74, syntheticCredentialsOnly: true, failures: [] });
    expect(evidence.routing).toHaveLength(74);
    expect(evidence.routing.every((request: { passed: boolean }) => request.passed)).toBe(true);
    expect(evidence.results.map((result: { id: string }) => result.id)).toEqual([
      "azure-openai-responses", "azure", "custom-azure",
    ]);
    for (const result of evidence.results) {
      expect(result).toMatchObject({
        api: "azure-openai-responses", modelRestored: true, credentialMatched: true,
        callId: "call_synthetic", itemId: "fc_synthetic", reasoningIds: ["rs_synthetic"],
      });
    }
  }, fixtureTestTimeoutMs);
});
