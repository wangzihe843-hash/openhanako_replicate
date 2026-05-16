import { describe, expect, it, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hana-server-runtime-context-"));
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function writeValidIdentity(root) {
  writeJson(path.join(root, "server-node.json"), {
    schemaVersion: 1,
    serverId: "server_runtime",
    label: "Runtime Server",
    createdAt: "2026-05-16T00:00:00.000Z",
    updatedAt: "2026-05-16T00:00:00.000Z",
  });
  writeJson(path.join(root, "users.json"), {
    schemaVersion: 1,
    defaultUserId: "user_runtime",
    users: [{
      userId: "user_runtime",
      kind: "legacy_owner",
      displayName: "Runtime User",
      profileSource: "legacy_user_profile",
      createdAt: "2026-05-16T00:00:00.000Z",
      updatedAt: "2026-05-16T00:00:00.000Z",
    }],
    createdAt: "2026-05-16T00:00:00.000Z",
    updatedAt: "2026-05-16T00:00:00.000Z",
  });
  writeJson(path.join(root, "studios.json"), {
    schemaVersion: 1,
    defaultStudioId: "studio_runtime",
    studios: [{
      studioId: "studio_runtime",
      ownerUserId: "user_runtime",
      label: "Runtime Studio",
      kind: "personal",
      storage: { provider: "legacy_hana_home", legacyRoot: true },
      membershipModel: "single_user_implicit",
      createdAt: "2026-05-16T00:00:00.000Z",
      updatedAt: "2026-05-16T00:00:00.000Z",
    }],
    createdAt: "2026-05-16T00:00:00.000Z",
    updatedAt: "2026-05-16T00:00:00.000Z",
  });
}

describe("server runtime context", () => {
  let tmpDir;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("creates a frozen local runtime context from stable identity registries", async () => {
    tmpDir = makeTmpDir();
    writeValidIdentity(tmpDir);
    const { createServerRuntimeContext } = await import("../core/server-runtime-context.js");

    const context = createServerRuntimeContext({ hanakoHome: tmpDir, appVersion: "2.3.4" });

    expect(context).toEqual({
      schemaVersion: 1,
      serverId: "server_runtime",
      userId: "user_runtime",
      studioId: "studio_runtime",
      label: "Runtime Server",
      userLabel: "Runtime User",
      studioLabel: "Runtime Studio",
      userKind: "legacy_owner",
      studioKind: "personal",
      membershipModel: "single_user_implicit",
      storage: { provider: "legacy_hana_home", legacyRoot: true },
      connectionKind: "local",
      authState: "paired",
      trustState: "local",
      credentialKind: "loopback_token",
      platformAccountId: null,
      officialServiceKind: null,
      capabilities: ["chat", "resources", "tools"],
      appVersion: "2.3.4",
    });
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.storage)).toBe(true);
  });

  it("fails explicitly when identity registries are invalid", async () => {
    tmpDir = makeTmpDir();
    writeValidIdentity(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "users.json"), "{ bad json", "utf-8");
    const { createServerRuntimeContext } = await import("../core/server-runtime-context.js");

    expect(() => createServerRuntimeContext({ hanakoHome: tmpDir }))
      .toThrow("invalid users.json");
  });
});
