import fs from "fs";
import os from "os";
import path from "path";
import YAML from "js-yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("first run default workspace", () => {
  let tmpDir;
  let homeDir;
  let productDir;
  let hanakoHome;
  let homedirSpy;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-first-run-workspace-"));
    homeDir = path.join(tmpDir, "home");
    productDir = path.join(tmpDir, "product");
    hanakoHome = path.join(tmpDir, ".hanako");
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(productDir, { recursive: true });
    fs.writeFileSync(
      path.join(productDir, "config.example.yaml"),
      [
        "agent:",
        "  name: Hanako",
        "  yuan: hanako",
        "user:",
        '  name: ""',
        "models:",
        '  chat: ""',
      ].join("\n"),
      "utf-8",
    );
    homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(homeDir);
  });

  afterEach(() => {
    homedirSpy?.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it("seeds hanako with the desktop OH-WorkSpace, enabled memory, and disabled patrol defaults", async () => {
    const { ensureFirstRun } = await import("../core/first-run.ts");

    ensureFirstRun(hanakoHome, productDir);

    const workspace = path.join(homeDir, "Desktop", "OH-WorkSpace");
    const cfgPath = path.join(hanakoHome, "agents", "hanako", "config.yaml");
    const cfg = YAML.load(fs.readFileSync(cfgPath, "utf-8"));

    expect(fs.statSync(workspace).isDirectory()).toBe(true);
    expect(cfg.desk.home_folder).toBe(workspace);
    expect(cfg.desk.heartbeat_enabled).toBe(false);
    expect(cfg.desk.heartbeat_interval).toBe(31);
    expect(cfg.memory.enabled).toBe(true);
  });

  it("keeps userName as a dynamic identity placeholder for first-run Hanako", async () => {
    fs.mkdirSync(path.join(productDir, "identity-templates"), { recursive: true });
    fs.writeFileSync(
      path.join(productDir, "identity-templates", "hanako.md"),
      "# {{agentName}}\n\n{{userName}}的个人助手。\n",
      "utf-8",
    );
    const { ensureFirstRun } = await import("../core/first-run.ts");

    ensureFirstRun(hanakoHome, productDir);

    const identity = fs.readFileSync(
      path.join(hanakoHome, "agents", "hanako", "identity.md"),
      "utf-8",
    );
    expect(identity).toContain("# {{agentName}}");
    expect(identity).toContain("{{userName}}的个人助手");
    expect(identity).not.toContain("\n\n的个人助手");
  });

  it("repairs a half-initialized default hanako agent directory", async () => {
    fs.mkdirSync(path.join(hanakoHome, "agents", "hanako", "memory"), { recursive: true });
    const { ensureFirstRun } = await import("../core/first-run.ts");

    ensureFirstRun(hanakoHome, productDir);

    const cfgPath = path.join(hanakoHome, "agents", "hanako", "config.yaml");
    const cfg = YAML.load(fs.readFileSync(cfgPath, "utf-8"));
    expect(cfg.agent.name).toBe("Hanako");
    expect(fs.statSync(path.join(hanakoHome, "agents", "hanako", "sessions")).isDirectory()).toBe(true);
  });

  it("ignores reserved scope directories (__shared__/__user__) during startup validation", async () => {
    // __shared__ 是共享礼物库存的存储作用域，__user__ 是用户朋友圈帖的作用域，都不是 agent。
    fs.mkdirSync(path.join(hanakoHome, "agents", "__shared__", "xingye", "gifts"), { recursive: true });
    fs.mkdirSync(path.join(hanakoHome, "agents", "__user__", "xingye"), { recursive: true });
    const { ensureFirstRun } = await import("../core/first-run.ts");

    expect(() => ensureFirstRun(hanakoHome, productDir)).not.toThrow();

    // 默认助手照常播种，保留作用域目录里不应被塞 pinned.md
    expect(fs.existsSync(path.join(hanakoHome, "agents", "hanako", "config.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(hanakoHome, "agents", "__shared__", "pinned.md"))).toBe(false);
    expect(fs.existsSync(path.join(hanakoHome, "agents", "__user__", "pinned.md"))).toBe(false);
  });

  it("fails fast for non-default agent directories without config.yaml", async () => {
    fs.mkdirSync(path.join(hanakoHome, "agents", "custom-agent"), { recursive: true });
    const { ensureFirstRun } = await import("../core/first-run.ts");

    expect(() => ensureFirstRun(hanakoHome, productDir)).toThrow(
      'invalid agent directory "custom-agent": config.yaml missing',
    );
  });
});
