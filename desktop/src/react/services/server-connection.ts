import { validateStudioConnectionTrust } from './studio-access';

export type StudioConnectionKind = 'local' | 'lan' | 'custom_remote' | 'relay' | 'cloud';
export type ServerTrustState = 'local' | 'lan' | 'tunnel' | 'cloud';
export type ServerAuthState = 'anonymous' | 'paired' | 'user' | 'expired';
export type ConnectionCredentialKind = 'none' | 'loopback_token' | 'device_credential' | 'user_session';
export type OfficialServiceKind = 'relay' | 'cloud_studio' | 'inference' | 'billing';
export type ServerConnectionRegistry = Record<string, ServerConnection>;
export type StudioConnection = ServerConnection;
export type StudioConnectionRegistry = ServerConnectionRegistry;

export const LOCAL_CONNECTION_ID = 'local';

export interface ExecutionBoundary {
  schemaVersion: 1;
  boundaryId: string;
  kind: string;
  serverNodeId: string;
  studioId: string;
  workbench?: {
    kind: string;
    root: string | null;
    [key: string]: unknown;
  };
  sandbox?: Record<string, unknown>;
  filesystem?: Record<string, unknown>;
  network?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ServerConnection {
  connectionId: string;
  kind: StudioConnectionKind;
  serverId: string;
  serverNodeId?: string;
  serverNodeKind?: string;
  serverNodeTransport?: string;
  userId?: string;
  studioId: string;
  label: string;
  userLabel?: string;
  studioLabel?: string;
  serverVersion?: string;
  baseUrl: string;
  wsUrl: string;
  token: string | null;
  authState: ServerAuthState;
  trustState: ServerTrustState;
  credentialKind: ConnectionCredentialKind;
  platformAccountId?: string | null;
  officialServiceKind?: OfficialServiceKind | null;
  executionBoundary?: ExecutionBoundary;
  capabilities: string[];
}

export interface ServerIdentity {
  connectionKind?: StudioConnectionKind;
  serverId: string;
  serverNodeId?: string;
  serverNodeKind?: string;
  serverNodeTransport?: string;
  userId?: string;
  studioId: string;
  label: string;
  userLabel?: string;
  studioLabel?: string;
  authState?: ServerAuthState;
  trustState?: ServerTrustState;
  credentialKind?: ConnectionCredentialKind;
  platformAccountId?: string | null;
  officialServiceKind?: OfficialServiceKind | null;
  executionBoundary?: ExecutionBoundary;
  capabilities?: string[];
  version?: string;
}

export interface ServerConnectionSource {
  serverConnections?: ServerConnectionRegistry | null;
  activeServerConnectionId?: string | null;
  activeServerConnection?: ServerConnection | null;
  serverPort?: string | number | null;
  serverToken?: string | null;
}

const LOCAL_CAPABILITIES = ['chat', 'resources', 'files', 'tools'];

function normalizePort(port: string | number | null | undefined): string | null {
  if (port === null || port === undefined) return null;
  const text = String(port).trim();
  if (!text) return null;

  const value = Number(text);
  if (!Number.isInteger(value) || value <= 0 || value > 65535) {
    throw new Error(`invalid local server port: ${text}`);
  }
  return text;
}

function normalizeToken(token: string | null | undefined): string | null {
  if (token === null || token === undefined || token === '') return null;
  return String(token);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function assertRoutePath(path: string): void {
  if (!path.startsWith('/')) {
    throw new Error(`server connection path must start with "/": ${path}`);
  }
}

function appendQueryParam(url: string, key: string, value: string): string {
  const hashIndex = url.indexOf('#');
  const beforeHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : '';
  const sep = beforeHash.includes('?') ? '&' : '?';
  return `${beforeHash}${sep}${encodeURIComponent(key)}=${encodeURIComponent(value)}${hash}`;
}

export function canUseQueryToken(connection: ServerConnection): boolean {
  return connection.kind === 'local' && connection.credentialKind === 'loopback_token';
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const out: Record<string, string> = {};
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers.map(([key, value]) => [key, value]));
  }
  return { ...headers };
}

