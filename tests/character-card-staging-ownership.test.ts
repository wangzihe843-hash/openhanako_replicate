import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCharacterCardService } from "../lib/character-cards/service.ts";
import { extractZip } from "../lib/extract-zip.ts";

describe("character-card staging asset paths", () => {
  let home: string;
  let agents: string;
  let skills: string;
  let engine: {
    hanakoHome: string; agentsDir: string; userSkillsDir: string; skillsDir: string;
    productDir: string; cwd: string; getAllSkills: () => unknown[];
    getAgent?: () => { agentDir: string; factStore: { exportAll: () => unknown[] } };
  };

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "hana-card-staging-"));
    agents = path.join(home, "agents");
    skills = path.join(home, "skills");
    fs.mkdirSync(agents, { recursive: true });
    fs.mkdirSync(skills, { recursive: true });
    engine = { hanakoHome: home, agentsDir: agents, userSkillsDir: skills, skillsDir: skills, productDir: home, cwd: home, getAllSkills: () => [] };
  });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(home, { recursive: true, force: true }); });

  function makeAgent(ext: string, contents: Buffer) {
    const dir = path.join(agents, "hana");
    fs.mkdirSync(path.join(dir, "avatars"), { recursive: true });
    fs.writeFileSync(path.join(dir, "config.yaml"), "agent:\n  name: Hana\n  yuan: hanako\n");
    const avatar = path.join(dir, "avatars", `agent.${ext}`);
    fs.writeFileSync(avatar, contents);
    engine.getAgent = () => ({ agentDir: dir, factStore: { exportAll: () => [] } });
    return avatar;
  }

  it("copies a non-PNG avatar into the export token package and ZIP without modifying its source", async () => {
    const content = Buffer.from("sample jpeg asset");
    const avatar = makeAgent("jpg", content);
    const copy = vi.spyOn(fs, "copyFileSync");
    const result = await createCharacterCardService(engine).exportAgentPackage("hana", { targetDir: home });
    const calls = copy.mock.calls.filter(([src]) => String(src) === avatar);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const exportsRoot = path.join(home, ".ephemeral", "character-card-exports") + path.sep;
    for (const [, dst] of calls) {
      const relative = path.relative(exportsRoot, String(dst)).split(path.sep);
      expect(relative).toHaveLength(4);
      expect(relative[0]).toMatch(/^[a-f0-9]{24}$/);
      expect(relative.slice(1, 3)).toEqual(["package", "assets"]);
      expect(["avatar.jpg", "card-front.jpg"]).toContain(relative[3]);
    }
    const out = path.join(home, "unzipped");
    fs.mkdirSync(out);
    await extractZip(result.filePath, out);
    expect(fs.readFileSync(path.join(out, "assets", "avatar.jpg"))).toEqual(content);
    expect(fs.readFileSync(avatar)).toEqual(content);
    expect(fs.readdirSync(skills)).toEqual([]);
  });

  it("allocates a suffix inside the import token package for an existing default-avatar name", async () => {
    const pkg = path.join(home, "input");
    fs.mkdirSync(path.join(pkg, "assets"), { recursive: true });
    fs.writeFileSync(path.join(pkg, "assets", "hana-default-avatar.png"), "existing");
    fs.writeFileSync(path.join(pkg, "card.json"), JSON.stringify({ kind: "CharacterCard", agent: { name: "Hana", yuan: "hanako" } }));
    const result = await createCharacterCardService(engine).createImportPlanFromPath(pkg);
    const stage = path.join(home, ".ephemeral", "character-card-imports", result.token);
    const plan = JSON.parse(fs.readFileSync(path.join(stage, "plan.json"), "utf8"));
    expect(plan.packageRoot).toBe(path.join(stage, "package"));
    expect(plan.assets.avatar.rel).toBe("assets/hana-default-avatar-1.png");
    expect(fs.readFileSync(path.join(stage, "package", "assets", "hana-default-avatar.png"), "utf8")).toBe("existing");
    expect(fs.existsSync(path.join(stage, "package", plan.assets.avatar.rel))).toBe(true);
    expect(fs.readFileSync(path.join(pkg, "assets", "hana-default-avatar.png"), "utf8")).toBe("existing");
  });

  it("fails malformed agent PNG export without publishing a ZIP or modifying the source", async () => {
    const bad = Buffer.from("not a valid PNG");
    const avatar = makeAgent("png", bad);
    await expect(createCharacterCardService(engine).exportAgentPackage("hana", { targetDir: home })).rejects.toThrow();
    expect(fs.readFileSync(avatar)).toEqual(bad);
    expect(fs.readdirSync(home).filter((name) => name.endsWith(".zip"))).toEqual([]);
    const exportsRoot = path.join(home, ".ephemeral", "character-card-exports");
    expect(fs.readdirSync(exportsRoot)).toEqual([]);
    expect(fs.readdirSync(skills)).toEqual([]);
  });
});
