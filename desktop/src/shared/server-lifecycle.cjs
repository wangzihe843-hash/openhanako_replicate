/** Desktop server startup failure diagnostics shared with the main process. */
const fs = require("node:fs");
const path = require("node:path");
const { readDataEpochStamp } = require("../../../shared/data-epoch.cjs");
const { DATA_EPOCH } = require("../../../shared/contract-versions.cjs");

function formatPortInUseStartupError(conflict) {
  const host = conflict?.host || "unknown";
  const port = conflict?.port ?? "unknown";
  const networkMode = conflict?.networkMode || "unknown";
  const suggestions = Array.isArray(conflict?.suggestions) && conflict.suggestions.length
    ? `\n\n${conflict.suggestions.map(item => `- ${item}`).join("\n")}`
    : "";
  return `PORT_IN_USE: ${host}:${port} is already in use (network mode: ${networkMode}).${suggestions}`;
}

/**
 * Recognizes the machine-readable markers server/index.ts's data-epoch
 * startup gate (core/data-epoch-coordinator.ts's coordinateDataEpochStartup)
 * prints to stderr, ahead of its human-readable text, when it refuses to
 * start. crashInfo is the full crash-log text handed to
 * buildLaunchFailureDialogDetail, which already folds in everything
 * captured from the server child's stdout/stderr (see writeCrashLog).
 */
function detectDataEpochLaunchMarker(crashInfo) {
  if (typeof crashInfo !== "string" || !crashInfo) return null;
  const blocked = crashInfo.match(/HANA_DATA_EPOCH_BLOCKED reason=(\S+)/);
  if (blocked) return { kind: "blocked", reason: blocked[1] };
  const incomplete = crashInfo.match(/HANA_DATA_EPOCH_TRANSITION_INCOMPLETE reason=(\S+)/);
  if (incomplete) return { kind: "incomplete", reason: incomplete[1] };
  return null;
}

/**
 * Counts published, complete data-epoch checkpoints under
 * {homeDir}/data-epoch-checkpoints. This only reads each metadata.json's
 * own `complete` flag for a yes/no "is there something to recover from"
 * signal — it never re-verifies item bytes/hashes (that reconciliation
 * lives solely in core/data-epoch-checkpoint-provider.ts's verify(), which
 * this dialog never calls, matching this slice's "no parallel
 * reconciliation logic" rule). `.tmp-*`/`.invalid-*` siblings are
 * provider-internal staging/quarantine, never a usable checkpoint, and are
 * skipped the same way the provider's own retention pass skips them.
 */
function countAvailableDataEpochCheckpoints(homeDir) {
  const checkpointsRoot = path.join(homeDir, "data-epoch-checkpoints");
  let entries;
  try {
    entries = fs.readdirSync(checkpointsRoot, { withFileTypes: true });
  } catch {
    return 0;
  }
  let count = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.includes(".tmp-") || entry.name.includes(".invalid-")) continue;
    try {
      const metadata = JSON.parse(fs.readFileSync(path.join(checkpointsRoot, entry.name, "metadata.json"), "utf-8"));
      if (metadata && metadata.complete === true) count += 1;
    } catch {
      // 无法解析：不计入可用清单，也不当作错误——半写/GC 中的目录本就不可用
    }
  }
  return count;
}

/**
 * BLOCKED: this kernel's own DATA_EPOCH is below the data directory's
 * stamped minimumReaderEpoch (an older kernel opened data a newer kernel
 * already touched). Every value shown here is re-derived locally through
 * shared/data-epoch.cjs's own read API — never trusted off the wire from
 * the server child's exit, per this slice's "desktop reads stamp/journal
 * only through the CJS API, never raw fs" rule. Unreadable fields degrade
 * to "未知/unknown" rather than guessing or throwing.
 */
