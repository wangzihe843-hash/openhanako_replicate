function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatResultNotification(taskId, result, meta) {
  const type = escapeXml(meta?.type || "background-task");
  const body =
    typeof result === "string"
      ? escapeXml(result)
      : escapeXml(JSON.stringify(result, null, 2));
  return `<hana-background-result task-id="${escapeXml(taskId)}" status="success" type="${type}">\n${body}\n</hana-background-result>`;
}

function formatFailNotification(taskId, reason, meta) {
  const type = escapeXml(meta?.type || "background-task");
  return `<hana-background-result task-id="${escapeXml(taskId)}" status="failed" type="${type}">\n${escapeXml(reason)}\n</hana-background-result>`;
}

function formatAbortNotification(taskId, reason, meta) {
  const type = escapeXml(meta?.type || "background-task");
  return `<hana-background-result task-id="${escapeXml(taskId)}" status="aborted" type="${type}">\n${escapeXml(reason || "task was stopped")}\n</hana-background-result>`;
}

export function formatDeferredResultNotification(taskId, task) {
  if (task?.status === "resolved") {
    return formatResultNotification(taskId, task.result, task.meta);
  }
  if (task?.status === "aborted") {
    return formatAbortNotification(taskId, task.reason, task.meta);
  }
  return formatFailNotification(taskId, task?.reason, task?.meta);
}

export function buildDeferredResultMessage(taskId, task) {
  return {
    customType: "hana-background-result",
    content: formatDeferredResultNotification(taskId, task),
    display: false,
  };
}
