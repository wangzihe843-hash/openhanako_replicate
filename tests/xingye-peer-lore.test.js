import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildXingyePeerRelationshipLore } from "../shared/xingye-peer-lore.js";

let hanakoHome;
let agentDir;
const AGENT_ID = "hanako-1";

beforeEach(() => {
  hanakoHome = fs.mkdtempSync(path.join(os.tmpdir(), "peer-lore-"));
  agentDir = path.join(hanakoHome, "agents", AGENT_ID);
  fs.mkdirSync(path.join(agentDir, "xingye", "lore"), { recursive: true });
});

afterEach(() => {
  try { fs.rmSync(hanakoHome, { recursive: true, force: true }); } catch {}
});

/** 写 keyword 类 lore 条目到 agentDir/xingye/lore/entries.json（对象 map 形态）。 */
function writeEntries(entriesById) {
  fs.writeFileSync(
    path.join(agentDir, "xingye", "lore", "entries.json"),
    JSON.stringify(entriesById, null, 2),
    "utf-8",
  );
}

function keywordEntry(over = {}) {
  return {
    id: "e1",
    agentId: AGENT_ID,
    title: "与明的关系",
    content: "明是你关系冷淡的表兄，三年前因为遗产闹翻，至今没和解。",
    category: "relationship",
    keywords: ["明", "ming"],
    enabled: true,
    visibility: "canonical",
    insertionMode: "keyword",
    priority: 50,
    ...over,
  };
}

describe("buildXingyePeerRelationshipLore", () => {
  it("returns the relationship lore when the peer's name/id matches keywords", () => {
    writeEntries({ e1: keywordEntry() });
    const out = buildXingyePeerRelationshipLore({
      agentId: AGENT_ID, agentDir, hanakoHome, peerName: "明", peerId: "ming",
    });
    expect(out).toContain("关系冷淡的表兄");
    expect(out).toContain("遗产闹翻");
  });

  it("matches by id alone (peerName missing)", () => {
    writeEntries({ e1: keywordEntry() });
    const out = buildXingyePeerRelationshipLore({
      agentId: AGENT_ID, agentDir, hanakoHome, peerId: "ming",
    });
    expect(out).toContain("关系冷淡的表兄");
  });

  it("returns '' for a peer that does not match any entry's keywords", () => {
    writeEntries({ e1: keywordEntry() });
    const out = buildXingyePeerRelationshipLore({
      agentId: AGENT_ID, agentDir, hanakoHome, peerName: "小满", peerId: "xiaoman",
    });
    expect(out).toBe("");
  });

  it("does not pick up entries belonging to a different agent", () => {
    writeEntries({ e1: keywordEntry({ agentId: "someone-else" }) });
    const out = buildXingyePeerRelationshipLore({
      agentId: AGENT_ID, agentDir, hanakoHome, peerName: "明", peerId: "ming",
    });
    expect(out).toBe("");
  });

  it("ignores disabled / non-canonical / non-keyword entries", () => {
    writeEntries({
      a: keywordEntry({ id: "a", enabled: false }),
      b: keywordEntry({ id: "b", visibility: "draft" }),
      c: keywordEntry({ id: "c", insertionMode: "always" }),
    });
    const out = buildXingyePeerRelationshipLore({
      agentId: AGENT_ID, agentDir, hanakoHome, peerName: "明", peerId: "ming",
    });
    expect(out).toBe("");
  });

  it("returns '' on missing dir / bad input without throwing", () => {
    expect(buildXingyePeerRelationshipLore({ agentId: AGENT_ID, agentDir, hanakoHome, peerId: "ming" })).toBe("");
    expect(buildXingyePeerRelationshipLore({})).toBe("");
    expect(buildXingyePeerRelationshipLore({ agentId: AGENT_ID, agentDir })).toBe(""); // 没给 peer
  });

  it("resolves entries from agentDir even without hanakoHome", () => {
    writeEntries({ e1: keywordEntry() });
    const out = buildXingyePeerRelationshipLore({
      agentId: AGENT_ID, agentDir, peerName: "明", peerId: "ming",
    });
    expect(out).toContain("关系冷淡的表兄");
  });
});
