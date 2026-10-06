import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");

function runFreshProcess(source: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hana-optional-import-"));
  try {
    return spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
      cwd: home,
      env: {
        ...process.env,
        NODE_OPTIONS: "",
        HANA_HOME: home,
        HOME: home,
        USERPROFILE: home,
        APPDATA: home,
        LOCALAPPDATA: home,
      },
      encoding: "utf8",
      windowsHide: true,
      timeout: 60_000,
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

describe("optional feature dependencies at startup", () => {
  it.each([
    ["lib/bridge/telegram-adapter.ts", "createTelegramAdapter"],
    ["lib/bridge/feishu-adapter.ts", "createFeishuAdapter"],
  ])("imports %s without loading unused feature packages", (relative, entry) => {
    const url = pathToFileURL(path.join(root, relative)).href;
    const result = runFreshProcess(`
      import assert from "node:assert/strict";
      import { registerHooks } from "node:module";
      const optional = ["jsdom", "node-telegram-bot-api", "@larksuiteoapi/node-sdk"];
      function assertNotOptional(specifier) {
        const normalized = specifier.replaceAll(String.fromCharCode(92), "/");
        if (optional.some(name => normalized === name || normalized.startsWith(name + "/")
            || normalized.includes("/node_modules/" + name + "/"))) {
          throw new Error("Unused feature loaded at startup: " + specifier);
        }
      }
      registerHooks({
        resolve(specifier, context, nextResolve) {
          assertNotOptional(specifier);
          const resolved = nextResolve(specifier, context);
          assertNotOptional(resolved.url);
          return resolved;
        },
      });
      const feature = await import(${JSON.stringify(url)});
      assert.equal(typeof feature[${JSON.stringify(entry)}], "function");
      if (feature.resolveFeishuDomain) {
        assert.equal(feature.resolveFeishuDomain("lark_global").domain, "https://open.larksuite.com");
        assert.throws(() => feature.resolveFeishuDomain("invalid"), /unsupported Feishu region/);
      }
      console.log("optional-import-ok");
    `);

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("optional-import-ok");
  });

  it("loads the real bridge SDKs on demand with cached exports and correct region enums", () => {
    const sdkUrl = pathToFileURL(path.join(root, "lib/bridge/optional-sdks.ts")).href;
    const feishuUrl = pathToFileURL(path.join(root, "lib/bridge/feishu-adapter.ts")).href;
    const result = runFreshProcess(`
      import assert from "node:assert/strict";
      import { registerHooks } from "node:module";
      let feishuLoads = 0;
      registerHooks({
        load(url, context, nextLoad) {
          if (url.includes("/node_modules/@larksuiteoapi/node-sdk/")) feishuLoads++;
          return nextLoad(url, context);
        },
      });
      const { loadTelegramSdk, loadFeishuSdk } = await import(${JSON.stringify(sdkUrl)});
      const { resolveFeishuDomain } = await import(${JSON.stringify(feishuUrl)});
      const china = resolveFeishuDomain("feishu_cn");
      const global = resolveFeishuDomain("lark_global");
      assert.equal(china, resolveFeishuDomain());
      assert.equal(china.region, "feishu_cn");
      assert.equal(global.domain, "https://open.larksuite.com");
      assert.equal(feishuLoads, 0);
      const chinaEnum = china.sdkDomain;
      assert.ok(feishuLoads > 0);
      const lark = loadFeishuSdk();
      assert.equal(chinaEnum, lark.Domain.Feishu);
      assert.equal(global.sdkDomain, lark.Domain.Lark);
      assert.equal(typeof lark.Client, "function");
      assert.equal(typeof lark.WSClient, "function");
      assert.equal(loadFeishuSdk(), lark);
      const telegram = loadTelegramSdk();
      assert.equal(typeof telegram, "function");
      assert.equal(loadTelegramSdk(), telegram);
      console.log("optional-use-ok");
    `);

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("optional-use-ok");
  });
});
