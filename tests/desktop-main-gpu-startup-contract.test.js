import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const MAIN_PATH = path.join(process.cwd(), "desktop", "main.cjs");

describe("desktop main GPU startup contract", () => {
  it("applies GPU startup policy before Electron ready", () => {
    const source = fs.readFileSync(MAIN_PATH, "utf-8");

    const applyIndex = source.indexOf("applyGpuStartupPolicy(app, gpuStartupPolicy");
    const pendingIndex = source.indexOf("markGpuStartupPending({");
    const readyIndex = source.indexOf("app.whenReady()");

    expect(applyIndex).toBeGreaterThan(-1);
    expect(pendingIndex).toBeGreaterThan(-1);
    expect(readyIndex).toBeGreaterThan(-1);
    expect(applyIndex).toBeLessThan(readyIndex);
    expect(pendingIndex).toBeLessThan(readyIndex);
  });

  it("listens for GPU child process exits instead of deprecated GPU crash hooks", () => {
    const source = fs.readFileSync(MAIN_PATH, "utf-8");

    expect(source).toContain('app.on("child-process-gone"');
    expect(source).not.toContain("gpu-process-crashed");
  });

  it("does not bake unsafe GPU recovery switches into startup", () => {
    const source = fs.readFileSync(MAIN_PATH, "utf-8");

    expect(source).not.toContain("disable-software-rasterizer");
    expect(source).not.toContain("disable-gpu-sandbox");
    expect(source).not.toContain("no-sandbox");
  });
});
