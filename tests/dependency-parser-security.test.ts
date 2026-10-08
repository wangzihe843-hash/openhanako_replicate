import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import yaml from "js-yaml";
import { parseSkillMetadata } from "../lib/skills/skill-metadata.ts";
import { parseMarkdownFrontMatter } from "../desktop/src/react/utils/markdown-document.ts";

describe("YAML parser security and frontmatter compatibility", () => {
  it.each(["{}", "{name: repeated}"])("bounds repeated merge sources including %s", mapping => {
    const raw = `source: &source ${mapping}\nitems:\n${"  - <<: *source\n".repeat(10001)}`;
    expect(() => yaml.load(raw)).toThrow(/maxTotalMergeKeys/);
    const onError = vi.fn();
    const markdown = `---\n${raw}---\nBody`;
    expect(parseSkillMetadata(markdown, "fallback", onError).name).toBe("fallback");
    expect(onError).toHaveBeenCalledOnce();
    expect(parseMarkdownFrontMatter(markdown)).toMatchObject({
      attributes: {}, body: "Body", error: expect.stringMatching(/maxTotalMergeKeys/),
    });
  });

  it("also rejects oversized merge sequences before expanding their sources", () => {
    const raw = `sources: &sources [${Array(110).fill("{}").join(",")}]\nmerged: {<<: *sources}`;
    expect(() => yaml.load(raw)).toThrow(/abnormal merge sequence size/);
  });

  it("preserves ordinary aliases, merge precedence, dates, booleans and block text", () => {
    const markdown = `---
defaults: &defaults
  description: |
    First line.
    Second line.
  default-enabled: false
<<: *defaults
name: safe-skill
date: 2026-10-07
items: [one, two]
---
Body`;
    expect(parseSkillMetadata(markdown)).toMatchObject({ name: "safe-skill", description: "First line. Second line.", defaultEnabled: false });
    expect(parseMarkdownFrontMatter(markdown)?.attributes).toMatchObject({
      date: new Date("2026-10-07T00:00:00.000Z"), items: ["one", "two"],
    });
  });

  it("preserves ordered mappings without quadratic duplicate-key scans", () => {
    const source = `!!omap\n${Array.from({ length: 4000 }, (_, i) => `- k${i}: ${i}\n`).join("")}`;
    const parsed = yaml.load(source) as unknown[];
    expect(parsed).toHaveLength(4000);
    expect(parsed[3999]).toEqual({ k3999: 3999 });
  });
});

describe("Markdown enabled linkify and typographer security", () => {
  // Use a bounded child process so a regression cannot wedge the test worker.
  // These are the enabled options in chat, document and screenshot renderers.
  it.each(["emails", "schemes", "quotes"])("completes the %s stress case within a bounded process", kind => {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import MarkdownIt from 'markdown-it';
      const md = new MarkdownIt({ linkify: true, typographer: true });
      const input = ${JSON.stringify(kind)} === 'emails' ? 'a@b.co\\n'.repeat(20000)
        : ${JSON.stringify(kind)} === 'schemes' ? 'a://'.repeat(40000) : '"'.repeat(160000);
      const output = md.render(input);
      assert.ok(output.length > 0);
      if (${JSON.stringify(kind)} === 'emails') assert.equal((output.match(/href="mailto:/g)||[]).length, 20000);
      assert.ok(md.render('**bold** https://example.invalid').includes('<strong>bold</strong>'));
    `], { encoding: "utf8", timeout: 5000 });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  });
});
