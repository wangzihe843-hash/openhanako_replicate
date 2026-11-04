import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUploadRoute } from "../server/routes/upload.ts";
import { SessionFileRegistry, sessionFilesCacheDir, sessionFileSidecarPath } from "../lib/session-files/session-file-registry.ts";

const roots: string[] = [];
function setup(sessionId: string | null = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-byte-owner-"));
  roots.push(root);
  const home = path.join(root, "home");
  const sessionPath = path.join(root, "session.jsonl");
  const registry = new SessionFileRegistry({ getSessionIdForPath: () => sessionId });
  const engine = { hanakoHome: home, getSessionIdForPath: () => sessionId, registerSessionFile: (entry) => registry.registerFile({ ...entry, ...(sessionId ? { sessionId } : {}) }), getSessionFileBySourceKey: (key, opts) => registry.getBySourceKey(key, opts) };
  const app = new Hono();
  app.route("/api", createUploadRoute(engine));
  return { root, home, sessionPath, registry, app };
}
async function post(app, endpoint, body) {
  const response = await app.request(`/api/${endpoint}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  expect(response.status).toBe(200);
  return response.json();
}
const blob = { name: "image.png", mimeType: "image/png", base64Data: Buffer.from("fixture-bytes").toString("base64") };
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("upload bytes on the real filesystem", () => {
  it.each([["upload", false, null], ["upload-blob", false, null], ["upload", true, null], ["upload-blob", true, null], ["upload", true, "session-id"], ["upload-blob", true, "session-id"]])("%s snapshot and storage routing (session=%s, id=%s)", async (endpoint, session, id) => {
    const { root, home, sessionPath, registry, app } = setup(id);
    const source = path.join(root, "source.txt");
    fs.writeFileSync(source, "fixture-bytes");
    const body = { ...(endpoint === "upload" ? { paths: [source] } : blob), ...(session ? { sessionPath } : {}) };
    const result = await post(app, endpoint, body);
    const entry = result.uploads[0];
    const expectedDir = session ? sessionFilesCacheDir(home, { sessionId: id, sessionPath }) : path.join(home, "uploads");
    expect(result.uploadsDir).toBe(expectedDir);
    expect(path.dirname(entry.dest)).toBe(expectedDir);
    expect(fs.readFileSync(entry.dest, "utf8")).toBe("fixture-bytes");
    fs.writeFileSync(source, "changed-source");
    expect(fs.readFileSync(entry.dest, "utf8")).toBe("fixture-bytes");
    if (session) {
      expect(entry.storageKind).toBe("managed_cache");
      expect(registry.get(entry.fileId, { sessionPath }).filePath).toBe(entry.dest);
      expect(fs.existsSync(sessionFileSidecarPath(sessionPath))).toBe(true);
    } else {
      expect(entry.fileId).toBeUndefined();
      expect(fs.existsSync(sessionFileSidecarPath(sessionPath))).toBe(false);
    }
  });
  it.each(["upload", "upload-blob"])("%s reuses a registered source without another byte copy", async (endpoint) => {
    const { root, home, sessionPath, app } = setup();
    const source = path.join(root, "source.txt");
    fs.writeFileSync(source, "fixture-bytes");
    const body = { ...(endpoint === "upload" ? { paths: [source] } : blob), sessionPath };
    const first = (await post(app, endpoint, body)).uploads[0];
    const second = (await post(app, endpoint, body)).uploads[0];
    expect(second.fileId).toBe(first.fileId);
    expect(second.dest).toBe(first.dest);
    expect(fs.readdirSync(sessionFilesCacheDir(home, { sessionId: null, sessionPath }))).toEqual([path.basename(first.dest)]);
  });
  it.each(["upload", "upload-blob"])("%s preserves bytes and in-memory registration if real sidecar rename fails", async (endpoint) => {
    const { root, home, sessionPath, registry, app } = setup();
    const source = path.join(root, "source.txt");
    fs.writeFileSync(source, "fixture-bytes");
    registry.getBySourceKey("initial-hydration", { sessionPath });
    const sidecar = sessionFileSidecarPath(sessionPath);
    fs.mkdirSync(sidecar);
    const body = { ...(endpoint === "upload" ? { paths: [source] } : blob), sessionPath };
    const result = await post(app, endpoint, body);
    expect(result.uploads[0].error).toBeTruthy();
    const dir = sessionFilesCacheDir(home, { sessionId: null, sessionPath });
    const names = fs.readdirSync(dir);
    expect(names).toHaveLength(1);
    const dest = path.join(dir, names[0]);
    expect(fs.readFileSync(dest, "utf8")).toBe("fixture-bytes");
    const entry = registry.getByFilePath(dest, { sessionPath });
    expect(entry.storageKind).toBe("managed_cache");
    expect(fs.readdirSync(root).filter((name) => name.startsWith("session.jsonl.files.json.") && name.endsWith(".tmp"))).toEqual([]);
    fs.rmdirSync(sidecar);
    const reloaded = new SessionFileRegistry();
    expect(reloaded.getByFilePath(dest, { sessionPath })).toBeNull();
    expect(fs.readFileSync(dest, "utf8")).toBe("fixture-bytes");
  });
  it.each([["upload", false], ["upload", true], ["upload-blob", false], ["upload-blob", true]])("%s continues after byte write error (session=%s)", async (endpoint, session) => {
    const { root, home, sessionPath, app } = setup();
    const source1 = path.join(root, "first.txt");
    const source2 = path.join(root, "second.txt");
    fs.writeFileSync(source1, "first");
    fs.writeFileSync(source2, "second");
    const method = endpoint === "upload" ? "copyFile" : "writeFile";
    const original = fs.promises[method].bind(fs.promises);
    vi.spyOn(fs.promises, method).mockImplementationOnce(async () => { throw new Error("byte write failed"); }).mockImplementation(original);
    const body = { ...(endpoint === "upload" ? { paths: [source1, source2] } : { blobs: [blob, { ...blob, name: "second.png", base64Data: Buffer.from("second").toString("base64") }] }), ...(session ? { sessionPath } : {}) };
    const result = await post(app, endpoint, body);
    expect(result.uploads[0].error).toBe("byte write failed");
    expect(result.uploads[1].error).toBeUndefined();
    expect(fs.readFileSync(result.uploads[1].dest, "utf8")).toBe("second");
    const dir = session ? sessionFilesCacheDir(home, { sessionId: null, sessionPath }) : path.join(home, "uploads");
    expect(fs.readdirSync(dir)).toEqual([path.basename(result.uploads[1].dest)]);
  });

});
