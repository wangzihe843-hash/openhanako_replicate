import path from "path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { wrapWithCheckpoint } from "../lib/checkpoint-wrapper.js";

// On Windows path.resolve("/project", "src/foo.js") yields "<DRIVE>:\project\src\foo.js"; on POSIX it's "/project/src/foo.js".
// Mirror the production resolution so assertions remain OS-agnostic.
const PROJECT_CWD = "/project";
function resolved(rel) {
  return path.resolve(PROJECT_CWD, rel);
}

function makeTool(name, execute) {
  return { name, execute: execute || vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })) };
}

function makeStore() {
  return { save: vi.fn(async () => "ckpt-001") };
}

describe("wrapWithCheckpoint", () => {
  let store;

  beforeEach(() => {
    store = makeStore();
  });

  it("wraps write tool — saves before execute", async () => {
    const writeTool = makeTool("write");
    const [wrapped] = wrapWithCheckpoint([writeTool], {
      store,
      maxFileSizeKb: 1024,
      cwd: PROJECT_CWD,
      getSessionPath: () => "sessions/test",
    });

    await wrapped.execute("t1", { path: "src/foo.js" });

    expect(store.save).toHaveBeenCalledWith({
      sessionPath: "sessions/test",
      tool: "write",
      source: "llm",
      reason: "tool-write",
      filePath: resolved("src/foo.js"),
      maxSizeKb: 1024,
    });
    expect(writeTool.execute).toHaveBeenCalled();
  });

  it("wraps edit tool — saves before execute", async () => {
    const editTool = makeTool("edit");
    const [wrapped] = wrapWithCheckpoint([editTool], {
      store,
      maxFileSizeKb: 1024,
      cwd: PROJECT_CWD,
      getSessionPath: () => null,
    });

    await wrapped.execute("t2", { path: "/absolute/bar.ts" });

    expect(store.save).toHaveBeenCalledWith({
      sessionPath: null,
      tool: "edit",
      source: "llm",
      reason: "tool-edit",
      filePath: "/absolute/bar.ts",
      maxSizeKb: 1024,
    });
  });

  it("wraps bash rm — detects rm and saves target", async () => {
    const bashTool = makeTool("bash");
    const [wrapped] = wrapWithCheckpoint([bashTool], {
      store,
      maxFileSizeKb: 1024,
      cwd: PROJECT_CWD,
      getSessionPath: () => null,
    });

    await wrapped.execute("t3", { command: "rm src/old.js" });

    expect(store.save).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "bash:rm",
        source: "llm",
        reason: "tool-bash-rm",
        filePath: resolved("src/old.js"),
      }),
    );
  });

  it("wraps bash mv — saves source before rename", async () => {
    const bashTool = makeTool("bash");
    const [wrapped] = wrapWithCheckpoint([bashTool], {
      store,
      maxFileSizeKb: 1024,
      cwd: PROJECT_CWD,
      getSessionPath: () => null,
    });

    await wrapped.execute("t4", { command: "mv src/a.js src/b.js" });

    expect(store.save).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "bash:mv",
        source: "llm",
        reason: "tool-bash-mv",
        filePath: resolved("src/a.js"),
      }),
    );
  });

  it("does not wrap unrelated tools", async () => {
    const grepTool = makeTool("grep");
    const [wrapped] = wrapWithCheckpoint([grepTool], {
      store,
      maxFileSizeKb: 1024,
      cwd: PROJECT_CWD,
      getSessionPath: () => null,
    });

    await wrapped.execute("t5", { pattern: "foo" });
    expect(store.save).not.toHaveBeenCalled();
  });

  it("still executes tool even if save fails", async () => {
    store.save = vi.fn(async () => { throw new Error("disk full"); });
    const writeTool = makeTool("write");
    const [wrapped] = wrapWithCheckpoint([writeTool], {
      store,
      maxFileSizeKb: 1024,
      cwd: PROJECT_CWD,
      getSessionPath: () => null,
    });

    const result = await wrapped.execute("t6", { path: "src/foo.js" });
    expect(writeTool.execute).toHaveBeenCalled();
  });
});
