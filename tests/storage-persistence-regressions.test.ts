import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import { InputDraftsStore } from "../core/input-drafts-store.ts";
import { writePinnedMemoryItems } from "../lib/memory/pinned-memory-store.ts";
import { createDataEpochCheckpointProvider } from "../core/data-epoch-checkpoint-provider.ts";
import { PERSISTENT_STORES } from "../shared/persistence/store-registry.ts";
import { FileHistoryService } from "../lib/file-history/file-history-service.ts";
import { createFileHistoryRoute } from "../server/routes/file-history.ts";
import { MAX_SNAPSHOT_BYTES } from "../lib/file-history/text-file-policy.ts";

const dirs: string[] = [];
const services: FileHistoryService[] = [];
function temp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "storage-regression-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const service of services.splice(0)) await service.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

it("B02 preserves corrupt bytes and retries quarantine instead of publishing empty cache", () => {
  const home = temp(), file = path.join(home, "input-drafts.v1.json");
  const original = "{ recoverable draft bytes";
  fs.writeFileSync(file, original);
  const rename = fs.renameSync;
  const fail = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (String(from) === file) throw Object.assign(new Error("quarantine denied"), { code: "EPERM" });
    return rename(from, to);
  });
  const store = new InputDraftsStore({ hanakoHome: home });
  expect(() => store.getAll("electron")).toThrow("quarantine denied");
  expect(() => store.setHome("electron", { text: "new draft" })).toThrow("quarantine denied");
  expect(fs.readFileSync(file, "utf8")).toBe(original);
  fail.mockRestore();
  store.setHome("electron", { text: "new draft" });
  const evidence = fs.readdirSync(home).find(name => name.includes(".corrupt-"))!;
  expect(fs.readFileSync(path.join(home, evidence), "utf8")).toBe(original);
  expect(new InputDraftsStore({ hanakoHome: home }).getAll("electron").home.text).toBe("new draft");
});

it("B04 captures the actual pinned entity file including IDs and timestamps", async () => {
  const home = temp(), agentDir = path.join(home, "agents", "audit");
  const items = [{ id: "stable-pin", content: "Keep entity metadata", createdAt: "2026-09-09T00:00:00.000Z" }];
  writePinnedMemoryItems(agentDir, items);
  fs.mkdirSync(path.join(agentDir, "memory", "daily"), { recursive: true });
  const markers = ["reset.json", "longterm.md.fingerprint", "daily/2026-09-09.md.fingerprint"];
  for (const name of markers) fs.writeFileSync(path.join(agentDir, "memory", name), "retained-marker");
  const provider = createDataEpochCheckpointProvider({ stores: PERSISTENT_STORES });
  const receipt = await provider.create({
    homeDir: home, fromEpoch: 1, toEpoch: 2, transitionId: "pins",
    affectedStoreIds: ["agent-memory"],
  });
  const captured = path.join(home, "data-epoch-checkpoints", "pins", "stores", "agent-memory", "agents", "audit", "pinned-memory.json");
  expect(fs.existsSync(captured)).toBe(true);
  expect(fs.readFileSync(captured)).toEqual(fs.readFileSync(path.join(agentDir, "pinned-memory.json")));
  expect(JSON.parse(fs.readFileSync(captured, "utf8")).items).toEqual(items);
  for (const name of markers) {
    expect(fs.readFileSync(path.join(path.dirname(captured), "memory", name), "utf8")).toBe("retained-marker");
  }
  await expect(provider.verify(receipt)).resolves.toBeUndefined();
});

it("B04 waits for hashed file handles to close before publishing the checkpoint", async () => {
  const home = temp();
  writePinnedMemoryItems(path.join(home, "agents", "audit"), [{ id: "pin", content: "Pinned", createdAt: "2026-09-09T00:00:00Z" }]);
  const open = new Set<PassThrough>();
  vi.spyOn(fs, "createReadStream").mockImplementation((file) => {
    const stream = new PassThrough({ autoDestroy: false });
    open.add(stream);
    stream.once("close", () => open.delete(stream));
    setTimeout(() => {
      stream.end(fs.readFileSync(file));
      // Model end-before-close without relying on a particular Windows timing.
      setTimeout(() => stream.destroy(), 10);
    }, 0);
    return stream as unknown as fs.ReadStream;
  });
  const rename = fsp.rename;
  vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
    expect(open.size, "hash readers must be closed before directory rename").toBe(0);
    return rename(from, to);
  });
  const provider = createDataEpochCheckpointProvider({ stores: PERSISTENT_STORES });
  try {
    await provider.create({ homeDir: home, fromEpoch: 1, toEpoch: 2, transitionId: "closed-handles", affectedStoreIds: ["agent-memory"] });
  } finally {
    for (const stream of open) stream.destroy();
  }
});

