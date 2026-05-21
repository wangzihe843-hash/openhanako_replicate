/**
 * 不变量：xingye_propose_draft 的 SUPPORTED_MODULES 与两个隐性 sink 保持同步——
 *
 *  1. lib/desk/heartbeat.js 里 mustPropose=true 时给 agent 的 directive 菜单。
 *     菜单是硬编码的中/英文 bullet 列表；模块加进 enum、忘了补菜单 → agent 永远
 *     不会从这个模块挑（默认它"不在备选"），但既有测试只手写了一个 `toContain`
 *     列表，会跟 enum 漂移。
 *
 *  2. desktop/src/react/xingye/Phone{Module}App.test.tsx（或对应 Panel）里的
 *     「待确认草稿区」UI 集成测试。doc/xingye-propose-draft.md 标了「容易忘」，
 *     2026-05 接入六个模块时全跳过过——本测试逼着开发者主动登记。
 *
 * 两个方向（enum→sink、sink→enum）都校验：
 *  - enum 多了项 → directive / UI 测试缺 → 红。
 *  - sink 多了项 → MODULE_UI_FIXTURES 没登记 → 红。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import { XINGYE_PROPOSE_DRAFT_SUPPORTED_MODULES } from "../lib/tools/xingye-propose-draft-tool.js";
import { createHeartbeat } from "../lib/desk/heartbeat.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

/**
 * 显式登记每个模块的 UI 入口与测试文件——加新模块时这张表会与 SUPPORTED_MODULES
 * 漂移并在 `keys equal SUPPORTED_MODULES` case 红。
 *
 *  - src：实际 UI 组件文件，必须包含「待确认草稿」section（用于辅助开发者定位）。
 *  - test：对应的 vitest .test.tsx，必须断言 confirmVerb / discardVerb 两条路径。
 *  - confirmVerb / discardVerb：渲染端 draft store 暴露的函数名（命名不齐——
 *    confirmJournalDraft / confirmMomentDraft（单数）/ confirmReadingNoteDraft
 *    （单数）/ confirmFileDraft（单数）等都不一致，所以显式写）。marker 检查只看
 *    test 文件文本里有没有这两个 verb，命名错了立刻红。
 *
 * 加新模块时：grep `^export async function confirm[A-Z]` desktop/src/react/xingye/
 * 找到对应 verb 名，登记进来；如果待确认草稿区物理上嵌在别的 Panel/App 里
 * （如 memory_candidate 嵌在 SecretSpacePanel），test 指向那个共享的 .test.tsx。
 */
