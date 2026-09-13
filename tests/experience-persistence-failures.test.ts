import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordEntry, rebuildIndex, syncExperienceCategories, listExperienceDocuments } from "../lib/tools/experience.ts";

let root: string;
let dir: string;
let index: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "experience-failure-"));
  dir = path.join(root, "experience");
  index = path.join(root, "experience.md");
  recordEntry(dir, index, "old category", "preserve this entry");
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});
describe("experience persistence errors", () => {
  it("propagates failed category deletion and leaves its contents available for retry", () => {
    const old = listExperienceDocuments(dir)[0];
    vi.spyOn(fs, "unlinkSync").mockImplementation(() => {
      throw Object.assign(new Error("delete denied"), { code: "EACCES" });
    });
    expect(() => syncExperienceCategories(dir, index, new Map())).toThrow("delete denied");
    expect(fs.readFileSync(old.filePath, "utf8")).toContain("preserve this entry");
    expect(fs.readFileSync(index, "utf8")).toContain("old category");
  });
  it("allows deletion to finish when another actor already removed the file", () => {
    const unlink = fs.unlinkSync;
    vi.spyOn(fs, "unlinkSync").mockImplementation(file => {
      unlink(file);
      throw Object.assign(new Error("already removed"), { code: "ENOENT" });
    });
    expect(() => syncExperienceCategories(dir, index, new Map())).not.toThrow();
    expect(fs.readFileSync(index, "utf8")).toBe("");
  });
  it("reports a failure to clear the index instead of silently leaving stale content", () => {
    for (const doc of listExperienceDocuments(dir)) fs.unlinkSync(doc.filePath);
    const write = fs.writeFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementation((...args: Parameters<typeof fs.writeFileSync>) => {
      if (String(args[0]) === index) throw new Error("index write failed");
      return write(...args);
    });
    expect(() => rebuildIndex(dir, index)).toThrow("index write failed");
    expect(fs.readFileSync(index, "utf8")).toContain("old category");
  });
});
