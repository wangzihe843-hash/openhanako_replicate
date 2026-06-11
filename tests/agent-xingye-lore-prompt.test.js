import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../core/agent.js";

function makeAgent() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-agent-xingye-lore-"));
  const agentsDir = path.join(root, "agents");
  const productDir = path.join(root, "product");
  const userDir = path.join(root, "user");
  const agentDir = path.join(agentsDir, "hana");

  fs.mkdirSync(path.join(productDir, "yuan"), { recursive: true });
  fs.mkdirSync(path.join(agentDir, "memory"), { recursive: true });
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(productDir, "yuan", "hanako.md"), "yuan", "utf-8");
  fs.writeFileSync(path.join(agentDir, "identity.md"), "identity", "utf-8");
  fs.writeFileSync(path.join(agentDir, "ishiki.md"), "ishiki", "utf-8");
  fs.writeFileSync(path.join(agentDir, "pinned.md"), "Pinned memory stays.", "utf-8");
  fs.writeFileSync(path.join(agentDir, "memory", "memory.md"), "Compiled memory stays.", "utf-8");

  const agent = new Agent({
    id: "hana",
    agentsDir,
    productDir,
    userDir,
  });
  agent._config = {
    locale: "en",
    agent: { name: "Hana", yuan: "hanako" },
    memory: { enabled: true },
  };
  agent.agentName = "Hana";
  agent.userName = "User";
  agent._memoryMasterEnabled = true;
  agent._memorySessionEnabled = true;
  agent._experienceEnabled = false;

  return { agent, root, agentDir };
}

function writeManagedLore(agentDir, body = "Stable Xingye lore summary.") {
  const loreDir = path.join(agentDir, "xingye");
  fs.mkdirSync(loreDir, { recursive: true });
  fs.writeFileSync(
    path.join(loreDir, "lore-memory.md"),
    [
      "# Xingye Lore Memory",
      "",
      "<!-- xingye-lore-memory:managed=true agentId=hana -->",
      "",
      "## Managed Stable Lore",
      "",
      "<!-- xingye-lore:id=lore-1 agentId=hana category=background updatedAt=2026-01-02T00:00:00.000Z -->",
      "### Origin",
      body,
      "<!-- /xingye-lore:id=lore-1 -->",
    ].join("\n"),
    "utf-8",
  );
}

function writeProfile(agentDir, profile) {
  const dir = path.join(agentDir, "xingye");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify(profile, null, 2), "utf-8");
}

function writeWorkspaceRuntimeLore(root, entries) {
  const loreDir = path.join(root, ".xingye", "agents", "hana");
  fs.mkdirSync(loreDir, { recursive: true });
  fs.writeFileSync(
    path.join(loreDir, "lore.json"),
    JSON.stringify(entries, null, 2),
    "utf-8",
  );
}

function writeAgentMirrorRuntimeLore(agentDir, entries) {
  const loreDir = path.join(agentDir, "xingye");
  fs.mkdirSync(loreDir, { recursive: true });
  fs.writeFileSync(
    path.join(loreDir, "lore.json"),
    JSON.stringify(entries, null, 2),
    "utf-8",
  );
}

/** Official HANA_HOME lore store mirror (same path readXingyeRuntimeLoreEntriesSync prefers first). */
function writeAgentLoreEntriesJson(agentDir, data) {
  const dir = path.join(agentDir, "xingye", "lore");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "entries.json"), JSON.stringify(data, null, 2), "utf-8");
}

function runtimeLore(overrides = {}) {
  return {
    id: overrides.id ?? "runtime-1",
    agentId: overrides.agentId ?? "hana",
    title: overrides.title ?? "Moon Observatory",
    content: overrides.content ?? "The moon observatory opens only during silver rain.",
    category: overrides.category ?? "location",
    keywords: overrides.keywords ?? ["observatory"],
    enabled: overrides.enabled ?? true,
    priority: overrides.priority ?? 50,
    insertionMode: overrides.insertionMode ?? "keyword",
    visibility: overrides.visibility ?? "canonical",
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-02T00:00:00.000Z",
  };
}

