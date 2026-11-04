import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureLocalIdentityRegistries, loadServerIdentity } from "../core/server-identity.ts";

const read = (root: string, name: string) => fs.readFileSync(path.join(root, name), "utf8");
const write = (root: string, name: string, value: unknown) => fs.writeFileSync(path.join(root, name), JSON.stringify(value, null, 2) + "\n");

describe("identity persistence behavior", () => {
  it.each(["server-node.json", "users.json", "studios.json"])("preserves completed writes and retries after publication of %s fails", (failed) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "identity-behavior-"));
    try {
      const names = ["server-node.json", "users.json", "studios.json"];
      const original = fs.renameSync;
      const trace: string[] = [];
      const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
        const target = path.basename(String(to));
        if (names.includes(target)) { trace.push(target); if (target === failed) throw new Error("injected failure"); }
        return original(from, to);
      });
      try { expect(() => ensureLocalIdentityRegistries(root)).toThrow("injected failure"); } finally { spy.mockRestore(); }
      const index = names.indexOf(failed);
      expect(trace).toEqual(names.slice(0, index + 1));
      const before = names.slice(0, index).map((name) => read(root, name));
      for (const name of names.slice(index)) expect(fs.existsSync(path.join(root, name))).toBe(false);
      const result = ensureLocalIdentityRegistries(root);
      expect(names.slice(0, index).map((name) => read(root, name))).toEqual(before);
      expect(result.created.filter((name) => names.includes(name))).toEqual(names.slice(index));
      expect(loadServerIdentity(root)).toMatchObject({ userId: expect.any(String), studioId: expect.any(String) });
      expect(ensureLocalIdentityRegistries(root).created).toEqual([]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("persists legacy spaces as studios without rewriting the legacy source", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "identity-behavior-"));
    try {
      ensureLocalIdentityRegistries(root);
      const studio = JSON.parse(read(root, "studios.json"));
      const legacy = { schemaVersion: 1, defaultSpaceId: studio.defaultStudioId, spaces: studio.studios.map(({studioId, ...rest}) => ({spaceId: studioId, ...rest})), createdAt: studio.createdAt, updatedAt: studio.updatedAt };
      fs.unlinkSync(path.join(root, "studios.json"));
      write(root, "spaces.json", legacy);
      const previous = read(root, "spaces.json");
      const result = ensureLocalIdentityRegistries(root);
      expect(result.migratedFromLegacySpaces).toBe(true);
      expect(result.created).toContain("studios.json");
      expect(read(root, "spaces.json")).toBe(previous);
      expect(loadServerIdentity(root).studioId).toBe(legacy.defaultSpaceId);
      write(root, "spaces.json", { invalid: true });
      expect(ensureLocalIdentityRegistries(root).migratedFromLegacySpaces).toBe(false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("repairs the default user to an existing studio owner without reporting creation", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "identity-behavior-"));
    try {
      ensureLocalIdentityRegistries(root);
      const users = JSON.parse(read(root, "users.json"));
      const old = users.users[0];
      users.users.push({ ...old, userId: "user_second" });
      write(root, "users.json", users);
      const studios = JSON.parse(read(root, "studios.json"));
      studios.studios[0].ownerUserId = "user_second";
      write(root, "studios.json", studios);
      const beforeStudio = read(root, "studios.json");
      expect(ensureLocalIdentityRegistries(root).created).toEqual([]);
      expect(JSON.parse(read(root, "users.json")).defaultUserId).toBe("user_second");
      expect(read(root, "studios.json")).toBe(beforeStudio);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it.each(["legacy", "default-user", "orphan-owner"])("retries %s after its identity publication fails", (scenario) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "identity-behavior-"));
    try {
      ensureLocalIdentityRegistries(root);
      const users = JSON.parse(read(root, "users.json"));
      const studios = JSON.parse(read(root, "studios.json"));
      let target: string;
      if (scenario === "legacy") {
        const legacy = { schemaVersion: 1, defaultSpaceId: studios.defaultStudioId, spaces: studios.studios.map(({studioId, ...rest}) => ({spaceId: studioId, ...rest})), createdAt: studios.createdAt, updatedAt: studios.updatedAt };
        write(root, "spaces.json", legacy);
        fs.unlinkSync(path.join(root, "studios.json"));
        target = "studios.json";
      } else if (scenario === "default-user") {
        users.users.push({ ...users.users[0], userId: "user_second" });
        studios.studios[0].ownerUserId = "user_second";
        write(root, "users.json", users);
        write(root, "studios.json", studios);
        target = "users.json";
      } else {
        studios.studios[0].ownerUserId = "user_deleted";
        write(root, "studios.json", studios);
        target = "studios.json";
      }
      const before = fs.existsSync(path.join(root, target)) ? read(root, target) : null;
      const original = fs.renameSync;
      const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
        if (String(to) === path.join(root, target)) throw new Error("injected repair failure");
        return original(from, to);
      });
      try { expect(() => ensureLocalIdentityRegistries(root)).toThrow("injected repair failure"); } finally { spy.mockRestore(); }
      expect(fs.existsSync(path.join(root, target)) ? read(root, target) : null).toBe(before);
      const result = ensureLocalIdentityRegistries(root);
      expect(result.created.includes(target)).toBe(scenario === "legacy");
      expect(result.migratedFromLegacySpaces).toBe(scenario === "legacy");
      const identity = loadServerIdentity(root);
      if (scenario === "default-user") expect(identity.userId).toBe("user_second");
      if (scenario === "orphan-owner") expect(identity.userId).toBe(users.defaultUserId);
      if (scenario === "legacy") expect(identity.studioId).toBe(studios.defaultStudioId);
      expect(ensureLocalIdentityRegistries(root).created).toEqual([]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
