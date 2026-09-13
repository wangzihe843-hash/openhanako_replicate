import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readTextFileSnapshot,
  writeTextFileIfUnchanged,
} from "../desktop/file-text-io.cjs";

describe("file-text-io", () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-file-text-io-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(dir));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Unsafe fixture cleanup: ${dir}`);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("I01 preserves original bytes after a partial write fails", () => {
    const filePath = path.join(dir, "note.md");
    fs.writeFileSync(filePath, "original bytes\r\n你好");
    const before = fs.readFileSync(filePath);
    const snapshot = readTextFileSnapshot(filePath);
    const write = fs.writeFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementation((target) => {
      write(target, "bad");
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    });
    expect(() => writeTextFileIfUnchanged(filePath, "replacement text", snapshot.version)).toThrow(/disk full/);
    expect(fs.readFileSync(filePath)).toEqual(before);
    expect(fs.readdirSync(dir)).toEqual(["note.md"]);
  });

  it("I01 preserves original bytes and cleans staging after Windows replacement failure", () => {
    const filePath = path.join(dir, "note.md");
    fs.writeFileSync(filePath, "old");
    const snapshot = readTextFileSnapshot(filePath);
    vi.spyOn(fs, "renameSync").mockImplementation(() => { throw Object.assign(new Error("file in use"), { code: "EPERM" }); });
    expect(() => writeTextFileIfUnchanged(filePath, "new", snapshot.version)).toThrow(/file in use/);
    expect(fs.readFileSync(filePath, "utf8")).toBe("old");
    expect(fs.readdirSync(dir)).toEqual(["note.md"]);
  });

  it("I01 detects an edit occurring during staging before committing", () => {
    const filePath = path.join(dir, "note.md");
    fs.writeFileSync(filePath, "old");
    const snapshot = readTextFileSnapshot(filePath);
    const write = fs.writeFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementation((...args) => {
      write(...args);
      write(filePath, "concurrent edit");
    });
    expect(writeTextFileIfUnchanged(filePath, "new", snapshot.version)).toMatchObject({ ok: false, conflict: true });
    expect(fs.readFileSync(filePath, "utf8")).toBe("concurrent edit");
    expect(fs.readdirSync(dir)).toEqual(["note.md"]);
  });

  it("I01 preserves original bytes if flushing the completed temporary write fails", () => {
    const filePath = path.join(dir, "note.md");
    fs.writeFileSync(filePath, "old");
    const snapshot = readTextFileSnapshot(filePath);
    vi.spyOn(fs, "fsyncSync").mockImplementation(() => { throw new Error("flush failed"); });
    expect(() => writeTextFileIfUnchanged(filePath, "new", snapshot.version)).toThrow(/flush failed/);
    expect(fs.readFileSync(filePath, "utf8")).toBe("old");
    expect(fs.readdirSync(dir)).toEqual(["note.md"]);
  });

  it("I01 preserves UTF-8, BOM, line endings and the file permission mode", () => {
    const filePath = path.join(dir, "note.md");
    fs.writeFileSync(filePath, "old");
    fs.chmodSync(filePath, 0o640);
    const mode = fs.statSync(filePath).mode & 0o777;
    const content = "\ufeff你好\r\nsecond\r\n";
    const result = writeTextFileIfUnchanged(filePath, content, readTextFileSnapshot(filePath).version);
    expect(result).toMatchObject({ ok: true, conflict: false });
    expect(fs.readFileSync(filePath)).toEqual(Buffer.from(content, "utf8"));
    expect(fs.statSync(filePath).mode & 0o777).toBe(mode);
    expect(result.version.sha256).toBe(readTextFileSnapshot(filePath).version.sha256);
  });

  it("I01 supports a new file with no expected version", () => {
    const filePath = path.join(dir, "new.md");
    expect(writeTextFileIfUnchanged(filePath, "created", undefined)).toMatchObject({ ok: true, conflict: false });
    expect(fs.readFileSync(filePath, "utf8")).toBe("created");
    expect(fs.readdirSync(dir)).toEqual(["new.md"]);
  });

  it("I01 treats deletion after the snapshot as a conflict and does not recreate the file", () => {
    const filePath = path.join(dir, "note.md");
    fs.writeFileSync(filePath, "old");
    const snapshot = readTextFileSnapshot(filePath);
    fs.unlinkSync(filePath);
    expect(writeTextFileIfUnchanged(filePath, "new", snapshot.version)).toMatchObject({ ok: false, conflict: true });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("I01 does not replace a symlink used to edit a file", (context) => {
    const filePath = path.join(dir, "note.md");
    const link = path.join(dir, "alias.md");
    fs.writeFileSync(filePath, "old");
    try { fs.symlinkSync(filePath, link, "file"); } catch (error) {
      if (process.platform === "win32" && error.code === "EPERM") { context.skip(); return; }
      throw error;
    }
    const result = writeTextFileIfUnchanged(link, "new", readTextFileSnapshot(link).version);
    expect(result).toMatchObject({ ok: true });
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(filePath, "utf8")).toBe("new");
  });

  it("refuses to overwrite a file that changed after the caller snapshot", () => {
    const filePath = path.join(dir, "note.md");
    fs.writeFileSync(filePath, "version one", "utf-8");
    const snapshot = readTextFileSnapshot(filePath);

    fs.writeFileSync(filePath, "version two", "utf-8");
    const result = writeTextFileIfUnchanged(filePath, "late stale save", snapshot.version);

    expect(result).toMatchObject({ ok: false, conflict: true });
    expect(fs.readFileSync(filePath, "utf-8")).toBe("version two");
  });

  it("writes and returns a new snapshot version when the caller snapshot still matches", () => {
    const filePath = path.join(dir, "note.md");
    fs.writeFileSync(filePath, "version one", "utf-8");
    const snapshot = readTextFileSnapshot(filePath);

    const result = writeTextFileIfUnchanged(filePath, "version two", snapshot.version);

    expect(result).toMatchObject({ ok: true });
    expect(result.version).toEqual(expect.objectContaining({
      mtimeMs: expect.any(Number),
      size: "version two".length,
    }));
    expect(fs.readFileSync(filePath, "utf-8")).toBe("version two");
  });
});
