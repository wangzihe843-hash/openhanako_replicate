/**
 * 不变量：xingye_propose_draft 工具的 SUPPORTED_MODULES 枚举与
 * skills2set/xingye-{module}-draft/ 目录必须保持双向一致。
 *
 * 双向是有意的：
 *  - enum → skill：模块在工具里 dispatch 通了，但没有对应 skill 给 agent 解释「什么时候提议、
 *    哪些字段、怎么写」，agent 会乱用或不用，模块名出现在 system prompt 里没意义。
 *  - skill → enum：skill 写了一份「该怎么提议 X 草稿」，但工具其实根本不接 X，agent 调一次失败一次。
 *
 * 加新模块时违反任一方向会在这里红，给开发者一个清晰的 fix-point。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { XINGYE_PROPOSE_DRAFT_SUPPORTED_MODULES } from "../lib/tools/xingye-propose-draft-tool.js";
import { parseSkillMetadata } from "../lib/skills/skill-metadata.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SKILLS_SET_DIR = path.join(REPO_ROOT, "skills2set");
const SKILL_NAME_PREFIX = "xingye-";
const SKILL_NAME_SUFFIX = "-draft";

function skillDirForModule(moduleName) {
  return path.join(SKILLS_SET_DIR, `${SKILL_NAME_PREFIX}${moduleName}${SKILL_NAME_SUFFIX}`);
}

function expectedSkillName(moduleName) {
  return `${SKILL_NAME_PREFIX}${moduleName}${SKILL_NAME_SUFFIX}`;
}

/**
 * 扫 skills2set/ 下所有形如 xingye-*-draft 的目录，提取中间的 module 名。
 * 比文件名拆分多挡一道：忽略未含 SKILL.md 的空目录，避免拷贝残留误报。
 */
function listXingyeDraftSkillModules() {
  if (!fs.existsSync(SKILLS_SET_DIR)) return [];
  const result = [];
  for (const entry of fs.readdirSync(SKILLS_SET_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    if (!name.startsWith(SKILL_NAME_PREFIX) || !name.endsWith(SKILL_NAME_SUFFIX)) continue;
    if (!fs.existsSync(path.join(SKILLS_SET_DIR, name, "SKILL.md"))) continue;
    const middle = name.slice(SKILL_NAME_PREFIX.length, name.length - SKILL_NAME_SUFFIX.length);
    if (middle) result.push(middle);
  }
  return result.sort();
}

describe("xingye_propose_draft enum ↔ skills2set drift guard", () => {
  it("SUPPORTED_MODULES is non-empty (otherwise the tool has nothing to dispatch)", () => {
    expect(XINGYE_PROPOSE_DRAFT_SUPPORTED_MODULES.length).toBeGreaterThan(0);
  });

  it("every SUPPORTED_MODULES entry has a matching skills2set/xingye-{module}-draft/SKILL.md", () => {
    const missing = [];
    for (const moduleName of XINGYE_PROPOSE_DRAFT_SUPPORTED_MODULES) {
      const file = path.join(skillDirForModule(moduleName), "SKILL.md");
      if (!fs.existsSync(file)) missing.push(`module=${moduleName} → ${path.relative(REPO_ROOT, file)}`);
    }
    expect(missing, [
      "Some SUPPORTED_MODULES have no matching skill markdown.",
      "Either remove the module from SUPPORTED_MODULES, or add the skill at:",
      ...missing,
    ].join("\n")).toEqual([]);
  });

  it("each skill's frontmatter `name` matches the directory name", () => {
    const mismatches = [];
    for (const moduleName of XINGYE_PROPOSE_DRAFT_SUPPORTED_MODULES) {
      const file = path.join(skillDirForModule(moduleName), "SKILL.md");
      if (!fs.existsSync(file)) continue; // covered by the test above
      const meta = parseSkillMetadata(fs.readFileSync(file, "utf-8"), expectedSkillName(moduleName));
      if (meta.name !== expectedSkillName(moduleName)) {
        mismatches.push(`${path.relative(REPO_ROOT, file)}: frontmatter name="${meta.name}" but dir suggests "${expectedSkillName(moduleName)}"`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("every xingye-*-draft skill on disk is covered by SUPPORTED_MODULES (reverse direction)", () => {
    const onDisk = listXingyeDraftSkillModules();
    const inEnum = new Set(XINGYE_PROPOSE_DRAFT_SUPPORTED_MODULES);
    const orphans = onDisk.filter((m) => !inEnum.has(m));
    expect(orphans, [
      "Found xingye-*-draft skill directories that the dispatch tool does NOT support:",
      ...orphans.map((m) => `  - skills2set/${SKILL_NAME_PREFIX}${m}${SKILL_NAME_SUFFIX}/  (add "${m}" to SUPPORTED_MODULES + a switch case, or delete the skill)`),
    ].join("\n")).toEqual([]);
  });
});
