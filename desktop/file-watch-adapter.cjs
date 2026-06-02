const path = require("path");
const chokidar = require("chokidar");

function normalizeFileWatchPath(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function createStableFileWatcher(filePath, options = {}, onChange) {
  if (typeof onChange !== "function") {
    throw new Error("createStableFileWatcher: onChange function required");
  }

  const targetPath = path.resolve(filePath);
  const targetKey = normalizeFileWatchPath(targetPath);
  const parentDir = path.dirname(targetPath);
  const watcher = chokidar.watch(parentDir, {
    ...options,
    ignoreInitial: true,
    atomic: true,
    awaitWriteFinish: false,
    ignorePermissionErrors: true,
    depth: 0,
  });

  watcher.on("all", (eventType, changedPath) => {
    if (!changedPath) return;
    if (normalizeFileWatchPath(changedPath) !== targetKey) return;
    onChange(eventType, targetPath);
  });

  return watcher;
}

module.exports = {
  createStableFileWatcher,
  normalizeFileWatchPath,
};
