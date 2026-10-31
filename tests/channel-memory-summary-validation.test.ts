import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../core/llm-client.ts", async original => ({
  ...await original<typeof import("../core/llm-client.ts")>(), callText: vi.fn(),
}));
import { callText } from "../core/llm-client.ts";
import { ChannelRouter } from "../hub/channel-router.ts";
import { FactStore } from "../lib/memory/fact-store.ts";
import { appendMessage, createChannel, readBookmarks } from "../lib/channels/channel-store.ts";
import { createChannelTicker } from "../lib/channels/channel-ticker.ts";
import { loadLocale } from "../lib/i18n.ts";

const llm = vi.mocked(callText);
const cleanup: (() => void)[] = [];
beforeEach(() => { loadLocale("en"); llm.mockReset(); });
afterEach(() => { for (const close of cleanup.splice(0)) close(); vi.restoreAllMocks(); });

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "channel-summary-validation-"));
  const agentsDir = path.join(root, "agents"), memoryDir = path.join(agentsDir, "hana", "memory");
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, "hana", "config.yaml"), "agent:\n  name: Hana\nmemory:\n  enabled: true\n");
  const facts = new FactStore(path.join(memoryDir, "facts.db"), { agentId: "hana" });
  facts.importAll([
    { fact: "oldquartz Hana chose Friday", session_id: "channel-ch_crew", tags: ["crew"] },
    { fact: "otherquartz another group", session_id: "channel-else", tags: [] },
    { fact: "ownerquartz protected", session_id: "channel-ch_crew", tags: [], memoryScope: { agentId: "else", realm: "legacy" } },
    { fact: "scopequartz protected", session_id: "channel-ch_crew", tags: [], memoryScope: { agentId: "hana", realm: "reality" } },
  ]);
  const agent = { factStore: facts, memoryMdPath: path.join(memoryDir, "memory.md"), memoryMasterEnabled: true };
  const engine = {
    agentsDir, channelsDir: path.join(root, "channels"), getAgent: () => agent,
    resolveUtilityConfigFresh: async () => ({ utility: "mock", api_key: "fake", base_url: "https://mock.invalid", api: "openai-completions" }),
  };
  const router = new ChannelRouter({ hub: { engine, eventBus: { emit: vi.fn() } } });
  const rows = () => facts.db.prepare("SELECT * FROM facts ORDER BY id").all();
  const fts = () => facts.db.prepare("SELECT rowid, fact FROM facts_fts ORDER BY rowid").all();
  const run = () => router._memorySummarize("hana", "ch_crew", {
    messages: [{ sender: "user", timestamp: "2026-10-31 12:00:00", body: "Hana considered the plan" }],
  });
  cleanup.push(() => { facts.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { agentsDir, engine, facts, router, rows, fts, run };
}

it.each([
  "[1,", "[true,", "[null,", "[false,", "[", "[1", "[-1.2e+", "[tru", "[nul",
  '["Hana chose Friday",', '[{"fact":', '[["Hana chose Friday"],',
  "[1]", "[true]", "[null]", '["Hana chose Friday"]', "[[1]]", '["Hana chose Friday",null]',
  "[1 2]", "[true false]", '[null "Hana"]', "[1 true]", '[1 {"fact": "Hana chose Friday"}]',
  "[1.2.3]", "[1e++]", "[1.2.3 true]", "[truee,", "[Hana", "{Hana",
  '{"fact":"Hana chose Friday"}', '{"fact":', "{facts: [", "{", "{}",
  '"Hana chose Friday"', '"Hana chose Friday', "1", "true", "false", "null",
  "```json\n[1,\n```", "```JSON\n[true,\n```", "```json\nHana chose Friday\n```",
  "```json\nNO_MEMORY\n```", "```text\n[null,\n```",
  "```text\nHana chose Friday", "Hana chose Friday\n```", "```\nHana chose Friday",
  "```text\nHana chose Friday\n```\nExplanation", "Explanation\n```text\nHana chose Friday\n```",
  "```text\nHana chose Friday\n```\n```text\nHana returned\n```", "```yaml\nHana chose Friday\n```",
  'Here is the summary:\n["Hana chose Friday",', 'Here is the summary: ["Hana chose Friday",',
  "Summary: true", "Summary: null", "Summary: 1", "Summary:true", "摘要：null", "Here is the summary: false",
  'Hana chose Friday; [true,', 'Hana chose Friday\n{"facts": [', '[1,2]\nHana chose Friday',
  "[] trailing explanation", "Hana chose Friday; []", "", " \n ",
])("rejects incomplete, structured or mixed output without publishing %j", async output => {
  const f = setup(), before = f.rows(), index = f.fts();
  const replace = vi.spyOn(f.facts, "replaceByIds"), error = vi.spyOn(console, "error");
  llm.mockResolvedValue(output);
  await f.run();
  expect(replace).not.toHaveBeenCalled();
  expect(f.rows()).toEqual(before);
  expect(f.fts()).toEqual(index);
  expect(error).toHaveBeenCalledWith(expect.stringContaining("记忆摘要失败"));
});

it.each([
  "[Hana] chose Friday", "[true story] Hana chose Friday", "[null hypothesis] Hana chose Friday",
  "[2026计划] Hana chose Friday", "{Hana} chose Friday", "(After review) Hana chose Friday",
  "[2026] Hana chose Friday", "[1] Hana chose Friday", "[t] chose Friday", "[T] chose Friday", "[f] chose Friday", "[n] chose Friday",
  "[1.2.3] Hana chose Friday",
  "Hana documented [] as an empty array", "Hana chose NO_MEMORY as the test token",
  "Hana documented [1, 2] as sample input", 'Hana documented {"x": 1} as sample input',
  '"Hana" chose Friday', "Hana chose Friday; Lin chose Saturday", "42 attendees joined Hana",
  "true friendship matters to Hana", "Hana chose Friday\nLin chose Saturday",
  "Hana chose 12:30 for the meeting", "Hana wrote: [Hana] chose Friday",
  "```text\n[Hana] chose Friday\n```", "```\nHana chose Friday\n```",
])("publishes ordinary fact text, including bracket-leading text %j", async output => {
  const f = setup(), before = f.rows();
  const error = vi.spyOn(console, "error");
  llm.mockResolvedValue(output);
  await f.run();
  const summary = output.startsWith("```") ? output.split("\n")[1] : output;
  expect(f.facts.getBySession("channel-ch_crew").map(row => row.fact)).toEqual([`[#ch_crew] ${summary}`]);
  expect(f.rows().filter(row => row.fact !== `[#ch_crew] ${summary}`)).toEqual(before.filter(row => !row.fact.startsWith("oldquartz")));
  expect(f.facts.db.prepare("SELECT rowid FROM facts_fts WHERE facts_fts MATCH 'oldquartz'").all()).toEqual([]);
  expect(f.facts.db.prepare("SELECT rowid FROM facts_fts WHERE facts_fts MATCH 'Friday'").all()).toHaveLength(summary.includes("Friday") ? 1 : 0);
  expect(error).not.toHaveBeenCalled();
});

it.each([null, undefined, false, 0, [], { facts: ["Hana chose Friday"] }])("rejects non-text model output %j", async output => {
  const f = setup(), before = f.rows(), index = f.fts();
  const replace = vi.spyOn(f.facts, "replaceByIds"), error = vi.spyOn(console, "error");
  llm.mockResolvedValue(output as never); // Exercise an invalid provider result outside callText's contract.
  await f.run();
  expect(replace).not.toHaveBeenCalled();
  expect(f.rows()).toEqual(before);
  expect(f.fts()).toEqual(index);
  expect(error).toHaveBeenCalledWith(expect.stringContaining("记忆摘要失败"));
});

it.each(["NO_MEMORY", " \tno_memory\n", "无记忆", "[]", "[ \n ]", "```JSON\n[]\n```", "```text\nNO_MEMORY\n```"])("keeps exact no-additions output a successful no-op %j", async output => {
  const f = setup(), before = f.rows(), index = f.fts();
  const replace = vi.spyOn(f.facts, "replaceByIds"), error = vi.spyOn(console, "error");
  llm.mockResolvedValue(output);
  await f.run();
  expect(replace).not.toHaveBeenCalled();
  expect(f.rows()).toEqual(before);
  expect(f.fts()).toEqual(index);
  expect(error).not.toHaveBeenCalled();
});

it.each(["[1,", "[true,", "[null,"])("ticker logs malformed summary and preserves facts without claiming retry %j", async output => {
  const f = setup(), before = f.rows(), index = f.fts();
  const channel = await createChannel(f.engine.channelsDir, { id: "crew", members: ["hana", "else"] });
  const msg = await appendMessage(channel.filePath, "user", "Hana agreed to the plan");
  const check = vi.fn(async () => ({ replied: false, passed: true }));
  const ticker = createChannelTicker({
    agentsDir: f.agentsDir, channelsDir: f.engine.channelsDir, getAgentOrder: () => ["hana"], executeCheck: check,
    captureMemoryContext: id => f.router._captureMemoryContext(id),
    onMemorySummarize: (id, name, payload) => f.router._memorySummarize(id, name, payload),
  });
  const error = vi.spyOn(console, "error");
  llm.mockResolvedValue(output);
  try {
    await ticker.triggerImmediate(channel.id);
    expect(readBookmarks(path.join(f.agentsDir, "hana", "channels.md")).get(channel.id)).toBe(msg.timestamp);
    await ticker.triggerImmediate(channel.id);
    expect(llm).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledTimes(1);
    expect(f.rows()).toEqual(before);
    expect(f.fts()).toEqual(index);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("记忆摘要失败"));
  } finally { await ticker.stop(); }
});

