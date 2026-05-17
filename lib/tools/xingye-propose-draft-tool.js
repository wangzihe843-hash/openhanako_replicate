/**
 * xingye-propose-draft-tool.js — `xingye_propose_draft` 通用 dispatch 工具
 *
 * 让 agent 在心跳巡检（或普通对话）中向小手机/秘密空间各模块提出一条
 * 「待用户确认的草稿」。各模块的草稿写法和触发场景由 skills2set 下
 * 同名 skill（`xingye-{module}-draft/SKILL.md`）的 prompt 描述，agent
 * 读完 skill 后调用这个工具，工具按 `module` switch 到对应模块的
 * append*DraftServer 实现。
 *
 * 设计意图：避免「每模块一个 tool」导致工具列表膨胀，也避免「heartbeat.js
 * 里硬编码 N 段模块说明」。新加一个模块的成本是：
 *   1. enum 加一项 + 一个 switch case（这个文件，~4 行）
 *   2. lib/xingye/{module}-drafts.js 加 appendXxxDraftServer
 *   3. 渲染端给该模块的 store 加 list/append/confirm/discard 草稿函数
 *   4. 渲染端给该模块的 App 加「待确认草稿」分组 UI
 *   5. skills2set/xingye-{module}-draft/SKILL.md 写一份 prompt
 * 步骤 (1) 不需要碰 heartbeat.js；(5) 由 SkillManager 自动扫描注入到
 * system prompt，agent 自然看到。
 */

import { Type, StringEnum } from "../pi-sdk/index.js";
import { appendJournalDraftServer } from "../xingye/journal-drafts.js";
import { appendScheduleDraftServer } from "../xingye/schedule-drafts.js";
import { appendMomentDraftServer } from "../xingye/moments-drafts.js";

/** 支持的模块枚举；后续新增模块只在这里加一项 + 下方 switch 加一个 case。 */
const SUPPORTED_MODULES = ["journal", "schedule", "moments"];

/**
 * @param {{ agentDir: string, agentId: string }} opts
 */
