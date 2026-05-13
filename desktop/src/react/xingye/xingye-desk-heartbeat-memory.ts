/**
 * 仅内存：记录小手机首页「立即巡检」最近一次接口结果摘要，供日记草稿等 prompt 可选引用。
 * 不写 localStorage / 不写事件日志；刷新即丢失（符合「如已有」的弱提示语义）。
 */

const lastByAgent = new Map<string, { line: string; recordedAt: string }>();

export function rememberDeskHeartbeatUiOutcome(agentId: string, line: string): void {
  const aid = agentId.trim();
  const text = line.replace(/\s+/g, ' ').trim();
  if (!aid || !text) return;
  lastByAgent.set(aid, { line: text.slice(0, 600), recordedAt: new Date().toISOString() });
}

export function peekDeskHeartbeatUiOutcome(agentId: string): string | null {
  const row = lastByAgent.get(agentId.trim());
  return row?.line ?? null;
}