// This table tests the publication language, not a list of JSON keyword misspellings.
// A boundary-leading container needs a complete text label AND an outside fact body.
const invalidBoundaryForms = [
  ...["True", "FALSE", "NULL", "truee", "nullx", "undefined", "NaN", "Infinity", "garbage", "错误"].flatMap(token => [
    `[${token},]`, `[${token}]`, `[${token},`, `{${token}}`,
  ]),
  '["Hana",] chose Friday', '[1,2] Hana chose Friday', '{"fact":"Hana"} chose Friday',
  '[Hana] true', '"Hana": "Friday"', '[2026] [true,]', '"Hana\\q" chose Friday',
];
const invalidBoundaryVariants = invalidBoundaryForms.flatMap(output => [
  output, ` \t${output}\r\n`, `Hana chose Friday; ${output}`,
  `Hana chose Friday\n${output}`, `Here is the summary: ${output}`, `\`\`\`text\n${output}\n\`\`\``,
]);
it.each(invalidBoundaryVariants)("rejects a structural boundary under context/wrapping transformations %j", output => {
  const router = Object.create(ChannelRouter.prototype) as ChannelRouter;
  const normalized = router._normalizeChannelMemorySummary(output);
  expect(router._isEmptyChannelMemorySummary(normalized)).toBe(false);
  expect(router._isStructuredChannelMemorySummary(normalized)).toBe(true);
});

