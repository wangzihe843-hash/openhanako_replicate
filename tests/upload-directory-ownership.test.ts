import fs from "fs";
import os from "os";
import path from "path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUploadRoute } from "../server/routes/upload.ts";
import { sessionFilesCacheDir } from "../lib/session-files/session-file-registry.ts";

const roots: string[] = [];
function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-upload-owner-"));
  roots.push(root);
  return root;
}
function request(app, endpoint, body) {
  return app.request(`/api/${endpoint}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}
function makeApp(engine) {
  const app = new Hono();
  app.route("/api", createUploadRoute(engine));
  return app;
}
const blob = { name: "image.png", mimeType: "image/png", base64Data: Buffer.from("fixture").toString("base64") };

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("upload target directory behavior", () => {
  it.each(["upload", "upload-blob"])("%s cleans only legacy entries strictly older than 24 hours", async (endpoint) => {
    const root = tempRoot();
    const uploads = path.join(root, "uploads");
    fs.mkdirSync(uploads);
    const now = 1800000000000;
    const cutoff = now - 24 * 60 * 60 * 1000;
    for (const [name, age] of [["old", -1000], ["boundary", 0], ["new", 1000]] as const) {
      const target = path.join(uploads, name);
      fs.writeFileSync(target, "fixture");
      fs.utimesSync(target, new Date(cutoff + age), new Date(cutoff + age));
      expect(fs.statSync(target).mtimeMs).toBe(cutoff + age);
    }
    vi.spyOn(Date, "now").mockReturnValue(now);
    const app = makeApp({ hanakoHome: root });
    const body = endpoint === "upload" ? { paths: [path.join(root, "missing")] } : blob;
    expect((await request(app, endpoint, body)).status).toBe(200);
    await vi.waitFor(() => expect(fs.existsSync(path.join(uploads, "old"))).toBe(false));
    expect(fs.existsSync(path.join(uploads, "boundary"))).toBe(true);
    expect(fs.existsSync(path.join(uploads, "new"))).toBe(true);
  });

  it.each(["upload", "upload-blob"])("%s does not run legacy cleanup for a session", async (endpoint) => {
    const root = tempRoot();
    const uploads = path.join(root, "uploads");
    fs.mkdirSync(uploads);
    const old = path.join(uploads, "old");
    fs.writeFileSync(old, "fixture");
    fs.utimesSync(old, new Date(0), new Date(0));
    const readdir = vi.spyOn(fs.promises, "readdir");
    const app = makeApp({ hanakoHome: root });
    const sessionPath = path.join(root, "session.jsonl");
    const body = endpoint === "upload" ? { paths: [path.join(root, "missing")], sessionPath } : { ...blob, sessionPath };
    expect((await request(app, endpoint, body)).status).toBe(200);
    expect(readdir.mock.calls.some(([p]) => p === uploads)).toBe(false);
    expect(fs.existsSync(old)).toBe(true);
    expect(fs.existsSync(sessionFilesCacheDir(root, { sessionId: null, sessionPath }))).toBe(true);
  });

  it.each(["upload", "upload-blob"])("%s creates the directory before reusing an existing session entry", async (endpoint) => {
    const root = tempRoot();
    const sessionPath = path.join(root, "session.jsonl");
    const home = path.join(root, "home");
    const dir = sessionFilesCacheDir(home, { sessionId: null, sessionPath });
    const source = path.join(root, "source.txt");
    fs.writeFileSync(source, "fixture");
    const getSessionFileBySourceKey = vi.fn(() => {
      expect(fs.existsSync(dir)).toBe(true);
      return { id: "existing", filePath: source, realPath: source, displayName: "source.txt", filename: "source.txt", storageKind: "managed_cache" };
    });
    const registerSessionFile = vi.fn();
    const app = makeApp({ hanakoHome: home, getSessionFileBySourceKey, registerSessionFile });
    const body = endpoint === "upload" ? { paths: [source], sessionPath } : { ...blob, sessionPath };
    const response = await request(app, endpoint, body);
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(getSessionFileBySourceKey).toHaveBeenCalledOnce();
    expect(data.uploads[0].fileId).toBe("existing");
    expect(registerSessionFile).not.toHaveBeenCalled();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it.each(["upload", "upload-blob"])("%s leaves the written bytes when registration fails", async (endpoint) => {
    const root = tempRoot();
    const home = path.join(root, "home");
    const source = path.join(root, "source.txt");
    fs.writeFileSync(source, "fixture");
    const sessionPath = path.join(root, "session.jsonl");
    const registerSessionFile = vi.fn(() => { throw new Error("registration failed"); });
    const app = makeApp({ hanakoHome: home, registerSessionFile });
    const body = endpoint === "upload" ? { paths: [source], sessionPath } : { ...blob, sessionPath };
    const response = await request(app, endpoint, body);
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.uploads[0].error).toBe("registration failed");
    expect(registerSessionFile).toHaveBeenCalledOnce();
    const dir = sessionFilesCacheDir(home, { sessionId: null, sessionPath });
    const names = fs.readdirSync(dir);
    expect(names).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, names[0]), "utf8")).toBe("fixture");
  });

  it.each([["upload", true], ["upload", false], ["upload-blob", true], ["upload-blob", false]])("%s stops before registration when mkdir fails (session=%s)", async (endpoint, session) => {
    const root = tempRoot();
    const home = path.join(root, "not-a-directory");
    fs.writeFileSync(home, "fixture");
    const source = path.join(root, "source.txt");
    fs.writeFileSync(source, "fixture");
    const registerSessionFile = vi.fn();
    const getSessionFileBySourceKey = vi.fn();
    const app = makeApp({ hanakoHome: home, registerSessionFile, getSessionFileBySourceKey });
    const sessionData = session ? { sessionPath: "/fixture/session" } : {};
    const body = endpoint === "upload" ? { paths: [source], ...sessionData } : { ...blob, ...sessionData };
    const response = await request(app, endpoint, body);
    expect(response.status).toBe(500);
    expect(registerSessionFile).not.toHaveBeenCalled();
    expect(getSessionFileBySourceKey).not.toHaveBeenCalled();
    expect(fs.readFileSync(source, "utf8")).toBe("fixture");
    expect(fs.readFileSync(home, "utf8")).toBe("fixture");
  });
});
