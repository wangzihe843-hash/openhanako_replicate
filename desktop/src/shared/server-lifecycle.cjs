/**
 * server-lifecycle.cjs — desktop 端 server 启动/复用/失败诊断的纯函数集合
 *
 * 这些函数从 main.cjs 抽出来便于独立单测：
 * - isDesktopOwnedServerInfo: 判 server-info.json 的 owner 是否是 desktop 自己 spawn 的
 * - verifyReusableServerInfo: 通过 /api/health + /api/server/identity 验已存在的 server 是否可复用
 * - formatPortInUseStartupError: 把 PORT_IN_USE 结构化对象转成人类可读字符串
 * - buildLaunchFailureDialogDetail: 拼最终展示给用户的 launch 失败 detail
 */

function isDesktopOwnedServerInfo(info) {
  return info?.ownerKind === "desktop";
}

async function verifyReusableServerInfo(existingInfo, { currentVersion, fetchFn = globalThis.fetch } = {}) {
  const port = Number(existingInfo?.port);
  const token = typeof existingInfo?.token === "string" ? existingInfo.token : "";
  const pid = Number(existingInfo?.pid);
  if (!Number.isInteger(port) || port <= 0 || !token || !Number.isInteger(pid)) {
    return { reusable: false, trusted: false, terminate: false, reason: "invalid server-info shape" };
  }

  const headers = { Authorization: `Bearer ${existingInfo.token}` };
  let health = null;
  let identity = null;
  try {
    const healthRes = await fetchFn(`http://127.0.0.1:${port}/api/health`, {
      headers,
      signal: AbortSignal.timeout(2000),
    });
    if (!healthRes.ok) {
      return { reusable: false, trusted: false, terminate: false, reason: `health returned ${healthRes.status}` };
    }
    health = await healthRes.json().catch(() => null);
  } catch (err) {
    return { reusable: false, trusted: false, terminate: false, reason: `health failed: ${err.message}` };
  }

  try {
    const identityRes = await fetchFn(`http://127.0.0.1:${port}/api/server/identity`, {
      headers,
      signal: AbortSignal.timeout(2000),
    });
    if (!identityRes.ok) {
      return { reusable: false, trusted: false, terminate: false, reason: `identity returned ${identityRes.status}` };
    }
    identity = await identityRes.json().catch(() => null);
  } catch (err) {
    return { reusable: false, trusted: false, terminate: false, reason: `identity failed: ${err.message}` };
  }

  if (!identity || !identity.studioId) {
    return { reusable: false, trusted: false, terminate: false, reason: "identity missing studioId" };
  }

  const healthVersion = health?.version;
  const identityVersion = identity?.version;
  const serverInfoVersion = existingInfo.version;
  const versionMatches = (!serverInfoVersion || serverInfoVersion === currentVersion)
    && (!healthVersion || healthVersion === currentVersion)
    && (!identityVersion || identityVersion === currentVersion);
  if (!versionMatches) {
    return { reusable: false, trusted: true, terminate: true, reason: "version mismatch", health, identity };
  }

  if (existingInfo.studioId && existingInfo.studioId !== identity.studioId) {
    return { reusable: false, trusted: true, terminate: false, reason: "studio identity mismatch", health, identity };
  }

  return { reusable: true, trusted: true, terminate: false, reason: "ok", health, identity };
}

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
  const rootServerError = structuredPortConflict
    || (typeof extractRootServerStartupError === "function" ? extractRootServerStartupError(serverLogs) : null);
  const tail = crashInfo.length > 800 ? "...\n" + crashInfo.slice(-800) : crashInfo;
  if (!rootServerError) return tail;
  if (tail.includes(rootServerError)) return tail;
  return `${rootServerError}\n\n${tail}`;
}

module.exports = {
  buildLaunchFailureDialogDetail,
  formatPortInUseStartupError,
  isDesktopOwnedServerInfo,
  verifyReusableServerInfo,
};
