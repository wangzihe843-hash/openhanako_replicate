import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHeartbeat } from "../lib/desk/heartbeat.ts";

interface PatrolTool {
  name: string;
  execute: (id: string, params: { status: string; note: string }) => Promise<unknown>;
}

let tempRoot: string;
let jianPath: string;
let logPath: string;
const oldInstructions = "巡检旧任务五次。";
const update = { status: "completed", note: "本轮已完成。" };

async function captureTools() {
  const tools: PatrolTool[] = [];
  const heartbeat = createHeartbeat({
    getDeskFiles: async () => [],
    getWorkspacePath: () => tempRoot,
    getAgentName: () => "Hana",
    registryPath: path.join(tempRoot, ".registry", "jian-registry.json"),
    onBeat: async (_prompt: string, opts: { customTools: PatrolTool[] }) => {
      tools.push(...opts.customTools);
    },
    onJianBeat: async (_prompt: string, _cwd: string, opts: { customTools: PatrolTool[] }) => {
      tools.push(...opts.customTools);
    },
    intervalMinutes: 31,
    locale: "zh-CN",
    getEventSummary: undefined,
    emitDevLog: undefined,
    overwatchPath: undefined,
    getProposeDraftAvailable: undefined,
    getDmAvailable: undefined,
  });
  await heartbeat.beat();
  const find = (name: string) => {
    const tool = tools.find((entry) => entry.name === name);
    if (!tool) throw new Error(`Missing heartbeat tool: ${name}`);
    return tool;
  };
  return { jian: find("jian_update_status"), patrol: find("patrol_update_log") };
}

function writeLog(bytes: string | Buffer) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, bytes);
}

