/** 将 OpenHanako agentId 转为 .xingye 下的目录名（不含路径遍历字符）。 */
export function sanitizeAgentIdForPath(agentId: string): string {
  return agentId.replace(/[^a-zA-Z0-9-_]/g, '_').slice(0, 120) || 'agent';
}