export function createLocalServerConnection({
  serverPort,
  serverToken,
}: {
  serverPort: string | number | null | undefined;
  serverToken?: string | null;
}): ServerConnection | null {
  const port = normalizePort(serverPort);
  if (!port) return null;

  return {
    connectionId: LOCAL_CONNECTION_ID,
    kind: 'local',
    serverId: 'local',
    studioId: 'local',
    label: 'Local Hana',
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}`,
    token: normalizeToken(serverToken),
    authState: 'paired',
    trustState: 'local',
    credentialKind: 'loopback_token',
    platformAccountId: null,
    officialServiceKind: null,
    capabilities: [...LOCAL_CAPABILITIES],
  };
}

export function refreshLocalServerConnection({
  existingConnection,
  serverPort,
  serverToken,
}: {
  existingConnection?: ServerConnection | null;
  serverPort: string | number | null | undefined;
  serverToken?: string | null;
}): ServerConnection | null {
  const nextTransport = createLocalServerConnection({ serverPort, serverToken });
  if (!nextTransport) return null;
  if (!existingConnection) return nextTransport;

  return {
    ...existingConnection,
    connectionId: LOCAL_CONNECTION_ID,
    kind: 'local',
    baseUrl: nextTransport.baseUrl,
    wsUrl: nextTransport.wsUrl,
    token: nextTransport.token,
    authState: 'paired',
    trustState: 'local',
    credentialKind: 'loopback_token',
    platformAccountId: null,
    officialServiceKind: null,
    capabilities: existingConnection.capabilities.length
      ? [...existingConnection.capabilities]
      : [...nextTransport.capabilities],
  };
}

export function resolveServerConnection(source: ServerConnectionSource): ServerConnection | null {
  if (source.activeServerConnectionId) {
    const registryConnection = source.serverConnections?.[source.activeServerConnectionId];
    if (registryConnection) return registryConnection;
  }
  if (source.activeServerConnection) return source.activeServerConnection;
  return createLocalServerConnection({
    serverPort: source.serverPort,
    serverToken: source.serverToken,
  });
}

export function requireServerConnection(
  source: ServerConnectionSource,
  errorMessage: string,
): ServerConnection {
  const connection = resolveServerConnection(source);
  if (!connection) throw new Error(errorMessage);
  return connection;
}

export function hasServerConnection(source: ServerConnectionSource): boolean {
  return !!resolveServerConnection(source);
}

export function upsertServerConnection(
  registry: ServerConnectionRegistry | null | undefined,
  connection: ServerConnection,
): ServerConnectionRegistry {
  if (!connection.connectionId) {
    throw new Error('server connection requires connectionId');
  }
  validateStudioConnectionTrust(connection);
  return {
    ...(registry ?? {}),
    [connection.connectionId]: connection,
  };
}

export function mergeServerIdentity(
  connection: ServerConnection,
  identity: ServerIdentity,
): ServerConnection {
  const nodeScope = {
    ...(identity.serverNodeId !== undefined ? { serverNodeId: identity.serverNodeId } : {}),
    ...(identity.serverNodeKind !== undefined ? { serverNodeKind: identity.serverNodeKind } : {}),
    ...(identity.serverNodeTransport !== undefined ? { serverNodeTransport: identity.serverNodeTransport } : {}),
    ...(identity.executionBoundary !== undefined ? { executionBoundary: identity.executionBoundary } : {}),
  };
  const next = {
    ...connection,
    kind: identity.connectionKind || connection.kind,
    serverId: identity.serverId,
    ...nodeScope,
    userId: identity.userId,
    studioId: identity.studioId,
    label: identity.label,
    userLabel: identity.userLabel,
    studioLabel: identity.studioLabel,
    serverVersion: identity.version,
    authState: identity.authState || connection.authState,
    trustState: identity.trustState || connection.trustState,
    credentialKind: identity.credentialKind || connection.credentialKind,
    platformAccountId: identity.platformAccountId ?? connection.platformAccountId ?? null,
    officialServiceKind: identity.officialServiceKind ?? connection.officialServiceKind ?? null,
    capabilities: identity.capabilities ? [...identity.capabilities] : [...connection.capabilities],
  };
  validateStudioConnectionTrust(next);
  return next;
}

export function buildConnectionUrl(
  connection: ServerConnection,
  path: string,
  opts: { includeTokenQuery?: boolean } = {},
): string {
  assertRoutePath(path);
  const url = `${trimTrailingSlash(connection.baseUrl)}${path}`;
  if (!opts.includeTokenQuery || !connection.token || !canUseQueryToken(connection)) return url;
  return appendQueryParam(url, 'token', connection.token);
}

export function buildConnectionWsUrl(
  connection: ServerConnection,
  path = '/ws',
): string {
  assertRoutePath(path);
  const url = `${trimTrailingSlash(connection.wsUrl)}${path}`;
  if (!connection.token || !canUseQueryToken(connection)) return url;
  return appendQueryParam(url, 'token', connection.token);
}

export function appendConnectionAuth(
  connection: ServerConnection,
  headers?: HeadersInit,
): Record<string, string> {
  const next = headersToRecord(headers);
  if (connection.token) {
    next.Authorization = `Bearer ${connection.token}`;
  }
  return next;
}
