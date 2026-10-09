import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// cmd.exe reads a raw command line, not CRT-escaped argv. The outer quotes
// belong to /s /c; both expansions stay quoted. /v:off preserves literal !,
// /d disables AutoRun, and /u makes redirected output independent of codepage.
const WINDOWS_SHORT_PATH_ARGS = [
  "/d", "/e:on", "/v:off", "/u", "/s", "/c",
  '"for %I in ("%HANA_SHORT_PATH_FIXTURE%") do @echo "%~fsI""',
];

export function parseWindowsShortPathOutput(stdout: string): string {
  const match = /^"([^"\r\n\0]+)"\r?\n$/.exec(stdout);
  const value = match?.[0] === stdout ? match[1] : undefined;
  // Do not repair malformed output such as CI #23's D:\\"C:\\...\\".
  if (!value || !/^[a-z]:\\/i.test(value) || value.slice(2).includes(":")) {
    throw new Error(`Invalid Windows short-path output: ${JSON.stringify(stdout)}`);
  }
  return value;
}

/** Test-only: require a real native alias; an unchanged long path is a failure. */
export function windowsShortPath(directory: string): string {
  if (process.platform !== "win32") throw new Error("Windows short-path fixture requires native Windows");
  if (!path.win32.isAbsolute(directory) || /["\r\n\0]/.test(directory)) {
    throw new Error(`Invalid Windows fixture path: ${JSON.stringify(directory)}`);
  }
  const long = fs.realpathSync.native(directory);
  const result = spawnSync("cmd.exe", WINDOWS_SHORT_PATH_ARGS, {
    windowsVerbatimArguments: true,
    windowsHide: true,
    encoding: "utf16le",
    timeout: 10_000,
    // No path is interpolated into the command, and cmd expands this only once.
    env: { ...process.env, HANA_SHORT_PATH_FIXTURE: directory },
  });
  const diagnostic = { directory, long, status: result.status, signal: result.signal,
    stdout: result.stdout, stderr: result.stderr, spawnError: result.error?.message };
  try {
    if (result.error || result.status !== 0) throw new Error("cmd short-path query failed");
    const short = parseWindowsShortPathOutput(result.stdout);
    // An existing short-name ancestor (e.g. RUNNER~1) is sufficient; new
    // directories need not receive 8.3 names. Never invent or enable a short name.
    if (!/~\d/.test(short) || short.toLowerCase() === long.toLowerCase()) {
      throw new Error("Windows fixture requires an actual 8.3 alias (including an existing ancestor)");
    }
    const native = fs.realpathSync.native(short);
    if (native !== long) throw new Error(`Short/long native identity mismatch: ${JSON.stringify({ short, native })}`);
    return short;
  } catch (error) {
    throw new Error(`Windows short-path fixture failed: ${error instanceof Error ? error.message : String(error)}; ${JSON.stringify(diagnostic)}`);
  }
}
