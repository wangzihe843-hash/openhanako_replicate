import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAvatarRoute } from "../server/routes/avatar.ts";
import { createAgentsRoute } from "../server/routes/agents.ts";

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "avatar-persistence-")); });
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function fixture(endpoint: "user" | "agent" | "agents") {
  const agentDir = path.join(root, "agents", "hana");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "config.yaml"), "agent:\n  name: Hana\n");
  const engine = {
    userDir: path.join(root, "user"), agentsDir: path.join(root, "agents"),
    getAgent: (id: string) => id === "hana" ? { id, agentDir } : null,
    invalidateAgentListCache: vi.fn(), emitEvent: vi.fn(),
  };
  const app = new Hono();
  app.onError((error, c) => c.json({ error: error.message }, 500));
  app.route("/api", createAvatarRoute(engine));
  app.route("/api", createAgentsRoute(engine));
  const role = endpoint === "user" ? "user" : "agent";
  const dir = path.join(endpoint === "user" ? engine.userDir : agentDir, "avatars");
  fs.mkdirSync(dir, { recursive: true });
  const url = endpoint === "agents" ? "/api/agents/hana/avatar" : `/api/avatar/${role}${role === "agent" ? "?agentId=hana" : ""}`;
  const original = path.join(dir, `${role}.png`);
  fs.writeFileSync(original, "original avatar");
  return { app, dir, original, role, url, engine };
}
const upload = (app: Hono, url: string, format = "png", content = "new avatar") => app.request(url, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ data: `data:image/${format};base64,${Buffer.from(content).toString("base64")}` }),
});

describe.each(["user", "agent", "agents"] as const)("%s avatar persistence", (endpoint) => {
  it.each(["write", "rename"] as const)("preserves the previous avatar if %s fails", async (stage) => {
    const { app, original, dir, role, url, engine } = fixture(endpoint);
    const error = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    if (stage === "write") vi.spyOn(fsp, "writeFile").mockRejectedValueOnce(error);
    else vi.spyOn(fsp, "rename").mockRejectedValueOnce(error);
    const result = await upload(app, url);
    expect(result.status).toBe(500);
    expect(fs.existsSync(original)).toBe(true);
    expect(fs.readFileSync(original, "utf-8")).toBe("original avatar");
    expect(fs.readdirSync(dir)).toEqual([`${role}.png`]);
    expect(engine.emitEvent).not.toHaveBeenCalled();
  });

  it.each(["POST", "DELETE"] as const)("reports %s failure when the old format cannot be removed", async (method) => {
    const { app, original, url, engine } = fixture(endpoint);
    const unlink = fsp.unlink.bind(fsp);
    vi.spyOn(fsp, "unlink").mockImplementation(async (file) => {
      if (String(file) === original) throw Object.assign(new Error("avatar is locked"), { code: "EACCES" });
      return unlink(file);
    });
    const result = method === "POST" ? await upload(app, url, "jpeg") : await app.request(url, { method });
    expect(result.status).toBe(500);
    expect(fs.readFileSync(original, "utf-8")).toBe("original avatar");
    expect(engine.emitEvent).not.toHaveBeenCalled();
  });

  it("switches formats and supports repeated deletion of a missing avatar", async () => {
    const { app, url, dir, role } = fixture(endpoint);
    expect((await upload(app, url, "jpeg")).status).toBe(200);
    expect(fs.readdirSync(dir)).toEqual([`${role}.jpg`]);
    const read = await app.request(url);
    expect(read.status).toBe(200);
    expect(await read.text()).toBe("new avatar");
    expect((await app.request(url, { method: "DELETE" })).status).toBe(200);
    expect((await app.request(url, { method: "DELETE" })).status).toBe(200);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

it("serializes format changes for the same agent across both route aliases", async () => {
  const { app, url, dir } = fixture("agent");
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const write = fsp.writeFile.bind(fsp);
  const spy = vi.spyOn(fsp, "writeFile").mockImplementationOnce(async (...args) => {
    started();
    await held;
    return write(...args);
  });
  const first = upload(app, url, "png", "first");
  await entered;
  const second = upload(app, "/api/agents/hana/avatar", "jpeg", "second");
  // Let the second request reach its mutation while the first file write is held.
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  const writesWhileHeld = spy.mock.calls.length;
  release();
  const responses = await Promise.all([first, second]);
  expect(responses.map((response) => response.status)).toEqual([200, 200]);
  expect(writesWhileHeld).toBe(1);
  expect(fs.readdirSync(dir)).toEqual(["agent.jpg"]);
  expect(await (await app.request(url)).text()).toBe("second");
});