describe("agent Xingye lore prompt", () => {
  const roots = [];

  afterEach(() => {
    vi.restoreAllMocks();
    while (roots.length) {
      fs.rmSync(roots.pop(), { recursive: true, force: true });
    }
  });

  it("injects Xingye stable lore after native pinned and memory content", () => {
    const { agent, root, agentDir } = makeAgent();
    roots.push(root);
    writeManagedLore(agentDir);

    const prompt = agent.buildSystemPrompt();
    const pinnedIndex = prompt.indexOf("Pinned memory stays.");
    const memoryIndex = prompt.indexOf("Compiled memory stays.");
    const xingyeIndex = prompt.indexOf("# 星野核心设定");

    expect(prompt).toContain("# 星野核心设定");
    expect(prompt).toContain("Stable Xingye lore summary.");
    expect(prompt).toContain("Pinned memory stays.");
    expect(prompt).toContain("Compiled memory stays.");
    expect(pinnedIndex).toBeGreaterThan(-1);
    expect(memoryIndex).toBeGreaterThan(pinnedIndex);
    expect(xingyeIndex).toBeGreaterThan(memoryIndex);
  });

  it("work mode <-> 角色扮演 双向对称：profile(性别/关系) + lore 与工作向 clause 互斥", () => {
    const { agent, root, agentDir } = makeAgent();
    roots.push(root);
    writeProfile(agentDir, {
      gender: "female",
      relationshipLabel: "恋人",
      relationshipMode: "亲密",
    });
    writeManagedLore(agentDir);
    writeWorkspaceRuntimeLore(root, [runtimeLore()]);

    // ── 工作模式 ON：剥离 4 个星野注入位（性别/关系/核心设定/关键词 lore），注入工作向 clause ──
    const workPrompt = agent.buildSystemPrompt({
      workModeEnabled: true,
      xingyeWorkspaceRoot: root,
      userText: "Can we go to the observatory?",
    });
    // makeAgent 用 locale "en"：性别/关系段是英文标题；lore 标题恒为中文。
    expect(workPrompt).not.toContain("# Role Gender and Pronoun Rules"); // profile.gender
    expect(workPrompt).not.toContain("# Your Relationship with User");   // profile.relationship
    expect(workPrompt).not.toContain("# 星野核心设定");          // stable lore
    expect(workPrompt).not.toContain("Stable Xingye lore summary.");
    expect(workPrompt).not.toContain("# 星野设定参考");          // runtime keyword lore
    expect(workPrompt).toContain("## Work Mode");
    expect(workPrompt).toContain("## Visible UI Context");
    // 基础人格层（pinned/记忆）始终保留
    expect(workPrompt).toContain("Pinned memory stays.");
    expect(workPrompt).toContain("Compiled memory stays.");

    // ── 工作模式 OFF（默认角色扮演）：4 个星野注入位全在、且绝无工作向 clause ──
    const rolePrompt = agent.buildSystemPrompt({
      xingyeWorkspaceRoot: root,
      userText: "Can we go to the observatory?",
    });
    expect(rolePrompt).toContain("# Role Gender and Pronoun Rules");
    expect(rolePrompt).toContain("# Your Relationship with User");
    expect(rolePrompt).toContain("# 星野核心设定");
    expect(rolePrompt).toContain("Stable Xingye lore summary.");
    expect(rolePrompt).toContain("# 星野设定参考");
    expect(rolePrompt).not.toContain("## Work Mode");
    expect(rolePrompt).not.toContain("## Visible UI Context");

    // 显式传 workModeEnabled:false 必须与不传完全等价（默认即关闭）
    const explicitOff = agent.buildSystemPrompt({
      workModeEnabled: false,
      xingyeWorkspaceRoot: root,
      userText: "Can we go to the observatory?",
    });
    expect(explicitOff).toBe(rolePrompt);
  });

  it("does not inject an empty Xingye section when lore-memory.md is absent", () => {
    const { agent, root } = makeAgent();
    roots.push(root);

    const prompt = agent.buildSystemPrompt();

    expect(prompt).not.toContain("# 星野核心设定");
    expect(prompt).not.toContain("undefined");
  });

  it("fails closed when the agent id is unavailable", () => {
    const { agent, root, agentDir } = makeAgent();
    roots.push(root);
    writeManagedLore(agentDir);
    agent.id = "";

    const prompt = agent.buildSystemPrompt();

    expect(prompt).not.toContain("# 星野核心设定");
    expect(prompt).not.toContain("undefined");
  });

  it("fails closed when reading Xingye lore fails", () => {
    const { agent, root, agentDir } = makeAgent();
    roots.push(root);
    const lorePath = path.join(agentDir, "xingye", "lore-memory.md");
    fs.mkdirSync(lorePath, { recursive: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const prompt = agent.buildSystemPrompt();

    expect(prompt).not.toContain("# 星野核心设定");
    expect(prompt).not.toContain("undefined");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("injects matched Xingye keyword runtime lore from workspace entries", () => {
    const { agent, root } = makeAgent();
    roots.push(root);
    writeWorkspaceRuntimeLore(root, [runtimeLore()]);

    const prompt = agent.buildSystemPrompt({
      xingyeWorkspaceRoot: root,
      userText: "Can we go to the observatory?",
    });

    expect(prompt).toContain("# 星野设定参考");
    expect(prompt).toContain("The moon observatory opens only during silver rain.");
  });

  it("tries agent mirror runtime lore when workspace cwd is unavailable", () => {
    const { agent, root, agentDir } = makeAgent();
    roots.push(root);
    writeAgentMirrorRuntimeLore(agentDir, [runtimeLore()]);

    const prompt = agent.buildSystemPrompt({
      userText: "Can we go to the observatory?",
    });

    expect(prompt).toContain("# 星野设定参考");
    expect(prompt).toContain("The moon observatory opens only during silver rain.");
  });

  it("does not inject Xingye keyword runtime lore when user text and recent messages do not match", () => {
    const { agent, root } = makeAgent();
    roots.push(root);
    writeWorkspaceRuntimeLore(root, [runtimeLore()]);

    const prompt = agent.buildSystemPrompt({
      xingyeWorkspaceRoot: root,
      userText: "Let's visit the market.",
      recentMessages: ["No relevant topic here."],
    });

    expect(prompt).not.toContain("# 星野设定参考");
    expect(prompt).not.toContain("The moon observatory opens only during silver rain.");
  });

  it("excludes disabled draft manual and always lore from the runtime block", () => {
    const { agent, root } = makeAgent();
    roots.push(root);
    writeWorkspaceRuntimeLore(root, [
      runtimeLore({ id: "disabled", enabled: false, content: "disabled lore" }),
      runtimeLore({ id: "draft", visibility: "draft", content: "draft lore" }),
      runtimeLore({ id: "manual", insertionMode: "manual", content: "manual lore" }),
      runtimeLore({ id: "always", insertionMode: "always", content: "always lore" }),
    ]);

    const prompt = agent.buildSystemPrompt({
      xingyeWorkspaceRoot: root,
      userText: "observatory",
    });

    expect(prompt).not.toContain("# 星野设定参考");
    expect(prompt).not.toContain("disabled lore");
    expect(prompt).not.toContain("draft lore");
    expect(prompt).not.toContain("manual lore");
    expect(prompt).not.toContain("always lore");
  });

  it("keeps stable lore before runtime lore when both are present", () => {
    const { agent, root, agentDir } = makeAgent();
    roots.push(root);
    writeManagedLore(agentDir);
    writeWorkspaceRuntimeLore(root, [runtimeLore()]);

    const prompt = agent.buildSystemPrompt({
      xingyeWorkspaceRoot: root,
      userText: "observatory",
    });
    const stableIndex = prompt.indexOf("# 星野核心设定");
    const runtimeIndex = prompt.indexOf("# 星野设定参考");

    expect(stableIndex).toBeGreaterThan(-1);
    expect(runtimeIndex).toBeGreaterThan(stableIndex);
  });

  it("injects a single stable heading from lore-memory only; no bracket stable title; lore/entries.json always is not merged into chat stable", () => {
    const { agent, root, agentDir } = makeAgent();
    roots.push(root);
    writeManagedLore(agentDir, "Stable from lore-memory only.");
    writeAgentLoreEntriesJson(agentDir, {
      "json-always-1": {
        id: "json-always-1",
        agentId: "hana",
        title: "WouldDuplicateIfMergedTwice",
        content: "DUPLICATE_MARKER_FROM_ENTRIES_JSON",
        category: "background",
        insertionMode: "always",
        enabled: true,
        visibility: "canonical",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
      "kw-1": runtimeLore({ id: "kw-1" }),
    });
    writeWorkspaceRuntimeLore(root, [runtimeLore({ id: "ws-only", content: "should not be read when entries.json wins" })]);

    const prompt = agent.buildSystemPrompt({
      xingyeWorkspaceRoot: root,
      userText: "observatory",
    });

    expect((prompt.match(/# 星野核心设定/g) || []).length).toBe(1);
    expect(prompt).not.toContain("【星野核心设定】");
    expect(prompt).toContain("Stable from lore-memory only.");
    expect(prompt).not.toContain("DUPLICATE_MARKER_FROM_ENTRIES_JSON");
    expect(prompt).toContain("# 星野设定参考");
    expect(prompt).toContain("The moon observatory opens only during silver rain.");
    expect(prompt).not.toContain("should not be read when entries.json wins");
  });

  it("fails closed when runtime lore entries cannot be read", () => {
    const { agent, root } = makeAgent();
    roots.push(root);
    const lorePath = path.join(root, ".xingye", "agents", "hana", "lore.json");
    fs.mkdirSync(lorePath, { recursive: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const prompt = agent.buildSystemPrompt({
      xingyeWorkspaceRoot: root,
      userText: "observatory",
    });

    expect(prompt).not.toContain("# 星野设定参考");
    expect(prompt).not.toContain("undefined");
    expect(warn).not.toHaveBeenCalled();
  });
});
