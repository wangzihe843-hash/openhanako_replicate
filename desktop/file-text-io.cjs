const fs = require("fs");
const crypto = require("crypto");
const path = require("path");

const DEFAULT_MAX_TEXT_FILE_BYTES = 5 * 1024 * 1024;

function hashBuffer(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function versionsEqual(a, b) {
  if (!a || !b) return false;
  if (typeof a.sha256 === "string" && typeof b.sha256 === "string") {
    return a.sha256 === b.sha256 && a.size === b.size;
  }
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

function readTextFileSnapshot(filePath, { maxBytes = DEFAULT_MAX_TEXT_FILE_BYTES } = {}) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return null;
  if (stat.size > maxBytes) return null;

  const buf = fs.readFileSync(filePath);
  const sample = buf.subarray(0, 8192);
  if (sample.includes(0)) return null;

  return {
    content: buf.toString("utf-8"),
    version: {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      sha256: hashBuffer(buf),
    },
  };
}

function writeTextFileIfUnchanged(filePath, content, expectedVersion) {
  const conflict = (current) => ({ ok: false, conflict: true, version: current?.version ?? null });
  const snapshotIfPresent = () => {
    try { return readTextFileSnapshot(filePath); } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  };
  if (expectedVersion) {
    const current = snapshotIfPresent();
    if (!current || !versionsEqual(current.version, expectedVersion)) {
      return conflict(current);
    }
  }

  // Resolve a symlink to preserve the old write-through behavior: replacing
  // the link itself would unexpectedly turn it into a regular file.
  let target = path.resolve(filePath);
  let originalStat;
  try {
    target = fs.realpathSync(target);
    originalStat = fs.statSync(target);
    if (!originalStat.isFile()) throw new Error("Expected a regular text file");
    fs.accessSync(target, fs.constants.W_OK);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (expectedVersion) return conflict(null);
    // Do not replace a dangling symlink with a new regular file.
    if (fs.lstatSync(filePath, { throwIfNoEntry: false })?.isSymbolicLink()) throw error;
  }

  const temporary = path.join(path.dirname(target), `.hana-save-${crypto.randomUUID()}.tmp`);
  let fd;
  let created = false;
  try {
    fd = fs.openSync(temporary, "wx", originalStat ? 0o600 : 0o666);
    created = true;
    fs.writeFileSync(fd, content, "utf-8");
    if (originalStat) {
      if (process.platform !== "win32") {
        const stagedStat = fs.fstatSync(fd);
        if (stagedStat.uid !== originalStat.uid || stagedStat.gid !== originalStat.gid) {
          fs.fchownSync(fd, originalStat.uid, originalStat.gid);
        }
      }
      fs.fchmodSync(fd, originalStat.mode & 0o7777);
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    // Read before commit: a failed verification must not report failure only
    // after the original has already been replaced.
    const next = readTextFileSnapshot(temporary);

    if (expectedVersion) {
      const current = snapshotIfPresent();
      if (!current || !versionsEqual(current.version, expectedVersion)) return conflict(current);
    }
    if (originalStat && fs.realpathSync(filePath) !== target) return conflict(snapshotIfPresent());
    // No unlink fallback: if Windows refuses replacement (e.g. an open file),
    // the old bytes must stay intact and the temporary file must be cleaned.
    fs.renameSync(temporary, target);
    created = false;
    return { ok: true, conflict: false, version: next?.version ?? null };
  } finally {
    try { if (fd !== undefined) fs.closeSync(fd); } finally {
      if (created) fs.unlinkSync(temporary);
    }
  }
}

module.exports = {
  readTextFileSnapshot,
  writeTextFileIfUnchanged,
  versionsEqual,
};
