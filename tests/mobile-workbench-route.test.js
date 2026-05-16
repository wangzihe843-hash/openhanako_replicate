import fs from "fs";
import os from "os";
import path from "path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hana-mobile-workbench-"));
}

function makeApp(engine) {
  const app = new Hono();
  return import("../server/routes/mobile-workbench.js").then(({ createMobileWorkbenchRoute }) => {
    app.route("/api", createMobileWorkbenchRoute(engine));
    return app;
  });
}

describe("mobile workbench route", () => {
  let tmpDir = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("lists workbench files without exposing absolute server paths", async () => {
    tmpDir = makeTmpDir();
    const workspace = path.join(tmpDir, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, "note.md"), "hello", "utf-8");
    fs.writeFileSync(path.join(workspace, ".secret"), "hidden", "utf-8");
    const app = await makeApp({
      hanakoHome: path.join(tmpDir, "hana"),
      deskCwd: workspace,
      homeCwd: workspace,
    });

    const res = await app.request("/api/mobile/workbench/files");

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({ rootId: "default", subdir: "" });
    expect(data).not.toHaveProperty("basePath");
    expect(data.files.map((file) => file.name)).toEqual(["note.md"]);
    expect(JSON.stringify(data)).not.toContain(workspace);
  });

  it("serves UTF-8 file content with HEAD and Range support", async () => {
    tmpDir = makeTmpDir();
    const workspace = path.join(tmpDir, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, "粘贴图片.md"), "abcdef", "utf-8");
    const app = await makeApp({
      hanakoHome: path.join(tmpDir, "hana"),
      deskCwd: workspace,
      homeCwd: workspace,
    });
    const query = `name=${encodeURIComponent("粘贴图片.md")}`;

    const head = await app.request(`/api/mobile/workbench/content?${query}`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("6");
    expect(head.headers.get("content-disposition")).toContain("filename*=UTF-8''");

    const range = await app.request(`/api/mobile/workbench/content?${query}`, {
      headers: { Range: "bytes=1-3" },
    });
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toBe("bytes 1-3/6");
    expect(await range.text()).toBe("bcd");
  });

  it("safe-deletes mobile files into recoverable trash instead of hard removing bytes", async () => {
    tmpDir = makeTmpDir();
    const workspace = path.join(tmpDir, "workspace");
    const hanakoHome = path.join(tmpDir, "hana");
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, "draft.txt"), "keep me recoverable", "utf-8");
    const app = await makeApp({
      hanakoHome,
      deskCwd: workspace,
      homeCwd: workspace,
    });

    const res = await app.request("/api/mobile/workbench/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "safeDelete", name: "draft.txt" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({ ok: true, action: "safeDelete" });
    expect(data.trashId).toMatch(/^trash_/);
    expect(fs.existsSync(path.join(workspace, "draft.txt"))).toBe(false);
    const trashDir = path.join(hanakoHome, "trash", "mobile-workbench", data.trashId);
    expect(fs.readFileSync(path.join(trashDir, "payload"), "utf-8")).toBe("keep me recoverable");
    expect(JSON.parse(fs.readFileSync(path.join(trashDir, "metadata.json"), "utf-8")))
      .toMatchObject({ originalName: "draft.txt", rootId: "default" });
  });

  it("rejects path traversal in mobile file names and subdirectories", async () => {
    tmpDir = makeTmpDir();
    const workspace = path.join(tmpDir, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    const app = await makeApp({
      hanakoHome: path.join(tmpDir, "hana"),
      deskCwd: workspace,
      homeCwd: workspace,
    });

    const res = await app.request("/api/mobile/workbench/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "writeText", subdir: "../outside", name: "x.md", content: "no" }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_subdir" });
  });
});
