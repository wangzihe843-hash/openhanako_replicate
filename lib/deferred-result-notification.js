function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function unescapeXml(str) {
  return String(str)
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

function parseAttrs(rawAttrs) {
  const attrs = {};
  const re = /([a-zA-Z0-9:_-]+)="([^"]*)"/g;
  let match;
  while ((match = re.exec(rawAttrs || ""))) {
    attrs[match[1]] = unescapeXml(match[2]);
  }
  return attrs;
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

export function parseDeferredResultNotification(content) {
  const text = contentToText(content).trim();
  const match = /^<hana-background-result\b([^>]*)>([\s\S]*?)<\/hana-background-result>$/.exec(text);
  if (!match) return null;

  const attrs = parseAttrs(match[1]);
  const taskId = attrs["task-id"] || attrs.taskId || null;
  const status = attrs.status || null;
  if (!taskId || !status) return null;

  const body = unescapeXml(match[2] || "").trim();
  const parsed = {
    taskId,
    status,
    type: attrs.type || "background-task",
  };

  if (status === "success") {
    try {
      parsed.result = body ? JSON.parse(body) : null;
    } catch {
      parsed.result = body;
    }
  } else {
    parsed.reason = body;
  }

  return parsed;
}
