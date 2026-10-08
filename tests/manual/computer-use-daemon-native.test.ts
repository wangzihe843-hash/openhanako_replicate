import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Opt in after building hana-daemon-test-probe and hana-computer-use-helper.
// The probe runs the production DaemonServer with an empty tool registry and
// no AppKit bootstrap. The real helper is invoked only for `status` on our UDS.
const probeBinary = process.env.HANA_DAEMON_TEST_BINARY;
const helperBinary = process.env.HANA_HELPER_TEST_BINARY;
const enabled = process.platform === "darwin" && Boolean(probeBinary && helperBinary);
type OwnedChild = { child: ChildProcess; exit: Promise<{ code: number | null; signal: string | null }>; output: string };

describe.runIf(enabled)("native Hana daemon socket ownership (isolated, no UI)", () => {
  let root: string;
  let socketPath: string;
  let children: OwnedChild[];
  let listeners: net.Server[];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "hana-daemon-test-"));
    socketPath = path.join(root, "daemon.sock");
    children = [];
    listeners = [];
  });

  function launch(binary: string, args: string[], instanceId = "test-instance") {
    const child = spawn(binary, args, {
      env: { ...process.env, HANA_DAEMON_TEST_ROOT: root, HANA_COMPUTER_USE_INSTANCE_ID: instanceId },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const owned: OwnedChild = {
      child, output: "",
      exit: new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      }),
    };
    child.stdout.on("data", (chunk) => { owned.output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { owned.output += chunk.toString(); });
    children.push(owned);
    return owned;
  }

  const daemon = (id: string, pidFile?: string) => launch(probeBinary, [socketPath, ...(pidFile ? [pidFile] : [])], id);

  async function bounded<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Owned test process/socket timed out")), 4000);
      })]);
    } finally { clearTimeout(timer); }
  }

  function request(method: string, name?: string): Promise<{ ok: boolean; error?: string }> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      let result = "";
      socket.setTimeout(1000, () => socket.destroy(new Error("Test socket timeout")));
      socket.once("error", reject);
      socket.once("connect", () => socket.write(JSON.stringify({ method, ...(name ? { name } : {}) }) + "\n"));
      socket.on("data", (chunk) => {
        result += chunk;
        if (!result.includes("\n")) return;
        socket.destroy();
        try { resolve(JSON.parse(result.split("\n")[0])); } catch (err) { reject(err); }
      });
      socket.once("end", () => reject(new Error("Test daemon closed without a response")));
    });
  }

  async function ready(id: string, owner: OwnedChild) {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      if (owner.child.exitCode != null || owner.child.signalCode != null) throw new Error(owner.output);
      try { if ((await request("hana_instance", id)).ok) return; } catch { /* not listening yet */ }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Daemon did not become ready: ${owner.output}`);
  }

  async function terminate(owner: OwnedChild, signal: NodeJS.Signals = "SIGTERM") {
    if (owner.child.exitCode == null && owner.child.signalCode == null) owner.child.kill(signal);
    return bounded(owner.exit);
  }

  async function legacyListener() {
    const server = net.createServer((socket) => socket.end());
    listeners.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    return server;
  }

  async function canConnect() {
    await new Promise<void>((resolve, reject) => {
      const client = net.createConnection(socketPath);
      client.once("error", reject);
      client.once("connect", () => { client.destroy(); resolve(); });
    });
  }

  afterEach(async () => {
    // Only objects created by this test are signalled. Do not clean files until
    // every child has exited, even when the assertion or graceful stop failed.
    for (const owner of children) await terminate(owner, "SIGKILL");
    for (const server of listeners) await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("answers instance checks and shuts down normally", async () => {
    const owner = daemon("owner-a");
    await ready("owner-a", owner);
    const version = launch(helperBinary, ["version", "--daemon-protocol", "--socket", socketPath]);
    expect((await bounded(version.exit)).code).toBe(0);
    expect(version.output.trim()).toBe("hana-daemon-ownership-v1");
    expect((await request("hana_instance", "not-owner-a")).ok).toBe(false);
    const match = launch(helperBinary, ["status", "--socket", socketPath, "--instance", "owner-a"]);
    const mismatch = launch(helperBinary, ["status", "--socket", socketPath, "--instance", "not-owner-a"]);
    expect((await bounded(match.exit)).code, match.output).toBe(0);
    expect((await bounded(mismatch.exit)).code).toBe(1);
    expect((await request("shutdown")).ok).toBe(true);
    expect((await bounded(owner.exit)).code).toBe(0);
    expect(fs.existsSync(socketPath)).toBe(false);
    expect(fs.existsSync(socketPath + ".lock")).toBe(true);
  });

  it("rejects a second daemon without touching the live socket or lock", async () => {
    const first = daemon("first");
    await ready("first", first);
    const socketInode = fs.lstatSync(socketPath).ino;
    const lockInode = fs.lstatSync(socketPath + ".lock").ino;
    const second = daemon("second");
    expect((await bounded(second.exit)).code, second.output).toBe(70);
    expect(fs.lstatSync(socketPath).ino).toBe(socketInode);
    expect(fs.lstatSync(socketPath + ".lock").ino).toBe(lockInode);
    expect((await request("hana_instance", "first")).ok).toBe(true);
  });

  it("allows exactly one concurrent starter and keeps the winner reachable", async () => {
    const first = daemon("first");
    const second = daemon("second");
    const loser = await bounded(Promise.race([
      first.exit.then((result) => ({ result, winner: second, id: "second" })),
      second.exit.then((result) => ({ result, winner: first, id: "first" })),
    ]));
    expect(loser.result.code).toBe(70);
    await ready(loser.id, loser.winner);
    expect((await request("hana_instance", loser.id)).ok).toBe(true);
  });

  it("preserves a live legacy socket that has no lock", async () => {
    await legacyListener();
    const inode = fs.lstatSync(socketPath).ino;
    const candidate = daemon("candidate");
    expect((await bounded(candidate.exit)).code, candidate.output).toBe(70);
    expect(fs.lstatSync(socketPath).ino).toBe(inode);
    await canConnect();
  });

  it("recovers a crashed owner's stale socket under the same lock inode", async () => {
    const first = daemon("first");
    await ready("first", first);
    const lockInode = fs.lstatSync(socketPath + ".lock").ino;
    await terminate(first, "SIGKILL");
    expect(fs.existsSync(socketPath)).toBe(true);
    const next = daemon("next");
    await ready("next", next);
    expect(fs.lstatSync(socketPath + ".lock").ino).toBe(lockInode);
    await terminate(next);
    expect(fs.existsSync(socketPath)).toBe(false);
  });

  it("rolls back a failure after bind and permits a later start", async () => {
    const failed = daemon("failed", path.join(root, "missing-parent", "daemon.pid"));
    expect((await bounded(failed.exit)).code, failed.output).toBe(70);
    expect(fs.existsSync(socketPath)).toBe(false);
    const next = daemon("next");
    await ready("next", next);
    await terminate(next);
    expect(fs.existsSync(socketPath)).toBe(false);
  });

  it("does not unlink a replacement socket when the old daemon receives SIGTERM", async () => {
    const first = daemon("first");
    await ready("first", first);
    fs.renameSync(socketPath, path.join(root, "old.sock"));
    await legacyListener();
    const replacementInode = fs.lstatSync(socketPath).ino;
    await terminate(first);
    expect(fs.lstatSync(socketPath).ino).toBe(replacementInode);
    await canConnect();
  });

  it("fails closed when the lock pathname is replaced, then recovers after exit", async () => {
    const first = daemon("first");
    await ready("first", first);
    fs.renameSync(socketPath + ".lock", path.join(root, "old.lock"));
    const second = daemon("second");
    expect((await bounded(second.exit)).code, second.output).toBe(70);
    expect((await request("hana_instance", "first")).ok).toBe(true);
    const inode = fs.lstatSync(socketPath).ino;
    await terminate(first);
    expect(fs.lstatSync(socketPath).ino).toBe(inode);
    const third = daemon("third");
    await ready("third", third);
  });

  it("preserves an unrelated file at the socket pathname", async () => {
    fs.writeFileSync(socketPath, "not a socket");
    const candidate = daemon("candidate");
    expect((await bounded(candidate.exit)).code, candidate.output).toBe(70);
    expect(fs.readFileSync(socketPath, "utf8")).toBe("not a socket");
  });

  it("does not delete a replaced pid file", async () => {
    const pidFile = path.join(root, "daemon.pid");
    const owner = daemon("owner", pidFile);
    await ready("owner", owner);
    fs.renameSync(pidFile, path.join(root, "old.pid"));
    fs.writeFileSync(pidFile, "replacement");
    await terminate(owner);
    expect(fs.readFileSync(pidFile, "utf8")).toBe("replacement");
  });
});
