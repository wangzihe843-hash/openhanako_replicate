import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function makeEngine(tmpDir, disabled = []) {
  const agent = {
    id: "agent-1",
    name: "Hana",
    config: { tools: { disabled } },
  };
  const emitEvent = vi.fn();
  return {
    deskCwd: tmpDir,
    homeCwd: tmpDir,
    currentAgentId: agent.id,
    agent,
    agentsDir: path.join(tmpDir, "agents"),
    getAgent: () => agent,
    pluginManager: {
      getAllTools: () => [{ _pluginId: "beautify", name: "beautify_create-cover" }],
    },
    emitEvent,
  };
}

describe("desk beautify cover apply route", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-cover-route-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("applies a user-selected local image through the same cover service", async () => {
    const notePath = path.join(tmpDir, "note.md");
    const imagePath = path.join(tmpDir, "cover.png");
    fs.writeFileSync(notePath, "# Demo\n", "utf-8");
    fs.writeFileSync(imagePath, Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x04, 0x00,
    ]));

    const { createDeskRoute } = await import("../server/routes/desk.js");
    const engine = makeEngine(tmpDir);
    const app = new Hono();
    app.route("/api", createDeskRoute(engine, null));

    const res = await app.request("/api/desk/beautify/cover/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: notePath, imageFilePath: imagePath, agentId: "agent-1" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.cover.image).toMatch(/^文本附件\/note-cover-/);
    expect(fs.existsSync(path.join(tmpDir, ...body.cover.image.split("/")))).toBe(true);
    expect(fs.readFileSync(notePath, "utf-8")).toContain("cover:");
    expect(engine.emitEvent).toHaveBeenCalledWith({
      type: "app_event",
      event: {
        type: "markdown-cover-updated",
        payload: { filePath: notePath },
        source: "server",
      },
    }, null);
  });

  it("follows the beautify tool switch for direct UI apply", async () => {
    const notePath = path.join(tmpDir, "note.md");
    const imagePath = path.join(tmpDir, "cover.png");
    fs.writeFileSync(notePath, "# Demo\n", "utf-8");
    fs.writeFileSync(imagePath, "png", "utf-8");

    const { createDeskRoute } = await import("../server/routes/desk.js");
    const app = new Hono();
    app.route("/api", createDeskRoute(makeEngine(tmpDir, ["beautify"]), null));

    const res = await app.request("/api/desk/beautify/cover/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: notePath, imageFilePath: imagePath, agentId: "agent-1" }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "beautify tool is disabled for this agent" });
  });

  it("applies a built-in cover gallery preset through a whitelist id", async () => {
    const notePath = path.join(tmpDir, "note.md");
    fs.writeFileSync(notePath, "# Demo\n", "utf-8");

    const { COVER_GALLERY_PRESETS } = await import("../shared/cover-gallery-presets.js");
    const { createDeskRoute } = await import("../server/routes/desk.js");
    const engine = makeEngine(tmpDir);
    const app = new Hono();
    app.route("/api", createDeskRoute(engine, null));

    const res = await app.request("/api/desk/beautify/cover/preset/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filePath: notePath,
        presetId: COVER_GALLERY_PRESETS[0].id,
        agentId: "agent-1",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.cover.image).toMatch(/^文本附件\/note-cover-/);
    expect(fs.existsSync(path.join(tmpDir, ...body.cover.image.split("/")))).toBe(true);
    expect(fs.readFileSync(notePath, "utf-8")).toContain("cover:");
    expect(engine.emitEvent).toHaveBeenCalledWith({
      type: "app_event",
      event: {
        type: "markdown-cover-updated",
        payload: { filePath: notePath },
        source: "server",
      },
    }, null);
  });

  it("rejects unknown built-in cover gallery preset ids", async () => {
    const notePath = path.join(tmpDir, "note.md");
    fs.writeFileSync(notePath, "# Demo\n", "utf-8");

    const { createDeskRoute } = await import("../server/routes/desk.js");
    const app = new Hono();
    app.route("/api", createDeskRoute(makeEngine(tmpDir), null));

    const res = await app.request("/api/desk/beautify/cover/preset/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filePath: notePath,
        presetId: "../private",
        agentId: "agent-1",
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "unknown cover gallery preset" });
  });
});
