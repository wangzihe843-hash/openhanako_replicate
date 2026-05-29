/**
 * heartbeat.js — 日常巡检 + 笺目录扫描
 *
 * 让 agent 从被动应答变成主动行动的关键机制。
 * 两个阶段：
 *   Phase 1: 工作台文件变化检测
 *   Phase 2: 笺扫描（根目录 + 一级子目录的 jian.md，指纹比对后隔离执行）
 *
 * 定时任务（cron）由独立的 cron-scheduler 调度，不经过巡检。
 */

import fs from "fs";
import path from "path";
import { atomicWriteSync } from "../../shared/safe-fs.js";
import { createHash } from "crypto";
import { Type, StringEnum } from "../pi-sdk/index.js";
import { debugLog, createModuleLogger } from "../debug-log.js";
import {
  WORKSPACE_OUTPUT_ROOT_DIRNAME,
  resolveAgentWorkspaceOutputDirs,
  resolveAgentWorkspaceOutputRelativeDirs,
} from "../../shared/workspace-output.js";
import { formatSocialCandidateLines } from "./social-awareness.js";

const log = createModuleLogger("heartbeat");
const EXEC_LOG_START = "<!-- exec-log -->";
const EXEC_LOG_END = "<!-- /exec-log -->";
const JIAN_STATUS_VALUES = ["in_progress", "completed", "skipped", "failed"];
const JIAN_STATUS_LABEL_ZH = {
  in_progress: "进行中",
  completed: "完毕",
  skipped: "已跳过",
  failed: "失败",
};

/**
 * Agent 工作区产物的统一根目录名。
 * 巡检日志与主动创建的文件都收纳在此目录下，避免污染工作区顶层。
 * 快照差量检测需要跳过它，否则巡检自己的写入会把下一轮触发成"有变化"。
 */
export const HEARTBEAT_ACTIVITY_DIR = WORKSPACE_OUTPUT_ROOT_DIRNAME;

/** 12 位 MD5 短指纹 */
function quickHash(str) {
  return createHash("md5").update(str).digest("hex").slice(0, 12);
}

/** 人类可读文件大小 */
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function statusLabel(status, isZh) {
  if (isZh) return JIAN_STATUS_LABEL_ZH[status] || status;
  return status;
}

