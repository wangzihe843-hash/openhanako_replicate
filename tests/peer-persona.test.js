import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCompactPeerPersona, PEER_PERSONA_MAX_CHARS } from "../lib/desk/peer-persona.js";

let agentsDir;

beforeEach(() => {
  agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "peer-persona-"));
});

afterEach(() => {
  try { fs.rmSync(agentsDir, { recursive: true, force: true }); } catch {}
});

function writePublicIshiki(peerId, content) {
  const dir = path.join(agentsDir, peerId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "public-ishiki.md"), content, "utf-8");
}

describe("readCompactPeerPersona", () => {
  it("returns '' when file missing", () => {
    expect(readCompactPeerPersona({ agentsDir, peerId: "ghost" })).toBe("");
  });

  it("returns '' when file empty / whitespace", () => {
    writePublicIshiki("ming", "   \n  \n");
    expect(readCompactPeerPersona({ agentsDir, peerId: "ming" })).toBe("");
  });

  it("returns '' on bad input", () => {
    expect(readCompactPeerPersona({ agentsDir: "", peerId: "ming" })).toBe("");
    expect(readCompactPeerPersona({ agentsDir, peerId: "" })).toBe("");
  });

  it("fills {{agentName}} / {{agentId}} / {{userName}} placeholders", () => {
    writePublicIshiki("ming", "我是 {{agentName}}（{{agentId}}），认识 {{userName}} 很久了。");
    const out = readCompactPeerPersona({ agentsDir, peerId: "ming", peerName: "明", userName: "阿星" });
    expect(out).toContain("明");
    expect(out).toContain("ming");
    expect(out).toContain("阿星");
    expect(out).not.toContain("{{");
  });

  it("strips markdown headers, comments, and leftover placeholders", () => {
    writePublicIshiki("ming", [
      "# 标题应被去掉",
      "<!-- 注释也去掉 -->",
      "正文保留 {{unknownPlaceholder}} 之后。",
    ].join("\n"));
    const out = readCompactPeerPersona({ agentsDir, peerId: "ming", peerName: "明" });
    expect(out).toContain("正文保留");
    expect(out).not.toContain("标题应被去掉");
    expect(out).not.toContain("注释");
    expect(out).not.toContain("{{");
  });

  it("collapses whitespace into single line", () => {
    writePublicIshiki("ming", "第一行。\n\n\n第二行。\t第三段。");
    const out = readCompactPeerPersona({ agentsDir, peerId: "ming" });
    expect(out).not.toContain("\n");
    expect(out).not.toMatch(/\s{2,}/);
  });

  it("truncates long persona to ~maxChars with ellipsis", () => {
    const long = "句子。".repeat(300); // 远超 240
    writePublicIshiki("ming", long);
    const out = readCompactPeerPersona({ agentsDir, peerId: "ming", maxChars: PEER_PERSONA_MAX_CHARS });
    // 截断到句末标点（。）→ 不一定带省略号，但长度必须被压下来
    expect(out.length).toBeLessThanOrEqual(PEER_PERSONA_MAX_CHARS + 1);
    expect(out.length).toBeGreaterThan(0);
  });

  it("keeps short persona intact (no ellipsis)", () => {
    writePublicIshiki("ming", "钟与共鸣，喜欢安静。");
    const out = readCompactPeerPersona({ agentsDir, peerId: "ming" });
    expect(out).toBe("钟与共鸣，喜欢安静。");
    expect(out.endsWith("…")).toBe(false);
  });
});