const MODULE_UI_FIXTURES = {
  journal:            { src: "desktop/src/react/xingye/PhoneJournalApp.tsx",        test: "desktop/src/react/xingye/PhoneJournalApp.test.tsx",       confirmVerb: "confirmJournalDraft",          discardVerb: "discardJournalDraft" },
  schedule:           { src: "desktop/src/react/xingye/PhoneScheduleApp.tsx",       test: "desktop/src/react/xingye/PhoneScheduleApp.test.tsx",      confirmVerb: "confirmScheduleDraft",         discardVerb: "discardScheduleDraft" },
  moments:            { src: "desktop/src/react/xingye/MomentsPanel.tsx",           test: "desktop/src/react/xingye/MomentsPanel.test.tsx",          confirmVerb: "confirmMomentDraft",           discardVerb: "discardMomentDraft" },
  mail:               { src: "desktop/src/react/xingye/PhoneMailApp.tsx",           test: "desktop/src/react/xingye/PhoneMailApp.test.tsx",          confirmVerb: "confirmMailDraft",             discardVerb: "discardMailDraft" },
  shopping:           { src: "desktop/src/react/xingye/PhoneShoppingApp.tsx",       test: "desktop/src/react/xingye/PhoneShoppingApp.test.tsx",      confirmVerb: "confirmShoppingDraft",         discardVerb: "discardShoppingDraft" },
  files:              { src: "desktop/src/react/xingye/PhoneFilesApp.tsx",          test: "desktop/src/react/xingye/PhoneFilesApp.test.tsx",         confirmVerb: "confirmFileDraft",             discardVerb: "discardFileDraft" },
  secret_space:       { src: "desktop/src/react/xingye/SecretSpacePanel.tsx",       test: "desktop/src/react/xingye/SecretSpacePanel.test.tsx",      confirmVerb: "confirmSecretSpaceDraft",      discardVerb: "discardSecretSpaceDraft" },
  reading_notes:      { src: "desktop/src/react/xingye/PhoneReadingNotesApp.tsx",   test: "desktop/src/react/xingye/PhoneReadingNotesApp.test.tsx",  confirmVerb: "confirmReadingNoteDraft",      discardVerb: "discardReadingNoteDraft" },
  divination:         { src: "desktop/src/react/xingye/PhoneDivinationApp.tsx",     test: "desktop/src/react/xingye/PhoneDivinationApp.drafts.test.tsx", confirmVerb: "confirmDivinationDraft",   discardVerb: "discardDivinationDraft" },
  // memory_candidate 的待确认草稿区物理上挂在 SecretSpacePanel 的 memory_fragment
  // 视图里（pendingMemoryCandidateDrafts），不在独立的 MemoryCandidatePanel.tsx 里。
  // 所以 test 指向 SecretSpacePanel.test.tsx，与 secret_space 共享文件——但 verb 不同。
  memory_candidate:   { src: "desktop/src/react/xingye/SecretSpacePanel.tsx",       test: "desktop/src/react/xingye/SecretSpacePanel.test.tsx",      confirmVerb: "confirmMemoryCandidateDraft",  discardVerb: "discardMemoryCandidateDraft" },
  relationship_state: { src: "desktop/src/react/xingye/RelationshipStatePanel.tsx", test: "desktop/src/react/xingye/RelationshipStatePanel.test.tsx", confirmVerb: "confirmRelationshipStateDraft", discardVerb: "discardRelationshipStateDraft" },
  phone_contact:      { src: "desktop/src/react/xingye/PhoneContactsApp.tsx",       test: "desktop/src/react/xingye/PhoneContactsApp.test.tsx",      confirmVerb: "confirmPhoneContactDraft",     discardVerb: "discardPhoneContactDraft" },
  sms:                { src: "desktop/src/react/xingye/PhoneSmsApp.tsx",            test: "desktop/src/react/xingye/PhoneSmsApp.test.tsx",           confirmVerb: "confirmSmsDraft",              discardVerb: "discardSmsDraft" },
  // news / interview 走「意图草稿」模型：草稿只带 angle / userQuestion，确认时 UI 才跑
  // 重型生成。confirm verb 因此是 confirmNewsDraftWithEntry / confirmInterviewDraftWithEntry
  // （带 WithEntry 后缀，区别于「草稿即成品」模块的 confirmXxxDraft）。interview 的待确认
  // 草稿区物理上挂在 SecretSpacePanel 的 interview 视图里。
  news:               { src: "desktop/src/react/xingye/PhoneNewsApp.tsx",          test: "desktop/src/react/xingye/PhoneNewsApp.test.tsx",          confirmVerb: "confirmNewsDraftWithEntry",      discardVerb: "discardNewsDraft" },
  interview:          { src: "desktop/src/react/xingye/SecretSpacePanel.tsx",       test: "desktop/src/react/xingye/SecretSpacePanel.test.tsx",      confirmVerb: "confirmInterviewDraftWithEntry", discardVerb: "discardInterviewDraft" },
};

/**
 * 用 createHeartbeat 接 onBeat 拿到完整 prompt——比直接 import buildHeartbeatContext
 * 干净（那个是模块内部函数）。staleness mustPropose=true 触发 directive 段。
 */
