import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSandboxedTools } from "../lib/sandbox/index.ts";

describe("ResourceIO sandbox file tools", () => {
  let tempRoot: string | null = null;

  afterEach(() => {
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  });

  function makeTools() {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-resource-sandbox-tools-"));
    const workspace = path.join(tempRoot, "workspace");
    const hanakoHome = path.join(tempRoot, "hana-home");
    const agentDir = path.join(hanakoHome, "agents", "hana");
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    const emitEvent = vi.fn();
    const sessionPath = path.join(agentDir, "sessions", "main.jsonl");
    const result = createSandboxedTools(workspace, [], {
      agentDir,
      workspace,
      workspaceFolders: [],
      hanakoHome,
      getSandboxEnabled: () => true,
      getSessionPath: () => sessionPath,
      emitEvent,
    } as any);
    return { workspace, emitEvent, tools: result.tools };
  }

  it("routes write, read, and edit through ResourceIO and emits mutation events", async () => {
    const { workspace, emitEvent, tools } = makeTools();
    const write = tools.find((tool) => tool.name === "write");
    const read = tools.find((tool) => tool.name === "read");
    const edit = tools.find((tool) => tool.name === "edit");

    await write.execute("write-1", { path: "notes/a.md", content: "hello" });
    expect(fs.readFileSync(path.join(workspace, "notes", "a.md"), "utf-8")).toBe("hello");
    expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "resource.changed",
      source: "agent_tool",
      reason: "agent_write",
      resourceKey: `local_fs:${path.join(workspace, "notes", "a.md").replace(/\\/g, "/")}`,
    }), expect.any(String));

    const readResult = await read.execute("read-1", { path: "notes/a.md" });
    expect(readResult.content[0].text).toBe("hello");

    await edit.execute("edit-1", {
      path: "notes/a.md",
      edits: [{ oldText: "hello", newText: "hello again" }],
    });
    expect(fs.readFileSync(path.join(workspace, "notes", "a.md"), "utf-8")).toBe("hello again");
    expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "resource.changed",
      source: "agent_tool",
      reason: "agent_edit",
      resourceKey: `local_fs:${path.join(workspace, "notes", "a.md").replace(/\\/g, "/")}`,
    }), expect.any(String));
  });
});
