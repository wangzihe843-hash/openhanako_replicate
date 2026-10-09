import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseWindowsShortPathOutput, windowsShortPath } from "./helpers/windows-short-path.ts";

describe("Windows short-path fixture output", () => {
  it("preserves spaces, shell metacharacters and Unicode inside one quoted path", () => {
    const value = "C:\\Users\\RUNNER~1\\Temp\\Synthetic & (100%) ! ^ 中文";
    expect(parseWindowsShortPathOutput(`"${value}"\r\n`)).toBe(value);
  });

  it.each([
    'D:\\"C:\\Users\\RUNNER~1\\Temp\\fixture\\"\r\n',
    '"D:\\"C:\\Users\\RUNNER~1\\Temp\\fixture\\""\r\n',
    '"D:\\C:\\Users\\RUNNER~1\\Temp\\fixture"\r\n',
    '"C:relative\\RUNNER~1"\r\n',
    '"\\Users\\RUNNER~1"\r\n',
    '"C:\\Temp\\RUNNER~1"\r\n"C:\\Temp\\OTHER~1"\r\n',
    '"C:\\Temp\\RUNNER~1"\n\n',
    '"C:\\Temp\\RUNNER~1\0"\r\n',
    "",
  ])("rejects malformed output without stripping embedded quotes or guessing a path: %j", (stdout) => {
    expect(() => parseWindowsShortPathOutput(stdout)).toThrow(/Invalid Windows short-path output/);
  });

  // Additional native quoting coverage; the 33 owning cases still use the real
  // query and real filesystem assertions. macOS parser tests are not evidence
  // that cmd.exe or Windows 8.3 resolution passed.
  it.runIf(process.platform === "win32")("queries a synthetic path literally through native cmd.exe", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "hana-short-path-"));
    try {
      const directory = path.join(fixture, "Literal & (x) %HANA_SHORT_PATH_FIXTURE% ! ^ 中文");
      fs.mkdirSync(directory);
      const short = windowsShortPath(directory);
      const long = fs.realpathSync.native(directory);
      expect(fs.realpathSync.native(short)).toBe(long);
      expect(short.toLowerCase()).not.toBe(long.toLowerCase());
      expect(fs.readdirSync(fixture)).toEqual([path.basename(directory)]);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
});
