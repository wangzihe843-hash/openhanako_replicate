import type { ServerConnection } from '../services/server-connection';

export type SettingsPinsSnapshot = { key: string; pins: string[] };

export function settingsPinsKey(connection: ServerConnection | null | undefined, agentId: string): string {
  return JSON.stringify([connection?.connectionId, connection?.baseUrl, connection?.token, agentId]);
}