const textBoundaryForms = [
  ...["2026", "2026-10-31", "2026/10/31", "1", "1.2.3", "花子", "true story", "null hypothesis", "2026计划", "2026-10-31 12:30"].flatMap(label => [
    `[${label}]花子决定周六见面`, `[${label}] Hana chose Friday`,
  ]),
  '{花子}决定周六见面', '"花子"决定周六见面', '"Hana" chose Friday',
  'Hana documented {"x":"sample; [True,]"} as sample input',
  'Hana wrote "a; [truee,]" in the manual',
  'Hana documented {"x": [1, 2],\n"y": "example"} as sample input',
  'Hana quoted “周六见面” in her diary',
  'Hana chose Friday; Lin chose Saturday',
];
const textBoundaryVariants = textBoundaryForms.flatMap(output => [output, ` \t${output}\r\n`, `\`\`\`text\n${output}\n\`\`\``]);
it.each(textBoundaryVariants)("keeps text publication invariant under whitespace and text fences %j", output => {
  const router = Object.create(ChannelRouter.prototype) as ChannelRouter;
  const normalized = router._normalizeChannelMemorySummary(output);
  expect(router._isEmptyChannelMemorySummary(normalized)).toBe(false);
  expect(router._isStructuredChannelMemorySummary(normalized)).toBe(false);
});

