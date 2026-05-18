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

interface BrowserServerConnectionPrincipal {
  kind?: string | null;
  credentialKind?: string | null;
  connectionKind?: string | null;
  trustState?: string | null;
  serverId?: string | null;
  serverNodeId?: string | null;
  userId?: string | null;
  studioId?: string | null;
  platformAccountId?: string | null;
  officialServiceKind?: string | null;
  scopes?: string[] | null;
}

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

export function createBrowserServerConnection({
  identity,
  principal,
  origin = typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1',
}: {
  identity: ServerIdentity;
  principal?: BrowserServerConnectionPrincipal | null;
  origin?: string;
}): ServerConnection {
  const base = trimTrailingSlash(origin);
  const parsed = new URL(base);
  const wsProtocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProtocol}//${parsed.host}`;
  const kind = normalizeBrowserConnectionKind(
    principal?.connectionKind || identity.connectionKind,
    parsed.hostname,
  );
  const credentialKind = normalizeBrowserCredentialKind(principal?.credentialKind, kind);
  const trustState = normalizeBrowserTrustState(principal?.trustState || identity.trustState, kind);
  const officialServiceKind = normalizeOfficialServiceKind(identity.officialServiceKind ?? principal?.officialServiceKind);
  const platformAccountId = identity.platformAccountId ?? principal?.platformAccountId ?? null;
  const connection: ServerConnection = {
    connectionId: `browser:${identity.serverId || principal?.serverId || parsed.host}`,
    kind,
    serverId: identity.serverId || principal?.serverId || parsed.host,
    serverNodeId: identity.serverNodeId || principal?.serverNodeId || identity.serverId || principal?.serverId || parsed.host,
    serverNodeKind: identity.serverNodeKind,
    serverNodeTransport: identity.serverNodeTransport,
    userId: principal?.userId || identity.userId,
    studioId: identity.studioId || principal?.studioId || 'default',
    label: identity.label || identity.studioLabel || 'Hana Studio',
    userLabel: identity.userLabel,
    studioLabel: identity.studioLabel,
    serverVersion: identity.version,
    baseUrl: base,
    wsUrl,
    token: null,
    authState: principal?.kind === 'account_user' ? 'user' : (identity.authState || 'paired'),
    trustState,
    credentialKind,
    platformAccountId,
    officialServiceKind,
    executionBoundary: identity.executionBoundary,
    capabilities: normalizeBrowserCapabilities(identity.capabilities, principal?.scopes),
  };
  validateStudioConnectionTrust(connection);
  return connection;
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

function normalizeBrowserConnectionKind(
  value: StudioConnectionKind | string | null | undefined,
  hostname: string,
): StudioConnectionKind {
  if (value === 'local' || value === 'lan' || value === 'custom_remote' || value === 'relay' || value === 'cloud') {
    if (value === 'local' && !isLoopbackHost(hostname)) return 'lan';
    return value;
  }
  return isLoopbackHost(hostname) ? 'local' : 'lan';
}

function normalizeBrowserTrustState(
  value: ServerTrustState | string | null | undefined,
  kind: StudioConnectionKind,
): ServerTrustState {
  if (kind === 'local') return 'local';
  if (kind === 'lan') return 'lan';
  if (kind === 'custom_remote' || kind === 'relay') return 'tunnel';
  if (kind === 'cloud') return 'cloud';
  if (value === 'local' || value === 'lan' || value === 'tunnel' || value === 'cloud') return value;
  return 'lan';
}

function normalizeBrowserCredentialKind(
  value: string | null | undefined,
  kind: StudioConnectionKind,
): ConnectionCredentialKind {
  if (kind === 'local') return 'loopback_token';
  if (value === 'password' || value === 'user_session') return 'user_session';
  if (kind === 'relay' || kind === 'cloud') return 'user_session';
  return 'device_credential';
}

function normalizeOfficialServiceKind(value: string | null | undefined): OfficialServiceKind | null {
  if (value === 'relay' || value === 'cloud_studio' || value === 'inference' || value === 'billing') return value;
  return null;
}

function normalizeBrowserCapabilities(
  identityCapabilities: string[] | null | undefined,
  scopes: string[] | null | undefined,
): string[] {
  const out = new Set(identityCapabilities?.length ? identityCapabilities : LOCAL_CAPABILITIES);
  for (const scope of scopes || []) {
    if (scope === 'chat') out.add('chat');
    else if (scope === 'resources' || scope.startsWith('resources.')) out.add('resources');
    else if (scope === 'files' || scope.startsWith('files.')) out.add('files');
    else if (scope === 'tools' || scope.startsWith('tools.')) out.add('tools');
  }
  return [...out];
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
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
