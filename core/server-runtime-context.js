import { loadServerIdentity } from "./server-identity.js";

const LOCAL_CAPABILITIES = ["chat", "resources", "tools"];

function clonePlain(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function createServerRuntimeContext({ hanakoHome, appVersion = "?" }) {
  const identity = loadServerIdentity(hanakoHome);
  return deepFreeze({
    schemaVersion: 1,
    serverId: identity.serverId,
    userId: identity.userId,
    studioId: identity.studioId,
    label: identity.label,
    userLabel: identity.userLabel,
    studioLabel: identity.studioLabel,
    userKind: identity.userKind,
    studioKind: identity.studioKind,
    membershipModel: identity.membershipModel,
    storage: clonePlain(identity.storage),
    connectionKind: "local",
    authState: "paired",
    trustState: "local",
    credentialKind: "loopback_token",
    platformAccountId: null,
    officialServiceKind: null,
    capabilities: [...LOCAL_CAPABILITIES],
    appVersion,
  });
}

export function toServerIdentityResponse(runtimeContext, { appVersion } = {}) {
  return {
    connectionKind: runtimeContext.connectionKind,
    serverId: runtimeContext.serverId,
    userId: runtimeContext.userId,
    studioId: runtimeContext.studioId,
    label: runtimeContext.label,
    userLabel: runtimeContext.userLabel,
    studioLabel: runtimeContext.studioLabel,
    trustState: runtimeContext.trustState,
    authState: runtimeContext.authState,
    credentialKind: runtimeContext.credentialKind,
    platformAccountId: runtimeContext.platformAccountId ?? null,
    officialServiceKind: runtimeContext.officialServiceKind ?? null,
    capabilities: [...runtimeContext.capabilities],
    version: appVersion || runtimeContext.appVersion || "?",
  };
}
