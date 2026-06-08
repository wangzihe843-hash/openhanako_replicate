import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  APP_USER_MODEL_ID,
  windowIconOpts,
  titleBarOpts,
} = require("../desktop/src/shared/window-chrome.cjs");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

function readIcoEntries(filePath) {
  const buf = fs.readFileSync(filePath);
  const reserved = buf.readUInt16LE(0);
  const type = buf.readUInt16LE(2);
  const count = buf.readUInt16LE(4);

  expect(reserved).toBe(0);
  expect(type).toBe(1);

  return Array.from({ length: count }, (_, i) => {
    const offset = 6 + i * 16;
    const width = buf[offset] || 256;
    const height = buf[offset + 1] || 256;
    const bitDepth = buf.readUInt16LE(offset + 6);
    const size = buf.readUInt32LE(offset + 8);
    const imageOffset = buf.readUInt32LE(offset + 12);
    const png = buf.subarray(imageOffset, imageOffset + size);

    return {
      width,
      height,
      bitDepth,
      pngColorType: png.subarray(1, 4).toString("ascii") === "PNG" ? png[25] : null,
    };
  });
}

describe("Windows icon contract", () => {
  it("uses the app ICO for Windows packaging and installer surfaces", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));

    expect(pkg.build.win.icon).toBe("desktop/src/icon.ico");
    expect(pkg.build.nsis.installerIcon).toBe("desktop/src/icon.ico");
    expect(pkg.build.nsis.uninstallerIcon).toBe("desktop/src/icon.ico");
    expect(pkg.build.files).toContain("desktop/src/**/*.{html,icns,ico,png,svg,json}");
    expect(pkg.scripts["dist:win"]).toContain("npm run generate:windows-icon");
  });

  it("keeps Windows app icon layers transparent for rounded taskbar rendering", () => {
    const entries = readIcoEntries(path.join(ROOT, "desktop", "src", "icon.ico"));
    const sizes = entries.map((entry) => entry.width).sort((a, b) => b - a);

    expect(sizes).toEqual([256, 128, 64, 48, 32, 24, 16]);
    for (const entry of entries) {
      expect(entry.width).toBe(entry.height);
      expect(entry.bitDepth).toBe(32);
      expect(entry.pngColorType).toBe(6);
    }
  });

  it("APP_USER_MODEL_ID matches the Windows taskbar identity grouped under com.hanako.app", () => {
    expect(APP_USER_MODEL_ID).toBe("com.hanako.app");
    // Cross-check: package.json build.appId must agree
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));
    expect(pkg.build.appId).toBe(APP_USER_MODEL_ID);
  });

  it("windowIconOpts returns the platform-specific Windows .ico for win32", () => {
    const win = windowIconOpts({ desktopDir: "/fake/desktop", platform: "win32" });
    expect(win.icon).toMatch(/icon\.ico$/);
    expect(win.icon).toContain(path.join("/fake/desktop", "src"));

    const linux = windowIconOpts({ desktopDir: "/fake/desktop", platform: "linux" });
    expect(linux.icon).toMatch(/icon\.png$/);

    const mac = windowIconOpts({ desktopDir: "/fake/desktop", platform: "darwin" });
    expect(mac).toEqual({}); // mac 不通过 BrowserWindow option 设 icon
  });

  it("titleBarOpts uses hiddenInset only on macOS and never injects an icon", () => {
    const mac = titleBarOpts({ trafficLight: { x: 12, y: 12 }, platform: "darwin" });
    expect(mac.titleBarStyle).toBe("hiddenInset");
    expect(mac.trafficLightPosition).toEqual({ x: 12, y: 12 });
    expect(mac.icon).toBeUndefined();

    const win = titleBarOpts({ platform: "win32" });
    expect(win.frame).toBe(false);
    expect(win.icon).toBeUndefined(); // 关键：title bar 不该带 icon，icon 由 BrowserWindow.icon 走 windowIconOpts
    expect(win.titleBarStyle).toBeUndefined();
  });

  it("separates app window icon from tray icon and sets Windows taskbar identity (call-site grep)", () => {
    const main = fs.readFileSync(path.join(ROOT, "desktop", "main.cjs"), "utf-8");

    expect(main).toContain("app.setAppUserModelId");
    expect(main).toContain("APP_USER_MODEL_ID"); // 从模块 import
    expect(main).toContain('"tray.ico"');        // tray 仍在 main.cjs 里硬编码
    // 防御反向：tray.ico 不应该出现在 titleBarOpts 返回的对象里（titleBarOpts 现在只返 frame/titleBarStyle/icon-from-windowIconOpts）
    expect(main).not.toMatch(/titleBarOpts[\s\S]*?"tray\.ico"[\s\S]*?return\s+\{\s*frame:\s*false,\s*icon:/);
  });
});
