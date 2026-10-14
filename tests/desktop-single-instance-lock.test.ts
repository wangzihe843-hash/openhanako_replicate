import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "path";

import {
  configureClientSingleInstance,
  focusExistingWindow,
} from "../desktop/src/shared/single-instance-lock.cjs";

let root: string;
let defaultHome: string;
let devHome: string;
let appData: string;
beforeEach(() => {
  // Keep the raw temp spelling as input, including Windows 8.3 aliases.
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-client-lock-"));
  defaultHome = path.join(root, ".hanako");
  devHome = path.join(root, ".hanako-dev");
  appData = path.join(root, "appdata");
  for (const dir of [defaultHome, devHome, appData]) fs.mkdirSync(dir);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function makeApp({ gotLock = true } = {}) {
  const handlers = new Map();
  return {
    app: {
      getPath: vi.fn((name) => {
        if (name === "appData") return appData;
        return root;
      }),
      setPath: vi.fn(),
      requestSingleInstanceLock: vi.fn(() => gotLock),
      on: vi.fn((event, handler) => handlers.set(event, handler)),
      exit: vi.fn(),
      quit: vi.fn(),
    },
    handlers,
  };
}

describe("desktop client single instance lock", () => {
  it("sets the dev userData namespace before requesting the lock", () => {
    const { app } = makeApp();

    const acquired = configureClientSingleInstance(app, {
      hanakoHome: devHome,
      defaultHome,
      onSecondInstance: vi.fn(),
    });

    expect(acquired).toBe(true);
    expect(app.setPath).toHaveBeenCalledWith(
      "userData",
      path.join(fs.realpathSync.native(appData), "Hanako-dev"),
    );
    expect(app.setPath.mock.invocationCallOrder[0]).toBeLessThan(
      app.requestSingleInstanceLock.mock.invocationCallOrder[0],
    );
    expect(app.requestSingleInstanceLock).toHaveBeenCalledTimes(1);
  });

  it("keeps production in the legacy Electron userData namespace", () => {
    const { app } = makeApp();

    const acquired = configureClientSingleInstance(app, {
      hanakoHome: defaultHome,
      defaultHome,
      onSecondInstance: vi.fn(),
    });

    expect(acquired).toBe(true);
    expect(app.setPath).toHaveBeenCalledWith(
      "userData",
      path.join(fs.realpathSync.native(appData), "Hanako"),
    );
    expect(app.requestSingleInstanceLock).toHaveBeenCalledTimes(1);
  });

  it("exits a duplicate client before registering second-instance handlers", () => {
    const { app } = makeApp({ gotLock: false });

    const acquired = configureClientSingleInstance(app, {
      hanakoHome: defaultHome,
      defaultHome,
      onSecondInstance: vi.fn(),
    });

    expect(acquired).toBe(false);
    expect(app.exit).toHaveBeenCalledWith(0);
    expect(app.quit).not.toHaveBeenCalled();
    expect(app.on).not.toHaveBeenCalledWith("second-instance", expect.any(Function));
  });

  it("brings the primary window forward when a duplicate launch is redirected", () => {
    const { app, handlers } = makeApp();
    const onSecondInstance = vi.fn();

    configureClientSingleInstance(app, {
      hanakoHome: defaultHome,
      defaultHome,
      onSecondInstance,
    });

    handlers.get("second-instance")?.();

    expect(onSecondInstance).toHaveBeenCalledTimes(1);
  });

  it("restores, shows, and focuses a hidden or minimized window", () => {
    const win = {
      isDestroyed: vi.fn(() => false),
      isMinimized: vi.fn(() => true),
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
    };

    expect(focusExistingWindow(win)).toBe(true);
    expect(win.restore).toHaveBeenCalledTimes(1);
    expect(win.show).toHaveBeenCalledTimes(1);
    expect(win.focus).toHaveBeenCalledTimes(1);
  });
});