async function renderMustProposeDirective(locale) {
  let captured = null;
  const hb = createHeartbeat({
    onBeat: async (p) => {
      captured = p;
      return { ok: true };
    },
    getEventSummary: async () => ({
      consumed: 0,
      skipped: true,
      autoDraftStaleness: {
        lastAutoDraftAt: null,
        chatTurnsSinceLastDraft: 60,
        mustPropose: true,
      },
    }),
    intervalMinutes: 31,
    locale,
  });
  await hb.runHeartbeatOnce({ reason: "coverage-test" });
  return captured;
}

describe("heartbeat directive ↔ SUPPORTED_MODULES (zh)", () => {
  it.each(XINGYE_PROPOSE_DRAFT_SUPPORTED_MODULES)(
    "must-propose directive (zh) mentions `%s`",
    async (moduleName) => {
      const prompt = await renderMustProposeDirective("zh-CN");
      expect(prompt, `zh directive missing module "${moduleName}" — add it to lib/desk/heartbeat.js mustPropose bullet list`)
        .toMatch(new RegExp("`" + moduleName + "`"));
    },
  );
});

describe("heartbeat directive ↔ SUPPORTED_MODULES (en)", () => {
  it.each(XINGYE_PROPOSE_DRAFT_SUPPORTED_MODULES)(
    "must-propose directive (en) mentions `%s`",
    async (moduleName) => {
      const prompt = await renderMustProposeDirective("en-US");
      expect(prompt, `en directive missing module "${moduleName}" — add it to lib/desk/heartbeat.js mustPropose bullet list`)
        .toMatch(new RegExp("`" + moduleName + "`"));
    },
  );
});

describe("UI fixtures ↔ SUPPORTED_MODULES", () => {
  it("MODULE_UI_FIXTURES keys equal SUPPORTED_MODULES (bi-directional)", () => {
    const fromEnum = [...XINGYE_PROPOSE_DRAFT_SUPPORTED_MODULES].sort();
    const fromMap = Object.keys(MODULE_UI_FIXTURES).sort();
    expect(fromMap).toEqual(fromEnum);
  });

  it.each(XINGYE_PROPOSE_DRAFT_SUPPORTED_MODULES)(
    "module `%s` has its registered UI source file on disk",
    (moduleName) => {
      const fixture = MODULE_UI_FIXTURES[moduleName];
      if (!fixture) return;
      expect(
        fs.existsSync(path.join(REPO_ROOT, fixture.src)),
        `expected ${fixture.src} to exist (UI source for module "${moduleName}")`,
      ).toBe(true);
    },
  );

  it.each(XINGYE_PROPOSE_DRAFT_SUPPORTED_MODULES)(
    "module `%s` has its registered UI test file on disk",
    (moduleName) => {
      const fixture = MODULE_UI_FIXTURES[moduleName];
      if (!fixture) return;
      expect(
        fs.existsSync(path.join(REPO_ROOT, fixture.test)),
        `expected ${fixture.test} to exist (UI integration test for module "${moduleName}" — see docs/xingye-propose-draft.md step ⑪)`,
      ).toBe(true);
    },
  );

  it.each(XINGYE_PROPOSE_DRAFT_SUPPORTED_MODULES)(
    "UI test for `%s` exercises confirm + discard paths against the drafts store",
    (moduleName) => {
      const fixture = MODULE_UI_FIXTURES[moduleName];
      if (!fixture) return;
      const filePath = path.join(REPO_ROOT, fixture.test);
      if (!fs.existsSync(filePath)) return; // 上一个 case 已经红了，避免双重失败
      const src = fs.readFileSync(filePath, "utf-8");
      expect(
        src,
        `${fixture.test}: must reference ${fixture.confirmVerb} (this is the module-specific confirm verb; ensure the test exercises that draft store)`,
      ).toContain(fixture.confirmVerb);
      expect(
        src,
        `${fixture.test}: must reference ${fixture.discardVerb} (this is the module-specific discard verb; ensure the test exercises that draft store)`,
      ).toContain(fixture.discardVerb);
    },
  );
});