it.each([
  '[True,]', '[truee,]', '[unknown,]', '[错误,]', '{unknown}', '[1,2] Hana chose Friday',
  'Hana chose Friday; [True,]', 'Here is the summary: [truee,]',
])("keeps actual database and FTS intact at a rejected publication boundary %j", async output => {
  const f = setup(), before = f.rows(), index = f.fts();
  const replace = vi.spyOn(f.facts, "replaceByIds"), error = vi.spyOn(console, "error");
  llm.mockResolvedValue(output); await f.run();
  expect(replace).not.toHaveBeenCalled(); expect(f.rows()).toEqual(before); expect(f.fts()).toEqual(index);
  expect(error).toHaveBeenCalledWith(expect.stringContaining("记忆摘要失败"));
});

it.each([
  '[2026]花子决定周六见面', '[2026-10-31 12:30]花子决定周六见面', '"花子"决定周六见面',
  'Hana documented {"x":"sample; [True,]"} as sample input',
  'Hana wrote "a; [truee,]" in the manual',
])("publishes legal labels and embedded quotations through the real store %j", async output => {
  const f = setup(), before = f.rows(), error = vi.spyOn(console, "error");
  llm.mockResolvedValue(output); await f.run();
  expect(f.facts.getBySession("channel-ch_crew").map(row => row.fact)).toEqual([`[#ch_crew] ${output}`]);
  expect(f.rows().filter(row => row.fact !== `[#ch_crew] ${output}`)).toEqual(before.filter(row => !row.fact.startsWith("oldquartz")));
  expect(f.facts.db.prepare("SELECT rowid FROM facts_fts WHERE facts_fts MATCH 'oldquartz'").all()).toEqual([]);
  expect(error).not.toHaveBeenCalled();
});

it.each([
  '[Oct 31, 2026] Hana chose Friday', '[Hana, Lin] chose Friday', '[1, p.4]花子决定周六见面',
  '[“花子”]决定周六见面', '[O’Connor] chose Friday',
  'Hana said: "Meet Friday"', 'Hana documented this sample: {"x": [1, 2]}',
  'Hana wrote “a; [True,]” in her diary',
])("retains natural-language dates, citations and quoted content %j", async output => {
  const f = setup(), error = vi.spyOn(console, "error");
  llm.mockResolvedValue(output); await f.run();
  expect(f.facts.getBySession("channel-ch_crew").map(row => row.fact)).toEqual([`[#ch_crew] ${output}`]);
  expect(error).not.toHaveBeenCalled();
});

it.each(['[True,] Hana chose Friday', '[true,false] Hana chose Friday', '[1e+,3] Hana chose Friday', '[01,2] Hana chose Friday'])("does not turn data delimiters into text labels %j", async output => {
  const f = setup(), before = f.rows(), index = f.fts(), error = vi.spyOn(console, "error");
  llm.mockResolvedValue(output); await f.run();
  expect(f.rows()).toEqual(before); expect(f.fts()).toEqual(index);
  expect(error).toHaveBeenCalledWith(expect.stringContaining("记忆摘要失败"));
});