async function historyFixture() {
  const home = temp(), workspace = path.join(home, "workspace");
  fs.mkdirSync(workspace);
  const file = path.join(workspace, "note.md");
  fs.writeFileSync(file, "V1");
  const service = new FileHistoryService({
    historyRoot: path.join(home, "history"), debounceMs: 100,
    createWatcher: (() => ({ close: async () => {} })) as any,
  });
  services.push(service);
  await service.syncWorkspaces([workspace]);
  await service.waitForIdle();
  const snapshotId = service.listVersions(workspace, "note.md")[0].id;
  const resource = { kind: "local-file", path: file };
  const changed = () => service.handleResourceEvent({ type: "resource.changed", resource });
  const write = vi.fn(async (_ref, content) => { await fsp.writeFile(file, content); changed(); });
  const app = new Hono().route("/api", createFileHistoryRoute({
    getExplicitHomeCwd: () => workspace, getFileHistoryService: () => service,
    getResourceIO: () => ({ write }),
  }));
  const restore = () => app.request("/api/file-history/restore", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentId: "audit", snapshotId }),
  });
  fs.writeFileSync(file, "V2");
  changed();
  return { service, workspace, file, write, restore };
}

it("B05 preserves V2 when V1 is restored inside the debounce window", async () => {
  const f = await historyFixture();
  expect((await f.restore()).status).toBe(200);
  await f.service.waitForIdle();
  const contents = f.service.listVersions(f.workspace, "note.md")
    .map(v => f.service.getSnapshotContent(f.workspace, v.id).content.toString());
  expect(contents).toContain("V2");
  expect(contents).toContain("V1");
  expect(fs.readFileSync(f.file, "utf8")).toBe("V1");
});

it("B05 refuses overwrite if the pre-restore snapshot cannot be stored", async () => {
  const f = await historyFixture();
  const store = f.service._entries.get(path.resolve(f.workspace))!.store;
  vi.spyOn(store, "recordSnapshot").mockImplementation(() => { throw new Error("history storage full"); });
  expect((await f.restore()).status).toBe(500);
  expect(f.write).not.toHaveBeenCalled();
  expect(fs.readFileSync(f.file, "utf8")).toBe("V2");
});

it("B05 refuses overwrite if current file bytes cannot be read", async () => {
  const f = await historyFixture();
  vi.spyOn(fsp, "readFile").mockRejectedValue(Object.assign(new Error("read denied"), { code: "EACCES" }));
  expect((await f.restore()).status).toBe(500);
  expect(f.write).not.toHaveBeenCalled();
  expect(fs.readFileSync(f.file, "utf8")).toBe("V2");
});

it("B05 rejects oversized preimages rather than treating a skipped capture as success", async () => {
  const f = await historyFixture();
  fs.writeFileSync(f.file, Buffer.alloc(MAX_SNAPSHOT_BYTES + 1, "x"));
  expect((await f.restore()).status).toBe(500);
  expect(f.write).not.toHaveBeenCalled();
  expect(fs.statSync(f.file).size).toBe(MAX_SNAPSHOT_BYTES + 1);
});

it("B05 can restore a deleted file with no existing bytes to preserve", async () => {
  const f = await historyFixture();
  fs.unlinkSync(f.file);
  expect((await f.restore()).status).toBe(200);
  expect(fs.readFileSync(f.file, "utf8")).toBe("V1");
});

it("B05 reports a failed post-restore capture while keeping the durable preimage", async () => {
  const f = await historyFixture();
  const store = f.service._entries.get(path.resolve(f.workspace))!.store;
  const record = store.recordSnapshot.bind(store);
  vi.spyOn(store, "recordSnapshot").mockImplementation(input => {
    if (input.origin === "restore" && input.opContext !== "before-restore") throw new Error("post-restore capture failed");
    return record(input);
  });
  expect((await f.restore()).status).toBe(500);
  expect(f.write).toHaveBeenCalledTimes(1);
  expect(f.service.listVersions(f.workspace, "note.md").map(v => f.service.getSnapshotContent(f.workspace, v.id).content.toString())).toContain("V2");
});


it("X1 checkpoints contact profile maps under their owning Xingye trees", async () => {
  const home = temp();
  const relativeFiles = ["a", "b"].map(agent => "agents/" + agent + "/xingye/phone/contact-profiles.json");
  for (let index = 0; index < relativeFiles.length; index++) {
    const file = path.join(home, relativeFiles[index]);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ "contact-id": { profile: "Owner " + index } }));
  }
  const descriptor = PERSISTENT_STORES.find(store => store.id === "xingye-state")!;
  expect(descriptor.pathKind).toBe("tree");
  expect(descriptor.checkpointPolicy).toContain("phoneContactProfiles");
  expect(descriptor.checkpointPolicy).toContain("agents/{agentId}/xingye/phone/contact-profiles.json");
  const provider = createDataEpochCheckpointProvider({ stores: PERSISTENT_STORES });
  const receipt = await provider.create({
    homeDir: home, fromEpoch: 1, toEpoch: 2, transitionId: "contact-profiles", affectedStoreIds: ["xingye-state"],
  });
  const checkpoint = path.join(home, "data-epoch-checkpoints", "contact-profiles");
  const metadata = JSON.parse(fs.readFileSync(path.join(checkpoint, "metadata.json"), "utf8"));
  expect(metadata.items.map((item: { relPath: string }) => item.relPath).sort()).toEqual(relativeFiles);
  expect(receipt.itemCount).toBe(2);
  for (const relative of relativeFiles) {
    expect(fs.readFileSync(path.join(checkpoint, "stores", "xingye-state", relative)))
      .toEqual(fs.readFileSync(path.join(home, relative)));
  }
  await expect(provider.verify(receipt)).resolves.toBeUndefined();
});
