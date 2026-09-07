/**
 * server-lifecycle.cjs — desktop 端 server 启动失败诊断的纯函数集合
 *
 * 这些函数从 main.cjs 抽出来便于独立单测：
 * - formatPortInUseStartupError: 把 PORT_IN_USE 结构化对象转成人类可读字符串
 * - buildLaunchFailureDialogDetail: 拼最终展示给用户的 launch 失败 detail
 */

function formatPortInUseStartupError(conflict) {
  const host = conflict?.host || "unknown";
  const port = conflict?.port ?? "unknown";
  const networkMode = conflict?.networkMode || "unknown";
  const suggestions = Array.isArray(conflict?.suggestions) && conflict.suggestions.length
    ? `\n\n${conflict.suggestions.map(item => `- ${item}`).join("\n")}`
    : "";
  return `PORT_IN_USE: ${host}:${port} is already in use (network mode: ${networkMode}).${suggestions}`;
}

function buildLaunchFailureDialogDetail({ err, crashInfo, serverLogs = [], extractRootServerStartupError }) {
  const structuredPortConflict = err?.startupError?.code === "PORT_IN_USE"
    ? formatPortInUseStartupError(err.startupError)
    : null;
  const staleServerError = err?.code === "STALE_SERVER_UNCLEANED" ? err.message : null;
  const rootServerError = structuredPortConflict
    || staleServerError
    || (typeof extractRootServerStartupError === "function" ? extractRootServerStartupError(serverLogs) : null);
  const tail = crashInfo.length > 800 ? "...\n" + crashInfo.slice(-800) : crashInfo;
  if (!rootServerError) return tail;
  if (tail.trimStart().startsWith(rootServerError)) return tail;
  return `${rootServerError}\n\n${tail}`;
}

module.exports = {
  buildLaunchFailureDialogDetail,
  formatPortInUseStartupError,
};
