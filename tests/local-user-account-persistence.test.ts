import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { clearLocalAccountPassword, setLocalAccountPassword, updateLocalAccountProfile } from "../core/local-user-account.ts";
import { createAccessRoute } from "../server/routes/access.ts";

const roots: string[] = [];
const makeRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-owner-test-"));
  roots.push(root);
  fs.writeFileSync(path.join(root, "users.json"), JSON.stringify({ schemaVersion: 1, defaultUserId: "owner", users: [{ userId: "owner", displayName: "Owner", createdAt: "old", updatedAt: "old" }], createdAt: "old", updatedAt: "old" }));
  return root;
};
const read = (root: string, file: string) => fs.readFileSync(path.join(root, file), "utf8");
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("local account persistence isolation", () => {
  it("keeps authentication bytes during profile updates and user bytes through password lifecycle", () => {
    const root = makeRoot();
    setLocalAccountPassword(root, { password: "initial password", now: "first" });
    const authBytes = read(root, "local-user-auth.json");
    updateLocalAccountProfile(root, { displayName: "Updated", now: "profile" });
    expect(read(root, "local-user-auth.json")).toBe(authBytes);
    const usersBytes = read(root, "users.json");
    const auth = JSON.parse(authBytes);
    auth.credentials.push({ ...auth.credentials[0], userId: "another", createdAt: "other" });
    fs.writeFileSync(path.join(root, "local-user-auth.json"), JSON.stringify(auth));
    setLocalAccountPassword(root, { password: "rotated password", now: "second" });
    const rotated = JSON.parse(read(root, "local-user-auth.json"));
    expect(rotated.credentials.find((c: {userId: string}) => c.userId === "owner").createdAt).toBe("first");
    expect(rotated.credentials.find((c: {userId: string}) => c.userId === "another")).toEqual(auth.credentials[1]);
    expect(read(root, "users.json")).toBe(usersBytes);
    clearLocalAccountPassword(root, { now: "third" });
    expect(JSON.parse(read(root, "local-user-auth.json")).credentials).toEqual([auth.credentials[1]]);
    expect(read(root, "users.json")).toBe(usersBytes);
  });

  it("preserves the existing partial success when auth is invalid after the profile write", () => {
    const root = makeRoot();
    fs.writeFileSync(path.join(root, "local-user-auth.json"), "{ broken");
    expect(() => updateLocalAccountProfile(root, { displayName: "Saved" })).toThrow(/invalid local-user-auth/);
    expect(JSON.parse(read(root, "users.json")).users[0].displayName).toBe("Saved");
    expect(read(root, "local-user-auth.json")).toBe("{ broken");
  });

  it("creates an empty auth record when clearing a missing password", () => {
    const root = makeRoot();
    clearLocalAccountPassword(root);
    expect(JSON.parse(read(root, "local-user-auth.json")).credentials).toEqual([]);
  });

  it("does not overwrite invalid auth during password operations", () => {
    const root = makeRoot();
    fs.writeFileSync(path.join(root, "local-user-auth.json"), "{ broken");
    const users = read(root, "users.json");
    expect(() => setLocalAccountPassword(root, { password: "test password" })).toThrow(/invalid local-user-auth/);
    expect(() => clearLocalAccountPassword(root)).toThrow(/invalid local-user-auth/);
    expect(read(root, "local-user-auth.json")).toBe("{ broken");
    expect(read(root, "users.json")).toBe(users);
  });

  it.skipIf(process.platform === "win32")("keeps the original save behavior when chmod fails", () => {
    const root = makeRoot();
    vi.spyOn(fs, "chmodSync").mockImplementation(() => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
    expect(() => setLocalAccountPassword(root, { password: "test password" })).not.toThrow();
    expect(JSON.parse(read(root, "local-user-auth.json")).credentials).toHaveLength(1);
  });

  it.each([
    ["PUT", "/access/account/profile", { displayName: "No" }],
    ["PUT", "/access/account/password", { password: "test password" }],
    ["DELETE", "/access/account/password", undefined],
  ])("rejects non-owner %s %s without writing either store", async (method, route, body) => {
    const root = makeRoot();
    const original = read(root, "users.json");
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("authPrincipal" as never, { kind: "device", credentialKind: "device_credential", connectionKind: "remote" } as never);
      await next();
    });
    app.route("/", createAccessRoute({ engine: { hanakoHome: root } }));
    const response = await app.request(route, { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    expect(response.status).toBe(403);
    expect(read(root, "users.json")).toBe(original);
    expect(fs.existsSync(path.join(root, "local-user-auth.json"))).toBe(false);
  });

  it.each(["mkdirSync", "writeFileSync", "renameSync"] as const)("propagates %s failure and leaves the prior target intact", (method) => {
    const root = makeRoot();
    const before = read(root, "users.json");
    const real = fs[method] as unknown as (...args: unknown[]) => unknown;
    vi.spyOn(fs, method).mockImplementation(((...args: unknown[]) => {
      const target = String(args[0]);
      if ((method === "mkdirSync" && target === root) || (method === "writeFileSync" && target === path.join(root, "users.json.tmp")) || (method === "renameSync" && target === path.join(root, "users.json.tmp"))) throw new Error("injected failure");
      return real(...args);
    }) as never);
    expect(() => updateLocalAccountProfile(root, { displayName: "No" })).toThrow("injected failure");
    expect(read(root, "users.json")).toBe(before);
    expect(fs.existsSync(path.join(root, "users.json.tmp"))).toBe(false);
  });

  it.each(["mkdirSync", "writeFileSync", "renameSync"] as const)("propagates authentication %s failure and retains both prior files", (method) => {
    const root = makeRoot();
    setLocalAccountPassword(root, { password: "initial password" });
    const beforeAuth = read(root, "local-user-auth.json");
    const beforeUsers = read(root, "users.json");
    const real = fs[method] as unknown as (...args: unknown[]) => unknown;
    vi.spyOn(fs, method).mockImplementation(((...args: unknown[]) => {
      const target = String(args[0]);
      if ((method === "mkdirSync" && target === root) || (method === "writeFileSync" && target === path.join(root, "local-user-auth.json.tmp")) || (method === "renameSync" && target === path.join(root, "local-user-auth.json.tmp"))) throw new Error("injected auth failure");
      return real(...args);
    }) as never);
    expect(() => setLocalAccountPassword(root, { password: "rotated password" })).toThrow("injected auth failure");
    expect(read(root, "local-user-auth.json")).toBe(beforeAuth);
    expect(read(root, "users.json")).toBe(beforeUsers);
    expect(fs.existsSync(path.join(root, "local-user-auth.json.tmp"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("creates temporary and final files with owner-only POSIX permissions", () => {
    const root = makeRoot();
    const modes: number[] = [];
    const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => { modes.push(fs.statSync(from).mode & 0o777); return rename(from, to); });
    setLocalAccountPassword(root, { password: "test password" });
    expect(modes).toEqual([0o600]);
    expect(fs.statSync(path.join(root, "local-user-auth.json")).mode & 0o777).toBe(0o600);
  });
});
