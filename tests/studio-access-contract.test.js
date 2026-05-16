import { describe, expect, it } from "vitest";

import {
  deriveStudioAccessGrant,
  getStudioConnectionProfile,
  validateStudioConnectionTrust,
} from "../shared/studio-access-contract.js";

function localConnection(patch = {}) {
  return {
    connectionId: "local",
    kind: "local",
    serverId: "local",
    userId: null,
    studioId: "local",
    baseUrl: "http://127.0.0.1:3210",
    wsUrl: "ws://127.0.0.1:3210",
    token: "local-token",
    authState: "paired",
    trustState: "local",
    credentialKind: "loopback_token",
    platformAccountId: null,
    officialServiceKind: null,
    capabilities: ["chat", "resources", "tools"],
    ...patch,
  };
}

describe("shared trusted studio access contract", () => {
  it("keeps relay as a forwarding profile for user-owned server data", () => {
    expect(getStudioConnectionProfile("relay")).toMatchObject({
      transport: "official_relay",
      credentialKinds: ["user_session"],
      requiresDevicePairing: true,
      requiresPlatformAccount: true,
      dataOwner: "user_server",
      officialServiceKind: "relay",
    });
  });

  it("keeps cloud as the only profile whose data owner is the hosted cloud studio", () => {
    expect(getStudioConnectionProfile("cloud")).toMatchObject({
      transport: "official_cloud",
      credentialKinds: ["user_session"],
      requiresDevicePairing: false,
      requiresPlatformAccount: true,
      dataOwner: "hana_cloud_studio",
      officialServiceKind: "cloud_studio",
    });
  });

  it("rejects local connections that drift away from loopback transport", () => {
    expect(() => validateStudioConnectionTrust(localConnection({
      baseUrl: "https://hana.example",
    }))).toThrow("local connection must use loopback baseUrl and wsUrl");
  });

  it("does not grant desktop-only local file access through a relay connection", () => {
    const relay = localConnection({
      connectionId: "relay:phone",
      kind: "relay",
      serverId: "server_relay",
      userId: "user_relay",
      studioId: "studio_relay",
      baseUrl: "https://relay.hana.example",
      wsUrl: "wss://relay.hana.example",
      token: "relay-session-token",
      trustState: "tunnel",
      credentialKind: "user_session",
      platformAccountId: "acct_relay",
      officialServiceKind: "relay",
    });

    expect(deriveStudioAccessGrant(relay)).toMatchObject({
      grantId: "access:relay:phone:studio_relay",
      scope: {
        serverId: "server_relay",
        userId: "user_relay",
        studioId: "studio_relay",
      },
      capabilities: [
        "chat",
        "resources.read",
        "tools.run",
      ],
    });
  });
});
