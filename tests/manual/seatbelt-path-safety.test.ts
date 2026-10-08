import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSeatbeltExec } from "../../lib/sandbox/seatbelt.ts";
import * as execHelper from "../../lib/sandbox/exec-helper.ts";

vi.mock("../../lib/debug-log.ts", () => ({ createModuleLogger: () => ({ warn() {}, error() {} }) }));

// Explicit opt-in: this launches actual macOS sandbox-exec, never a fallback.
describe.runIf(process.platform === "darwin" && process.env.HANA_NATIVE_SANDBOX_TEST === "1")("native Seatbelt path/permission integration", () => {
  let root: string;
  afterEach(() => {
    vi.restoreAllMocks();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("starts with literal special paths, permits allowed access, and retains write/read denials", async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hana-seatbelt-native-")));
    vi.spyOn(os, "tmpdir").mockReturnValue(root);
    const originalSpawn = execHelper.spawnAndStream;
    const calls: { command: string; args: string[]; stdout: string; stderr: string }[] = [];
    vi.spyOn(execHelper, "spawnAndStream").mockImplementation(async (command, args, options) => {
      const observed = { command, args, stdout: "", stderr: "" };
      calls.push(observed);
      return originalSpawn(command, args, {
        ...options,
        onStdout: (data) => { observed.stdout += data.toString(); },
        onStderr: (data) => { observed.stderr += data.toString(); },
      });
    });

    // Stop after the first initialization/parse failure; no permission widening.
    for (const name of ["ordinary", 'special"back\\slash 中文 $literal `literal`']) {
      const cwd = path.join(root, name);
      const protectedDir = path.join(cwd, 'protected"back\\slash');
      const deniedDir = path.join(cwd, 'denied"back\\slash');
      for (const dir of [protectedDir, deniedDir]) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(deniedDir, "secret"), "synthetic unreadable payload");
      fs.writeFileSync(path.join(protectedDir, "unchanged"), "synthetic protected payload");
      const exec = createSeatbeltExec({ writablePaths: [cwd], protectedPaths: [protectedDir], denyReadPaths: [deniedDir] }, { getSandboxNetworkEnabled: () => false });
      const result = await exec("printf started > started\n/bin/pwd -P\nprintf allowed > allowed\n", cwd, { onData() {}, timeout: 5, env: { PATH: "/usr/bin:/bin", TMPDIR: root } });
      const launched = calls.at(-1)!;
      console.log("NATIVE_START_RESULT", JSON.stringify({ name, ...result, ...launched }));
      if (result.exitCode !== 0) {
        expect(fs.existsSync(path.join(cwd, "started"))).toBe(false);
        throw new Error(`Native sandbox startup unavailable; stopped without retry: ${launched.stderr}`);
      }
      expect(launched.stdout).toBe(fs.realpathSync(cwd) + "\n");
      expect(fs.readFileSync(path.join(cwd, "allowed"), "utf8")).toBe("allowed");

      // Relative paths are shell literals, not interpolated profile data.
      const quote = (p: string) => "'" + p.replace(/'/g, "'\\''") + "'";
      const deniedRead = await exec(`/bin/cat ${quote(path.relative(cwd, path.join(deniedDir, "secret")))}`, cwd, { onData() {}, timeout: 5, env: { PATH: "/usr/bin:/bin", TMPDIR: root } });
      console.log("EXPECTED_NATIVE_READ_DENIAL", JSON.stringify({ ...deniedRead, ...calls.at(-1) }));
      expect(deniedRead.exitCode).not.toBe(0);
      expect(calls.at(-1)!.stdout).not.toContain("synthetic unreadable payload");
      const deniedWrite = await exec(`printf changed > ${quote(path.relative(cwd, path.join(protectedDir, "unchanged")))}`, cwd, { onData() {}, timeout: 5, env: { PATH: "/usr/bin:/bin", TMPDIR: root } });
      console.log("EXPECTED_NATIVE_WRITE_DENIAL", JSON.stringify({ ...deniedWrite, ...calls.at(-1) }));
      expect(deniedWrite.exitCode).not.toBe(0);
      expect(fs.readFileSync(path.join(protectedDir, "unchanged"), "utf8")).toBe("synthetic protected payload");
    }
    expect(calls.every((call) => call.command === "sandbox-exec")).toBe(true);
  });
});