// v4 publication contract: contentless structural fragments fail at a fact
// boundary; punctuation within a complete natural-language label is not data.
const contentlessFragments = [
  "[", "]", "{", "}", "(", ")", "<", ">", '"', "'", "“”,", "‘’", "()", "{}",
  "][", "}{", "...", "…", "?!", "？！。", "——", "_", "###", "+-*/", "，、",
];
const v4InvalidForms = [
  ...contentlessFragments, "] Hana confirmed Saturday", "}花子确认周六见面",
  '[Hana', '{花子', '"Hana', '[Hana,] chose Saturday', '[花子、]决定周六见面',
  '[、琳]决定周六见面', '[Hana，，Lin] chose Saturday', '[true、false] Hana confirmed Saturday',
  '[1，2]花子确认周六见面', '["Hana", "Lin"] chose Saturday',
];
it.each(v4InvalidForms.flatMap(output => [
  output, ` \t${output}\r\n`, `Hana confirmed Saturday; ${output}`,
  `Hana confirmed Saturday\n${output}`, `Here is the summary: ${output}`,
]))("rejects contentless or structural fragments at actual fact boundaries %j", output => {
  const router = Object.create(ChannelRouter.prototype) as ChannelRouter;
  expect(router._isStructuredChannelMemorySummary(router._normalizeChannelMemorySummary(output))).toBe(true);
});

it.each([" ", "\t\r\n", ";", "；", ";；\n", "\u200b", "...", "。！；\n？", "[,]", "{ }", "[ ] []"])("never classifies an entire contentless response as prose %j", output => {
  const router = Object.create(ChannelRouter.prototype) as ChannelRouter;
  expect(router._isStructuredChannelMemorySummary(router._normalizeChannelMemorySummary(output))).toBe(true);
});

const v4TextLabels = [
  "花子、琳", "花子，琳", "Hana、Lin", "Hana, Lin", "Hana，Lin", "Hana & Lin",
  "O'Connor", "O’Connor", "Jean-Luc, Anaïs", "ハナ・リン", "李·琳", "Ame\u0301lie",
  "2026", "2", "2026/10/31", "Oct 31, 2026", "2, p.10", "“花子、琳”",
  "花子说“周六；周日备选”", "Meeting moved to Saturday",
];
const v4ProseForms = [
  ...v4TextLabels.flatMap(label => [`[${label}]决定周六见面`, `[${label}] confirmed Saturday`]),
  "{花子、琳}决定周六见面", "(Hana, Lin) confirmed Saturday", '"Hana" confirmed Saturday',
  "花子[和琳]决定周六见面", "Hana [and Lin] confirmed Saturday",
  "Hana confirmed [Saturday]", "花子确认了[周六见面]的约定",
  "花子决定周六见面；琳决定带书", "Hana confirmed Saturday; Lin will bring a book",
  'Hana kept "]" and "}" as parser samples', "花子把“]；}”记作示例",
  'Hana recorded {"names":["Hana", "Lin"]} as an example',
];
it.each(v4ProseForms.flatMap(output => [output, ` \t${output}\r\n`, `\`\`\`text\n${output}\n\`\`\``]))("retains natural-language labels and bracketed content without a character whitelist %j", output => {
  const router = Object.create(ChannelRouter.prototype) as ChannelRouter;
  const normalized = router._normalizeChannelMemorySummary(output);
  expect(router._isEmptyChannelMemorySummary(normalized)).toBe(false);
  expect(router._isStructuredChannelMemorySummary(normalized)).toBe(false);
});