function buildDataEpochBlockedDetail(homeDir) {
  const stampRead = readDataEpochStamp(homeDir);
  const stampEpoch = stampRead.status === "ok" ? String(stampRead.stamp.minimumReaderEpoch) : "未知/unknown";
  const lastVersion = stampRead.status === "ok" && stampRead.stamp.lastVersion ? stampRead.stamp.lastVersion : "未知/unknown";
  const checkpointCount = countAvailableDataEpochCheckpoints(homeDir);
  const checkpointTextZh = checkpointCount > 0 ? `有，共 ${checkpointCount} 个` : "无";
  const checkpointTextEn = checkpointCount > 0 ? `Available, ${checkpointCount} found` : "None found";

  return [
    "数据已被更新的版本使用 / Your data was upgraded by a newer version",
    "",
    `本安装能理解的数据纪元：${DATA_EPOCH}`,
    `数据当前纪元：${stampEpoch}`,
    `最后写入数据的版本：${lastVersion}`,
    `可用恢复点：${checkpointTextZh}`,
    "",
    "继续使用这份数据前，你有两条路：",
    "① 安装更新版本（保留全部数据，推荐）",
    "② 使用新版本内的恢复工具回到旧格式（会丢弃升级后产生的改动）",
    "",
    `This installation understands data revision: ${DATA_EPOCH}`,
    `Your data is currently at revision: ${stampEpoch}`,
    `Last written by version: ${lastVersion}`,
    `Recovery point available: ${checkpointTextEn}`,
    "",
    "You have two ways forward:",
    "① Install the newer version (keeps all your data, recommended)",
    "② Use the recovery tool in the newer version to revert to the old format (this discards changes made after the upgrade)",
  ].join("\n");
}

/**
 * TRANSITION_INCOMPLETE: covers every non-"blocked" data-epoch startup
 * refusal (an interrupted migration, or a corrupt stamp/journal — see
 * server/index.ts's HANA_DATA_EPOCH_TRANSITION_INCOMPLETE marker and
 * core/data-epoch-coordinator.ts's DataEpochFailureReason union).
 * Deliberately generic per this slice's spec: none of these states are
 * corruption from the user's point of view, and none of them are safe for
 * an ordinary launch to guess its way through.
 */
function buildDataEpochTransitionIncompleteDetail() {
  return [
    "数据迁移未完成 / A data migration did not finish",
    "",
    "上一次的数据迁移中途被打断，数据现在处于受保护状态，没有发生损坏。",
    "请打开最新版本以继续迁移或使用恢复工具。",
    "",
    "A previous data migration was interrupted partway through. Your data is now in a protected state and has not been corrupted.",
    "Please install the latest version to continue the migration or use the recovery tool.",
  ].join("\n");
}

function buildLaunchFailureDialogDetail({ err, crashInfo, hanakoHome, serverLogs = [], extractRootServerStartupError }) {
  const tail = crashInfo.length > 800 ? "...\n" + crashInfo.slice(-800) : crashInfo;
  const dataEpochMarker = detectDataEpochLaunchMarker(crashInfo);
  if (dataEpochMarker) {
    const specialized = dataEpochMarker.kind === "blocked"
      ? buildDataEpochBlockedDetail(hanakoHome)
      : buildDataEpochTransitionIncompleteDetail();
    return `${specialized}\n\n${tail}`;
  }
  const structuredPortConflict = err?.startupError?.code === "PORT_IN_USE"
    ? formatPortInUseStartupError(err.startupError)
    : null;
  const staleServerError = err?.code === "STALE_SERVER_UNCLEANED" ? err.message : null;
  const foreignServerError = err?.code === "FOREIGN_SERVER_RUNNING" ? err.message : null;
  const rootServerError = structuredPortConflict
    || staleServerError
    || foreignServerError
    || (typeof extractRootServerStartupError === "function" ? extractRootServerStartupError(serverLogs) : null);
  if (!rootServerError) return tail;
  if (tail.trimStart().startsWith(rootServerError)) return tail;
  return `${rootServerError}\n\n${tail}`;
}

module.exports = { buildLaunchFailureDialogDetail, formatPortInUseStartupError };
