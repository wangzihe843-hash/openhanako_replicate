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
  fs.rmSync(hanakoHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
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

  it("uses exact structured identity matching for overlapping peer names", () => {
    writeEntries({
      ming: keywordEntry({ id: "ming", content: "明是普通同事。" }),
      xiaoming: keywordEntry({
        id: "xiaoming",
        title: "与小明的关系",
        content: "小明是你的亲弟弟。",
        keywords: ["小明", "xiaoming"],
      }),
    });
    const out = buildXingyePeerRelationshipLore({
      agentId: AGENT_ID, agentDir, hanakoHome, peerName: "小明", peerId: "xiaoming",
    });
    expect(out).toContain("小明是你的亲弟弟");
    expect(out).not.toContain("明是普通同事");
  });

  it("does not pick up entries belonging to a different agent", () => {
    writeEntries({ e1: keywordEntry({ agentId: "someone-else" }) });
    const out = buildXingyePeerRelationshipLore({
      agentId: AGENT_ID, agentDir, hanakoHome, peerName: "明", peerId: "ming",
    });
    expect(out).toBe("");
  });

  it("ignores disabled / non-canonical / manual entries", () => {
    writeEntries({
      a: keywordEntry({ id: "a", enabled: false }),
      b: keywordEntry({ id: "b", visibility: "draft" }),
      c: keywordEntry({ id: "c", insertionMode: "manual" }),
    });
    const out = buildXingyePeerRelationshipLore({
      agentId: AGENT_ID, agentDir, hanakoHome, peerName: "明", peerId: "ming",
    });
    expect(out).toBe("");
  });

  it("ignores a topical worldview keyword that happens to match the peer", () => {
    writeEntries({
      e1: keywordEntry({
        category: "worldview",
        title: "明城",
        content: "明城采用宵禁制度，这不是一条人物关系。",
      }),
    });
    expect(buildXingyePeerRelationshipLore({
      agentId: AGENT_ID, agentDir, hanakoHome, peerName: "明", peerId: "ming",
    })).toBe("");
  });

  it("recognizes legacy always peer relationships for existing agents", () => {
    writeEntries({ e1: keywordEntry({ insertionMode: "always" }) });
    const out = buildXingyePeerRelationshipLore({
      agentId: AGENT_ID, agentDir, hanakoHome, peerName: "明", peerId: "ming",
    });
    expect(out).toContain("关系冷淡的表兄");
  });

  it("keeps a legacy Lore Studio relationship linked by exact agent id after rename", () => {
    writeEntries({
      legacy: keywordEntry({
        insertionMode: "always",
        keywords: ["Old Display Name"],
        content: "This is an independent agent (id: legacy-peer). You grew up together.",
      }),
      collision: keywordEntry({
        id: "collision",
        insertionMode: "always",
        keywords: ["Someone Else"],
        content: "This is an independent agent (id: legacy-peer-2). You are rivals.",
      }),
    });
    const out = buildXingyePeerRelationshipLore({
      agentId: AGENT_ID,
      agentDir,
      hanakoHome,
      peerName: "Renamed Peer",
      peerId: "legacy-peer",
    });
    expect(out).toContain("You grew up together.");
    expect(out).not.toContain("You are rivals.");
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
