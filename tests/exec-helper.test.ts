import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { spawnAndStream } from "../lib/sandbox/exec-helper.ts";

describe("spawnAndStream", () => {
  it("returns when the direct child exits even if a background descendant still holds stdio", async () => {
    const holdInheritedStdioMs = 5000;
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-exec-helper-descendant-"));
    const descendantDonePath = path.join(fixtureDir, "done");
    const fixture = `
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, [
        "-e",
        ${JSON.stringify(`setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(descendantDonePath)}, "done"), ${holdInheritedStdioMs})`)},
      ], {
        stdio: ["ignore", "inherit", "inherit"],
        windowsHide: true,
      });
      child.unref();
      process.stdout.write("parent-exit background-pid=" + child.pid + "\\\\n");
    `;

    const chunks = [];
    let backgroundPid = 0;
    try {
      const result = await spawnAndStream(process.execPath, ["-e", fixture], {
        cwd: process.cwd(),
        env: process.env,
        onData: (data: any) => chunks.push(Buffer.from(data).toString("utf8")),
        timeout: 5,
      } as any);
      expect((result as any).exitCode).toBe(0);
      const output = chunks.join("");
      expect(output).toContain("parent-exit");
      backgroundPid = Number(output.match(/background-pid=(\d+)/)?.[1]);
      expect(backgroundPid).toBeGreaterThan(0);
      expect(fs.existsSync(descendantDonePath)).toBe(false);
    } finally {
      if (backgroundPid > 0) {
        try {
          process.kill(backgroundPid);
        } catch {
          // The descendant may already have exited.
        }
      }
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  }, 7000);

  it("enriches spawn ENOENT with the missing cwd so the executable is not falsely blamed", async () => {
    const missingCwd = path.join(os.tmpdir(), `hana-exec-helper-gone-${Date.now()}`);
    let caught: any;
    try {
      await spawnAndStream(process.execPath, ["-e", "process.exit(0)"], {
        cwd: missingCwd,
        env: process.env,
        onData: () => {},
      } as any);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeTruthy();
    expect(caught.code).toBe("ENOENT");
    expect(caught.cwdMissing).toBe(true);
    expect(caught.message).toContain(missingCwd);
    expect(caught.message.toLowerCase()).toContain("working directory");
  });

  it("can watchdog only the helper process while preserving the native timeout label", async () => {
    await expect(spawnAndStream(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
      cwd: process.cwd(),
      env: process.env,
      onData: () => {},
      timeout: 0.05,
      timeoutErrorValue: 7,
      killMode: "process",
    } as any)).rejects.toThrow("timeout:7");
  });

  it("can route stdout and stderr to distinct callbacks without duplicating them through onData", async () => {
    const combined: string[] = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const result = await spawnAndStream(process.execPath, [
      "-e",
      'process.stdout.write("out\\n"); process.stderr.write("err\\n")',
    ], {
      cwd: process.cwd(),
      env: process.env,
      onData: (data: Buffer) => combined.push(data.toString("utf8")),
      onStdout: (data: Buffer) => stdout.push(data.toString("utf8")),
      onStderr: (data: Buffer) => stderr.push(data.toString("utf8")),
      timeout: 5,
    } as any) as { exitCode: number | null };

    expect(result.exitCode).toBe(0);
    expect(stdout.join("")).toBe("out\n");
    expect(stderr.join("")).toBe("err\n");
    expect(combined).toEqual([]);
  });
});