export function createProposeDraftTool({ agentDir, agentId }) {
  return {
    name: "xingye_propose_draft",
    label: "提议小手机/秘密空间草稿",
    description:
      "向当前 agent 的小手机或秘密空间某个模块提出一条「待用户确认的草稿」。"
      + " 草稿不会出现在用户的「已生成」列表里，必须用户在对应 App / 面板里点「确认生成」之后才会真正写入。"
      + " 各模块的触发条件、字段要求、写作要点由对应 skill（`xingye-{module}-draft`）描述；先读 skill，再调本工具。"
      + " 不要用本工具替代 `notify`：`notify` 是面向用户的提醒，本工具是面向角色生活面板的内容草拟。",
    parameters: Type.Object({
      module: StringEnum(SUPPORTED_MODULES, {
        description:
          "目标模块。每个模块对应一份 `xingye-{module}-draft` skill；先读那份 skill 了解触发条件与字段要求，再选定 module。",
      }),
      reason: Type.Optional(Type.String({
        description:
          "为什么提议这条草稿（会展示给用户帮助决定是否确认）。例：「最近一周聊天反复出现这件事」。强烈建议每次都传。",
      })),
      sourceEventIds: Type.Optional(Type.Array(Type.String(), {
        description: "触发本草稿的 xingye event id 列表（可选，用于追溯）。",
      })),
      /**
       * 每模块自己的 payload 字段。Agent 只需要填写与 `module` 对应那一项；
       * 其它项留空。schema 上都是 Optional 是为了同一 tool 接住多种 payload，
       * 必填字段的校验在各模块的 execute 分支里做（缺字段时返回 ok:false）。
       */
      journal: Type.Optional(Type.Object({
        title: Type.Optional(Type.String({
          description: "[journal] 草稿标题；不填会用「无标题」。",
        })),
        body: Type.String({
          description: "[journal] 日记正文，必填，trim 后不能为空。第一人称、贴角色口吻。",
        }),
        dayKey: Type.Optional(Type.String({
          description: "[journal] YYYY-MM-DD（本地日历）；不填取服务器当天。",
        })),
        mood: Type.Optional(Type.String({
          description: "[journal] 心情短语（2–6 字），如「平淡 / 想他 / 安静」；超过 24 字符会截断。",
        })),
      }, { description: "module === 'journal' 时的字段。" })),
      schedule: Type.Optional(Type.Object({
        title: Type.String({
          description: "[schedule] 日程标题，必填，trim 后不能为空。例：「晚自习」「下次去诊所前整理」。",
        }),
        dateLabel: Type.String({
          description: "[schedule] 日期文本，必填，自由格式（如「今天」「明天上午」「下次去诊所前」「2026-05-20」）。会被前端 parseDateLabel 尽力解析；解析不出的也保留原文。",
        }),
        content: Type.String({
          description: "[schedule] 日程正文/详情，必填，trim 后不能为空。",
        }),
        timeText: Type.Optional(Type.String({
          description: "[schedule] 时间，可选，自由格式如「上午」「19:30」「睡前」。≤80 字符。",
        })),
        note: Type.Optional(Type.String({
          description: "[schedule] 备注，可选。≤500 字符。",
        })),
        category: Type.Optional(Type.String({
          description: "[schedule] 类别，可选。常见：「约定 / 提醒 / 自己定的 / 也许吧 / 平常」——前端用它来配色。≤24 字符。",
        })),
      }, { description: "module === 'schedule' 时的字段。" })),
      moments: Type.Optional(Type.Object({
        content: Type.String({
          description: "[moments] 朋友圈正文，必填，trim 后不能为空。第一人称、贴角色口吻。超过 280 个码点会被截断。",
        }),
      }, { description: "module === 'moments' 时的字段。仅承诺 content；互动者数据（点赞/评论）依赖通讯录与 peer roster，由用户在 MomentComposer 用「AI 生成」路径现拉，不在草稿提议范围。" })),
    }),
    execute: async (_toolCallId, params) => {
      const moduleName = typeof params?.module === "string" ? params.module : "";
      if (!SUPPORTED_MODULES.includes(moduleName)) {
        return {
          content: [{ type: "text", text: `unsupported module: ${moduleName || "(empty)"}` }],
          details: { ok: false, reason: "unsupported_module" },
        };
      }

      const reason = typeof params?.reason === "string" ? params.reason : undefined;
      const sourceEventIds = Array.isArray(params?.sourceEventIds)
        ? params.sourceEventIds.filter((entry) => typeof entry === "string")
        : undefined;

      switch (moduleName) {
        case "journal": {
          const journal = params?.journal && typeof params.journal === "object" ? params.journal : null;
          const body = typeof journal?.body === "string" ? journal.body.trim() : "";
          if (!body) {
            return {
              content: [{ type: "text", text: "module=journal 缺少 journal.body（或为空）；已拒绝写入草稿。" }],
              details: { ok: false, module: "journal", reason: "empty_body" },
            };
          }
          try {
            const draft = await appendJournalDraftServer({
              agentDir,
              agentId,
              input: {
                title: typeof journal.title === "string" ? journal.title : undefined,
                body,
                dayKey: typeof journal.dayKey === "string" ? journal.dayKey : undefined,
                mood: typeof journal.mood === "string" ? journal.mood : undefined,
                reason,
                source: "xingye-heartbeat-tool",
                sourceEventIds,
              },
            });
            if (!draft) {
              return {
                content: [{ type: "text", text: "草稿写入失败：输入校验未通过（agentId / body / source 不合法）。" }],
                details: { ok: false, module: "journal", reason: "validation_failed" },
              };
            }
            return {
              content: [{
                type: "text",
                text: `已写入日记草稿 ${draft.id}（${draft.dayKey} ${draft.title}），待用户在小手机日记本「待确认草稿」区确认。`,
              }],
              details: { ok: true, module: "journal", draftId: draft.id, dayKey: draft.dayKey, title: draft.title },
            };
          } catch (err) {
            const msg = err?.message || String(err);
            return {
              content: [{ type: "text", text: `草稿写入失败：${msg}` }],
              details: { ok: false, module: "journal", error: msg },
            };
          }
        }
        case "schedule": {
          const schedule = params?.schedule && typeof params.schedule === "object" ? params.schedule : null;
          const title = typeof schedule?.title === "string" ? schedule.title.trim() : "";
          const dateLabel = typeof schedule?.dateLabel === "string" ? schedule.dateLabel.trim() : "";
          const content = typeof schedule?.content === "string" ? schedule.content.trim() : "";
          if (!title || !dateLabel || !content) {
            return {
              content: [{ type: "text", text: "module=schedule 需要 schedule.title / dateLabel / content 三项；缺一项已拒绝写入。" }],
              details: { ok: false, module: "schedule", reason: "missing_required_fields" },
            };
          }
          try {
            const draft = await appendScheduleDraftServer({
              agentDir,
              agentId,
              input: {
                title,
                dateLabel,
                content,
                timeText: typeof schedule.timeText === "string" ? schedule.timeText : undefined,
                note: typeof schedule.note === "string" ? schedule.note : undefined,
                category: typeof schedule.category === "string" ? schedule.category : undefined,
                reason,
                source: "xingye-heartbeat-tool",
                sourceEventIds,
              },
            });
            if (!draft) {
              return {
                content: [{ type: "text", text: "草稿写入失败：输入校验未通过（agentId / 字段长度 / source 不合法）。" }],
                details: { ok: false, module: "schedule", reason: "validation_failed" },
              };
            }
            return {
              content: [{
                type: "text",
                text: `已写入日程草稿 ${draft.id}（${draft.dateLabel} ${draft.title}），待用户在小手机日程「待确认草稿」区确认。`,
              }],
              details: { ok: true, module: "schedule", draftId: draft.id, dateLabel: draft.dateLabel, title: draft.title },
            };
          } catch (err) {
            const msg = err?.message || String(err);
            return {
              content: [{ type: "text", text: `草稿写入失败：${msg}` }],
              details: { ok: false, module: "schedule", error: msg },
            };
          }
        }
        case "moments": {
          const moments = params?.moments && typeof params.moments === "object" ? params.moments : null;
          const content = typeof moments?.content === "string" ? moments.content.trim() : "";
          if (!content) {
            return {
              content: [{ type: "text", text: "module=moments 缺少 moments.content（或为空）；已拒绝写入草稿。" }],
              details: { ok: false, module: "moments", reason: "empty_content" },
            };
          }
          try {
            const draft = await appendMomentDraftServer({
              agentDir,
              agentId,
              input: {
                content,
                reason,
                source: "xingye-heartbeat-tool",
                sourceEventIds,
              },
            });
            if (!draft) {
              return {
                content: [{ type: "text", text: "草稿写入失败：输入校验未通过（agentId / content / source 不合法）。" }],
                details: { ok: false, module: "moments", reason: "validation_failed" },
              };
            }
            return {
              content: [{
                type: "text",
                text: `已写入朋友圈草稿 ${draft.id}（${draft.content.slice(0, 24)}…），待用户在朋友圈面板「待确认草稿」区确认。`,
              }],
              details: { ok: true, module: "moments", draftId: draft.id, contentLength: draft.content.length },
            };
          } catch (err) {
            const msg = err?.message || String(err);
            return {
              content: [{ type: "text", text: `草稿写入失败：${msg}` }],
              details: { ok: false, module: "moments", error: msg },
            };
          }
        }
        default:
          /** Defensive — SUPPORTED_MODULES 与 switch 不一致时打到这里。 */
          return {
            content: [{ type: "text", text: `module=${moduleName} 还未实现 dispatch（SUPPORTED_MODULES 与 switch 不同步）。` }],
            details: { ok: false, reason: "dispatch_not_implemented" },
          };
      }
    },
  };
}

/** 暴露给测试 / categorization 检查用，避免 enum 漂移。 */
export const XINGYE_PROPOSE_DRAFT_SUPPORTED_MODULES = Object.freeze([...SUPPORTED_MODULES]);
