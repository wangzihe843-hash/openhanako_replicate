import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildDevWebClientConfig,
  buildDevWebPreviewUrl,
  normalizeServerInfoForDevWeb,
  resolveViteCommand,
} from "../scripts/dev-web-runtime.js";

describe("dev-web runtime helpers", () => {
  it("normalizes server-info into the client config injected into Vite", () => {
    const serverInfo = normalizeServerInfoForDevWeb({
      port: 4567,
      token: "dev-token",
    });

    expect(buildDevWebClientConfig(serverInfo, { clientPort: 5173 })).toEqual({
      serverPort: "5173",
      apiBaseUrl: "http://127.0.0.1:5173",
    });
  });

  it("rejects incomplete server-info instead of guessing a browser connection", () => {
    expect(() => normalizeServerInfoForDevWeb({ port: 4567 }))
      .toThrow("server-info token is required for dev-web");
    expect(() => normalizeServerInfoForDevWeb({ token: "dev-token" }))
      .toThrow("server-info port is required for dev-web");
  });

  it("builds the local browser URL without leaking the owner token into the address bar", () => {
    expect(buildDevWebPreviewUrl({ host: "127.0.0.1", port: 5173 }))
      .toBe("http://127.0.0.1:5173/index.html");
  });

  it.each([
    ["darwin", "/repo"],
    ["linux", "/workspace/Open Hanako"],
    ["darwin", "/workspace/花子 (dev) & friends"],
    ["win32", "C:\\repo"],
    ["win32", "C:\\Projects\\Open Hanako"],
    ["win32", "C:\\用户\\花子 (dev) & 100% ^ ! '"],
    ["win32", "\\\\server\\shared projects\\花子"],
  ])("resolves the JS CLI as a literal path for %s: %s", (platform, root) => {
    const paths = platform === "win32" ? path.win32 : path.posix;
    expect(resolveViteCommand(root, { platform }))
      .toBe(paths.join(root, "node_modules", "vite", "bin", "vite.js"));
  });

  it("targets the installed Vite package's declared CLI without importing it", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const packageDir = path.join(root, "node_modules", "vite");
    const metadata = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
    const cli = resolveViteCommand(root);
    expect(cli).toBe(path.join(packageDir, metadata.bin.vite));
    expect(fs.statSync(cli).isFile()).toBe(true);
  });
});