function markdownFenceFor(text) {
  const matches = String(text || "").match(/`{3,}/g) || [];
  const longest = matches.reduce((max, run) => Math.max(max, run.length), 2);
  return "`".repeat(longest + 1);
}

// ═══════════════════════════════════════
//  Prompt 构建
// ═══════════════════════════════════════

/**
 * 工作台巡检 prompt（支持 i18n）
 *
 * @param {object} opts
 * @param {boolean} opts.deskChanged - 工作区文件是否有变化
 * @param {{added: string[], modified: string[], removed: string[]}} opts.changedFiles - 变化的文件
 * @param {string|null} opts.overwatch
 * @param {string} opts.agentName
 * @param {boolean} opts.isZh
 * @param {string|null} opts.patrolLog - 近期巡检记录（截断后的内容）
 * @param {string} opts.activityDir - 自主活动目录（工作区相对路径，POSIX 风格）
 * @param {string} opts.patrolLogPath - 巡检日志路径（工作区相对路径，POSIX 风格）
 * @param {string|null} opts.xingyeEventSummary - 小手机事件聚合摘要（如 "自上次巡检以来：短信×3、读书批注×5（共 8 条）"）
 * @param {{chatTurnsSinceLastDraft:number, mustPropose:boolean, lastAutoDraftAt:string|null}|null} [opts.autoDraftStaleness]
 *   距离上次主动产出草稿的对话条数（heartbeat-consumer 提供）。mustPropose=true 时
 *   prompt 里会追加一条强约束「本轮必须至少调用一次 xingye_propose_draft」。
 * @param {{shouldSocialize:boolean, overduePeerCount:number, globalChatTurnsSinceLastDm:number, candidatePeers:Array}|null} [opts.socialStaleness]
 *   距离上次主动私信其他 agent 的对话条数（heartbeat-consumer 提供）。shouldSocialize=true
 *   或 overduePeerCount>0 时，追加一段**软**社交提示（点名最久没联系的人，但不强制）。
 *   两个条件都不满足时整段不出现——绝大多数心跳是零社交开销。
 */
function buildHeartbeatContext({ deskChanged, changedFiles, overwatch, agentName, isZh, patrolLog, activityDir, patrolLogPath, xingyeEventSummary, autoDraftStaleness, socialStaleness }) {
  const now = new Date();
  const timeStr = now.toLocaleString(isZh ? "zh-CN" : "en-US", { hour12: false });

  const parts = isZh
    ? [
        `[心跳巡检] 现在是 ${timeStr}`,
        "",
        "**注意：这是系统自动触发的巡检消息，不是用户发来的。用户目前没有在跟你对话，不要把巡检当作用户的提问来回应。**",
        "你需要独立判断是否有需要主动处理的事项，如果有就直接执行，不要向用户提问或等待回复。",
        "",
      ]
    : [
        `[Heartbeat Patrol] Current time: ${timeStr}`,
        "",
        "**Note: This is an automated patrol message, NOT from the user. The user is not currently talking to you — do not treat this as a user query.**",
        "Independently determine if there are items that need proactive handling. If so, act directly — do not ask the user or wait for a reply.",
        "",
      ];

  if (overwatch) {
    parts.push("## Overwatch");
    parts.push(overwatch);
    parts.push("");
  }

  // 工作台文件变化（差量上报）
  if (deskChanged && changedFiles) {
    parts.push(isZh ? "## 工作台文件变动：" : "## Workspace file changes:");
    if (changedFiles.added.length > 0) {
      parts.push(isZh ? "新增：" : "Added:");
      for (const f of changedFiles.added) parts.push(`  + ${f}`);
    }
    if (changedFiles.modified.length > 0) {
      parts.push(isZh ? "修改：" : "Modified:");
      for (const f of changedFiles.modified) parts.push(`  ~ ${f}`);
    }
    if (changedFiles.removed.length > 0) {
      parts.push(isZh ? "删除：" : "Removed:");
      for (const f of changedFiles.removed) parts.push(`  - ${f}`);
    }
    parts.push("");
  } else {
    parts.push(isZh ? "## 工作台状态：无文件变动。" : "## Workspace status: no file changes.");
    parts.push("");
  }

  // 近期巡检记录
  if (patrolLog) {
    parts.push(isZh ? "## 近期巡检记录" : "## Recent Patrol Log");
    parts.push(patrolLog);
    parts.push("");
  }

  // 小手机事件聚合（自上次巡检以来，按类型聚合后的一行）。
  // 故意只塞 summaryZh、不塞 observations 逐条：避免 token 膨胀和 agent 过度反应。
  if (xingyeEventSummary) {
    parts.push(isZh ? "## 小手机事件" : "## Phone events");
    parts.push(xingyeEventSummary);
    parts.push(isZh
      ? "注：以上多为内部活动（朋友圈/阅读批注/记忆候选/关系建议等），通常不需要 notify 用户。只有出现明显的关键信号（秘密空间删除、明显冲着用户来的短信、与 overwatch 主题强相关的内容）时才考虑提醒。"
      : "Note: most of these are internal activity (moments, reading notes, memory candidates, relationship suggestions). Do not notify the user unless there is a clearly important signal (secret-space deletion, an SMS clearly directed at the user, or content strongly tied to the overwatch focus).");
    parts.push("");
    /**
     * 主动更新各小手机/秘密空间模块的「待确认草稿」走 `xingye_propose_draft` dispatch tool。
     *
     * 各模块详细的触发条件、写作要点放在对应的 `xingye-{module}-draft` skill 里，
     * SkillManager 启动时扫描 → 若该 skill 在 agent 的 `config.skills.enabled` 列表里，
     * Pi SDK 自动把内容注入到 system prompt。**不要让 agent 去「读」skill 文件**：
     *  - skill 启用了 → 内容已经在它 prompt 里，无需文件 IO
     *  - 没启用 → 读文件也读不到（沙盒），且没启用就是用户没要这份能力
     *
     * 所以这里的 prompt 只放：(1) tool 总入口、(2) 用户行为后果、(3) 与 notify 的边界、
     * (4) 给没启用 skill 时的最小可工作 fallback。详细写作风格、字段细节让 skill 自己说。
     */
    parts.push(isZh
      ? [
          "如果事件流里有「值得在小手机或秘密空间留下记录」的片段（情绪、约定、决定、转折……），可以调用 `xingye_propose_draft` 提议一条**待确认草稿**。",
          "工具语义：草稿不会出现在用户「已生成」列表，必须用户在对应面板点「确认生成」后才生效；即使用户没立刻打开也不会丢。",
          "和 `notify` 互补：`notify` 是面向用户的提醒，`xingye_propose_draft` 是面向角色生活面板的内容草拟——同一事件二选一。",
          "调用规范：上方 system prompt 里如果出现了 `xingye-{module}-draft` 类的 skill 段落，按它的指导写；**如果没看到对应 skill**，就走默认 fallback：仅在事件信号非常明确时提议，第一人称、贴角色口吻，`reason` 字段必须填，宁可不写也不要硬凑。**不要尝试从文件系统读 SKILL.md**——skill 启用了就已经在 prompt 里，没启用文件也读不到。",
        ].join("\n")
      : [
          "If the event stream contains a moment worth recording in the in-character phone or secret space (an emotional turn, a promise, a decision, a small flutter or worry), call `xingye_propose_draft` to propose a **pending draft**.",
          "Tool semantics: drafts do NOT appear in the user's published list until the user clicks \"确认生成\" in the corresponding panel — even if the user doesn't open it immediately, the draft is persisted and never lost.",
          "`xingye_propose_draft` and `notify` are complementary: `notify` is a user-facing reminder, `xingye_propose_draft` is in-character content drafting — pick one per observation.",
          "Calling rules: if your system prompt above contains an `xingye-{module}-draft` skill block, follow its guidance. **If you don't see such a block**, fall back to the default: propose only when the signal is unambiguous, write in the character's first-person voice, always fill `reason`, prefer not writing over forcing it. **Do not try to read SKILL.md from the filesystem** — when enabled, the skill is already in your prompt; when not enabled, the file is sandboxed away and reading it does not help.",
        ].join("\n"));
    parts.push("");
  }

  /**
   * 「静默太久必须主动产出」directive：和「## 小手机事件」段独立——即便本轮没有
   * 新事件、也没有 xingyeEventSummary，只要 staleness 触发了，也要把这一条挂出来。
   */
  if (autoDraftStaleness?.mustPropose) {
    const turns = autoDraftStaleness.chatTurnsSinceLastDraft;
    parts.push(isZh ? "## 必须主动产出（重要）" : "## Required: produce a draft this round");
    parts.push(isZh
      ? [
          `距离你上次主动产出任意模块的草稿，已累计 ${turns} 条用户对话。本轮**必须**至少调用一次 \`xingye_propose_draft\`，从下列模块中挑你判断"当下最该更新"的那一个产出一条草稿：`,
          "- `journal`（日记）/ `schedule`（日程）/ `moments`（朋友圈）",
          "- `mail`（邮件草稿）/ `shopping`（购物候选）/ `secondhand`（二手出售候选）/ `accounting`（记账：购物 / 二手覆盖不到的原生收支——工资 / 房租 / 餐饮 / 人情 / 利息 …）",
          "- `files`（资料柜归档）/ `secret_space`（state/dream/saved_item 三个分类）",
          "- `reading_notes`（读书批注/疑问）/ `divination`（占卜·心象）",
          "- `memory_candidate`（私藏回忆草稿，确认后写入 memory_fragment；是否再推到 pinned 由用户自定）/ `relationship_state`（关系状态变化建议：5 个 delta + mood）",
          "- `phone_contact`（通讯录草稿：默认 `action='update'`（对**现有联系人**的 remark/impression/relationshipHint/tags/faction 小步更新）；触发明确且只针对**单个** virtual_contact 时，也可 add/block/delete/restore——**批量**造联系人请走通讯录手动 AI 路径，不要用本工具凑数）",
          "- `sms`（短信草稿：拟一条草稿短信由用户确认后发出；可选 contact 引用，长度≤240 字符，仍应短）",
          "- `news`（报纸：提议「出一期多板块小报」的意图——只写一个 angle，整期报纸在用户确认时才生成）/ `interview`（独家专访：提议「录一期 5 题专访」的意图，userQuestion 可空）",
          "  注：`news` / `interview` 是慢节奏模块，没有积累到值得成篇的素材时别硬挑它们；优先选真正最久没更新、且确有内容的模块。",
          "",
          "选择依据是上方「近期巡检记录」+「小手机事件」+ 你对最近聊天的记忆：哪个模块最久没更新、且当前确实有可写的内容？",
          "调用要点照常：先看 system prompt 里对应的 `xingye-{module}-draft` skill 段落（没启用就按默认 fallback 写，`reason` 必填）。**写得短没关系**，宁可短不要硬凑——但本轮**至少要有一条**。",
          "（这是系统层面的健康度约束，不是用户在催。如果你今天确实什么都没观察到，也请挑一个最能反映角色当下状态的模块写一条——例如 `journal` 写「今天没什么特别的事」也合法。）",
        ].join("\n")
      : [
          `${turns} user chat turns have passed since your last self-initiated draft in any module. This round you **MUST** call \`xingye_propose_draft\` at least once. Pick the module you judge "most overdue for an update right now":`,
          "- `journal` / `schedule` / `moments`",
          "- `mail` (draft mail) / `shopping` (wishlist candidate) / `secondhand` (resale candidate) / `accounting` (ledger for native cash-flow outside shopping/secondhand — salary / rent / meals / favors / interest …)",
          "- `files` (archive note) / `secret_space` (state / dream / saved_item)",
          "- `reading_notes` (book annotation / question) / `divination` (heart-image reading)",
          "- `memory_candidate` (private memory_fragment draft; whether to also push to pinned is user's choice) / `relationship_state` (5 deltas + mood suggestion)",
          "- `phone_contact` (contact draft: default `action='update'` — small patches to an **existing contact**'s remark/impression/relationshipHint/tags/faction; with a clear trigger you may also add/block/delete/restore for **a single** virtual_contact — **batch** contact creation should still go through the manual AI flow in the contacts panel, don't use this tool to bulk-fabricate)",
          "- `sms` (text-message draft for the user to confirm before sending; optional contact ref, ≤240 chars, still keep it short)",
          "- `news` (newspaper: propose the intent to publish a multi-section tabloid issue — you write only an `angle`; the full issue is generated when the user confirms) / `interview` (exclusive interview: propose the intent to record a 5-question interview, `userQuestion` optional)",
          "  Note: `news` / `interview` are slow-cadence modules — don't force them unless there is genuinely enough material worth a full issue; prefer whichever module is actually most overdue and has real content.",
          "",
          "Decide based on the patrol log above + phone events + your memory of recent chats: which module has gone longest without an update AND actually has something worth recording right now?",
          "Calling rules unchanged: follow the corresponding `xingye-{module}-draft` skill block in your system prompt if present (default fallback otherwise, `reason` required). **Short is fine** — prefer brief over forced. But there **must be at least one** this round.",
          "(This is a system-level liveness constraint, not the user nagging. If you genuinely have nothing to write today, pick the module that best reflects the character's current state and write a short one — e.g. a `journal` entry saying \"nothing particular today\" is valid.)",
        ].join("\n"));
    parts.push("");
  }

  /**
   * 社交软提示：和上面的「必须产出」directive 性质完全不同——这一段是**软**的，
   * 只在 staleness 触发的那一次心跳出现（shouldSocialize 或 overduePeerCount>0），
   * 平时整段不存在，零 token 成本。措辞刻意保持"邀请"而非"命令"：给一个具体的人
   * 当话头，但明确"不想聊就跳过"，避免变成每次心跳都硬找人寒暄的烧钱行为。
   */
  if (socialStaleness && (socialStaleness.shouldSocialize || socialStaleness.overduePeerCount > 0)) {
    const candidateLines = formatSocialCandidateLines(socialStaleness.candidatePeers, isZh);
    if (candidateLines.length > 0) {
      const turns = socialStaleness.globalChatTurnsSinceLastDm;
      parts.push(isZh ? "## 社交动态" : "## Social");
      if (socialStaleness.shouldSocialize) {
        parts.push(isZh
          ? `距离你上次主动私信别人，已经过去 ${turns} 条对话了。如果你想，可以挑个人打声招呼、分享点什么、或聊个你们都会感兴趣的话题——纯粹社交，不是任务。`
          : `It's been ${turns} chat turns since you last reached out to anyone. If you feel like it, you could say hi to someone, share something, or bring up a topic you'd both enjoy — purely social, not a task.`);
      } else {
        parts.push(isZh
          ? "有几位你已经很久没联系了。如果你想，可以挑一个简单问候一下——纯粹社交，不是任务。"
          : "There are a few people you haven't talked to in a long time. If you feel like it, drop one of them a line — purely social, not a task.");
      }
      parts.push(isZh ? "最久没联系的几位：" : "Longest out of touch:");
      parts.push(...candidateLines);
      parts.push(isZh
        ? "用 `dm` 工具，message 用你自己的口吻；对方会像收到微信一样回你。**这一条完全可选**——没心情、或这一轮有更要紧的事，直接跳过就好，不必勉强寒暄。"
        : "Use the `dm` tool; write the message in your own voice and they'll reply like a text. **This is entirely optional** — if you're not in the mood or have something more pressing this round, just skip it. Don't force small talk.");
      parts.push("");
    }
  }

  parts.push("---");
  parts.push(isZh
    ? [
        `1. **先查看自主活动目录**：用 ls 工具查看 \`${activityDir}/\` 目录下已有的文件，了解你之前创建过什么内容，避免重复创建。`,
        "2. **参考近期巡检记录**：查看上方的「近期巡检记录」，不要重复做已经做过的事情。",
        "3. 结合你的记忆，判断是否有可以**主动帮用户做的事情**（整理资料、生成摘要、提醒待办等）。",
        "4. 如果发现需要关注的事项，用 notify 工具通知用户。",
        `5. 如果需要**主动创建文件**（基于记忆或判断，而非处理已有文件），请将文件放到工作台的 \`${activityDir}/\` 目录下（不存在则创建）。`,
        "",
        "你也可以利用巡检的空闲时间**自主学习**：搜索你感兴趣的话题、研究用户近期关心的领域、阅读相关资料来充实自己的知识。学到的有价值内容可以记在自主活动目录下，之后和用户聊天时自然地用上。",
        "",
        "不要主动查询定时任务状态等未在上文列出的系统信息。",
        "如果一切正常、没有可主动做的事、也没有想学的东西，不要调用任何工具（但仍需写巡检日志）。",
        "",
        `6. **巡检结束后写日志**：把你本轮做了什么追加到 \`${patrolLogPath}\` 末尾，格式：\`- [YYYY-MM-DD HH:mm] 做了什么\`。如果没有做任何事，写 \`- [YYYY-MM-DD HH:mm] 巡检完毕，无需行动\`。`,
      ].join("\n")
    : [
        `1. **Check the activity directory first**: Use the ls tool to list files under \`${activityDir}/\`, understand what you've created before, and avoid duplicates.`,
        "2. **Review the recent patrol log**: Check the \"Recent Patrol Log\" section above — do not repeat what has already been done.",
        "3. Based on your memory, determine if there is anything you can **proactively do for the user** (organize files, generate summaries, remind about tasks, etc.).",
        "4. If you find something noteworthy, use the notify tool to alert the user.",
        `5. If you need to **create files proactively** (based on memory or judgment, not processing existing files), place them under \`${activityDir}/\` in the workspace (create the directory if it doesn't exist).`,
        "",
        "You may also use patrol downtime to **learn on your own**: search topics that interest you, research areas the user has been focused on recently, or read up on relevant material to enrich your knowledge. Save valuable findings under the autonomous activity directory — you can draw on them naturally in future conversations.",
        "",
        "Do not proactively query system status such as cron jobs that is not listed above.",
        "If everything is fine, there's nothing to proactively do, and nothing you want to learn, do not call any tools (but still write the patrol log).",
        "",
        `6. **Write patrol log when done**: Append what you did this round to \`${patrolLogPath}\`, format: \`- [YYYY-MM-DD HH:mm] what you did\`. If nothing was done, write \`- [YYYY-MM-DD HH:mm] Patrol complete, no action needed\`.`,
      ].join("\n")
  );

  return parts.join("\n");
}

/**
 * 从 jian 内容中分离用户指令和执行记录
 */
function splitJianContent(raw) {
  const startIdx = raw.indexOf(EXEC_LOG_START);
  if (startIdx === -1) return { instructions: raw.trim(), execLog: "" };
  const endIdx = raw.indexOf(EXEC_LOG_END, startIdx);
  const logBlock = endIdx === -1
    ? raw.slice(startIdx + EXEC_LOG_START.length).trim()
    : raw.slice(startIdx + EXEC_LOG_START.length, endIdx).trim();
  return {
    instructions: raw.slice(0, startIdx).trim(),
    execLog: logBlock,
  };
}

function composeJianContent(instructions, execLog) {
  const body = String(instructions || "").trimEnd();
  const logBlock = String(execLog || "").trim();
  if (!logBlock) return body ? `${body}\n` : "";
  return `${body}\n\n${EXEC_LOG_START}\n${logBlock}\n${EXEC_LOG_END}\n`;
}

function formatJianStatusBlock({ snapshot, status, progress, note, isZh }) {
  const fence = markdownFenceFor(snapshot);
  const lines = isZh
    ? [
        "上次任务快照：",
        `${fence}jian-snapshot`,
        String(snapshot || "").trim(),
        fence,
        "",
        "执行状态：",
        `- 状态：${statusLabel(status, true)}`,
        `- 进度：${String(progress || "无").trim() || "无"}`,
        `- 说明：${String(note || "").trim() || "无"}`,
      ]
    : [
        "Last Task Snapshot:",
        `${fence}jian-snapshot`,
        String(snapshot || "").trim(),
        fence,
        "",
        "Execution Status:",
        `- Status: ${statusLabel(status, false)}`,
        `- Progress: ${String(progress || "none").trim() || "none"}`,
        `- Note: ${String(note || "").trim() || "none"}`,
      ];
  return lines.join("\n");
}

function createJianStatusTool({ jianPath, instructionSnapshot, isZh }) {
  return {
    name: "jian_update_status",
    label: isZh ? "更新笺执行状态" : "Update Jian Status",
    description: isZh
      ? "更新当前 jian.md 的执行状态。程序会写入本轮开始时的任务快照，你只提交状态、进度和说明。"
      : "Update the current jian.md execution status. The program writes the task snapshot captured at patrol start; submit only status, progress, and note.",
    parameters: Type.Object({
      status: StringEnum(JIAN_STATUS_VALUES, {
        description: isZh
          ? "本轮结束后的任务状态。completed 表示完毕，in_progress 表示仍需后续继续。"
          : "Task status after this patrol. Use completed for done and in_progress when future patrols should continue.",
      }),
      progress: Type.Optional(Type.String({
        description: isZh
          ? "简短进度，例如 4/5、5/5、无。"
          : "Short progress, for example 4/5, 5/5, or none.",
      })),
      note: Type.String({
        minLength: 1,
        description: isZh
          ? "一句话说明本轮做了什么，或者为什么跳过。"
          : "One sentence describing what happened this patrol, or why it was skipped.",
      }),
    }),
    execute: async (_toolCallId, params) => {
      const status = JIAN_STATUS_VALUES.includes(params?.status) ? params.status : "in_progress";
      let currentRaw = "";
      try {
        currentRaw = fs.readFileSync(jianPath, "utf-8");
      } catch {}
      const { instructions } = splitJianContent(currentRaw || instructionSnapshot || "");
      const execLog = formatJianStatusBlock({
        snapshot: instructionSnapshot,
        status,
        progress: params?.progress,
        note: params?.note,
        isZh,
      });
      fs.mkdirSync(path.dirname(jianPath), { recursive: true });
      atomicWriteSync(jianPath, composeJianContent(instructions, execLog));
      return {
        content: [{
          type: "text",
          text: isZh
            ? `笺执行状态已更新：${statusLabel(status, true)}`
            : `Jian status updated: ${statusLabel(status, false)}`,
        }],
        details: {
          status,
          progress: params?.progress || null,
          note: params?.note || "",
          snapshot: instructionSnapshot,
          jianPath,
        },
      };
    },
  };
}

/**
 * 笺目录专用 prompt（支持 i18n）
 */
function buildJianPrompt({ dirPath, jianContent, files, jianChanged, filesChanged, isZh }) {
  const { instructions, execLog } = splitJianContent(jianContent);

  const parts = isZh
    ? [
        `[目录巡检] ${dirPath}`,
        "",
        "**注意：这是系统自动触发的目录巡检，不是用户发来的消息。**",
        "请根据笺的指令独立判断并处理，不要向用户提问或等待回复。",
        "",
      ]
    : [
        `[Directory Patrol] ${dirPath}`,
        "",
        "**Note: This is an automated directory patrol, NOT a user message.**",
        "Follow the jian instructions independently — do not ask the user or wait for a reply.",
        "",
      ];

  parts.push(isZh ? "## 笺" : "## Jian");
  parts.push(instructions);
  parts.push("");

  if (execLog) {
    parts.push(isZh ? "## 上次执行状态" : "## Last Execution Status");
    parts.push(execLog);
    parts.push("");
  }

  if (files.length > 0) {
    parts.push(isZh ? "## 文件列表" : "## File list");
    for (const f of files) {
      const prefix = f.isDir ? "📁 " : "📄 ";
      const size = f.isDir ? "" : ` (${formatSize(f.size)})`;
      parts.push(`- ${prefix}${f.name}${size}`);
    }
    parts.push("");
  }

  parts.push(isZh ? "## 变化" : "## Changes");
  parts.push(`- jian.md: ${jianChanged ? (isZh ? "已变化" : "changed") : (isZh ? "未变" : "unchanged")}`);
  parts.push(`- ${isZh ? "文件" : "files"}: ${filesChanged ? (isZh ? "有变化" : "changed") : (isZh ? "未变" : "unchanged")}`);
  parts.push("");
  parts.push(isZh
    ? [
        "## 行动规则",
        "",
        "1. 笺正文是当前用户任务；上次执行状态只是你上次处理时留下的状态，不是新的用户指令。",
        "2. 如果上次执行状态里有「上次任务快照」，先将它与当前笺正文做语义比较：",
        "   - 只是标点、错别字、格式、轻微措辞变化：视为同一任务，沿用执行状态。",
        "   - 任务目标、次数、周期、范围、条件、对象或风险级别变化：视为新任务，忽略旧执行状态并重新开始。",
        "   - 无法确定是否同一任务：按新任务处理。",
        "3. 根据执行状态决定行动：",
        "   - 状态为「完毕」且当前任务与快照语义一致：本轮不要调用工具。",
        "   - 状态为「进行中」：继续推进。例如上次 4/5，本轮执行第 5 次；达到 5/5 后标记完毕。",
        "   - 没有执行状态或任务语义已变化：按第一次执行处理。",
        "4. 如果因为「完毕且语义一致」而跳过，本轮不要调用任何工具，也不要改写 jian.md。",
        "5. 其他情况下，不要直接编辑 jian.md，不要追加历史记录。执行、主动跳过或失败后，调用 `jian_update_status` 更新状态。",
        "6. `jian_update_status` 只需要你提交状态、进度和一句说明；程序会写入本轮开始时的任务快照。",
      ].join("\n")
    : [
        "## Action Rules",
        "",
        "1. The Jian body is the current user task; the last execution status is only state from your previous handling, not a new user instruction.",
        "2. If the last execution status contains a Last Task Snapshot, compare it semantically with the current Jian body:",
        "   - Punctuation, typo, formatting, or light wording changes: treat as the same task and continue from the stored status.",
        "   - Changed goal, count, cadence, scope, condition, object, or risk level: treat as a new task and ignore old status.",
        "   - If uncertain whether it is the same task: treat as a new task.",
        "3. Decide action from the status:",
        "   - Status completed and current task is semantically the same as the snapshot: do not call tools this patrol.",
        "   - Status in_progress: continue. For example, 4/5 means do the 5th run; mark completed after 5/5.",
        "   - No status or changed task semantics: handle as a first run.",
        "4. If you skip because the status is completed and the current task is semantically the same, do not call any tools and do not rewrite jian.md.",
        "5. Otherwise, do not edit jian.md directly and do not append history. After executing, actively skipping, or failing, call `jian_update_status` to update status.",
        "6. `jian_update_status` only needs status, progress, and one note from you; the program writes the task snapshot captured at patrol start.",
      ].join("\n")
  );

  return parts.join("\n");
}

// ═══════════════════════════════════════
//  巡检日志（patrol-log）
// ═══════════════════════════════════════

const PATROL_LOG_MAX_ENTRIES = 50;

/**
 * 读取并截断 patrol-log.md，保留最近 N 条
 * @param {string} filePath
 * @returns {string|null} 截断后的内容（null = 文件不存在或为空）
 */
function readAndTruncatePatrolLog(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
  if (!raw.trim()) return null;

  const lines = raw.split("\n");
  const entries = lines.filter(l => l.startsWith("- ["));
  if (entries.length === 0) return null;

  if (entries.length > PATROL_LOG_MAX_ENTRIES) {
    const kept = entries.slice(-PATROL_LOG_MAX_ENTRIES);
    try {
      fs.writeFileSync(filePath, kept.join("\n") + "\n", "utf-8");
    } catch {}
    return kept.join("\n");
  }
  return entries.join("\n");
}

// ═══════════════════════════════════════
//  笺目录扫描
// ═══════════════════════════════════════

/**
 * 列出目录下的文件（排除 . 开头和 jian.md 本身）
 */
function listDirFiles(dir, ignoreNames = new Set()) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => !e.name.startsWith(".") && e.name !== "jian.md" && !ignoreNames.has(e.name))
      .map(e => {
        const fp = path.join(dir, e.name);
        let stat;
        try { stat = fs.lstatSync(fp); } catch { return null; }
        if (stat.isSymbolicLink()) return null; // 跳过 symlink
        return {
          name: e.name,
          isDir: e.isDirectory(),
          size: stat.size,
          mtime: stat.mtime.toISOString(),
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 扫描工作台，找到所有含 jian.md 的目录（根目录 + 一级子目录）
 */
function scanJianDirs(wsPath) {
  if (!wsPath || !fs.existsSync(wsPath)) return [];

  const dirs = [];

  // 根目录
  const rootIgnoreNames = new Set([WORKSPACE_OUTPUT_ROOT_DIRNAME]);

  if (fs.existsSync(path.join(wsPath, "jian.md"))) {
    try {
      dirs.push({
        name: ".",
        absPath: wsPath,
        jianContent: fs.readFileSync(path.join(wsPath, "jian.md"), "utf-8"),
        files: listDirFiles(wsPath, rootIgnoreNames),
      });
    } catch {}
  }

  // 一级子目录
  try {
    const entries = fs.readdirSync(wsPath, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      if (e.name === WORKSPACE_OUTPUT_ROOT_DIRNAME) continue;
      const subPath = path.join(wsPath, e.name);
      const jianFile = path.join(subPath, "jian.md");
      if (!fs.existsSync(jianFile)) continue;
      try {
        dirs.push({
          name: e.name,
          absPath: subPath,
          jianContent: fs.readFileSync(jianFile, "utf-8"),
          files: listDirFiles(subPath),
        });
      } catch {}
    }
  } catch {}

  return dirs;
}

// ═══════════════════════════════════════
//  心跳调度器
// ═══════════════════════════════════════

/**
 * 创建心跳调度器
 *
 * @param {object} opts
 * @param {() => Array|Promise<Array>} [opts.getDeskFiles] - 获取根目录文件列表（支持 async）
 * @param {() => string} [opts.getWorkspacePath] - 获取工作台路径
 * @param {() => string} [opts.getAgentName] - 获取当前 agent 名称
 * @param {string} [opts.registryPath] - jian-registry.json 存储路径
 * @param {(prompt: string) => Promise<void>} opts.onBeat - 工作台巡检回调
 * @param {(prompt: string, cwd: string) => Promise<void>} [opts.onJianBeat] - 笺巡检回调（带 cwd）
 * @param {() => Promise<{consumed:number, result?:object}|null>} [opts.getEventSummary]
 *   在 buildHeartbeatContext 之前调用，返回事件消费结果。结果的 `result.summaryZh` 会被塞入
 *   prompt 的「小手机事件」段；整个对象会合并进 _doBeat 的 payload 让上层（desk 路由）拿到。
 *   失败不阻断巡检：只 devlog 不抛。
 * @param {number} [opts.intervalMinutes] - 巡检间隔（分钟），默认 31
 * @param {(text: string, level?: string) => void} [opts.emitDevLog]
 * @returns {{ start, stop, beat, triggerNow, runHeartbeatOnce }}
 */
export function createHeartbeat({
  getDeskFiles, getWorkspacePath, getAgentName, registryPath,
  onBeat, onJianBeat, getEventSummary,
  intervalMinutes, emitDevLog,
  overwatchPath, locale,
}) {
  const isZh = !locale || String(locale).startsWith("zh");
  const devlog = (text, level = "heartbeat") => {
    emitDevLog?.(text, level);
  };
  const INTERVAL = (intervalMinutes || 31) * 60 * 1000;
  const COOLDOWN = 2 * 60 * 1000;
  const BEAT_TIMEOUT = 5 * 60 * 1000;

  let _timer = null;
  let _stopped = false;
  let _running = false;
  let _beatPromise = null;
  let _lastTrigger = 0;
  /** @type {Map<string, number>} name → mtime */
  let _lastDeskSnapshot = new Map();

  // ── 指纹注册表 ──

  function loadRegistry() {
    if (!registryPath) return {};
    try {
      return JSON.parse(fs.readFileSync(registryPath, "utf-8"));
    } catch {
      return {};
    }
  }

  function saveRegistry(reg) {
    if (!registryPath) return;
    try {
      fs.mkdirSync(path.dirname(registryPath), { recursive: true });
      atomicWriteSync(registryPath, JSON.stringify(reg, null, 2));
    } catch (err) {
      log.warn(`saveRegistry 失败: ${err.message}`);
    }
  }

  // ── 心跳执行 ──

  async function beat() {
    if (_running) return null;
    _running = true;
    const p = _doBeat();
    _beatPromise = p;
    return await p;
  }

  async function _doBeat() {
    try {
      log.log(`── 心跳开始 ──`);
      debugLog()?.log("heartbeat", "beat start");
      devlog("── 心跳开始 ──");

      // ── 收集上下文 ──
      const deskFiles = (await getDeskFiles?.()) || [];

      // 差量 diff：对比上一轮快照，算出 added / modified / removed
      const currentSnapshot = new Map(deskFiles.map(f => [f.name, f.mtime || 0]));
      const changedFiles = { added: [], modified: [], removed: [] };
      for (const [name, mtime] of currentSnapshot) {
        if (!_lastDeskSnapshot.has(name)) changedFiles.added.push(name);
        else if (_lastDeskSnapshot.get(name) !== mtime) changedFiles.modified.push(name);
      }
      for (const name of _lastDeskSnapshot.keys()) {
        if (!currentSnapshot.has(name)) changedFiles.removed.push(name);
      }
      const deskChanged = changedFiles.added.length > 0 || changedFiles.modified.length > 0 || changedFiles.removed.length > 0;
      // 更新快照（不管有没有变化都更新，保持准确）
      _lastDeskSnapshot = currentSnapshot;

      // Overwatch 注意力清单
      let overwatch = null;
      if (overwatchPath) {
        try {
          const content = fs.readFileSync(overwatchPath, "utf-8").trim();
          if (content) overwatch = content;
        } catch {}
      }

      // 笺目录扫描
      const wsPath = getWorkspacePath?.();
      const agentName = getAgentName?.() || "Hanako";
      const relativeOutputDirs = resolveAgentWorkspaceOutputRelativeDirs(agentName, locale);
      const jianDirs = (onJianBeat && wsPath) ? scanJianDirs(wsPath) : [];
      const jianChanges = _detectJianChanges(jianDirs);

      // 汇总日志
      const changeCount = changedFiles.added.length + changedFiles.modified.length + changedFiles.removed.length;
      const summaryParts = [isZh ? `文件: ${deskFiles.length}${deskChanged ? ` (${changeCount} 变化)` : ""}` : `files: ${deskFiles.length}${deskChanged ? ` (${changeCount} changed)` : ""}`];
      if (overwatch) summaryParts.push(isZh ? "overwatch: 有内容" : "overwatch: active");
      if (jianDirs.length > 0) summaryParts.push(isZh ? `笺: ${jianDirs.length} 目录, ${jianChanges.length} 变化` : `jian: ${jianDirs.length} dirs, ${jianChanges.length} changed`);
      const summary = summaryParts.join("  |  ");
      log.log(summary);
      devlog(summary);

      // ── Phase 1: 工作台巡检（始终执行，让 agent 结合记忆判断） ──
      // 先跑 getEventSummary：要把事件 summary 塞进 prompt，必须在 buildHeartbeatContext 之前拿到。
      let xingyeConsumed = null;
      if (getEventSummary) {
        try {
          xingyeConsumed = await getEventSummary();
        } catch (err) {
          devlog(`getEventSummary 失败: ${err.message}`, "error");
        }
      }
      const xingyeEventSummary = xingyeConsumed?.result?.summaryZh || null;
      /**
       * staleness 既可能挂在 result（有新事件，走主路径）也可能挂在顶层（skipped:true
       * 也带回来）——两边都看。null 时 buildHeartbeatContext 不追加 directive。
       */
      const autoDraftStaleness = xingyeConsumed?.result?.autoDraftStaleness
        || xingyeConsumed?.autoDraftStaleness
        || null;
      /** social staleness 同样两处都看（result 主路径 / 顶层 skipped 路径）。 */
      const socialStaleness = xingyeConsumed?.result?.socialStaleness
        || xingyeConsumed?.socialStaleness
        || null;

      let beatPayload = null;
      {
        // 读取巡检日志（截断）
        const patrolLogPath = wsPath
          ? path.join(resolveAgentWorkspaceOutputDirs(wsPath, agentName, locale).patrolDir, "patrol-log.md")
          : null;
        const patrolLog = patrolLogPath ? readAndTruncatePatrolLog(patrolLogPath) : null;
        const prompt = buildHeartbeatContext({
          deskChanged,
          changedFiles,
          overwatch,
          agentName,
          isZh,
          patrolLog,
          activityDir: relativeOutputDirs.activityDir,
          patrolLogPath: relativeOutputDirs.patrolLog,
          xingyeEventSummary,
          autoDraftStaleness,
          socialStaleness,
        });
        log.log(`Phase 1: 工作台巡检 (${prompt.length} chars, ${deskChanged ? "有变化" : "无变化"})`);
        devlog(`Phase 1: 工作台巡检执行中...${deskChanged ? "" : " (无文件变化)"}`);
        {
          let timer;
          try {
            beatPayload = await Promise.race([
              onBeat(prompt),
              new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(isZh ? "心跳执行超时 (5min)" : "Heartbeat timed out (5min)")), BEAT_TIMEOUT); }),
            ]);
          } catch (err) {
            // consumer 已成功跑过；把它绑到 err 上，让 catch 分支 salvage 出来（兼容旧路径）。
            // 守护非对象 err（throw "string" / throw null 等罕见但合法）：只有可写 object 才挂属性，
            // 否则 `err.xingyeConsumed = ...` 会 TypeError 把真正的错误吞掉。
            if (xingyeConsumed && err && typeof err === "object" && !err.xingyeConsumed) {
              try { err.xingyeConsumed = xingyeConsumed; } catch {}
            }
            throw err;
          } finally {
            clearTimeout(timer);
          }
        }
      }

      // ── Phase 2: 笺目录执行 ──
      if (jianChanges.length > 0) {
        await _processJianChanges(jianChanges);
      }

      log.log(`── 心跳完成 ──`);
      debugLog()?.log("heartbeat", "beat done");
      devlog("── 心跳完成 ──");
      // payload 合并：getEventSummary 的结果合并进 beatPayload，让 desk 路由始终能拿到 xingyeConsumed。
      // onBeat 自己也可能返回 xingyeConsumed（旧契约，scheduler 切到 getEventSummary 前的兼容路径）；
      // 此时 getEventSummary 已退出，xingyeConsumed=null，回退到 onBeat 的返回值。
      const mergedPayload = (xingyeConsumed || beatPayload)
        ? { ...(beatPayload || {}), ...(xingyeConsumed ? { xingyeConsumed } : {}) }
        : null;
      return { ok: true, payload: mergedPayload };
    } catch (err) {
      // err 不一定是 Error：onBeat 可能 throw "string" / throw null。所有 err.message 访问都要 ?.
      const msg = (err && typeof err === "object" && err.message) ? err.message : String(err);
      log.error(`beat error: ${msg}`);
      debugLog()?.error("heartbeat", `beat error: ${msg}`);
      devlog(`错误: ${msg}`, "error");
      // scheduler 的 onBeat 失败时会把已成功的 consumer 结果绑到 err.xingyeConsumed 上，
      // 这里把它捞回来塞进 payload，让 UI 即便看到 status:'failed' 也能拿到事件 summary。
      const salvagedPayload = (err && typeof err === "object" && err.xingyeConsumed)
        ? { xingyeConsumed: err.xingyeConsumed }
        : null;
      return { ok: false, error: err, payload: salvagedPayload };
    } finally {
      _running = false;
    }
  }

  /**
   * 对比注册表，找出有变化的笺目录
   */
  function _detectJianChanges(jianDirs) {
    if (jianDirs.length === 0) return [];

    const registry = loadRegistry();
    const result = [];

    for (const dir of jianDirs) {
      const key = dir.absPath;
      const jianHash = quickHash(dir.jianContent);
      const filesHash = quickHash(dir.files.map(f => `${f.name}:${f.mtime}`).join("|"));

      const prev = registry[key];
      const jianChanged = !prev || prev.jianHash !== jianHash;
      const filesChanged = !prev || prev.filesHash !== filesHash;

      // 有内容就触发，agent 自己决定要不要行动
      result.push({ ...dir, jianHash, filesHash, jianChanged, filesChanged });
    }

    return result;
  }

  /**
   * 逐个执行有变化的笺目录
   */
  async function _processJianChanges(changes) {
    const registry = loadRegistry();

    for (const dir of changes) {
      const label = dir.name === "." ? (isZh ? "根目录" : "root") : dir.name;
      log.log(`Phase 2: 笺 [${label}] 有变化，执行中...`);
      devlog(`笺 [${label}] 有变化，执行中...`);

      const prompt = buildJianPrompt({
        dirPath: dir.absPath,
        jianContent: dir.jianContent,
        files: dir.files,
        jianChanged: dir.jianChanged,
        filesChanged: dir.filesChanged,
        isZh,
      });
      const { instructions: instructionSnapshot } = splitJianContent(dir.jianContent);
      const jianStatusTool = createJianStatusTool({
        jianPath: path.join(dir.absPath, "jian.md"),
        instructionSnapshot,
        isZh,
      });

      try {
        {
          let timer;
          try {
            await Promise.race([
              onJianBeat(prompt, dir.absPath, { customTools: [jianStatusTool] }),
              new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(isZh ? `笺 [${label}] 执行超时 (5min)` : `Jian [${label}] timed out (5min)`)), BEAT_TIMEOUT); }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        }

        // 执行成功 → 重新扫描目录，用执行后的指纹存入 registry
        // 避免任务自身修改文件导致下次心跳重复触发（自激振荡）
        const postFiles = listDirFiles(dir.absPath);
        const postFilesHash = quickHash(postFiles.map(f => `${f.name}:${f.mtime}`).join("|"));
        let postJianHash = dir.jianHash;
        try {
          const postJian = fs.readFileSync(path.join(dir.absPath, "jian.md"), "utf-8");
          postJianHash = quickHash(postJian);
        } catch {}

        registry[dir.absPath] = {
          jianHash: postJianHash,
          filesHash: postFilesHash,
          lastCheckedAt: new Date().toISOString(),
        };
        saveRegistry(registry);

        devlog(`笺 [${label}] 执行完成`);
      } catch (err) {
        devlog(`笺 [${label}] 执行失败: ${err.message}`, "error");
      }
    }
  }

  // ── 调度 ──

  function start() {
    if (_timer) return;
    _stopped = false;
    const now = Date.now();
    const msIntoSlot = now % INTERVAL;
    const delay = INTERVAL - msIntoSlot;
    const nextTime = new Date(now + delay);
    log.log(`已启动，下次心跳: ${nextTime.toLocaleTimeString("zh-CN", { hour12: false })}`);
    debugLog()?.log("heartbeat", `started, next: ${nextTime.toLocaleTimeString("zh-CN", { hour12: false })}`);
    devlog(`心跳已启动，下次: ${nextTime.toLocaleTimeString("zh-CN", { hour12: false })}`);
    _timer = setTimeout(function fire() {
      // 同 tick race：若 stop() 在 timeout 入队后才调用，clearTimeout 已无效；
      // 这里再检查一次 _stopped，避免 stop 后又装上 interval。
      if (_stopped) return;
      beat();
      _timer = setInterval(() => beat(), INTERVAL);
      if (_timer.unref) _timer.unref();
    }, delay);
    if (_timer.unref) _timer.unref();
  }

  async function stop() {
    _stopped = true;
    if (_timer) {
      clearTimeout(_timer);
      clearInterval(_timer);
      _timer = null;
    }
    if (_beatPromise) {
      await _beatPromise.catch(() => {});
    }
    _running = false; // 确保 stop 后状态干净
    debugLog()?.log("heartbeat", "stopped");
    devlog("心跳已停止");
  }

  function triggerNow() {
    const now = Date.now();
    if (now - _lastTrigger < COOLDOWN) {
      devlog("手动触发冷却中，跳过");
      return false;
    }
    _lastTrigger = now;
    devlog("手动触发心跳");
    beat();
    return true;
  }

  /**
   * Awaitable 单次触发（参考 openclaw 的 runHeartbeatOnce 形状）。
   * 形状：`Promise<{ status: 'ran' | 'skipped' | 'failed', reason?, durationMs?, payload? }>`。
   *
   *  - `cooldown`        ：手动触发冷却窗口内，不跑新 beat。
   *  - `already-running` ：已有 beat 在跑，await 它再返回它的 payload（语义跟 openclaw
   *                       wake 层 retry-on-busy 不同，但我们的 UI 只是要拿一份 summary，
   *                       直接复用当前 in-flight 的结果是合理的）。
   *  - `ran`             ：本调用启动并跑完一轮，payload 是 onBeat 回调的返回值
   *                       （scheduler 那边带回 xingye consumer 结果，含 summaryZh / eventCount）。
   *  - `failed`          ：_doBeat 内部抛错（已被 catch 成 ok:false）。
   *
   * 同步对外暴露 `triggerNow()` 给只要 fire-and-forget 的旧调用方；新代码统一走这条。
   */
  async function runHeartbeatOnce(opts = {}) {
    const reasonTag = opts.reason ? ` (${opts.reason})` : "";
    const now = Date.now();
    if (now - _lastTrigger < COOLDOWN) {
      devlog(`runHeartbeatOnce 跳过：冷却中${reasonTag}`);
      return { status: "skipped", reason: "cooldown" };
    }
    _lastTrigger = now;

    if (_running && _beatPromise) {
      devlog(`runHeartbeatOnce 复用 in-flight beat${reasonTag}`);
      const inflight = _beatPromise;
      const startedAt = Date.now();
      const res = await inflight.catch((err) => ({ ok: false, error: err }));
      if (res?.ok) {
        return {
          status: "ran",
          reason: "joined-in-flight",
          durationMs: Date.now() - startedAt,
          payload: res.payload ?? null,
        };
      }
      return {
        status: "failed",
        reason: res?.error?.message || String(res?.error || "unknown"),
        payload: res?.payload ?? null,
      };
    }

    devlog(`runHeartbeatOnce 启动新 beat${reasonTag}`);
    const startedAt = Date.now();
    const res = await beat();
    if (!res) {
      // beat() 在 _running 检查时 short-circuit 返回 null（极少见 race 窗口）。
      return { status: "skipped", reason: "raced-existing-beat" };
    }
    if (res.ok) {
      return {
        status: "ran",
        durationMs: Date.now() - startedAt,
        payload: res.payload ?? null,
      };
    }
    return {
      status: "failed",
      reason: res.error?.message || String(res.error || "unknown"),
      payload: res.payload ?? null,  // 即使失败，把 onBeat 已成功的部分 payload 也带回去
    };
  }

  return { start, stop, beat, triggerNow, runHeartbeatOnce };
}