describe("heartbeat persistence failure boundaries", () => {
  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-heartbeat-persistence-"));
    jianPath = path.join(tempRoot, "jian.md");
    logPath = path.join(tempRoot, "OH-Works", "Hana的巡检", "patrol-log.md");
    fs.writeFileSync(jianPath, oldInstructions);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it.each(["新的任务：只巡检一次。", ""])("keeps the current Jian body after a user edit to %j", async (instructions) => {
    const { jian } = await captureTools();
    fs.writeFileSync(jianPath, instructions);

    await expect(jian.execute("update", update)).resolves.toBeDefined();

    const next = fs.readFileSync(jianPath, "utf-8");
    expect(next.split("<!-- exec-log -->")[0].trim()).toBe(instructions);
    expect(next).toContain(`上次任务快照：\n\`\`\`jian-snapshot\n${oldInstructions}`);
    expect(next).toContain("- 状态：完毕");
  });

  it("does not recreate a Jian deleted after patrol started", async () => {
    const { jian } = await captureTools();
    fs.unlinkSync(jianPath);
    const write = vi.spyOn(fs, "writeFileSync");

    await expect(jian.execute("update", update)).rejects.toMatchObject({ code: "ENOENT" });

    expect(write).not.toHaveBeenCalled();
    expect(fs.existsSync(jianPath)).toBe(false);
  });

  it.each(["EACCES", "EIO"])("leaves newer Jian instructions untouched on %s", async (code) => {
    const { jian } = await captureTools();
    const current = Buffer.from("较新的指令，必须保留。\r\n", "utf-8");
    fs.writeFileSync(jianPath, current);
    const failure = Object.assign(new Error(`Jian read failed: ${code}`), { code });
    const read = vi.spyOn(fs, "readFileSync").mockImplementationOnce(() => { throw failure; });
    const write = vi.spyOn(fs, "writeFileSync");

    await expect(jian.execute("update", update)).rejects.toBe(failure);

    expect(read.mock.calls[0][0]).toBe(jianPath);
    expect(write).not.toHaveBeenCalled();
    expect(fs.readFileSync(jianPath)).toEqual(current);
  });

  it.each(["jian", "patrol"] as const)("rejects %s publish failure while retaining the original file", async (kind) => {
    const original = Buffer.from("- [2026-09-13 09:00] 旧内容\n", "utf-8");
    writeLog(original);
    const tools = await captureTools();
    const target = kind === "jian" ? jianPath : logPath;
    const before = fs.readFileSync(target);
    const failure = Object.assign(new Error("Publish failed"), { code: "EACCES" });
    const rename = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => { throw failure; });

    await expect(tools[kind].execute("update", update)).rejects.toBe(failure);

    expect(rename).toHaveBeenCalledWith(`${target}.tmp`, target);
    expect(fs.readFileSync(target)).toEqual(before);
  });

  it.each(["EACCES", "EIO", "ENOENT"])("does not overwrite existing patrol history after a read reports %s", async (code) => {
    const history = Buffer.from("- [2026-09-13 09:00] 第一条\r\n- [2026-09-13 09:30] 第二条\n", "utf-8");
    writeLog(history);
    const { patrol } = await captureTools();
    const failure = Object.assign(new Error(`Patrol read failed: ${code}`), { code });
    const read = vi.spyOn(fs, "readFileSync").mockImplementationOnce(() => { throw failure; });
    const write = vi.spyOn(fs, "writeFileSync");

    await expect(patrol.execute("update", update)).rejects.toBe(failure);

    expect(read.mock.calls[0][0]).toBe(logPath);
    expect(write).not.toHaveBeenCalled();
    expect(fs.readFileSync(logPath)).toEqual(history);
  });

  it.each(["EACCES", "EIO"])("reports unavailable history during preview and blocks append on %s", async (code) => {
    const history = Buffer.from(Array.from({ length: 51 }, (_, index) => `- [2026-09-13 09:00] record ${index}\n`).join(""));
    writeLog(history);
    const failure = Object.assign(new Error(`Patrol preview failed: ${code}`), { code });
    const originalRead = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation((file, options) => {
      if (file === logPath) throw failure;
      return originalRead(file, options);
    });
    const write = vi.spyOn(fs, "writeFileSync");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const { patrol } = await captureTools();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("skipping history preview"));
    expect(originalRead(logPath)).toEqual(history);
    await expect(patrol.execute("update", update)).rejects.toBe(failure);
    expect(write.mock.calls.some(([file]) => file === `${logPath}.tmp` || file === logPath)).toBe(false);
    expect(originalRead(logPath)).toEqual(history);
  });

  it("requires confirmed absence before creating a new patrol log", async () => {
    const { patrol } = await captureTools();
    const failure = Object.assign(new Error("Cannot confirm log absence"), { code: "EACCES" });
    const stat = vi.spyOn(fs, "lstatSync").mockImplementationOnce(() => { throw failure; });
    const write = vi.spyOn(fs, "writeFileSync");

    await expect(patrol.execute("update", update)).rejects.toBe(failure);

    expect(stat).toHaveBeenCalledWith(logPath);
    expect(write).not.toHaveBeenCalled();
    expect(fs.existsSync(logPath)).toBe(false);
  });

  it("creates a genuinely absent patrol log and appends to it", async () => {
    const { patrol } = await captureTools();
    await patrol.execute("first", update);
    await patrol.execute("second", { ...update, note: "下一条。" });

    const text = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(logPath));
    expect(text.split("\n").filter(Boolean)).toHaveLength(2);
    expect(text).toContain(update.note);
    expect(text).toContain("下一条。");
  });

  it("normalizes BOM UTF-8 and mixed cp936 history without losing entries", async () => {
    const history = Buffer.concat([
      Buffer.from("\ufeff- [2026-09-13 09:00] UTF-8 正常\r\n- [2026-09-13 09:30] ", "utf-8"),
      Buffer.from([0xd6, 0xd0, 0xce, 0xc4]),
      Buffer.from(" cp936", "ascii"),
    ]);
    writeLog(history);
    const { patrol } = await captureTools();

    await patrol.execute("update", update);

    const text = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(logPath));
    expect(text).toContain("UTF-8 正常");
    expect(text).toContain("中文 cp936\n- [");
    expect(text).toContain(update.note);
    expect(text).not.toContain("\ufffd");
  });

  it.each([false, true])("preserves undecodable history and rejects append (BOM: %s)", async (bom) => {
    const history = Buffer.concat([
      Buffer.from(`${bom ? "\ufeff" : ""}- [2026-09-13 09:00] retained `, "utf-8"),
      Buffer.from([0xff]),
    ]);
    writeLog(history);
    // Preview failure must still allow the patrol to start; writing remains strict.
    const { patrol } = await captureTools();
    const write = vi.spyOn(fs, "writeFileSync");

    await expect(patrol.execute("update", update)).rejects.toThrow();

    expect(write).not.toHaveBeenCalled();
    expect(fs.readFileSync(logPath)).toEqual(history);
  });
});
