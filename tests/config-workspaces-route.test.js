import fs from "fs";
import os from "os";
import path from "path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeWorkspacePath } from "../shared/workspace-history.js";

describe("config workspace routes", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-workspaces-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("persists a selected workspace into the current agent workspace history", async () => {
    const { createConfigRoute } = await import("../server/routes/config.js");
    const oldWorkspace = path.join(tmpDir, "old");
    const nextWorkspace = path.join(tmpDir, "next");
    fs.mkdirSync(oldWorkspace);
    fs.mkdirSync(nextWorkspace);
    const engine = {
      config: { cwd_history: [oldWorkspace] },
      updateConfig: vi.fn(async (patch) => {
        engine.config = { ...engine.config, ...patch };
      }),
    };
    const app = new Hono();
    app.route("/api", createConfigRoute(engine));

    const res = await app.request("/api/config/workspaces/recent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: nextWorkspace }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    // cwd_history is stored after normalizeWorkspacePath: backslashes folded to forward slashes
    // so the same config file is portable across platforms.
    const expectedHistory = [normalizeWorkspacePath(nextWorkspace), normalizeWorkspacePath(oldWorkspace)];
    expect(data.cwd_history).toEqual(expectedHistory);
    expect(engine.updateConfig).toHaveBeenCalledWith({
      cwd_history: expectedHistory,
    });
  });

  it("removes a recent workspace entry without deleting the directory", async () => {
    const { createConfigRoute } = await import("../server/routes/config.js");
    const oldWorkspace = path.join(tmpDir, "old");
    const keepWorkspace = path.join(tmpDir, "keep");
    fs.mkdirSync(oldWorkspace);
    fs.mkdirSync(keepWorkspace);
    const engine = {
      config: { cwd_history: [oldWorkspace, keepWorkspace] },
      updateConfig: vi.fn(async (patch) => {
        engine.config = { ...engine.config, ...patch };
      }),
    };
    const app = new Hono();
    app.route("/api", createConfigRoute(engine));

    const res = await app.request("/api/config/workspaces/recent", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: oldWorkspace }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.cwd_history).toEqual([keepWorkspace]);
    expect(fs.existsSync(oldWorkspace)).toBe(true);
    expect(engine.updateConfig).toHaveBeenCalledWith({ cwd_history: [keepWorkspace] });
  });

  it("clears recent workspace history without deleting directories", async () => {
    const { createConfigRoute } = await import("../server/routes/config.js");
    const oldWorkspace = path.join(tmpDir, "old");
    fs.mkdirSync(oldWorkspace);
    const engine = {
      config: { cwd_history: [oldWorkspace] },
      updateConfig: vi.fn(async (patch) => {
        engine.config = { ...engine.config, ...patch };
      }),
    };
    const app = new Hono();
    app.route("/api", createConfigRoute(engine));

    const res = await app.request("/api/config/workspaces/recent/all", { method: "DELETE" });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, cwd_history: [] });
    expect(fs.existsSync(oldWorkspace)).toBe(true);
    expect(engine.updateConfig).toHaveBeenCalledWith({ cwd_history: [] });
  });

  it("exposes and creates the default onboarding workspace", async () => {
    const homeDir = path.join(tmpDir, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    const { createConfigRoute } = await import("../server/routes/config.js");
    const engine = { config: {} };
    const app = new Hono();
    app.route("/api", createConfigRoute(engine));

    const expected = path.join(homeDir, "Desktop", "OH-WorkSpace");

    const getRes = await app.request("/api/config/default-workspace");
    expect(getRes.status).toBe(200);
    await expect(getRes.json()).resolves.toEqual({ path: expected });
    expect(fs.existsSync(expected)).toBe(false);

    const postRes = await app.request("/api/config/default-workspace", { method: "POST" });
    expect(postRes.status).toBe(200);
    await expect(postRes.json()).resolves.toEqual({ ok: true, path: expected });
    expect(fs.statSync(expected).isDirectory()).toBe(true);

    homedirSpy.mockRestore();
  });
});
