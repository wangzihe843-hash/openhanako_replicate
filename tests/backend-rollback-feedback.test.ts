import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../core/agent-manager.ts";
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
describe("agent rollback feedback", () => {
  it("attempts both cleanup steps and reports their failures without masking the primary error", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-agent-rollback-feedback-"));
    roots.push(root);
    const cleanupChannels = vi.fn(async () => { throw new Error("channel cleanup denied"); });
    const manager = new AgentManager({ getChannelManager: () => ({ cleanupAgentFromChannels: cleanupChannels }) });
    vi.spyOn(fs, "rmSync").mockImplementationOnce(() => { throw new Error("directory cleanup denied"); });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(manager._rollbackAgentCreation(root, "agent-alpha")).resolves.toBeUndefined();
    expect(cleanupChannels).toHaveBeenCalledWith("agent-alpha");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("directory cleanup failed (agent-alpha)"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("channel cleanup failed (agent-alpha)"));
    expect(fs.existsSync(root)).toBe(true);
  });
});
