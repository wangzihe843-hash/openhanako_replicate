import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserManager } from "../lib/browser/browser-manager.ts";
import { createBrowserTool } from "../lib/tools/browser-tool.ts";

type ActionEntry = { action: string; result: string };
const sessionPath = "/sessions/stop-failure.jsonl";
let home: string;
let manager: BrowserManager;
let tool: ReturnType<typeof createBrowserTool>;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "hana-browser-tool-stop-"));
  fs.mkdirSync(path.join(home, "user"));
  BrowserManager.setHanakoHome(home);
  manager = new BrowserManager();
  manager._setSessionEntry(sessionPath, {
    running: true, activeTabId: "t1",
    tabs: [{ tabId: "t1", url: "https://stop.example.test" }],
  });
  vi.spyOn(manager, "thumbnail").mockResolvedValue(null);
  vi.spyOn(BrowserManager, "instance").mockReturnValue(manager);
  tool = createBrowserTool(() => sessionPath);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

function execute(action: "start" | "stop") {
  return tool.execute(`call-${action}`, { action }, null, null, { sessionPath });
}

function actionLog(result: { details?: object }): ActionEntry[] {
  expect(result.details).toHaveProperty("actionLog");
  return (result.details as { actionLog: ActionEntry[] }).actionLog;
}

describe("browser stop success history", () => {
  it("keeps failure history but records closed only once after a successful retry", async () => {
    const send = vi.spyOn(manager, "_sendCmd")
      .mockRejectedValueOnce(new Error("first close refused"))
      .mockRejectedValueOnce(new Error("second close refused"))
      .mockResolvedValue({});
    await execute("start");

    for (const message of ["first close refused", "second close refused"]) {
      const failed = await execute("stop");
      expect(failed.details).toMatchObject({ running: true, error: expect.stringContaining(message) });
      expect(manager.isRunning(sessionPath)).toBe(true);
    }

    const closed = await execute("stop");
    expect(closed.details).toMatchObject({ status: "closed", running: false });
    expect(actionLog(closed)).toMatchObject([
      { action: "start", result: "already_running" },
      { action: "stop", result: "ERROR: first close refused" },
      { action: "stop", result: "ERROR: second close refused" },
      { action: "stop", result: "closed" },
    ]);
    expect(actionLog(closed).filter(entry => entry.result === "closed")).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(3);
    expect((await execute("stop")).details).toMatchObject({ status: "not_running" });
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("captures history after close acknowledges, including actions while it was pending", async () => {
    let acknowledge!: (value: object) => void;
    const response = new Promise<object>(resolve => { acknowledge = resolve; });
    const send = vi.spyOn(manager, "_sendCmd").mockReturnValueOnce(response).mockResolvedValue({});
    const closing = execute("stop");
    expect(send).toHaveBeenCalledWith("close", { sessionPath });
    expect(manager.isRunning(sessionPath)).toBe(true);
    await execute("start");
    acknowledge({});

    const closed = await closing;
    expect(actionLog(closed)).toMatchObject([
      { action: "start", result: "already_running" },
      { action: "stop", result: "closed" },
    ]);
    // A subsequent browser lifecycle gets fresh history; the returned snapshot stays intact.
    manager._setSessionEntry(sessionPath, { running: true });
    const next = await execute("stop");
    expect(actionLog(next)).toMatchObject([{ action: "stop", result: "closed" }]);
    expect(actionLog(closed)).toHaveLength(2);
  });
});