const v4PublicationCases = [
  ...[
    "]", "}", "[", "{", "()", "...", ";；\n", " \t\r\n", "Hana confirmed Saturday; ]",
    "Hana confirmed Saturday\n}", "Here is the summary: 。", "```text\n]\n```",
    '["Hana confirmed Saturday"]', '{"fact":"Hana confirmed Saturday"}', '[True,]', '[truee,]',
  ].map(output => ({ kind: "invalid", output })),
  ...[
    "[花子、琳]决定周六见面", "[Hana、Lin] confirmed Saturday", "[O'Connor] confirmed Saturday",
    "[花子说“周六；周日备选”]琳记下安排", "[2026]花子决定周六见面", "[2, p.10] Hana confirmed Saturday",
    "Hana [and Lin] confirmed Saturday", 'Hana kept "]" and "}" as parser samples',
  ].map(output => ({ kind: "valid", output })),
  ...["NO_MEMORY", "无记忆", "[ \n ]", "```JSON\n[]\n```"].map(output => ({ kind: "noop", output })),
];
it.each(v4PublicationCases)("enforces v4 $kind publication with real facts, FTS and owner/scope controls: $output", async ({ kind, output }) => {
  const f = setup(), before = f.rows(), index = f.fts();
  const replace = vi.spyOn(f.facts, "replaceByIds"), error = vi.spyOn(console, "error");
  llm.mockResolvedValue(output); await f.run();
  if (kind === "valid") {
    expect(replace).toHaveBeenCalledTimes(1);
    expect(f.facts.getBySession("channel-ch_crew").map(row => row.fact)).toEqual([`[#ch_crew] ${output}`]);
    expect(f.rows().filter(row => row.fact !== `[#ch_crew] ${output}`)).toEqual(before.filter(row => !row.fact.startsWith("oldquartz")));
    expect(f.fts().filter(row => row.fact !== `[#ch_crew] ${output}`)).toEqual(index.filter(row => !row.fact.startsWith("oldquartz")));
    expect(f.facts.db.prepare("SELECT rowid FROM facts_fts WHERE facts_fts MATCH 'oldquartz'").all()).toEqual([]);
    expect(error).not.toHaveBeenCalled();
  } else {
    expect(replace).not.toHaveBeenCalled(); expect(f.rows()).toEqual(before); expect(f.fts()).toEqual(index);
    if (kind === "invalid") expect(error).toHaveBeenCalledWith(expect.stringContaining("记忆摘要失败"));
    else expect(error).not.toHaveBeenCalled();
  }
});

it.each([
  { output: "]", valid: false }, { output: "Hana confirmed Saturday\n}", valid: false },
  { output: "[花子、琳]决定周六见面", valid: true }, { output: "[Hana，Lin] confirmed Saturday", valid: true },
])("keeps ticker publication and bookmark behavior for the v4 boundary $output", async ({ output, valid }) => {
  const f = setup(), before = f.rows(), index = f.fts();
  const channel = await createChannel(f.engine.channelsDir, { id: "crew", members: ["hana", "else"] });
  const message = await appendMessage(channel.filePath, "user", "Hana and Lin confirmed Saturday");
  const check = vi.fn(async () => ({ replied: false, passed: true }));
  const ticker = createChannelTicker({
    agentsDir: f.agentsDir, channelsDir: f.engine.channelsDir, getAgentOrder: () => ["hana"], executeCheck: check,
    captureMemoryContext: id => f.router._captureMemoryContext(id),
    onMemorySummarize: (id, name, payload) => f.router._memorySummarize(id, name, payload),
  });
  const error = vi.spyOn(console, "error"); llm.mockResolvedValue(output);
  try {
    await ticker.triggerImmediate(channel.id); await ticker.triggerImmediate(channel.id);
    expect(readBookmarks(path.join(f.agentsDir, "hana", "channels.md")).get(channel.id)).toBe(message.timestamp);
    expect(check).toHaveBeenCalledTimes(1); expect(llm).toHaveBeenCalledTimes(1);
    if (valid) {
      expect(f.facts.getBySession("channel-ch_crew").map(row => row.fact)).toEqual([`[#ch_crew] ${output}`]);
      expect(error).not.toHaveBeenCalled();
    } else {
      expect(f.rows()).toEqual(before); expect(f.fts()).toEqual(index);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("记忆摘要失败"));
    }
  } finally { await ticker.stop(); }
});
