import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnAndStream = vi.fn(async () => ({ exitCode: 0 }));
const classifyWin32Command = vi.fn();
const existsSync = vi.fn(() => false);
const spawnSync = vi.fn(() => ({ status: 1, stdout: "", stderr: "" }));

vi.mock("../lib/sandbox/exec-helper.js", () => ({
  spawnAndStream,
}));

vi.mock("../lib/sandbox/win32-command-router.js", () => ({
  classifyWin32Command,
}));

vi.mock("fs", () => ({
  existsSync,
}));

vi.mock("child_process", () => ({
  spawnSync,
}));

async function loadExecFactory() {
  const mod = await import("../lib/sandbox/win32-exec.js");
  return mod.createWin32Exec;
}

describe("createWin32Exec", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    existsSync.mockReturnValue(false);
    spawnSync.mockReturnValue({ status: 1, stdout: "", stderr: "" });
  });

  it("routes Windows native commands through cmd.exe", async () => {
    classifyWin32Command.mockReturnValue({ runner: "cmd", reason: "windows-system-executable" });
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec();

    await exec("ipconfig /all", "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: { PATH: "C:\\Windows\\System32" },
    });

    expect(spawnAndStream).toHaveBeenCalledWith(
      "cmd.exe",
      ["/d", "/s", "/c", "ipconfig /all"],
      expect.objectContaining({ cwd: "C:\\work" })
    );
  });

  it("routes simple Git commands through bundled git.exe without bash", async () => {
    classifyWin32Command.mockReturnValue({ runner: "git", reason: "git-command" });
    const gitExe = "C:\\Hanako\\resources\\git\\cmd\\git.exe";
    existsSync.mockImplementation((p) => p === gitExe);

    const originalResourcesPath = process.resourcesPath;
    Object.defineProperty(process, "resourcesPath", {
      value: "C:\\Hanako\\resources",
      configurable: true,
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec();

    try {
      await exec('git -C "C:\\Users\\Me\\repo" status --short "src file.txt"', "C:\\work", {
        onData: () => {},
        signal: undefined,
        timeout: 5,
        env: { PATH: "C:\\Windows\\System32" },
      });
    } finally {
      Object.defineProperty(process, "resourcesPath", {
        value: originalResourcesPath,
        configurable: true,
      });
    }

    expect(spawnAndStream).toHaveBeenCalledWith(
      gitExe,
      ["-C", "C:\\Users\\Me\\repo", "status", "--short", "src file.txt"],
      expect.objectContaining({ cwd: "C:\\work" })
    );
  });

  it("routes sandboxed simple Git commands through bundled git.exe via the helper", async () => {
    classifyWin32Command.mockReturnValue({ runner: "git", reason: "git-command" });
    const gitExe = "C:\\Hanako\\resources\\git\\cmd\\git.exe";
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === gitExe || p === helper);

    const originalResourcesPath = process.resourcesPath;
    Object.defineProperty(process, "resourcesPath", {
      value: "C:\\Hanako\\resources",
      configurable: true,
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        grants: {
          readPaths: [],
          writePaths: ["C:\\work"],
        },
      },
    });

    try {
      await exec("git status --short", "C:\\work", {
        onData: () => {},
        signal: undefined,
        timeout: 5,
        env: { PATH: "C:\\Windows\\System32" },
      });
    } finally {
      Object.defineProperty(process, "resourcesPath", {
        value: originalResourcesPath,
        configurable: true,
      });
    }

    expect(spawnAndStream).toHaveBeenCalledWith(
      helper,
      expect.arrayContaining([
        "--grant-read",
        "C:\\Hanako\\resources\\git",
        "--",
        gitExe,
        "status",
        "--short",
      ]),
      expect.objectContaining({ cwd: "C:\\work" })
    );
  });

  it("keeps bash-routed commands on the bash fallback path", async () => {
    classifyWin32Command.mockReturnValue({ runner: "bash", reason: "complex-shell" });
    existsSync.mockImplementation((p) => p === "C:\\mock\\bash.exe");
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === "where" && args?.[0] === "bash.exe") {
        return { status: 0, stdout: "C:\\mock\\bash.exe\r\n", stderr: "" };
      }
      if (cmd === "C:\\mock\\bash.exe" && args?.[0] === "-c") {
        return { status: 0, stdout: "__hana_probe_ok__\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec();

    await exec("ls && pwd", "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: { PATH: "C:\\Windows\\System32" },
    });

    expect(spawnAndStream).toHaveBeenCalledWith(
      "C:\\mock\\bash.exe",
      ["-c", "ls && pwd"],
      expect.objectContaining({ cwd: "C:\\work" })
    );
  });

  it("prefers bundled POSIX runtime over system Git Bash when sandbox is disabled", async () => {
    classifyWin32Command.mockReturnValue({ runner: "bash", reason: "complex-shell" });
    const bundledShell = "C:\\Hanako\\resources\\git\\bin\\bash.exe";
    const systemBash = "C:\\Program Files\\Git\\bin\\bash.exe";
    existsSync.mockImplementation((p) => p === bundledShell || p === systemBash);
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === bundledShell && args?.[0] === "-lc") {
        return { status: 0, stdout: "__hana_probe_ok__\n", stderr: "" };
      }
      if (cmd === systemBash && args?.[0] === "-c") {
        return { status: 0, stdout: "__hana_probe_ok__\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    const originalResourcesPath = process.resourcesPath;
    Object.defineProperty(process, "resourcesPath", {
      value: "C:\\Hanako\\resources",
      configurable: true,
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec();

    try {
      await exec("ls && pwd", "C:\\work", {
        onData: () => {},
        signal: undefined,
        timeout: 5,
        env: {
          PATH: "C:\\Windows\\System32",
          ProgramFiles: "C:\\Program Files",
        },
      });
    } finally {
      Object.defineProperty(process, "resourcesPath", {
        value: originalResourcesPath,
        configurable: true,
      });
    }

    expect(spawnAndStream).toHaveBeenCalledWith(
      bundledShell,
      ["-lc", "ls && pwd"],
      expect.objectContaining({
        cwd: "C:\\work",
        env: expect.objectContaining({
          PATH: expect.stringMatching(/^C:\\Hanako\\resources\\git\\bin;C:\\Hanako\\resources\\git\\usr\\bin;C:\\Hanako\\resources\\git\\mingw64\\bin;C:\\Hanako\\resources\\git\\cmd;/),
        }),
      })
    );
  });

  it("rejects CMD nul redirection before executing bash-routed commands", async () => {
    classifyWin32Command.mockReturnValue({ runner: "bash", reason: "complex-shell" });
    existsSync.mockImplementation((p) => p === "C:\\mock\\bash.exe");
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === "where" && args?.[0] === "bash.exe") {
        return { status: 0, stdout: "C:\\mock\\bash.exe\r\n", stderr: "" };
      }
      if (cmd === "C:\\mock\\bash.exe" && args?.[0] === "-c") {
        return { status: 0, stdout: "__hana_probe_ok__\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec();

    await expect(exec("ipconfig /all > nul 2>&1", "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: { PATH: "C:\\Windows\\System32" },
    })).rejects.toThrow("/dev/null");

    expect(spawnAndStream).not.toHaveBeenCalled();
  });

  it("routes sandbox-enabled bash commands through the AppContainer helper with policy grants", async () => {
    classifyWin32Command.mockReturnValue({ runner: "bash", reason: "complex-shell" });
    const bundledShell = "C:\\Hanako\\resources\\git\\bin\\bash.exe";
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === bundledShell || p === helper);
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === bundledShell && args?.[0] === "-lc") {
        return { status: 0, stdout: "__hana_probe_ok__\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    const originalResourcesPath = process.resourcesPath;
    Object.defineProperty(process, "resourcesPath", {
      value: "C:\\Hanako\\resources",
      configurable: true,
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        grants: {
          readPaths: ["C:\\outside\\reference.md"],
          optionalReadPaths: ["C:\\Users\\Hana\\.hanako\\agents\\hanako\\config.yaml"],
          writePaths: ["C:\\work"],
          optionalWritePaths: ["C:\\Users\\Hana\\.hanako\\agents\\hanako\\memory"],
        },
      },
    });

    try {
      await exec("ls && pwd", "C:\\work", {
        onData: () => {},
        signal: undefined,
        timeout: 5,
        env: { PATH: "C:\\Windows\\System32" },
      });
    } finally {
      Object.defineProperty(process, "resourcesPath", {
        value: originalResourcesPath,
        configurable: true,
      });
    }

    expect(spawnAndStream).toHaveBeenCalledWith(
      helper,
      expect.arrayContaining([
        "--cwd",
        "C:\\work",
        "--grant-read",
        "C:\\outside\\reference.md",
        "--grant-read-optional",
        "C:\\Users\\Hana\\.hanako\\agents\\hanako\\config.yaml",
        "--grant-write",
        "C:\\work",
        "--grant-write-optional",
        "C:\\Users\\Hana\\.hanako\\agents\\hanako\\memory",
        "--",
        bundledShell,
        "-lc",
        "ls && pwd",
      ]),
      expect.objectContaining({ cwd: "C:\\work" })
    );
  });

  it("passes the sandbox network grant to the AppContainer helper when enabled", async () => {
    classifyWin32Command.mockReturnValue({ runner: "bash", reason: "complex-shell" });
    const bundledShell = "C:\\Hanako\\resources\\git\\bin\\bash.exe";
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === bundledShell || p === helper);
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === bundledShell && args?.[0] === "-lc") {
        return { status: 0, stdout: "__hana_probe_ok__\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    const originalResourcesPath = process.resourcesPath;
    Object.defineProperty(process, "resourcesPath", {
      value: "C:\\Hanako\\resources",
      configurable: true,
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        grants: {
          readPaths: [],
          writePaths: ["C:\\work"],
        },
        getSandboxNetworkEnabled: () => true,
      },
    });

    try {
      await exec("curl https://example.com", "C:\\work", {
        onData: () => {},
        signal: undefined,
        timeout: 5,
        env: { PATH: "C:\\Windows\\System32" },
      });
    } finally {
      Object.defineProperty(process, "resourcesPath", {
        value: originalResourcesPath,
        configurable: true,
      });
    }

    expect(spawnAndStream).toHaveBeenCalledWith(
      helper,
      expect.arrayContaining(["--network", "internet-client", "--", bundledShell, "-lc", "curl https://example.com"]),
      expect.objectContaining({ cwd: "C:\\work" })
    );
  });

  it("does not fall back to system Git Bash for sandboxed POSIX commands", async () => {
    classifyWin32Command.mockReturnValue({ runner: "bash", reason: "complex-shell" });
    const systemBash = "C:\\Program Files\\Git\\bin\\bash.exe";
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === systemBash || p === helper);
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === systemBash && args?.[0] === "-c") {
        return { status: 0, stdout: "__hana_probe_ok__\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    const originalResourcesPath = process.resourcesPath;
    Object.defineProperty(process, "resourcesPath", {
      value: "C:\\Hanako\\resources",
      configurable: true,
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        grants: {
          readPaths: [],
          writePaths: ["C:\\work"],
        },
      },
    });

    try {
      await expect(exec("ls && pwd", "C:\\work", {
        onData: () => {},
        signal: undefined,
        timeout: 5,
        env: {
          PATH: "C:\\Windows\\System32",
          ProgramFiles: "C:\\Program Files",
        },
      })).rejects.toThrow("Sandboxed POSIX commands require bundled");
    } finally {
      Object.defineProperty(process, "resourcesPath", {
        value: originalResourcesPath,
        configurable: true,
      });
    }

    expect(spawnAndStream).not.toHaveBeenCalled();
  });
});
