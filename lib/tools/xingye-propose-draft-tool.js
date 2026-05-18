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
import { appendMailDraftServer } from "../xingye/mail-drafts.js";
import { appendShoppingDraftServer } from "../xingye/shopping-drafts.js";
import { appendFilesDraftServer } from "../xingye/files-drafts.js";
import {
  appendSecretSpaceDraftServer,
  SECRET_SPACE_DRAFT_ALLOWED_CATEGORIES,
} from "../xingye/secret-space-drafts.js";
import { appendReadingNoteDraftServer } from "../xingye/reading-notes-drafts.js";
import { appendDivinationDraftServer } from "../xingye/divination-drafts.js";
import {
  appendMemoryCandidateDraftServer,
  MEMORY_CANDIDATE_DRAFT_ALLOWED_IMPORTANCE,
} from "../xingye/memory-candidate-drafts.js";
import { appendRelationshipStateDraftServer } from "../xingye/relationship-state-drafts.js";

/**
 * 支持的模块枚举；后续新增模块只在这里加一项 + 下方 switch 加一个 case。
 *
 * 历史候选（已接入）：
 *  - `memory_candidate`（2026-05）：草稿写到 memory-candidate/drafts.jsonl，UI 在
 *     SecretSpacePanel → 私藏回忆 (memory_fragment) 视图顶部展示。用户在卡片上点
 *     「采纳为回忆」会把内容写入 secret-space/memory_fragment.jsonl——**不会自动**
 *     写到 OpenHanako pinned；之后用户可以在每条回忆卡片上单独决定要不要「推到
 *     pinned」。pinned 由 OpenHanako 内置 memory 单独维护，memory_fragment 是 TA
 *     的「人类友好的回忆查看界面」，两者刻意保留为并列存储以避免重复定位。
 *  - `relationship_state`（2026-05）：RelationshipStatePanel 仍保留「手动 refresh → AI
 *     建议 → 接受」路径；本模块写 relationship-state/drafts.jsonl，UI 在 confirm 时
 *     调 updateRelationshipState 应用 deltas。两路径并存，互不干扰。
 */
const SUPPORTED_MODULES = [
  "journal",
  "schedule",
  "moments",
  "mail",
  "shopping",
  "files",
  "secret_space",
  "reading_notes",
  "divination",
  "memory_candidate",
  "relationship_state",
];

const READING_NOTE_DRAFT_ALLOWED_TYPES = ["reading_note", "question"];

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
      mail: Type.Optional(Type.Object({
        subject: Type.Optional(Type.String({
          description: "[mail] 邮件主题；≤200 字符。subject 与 body 不能同时为空。",
        })),
        body: Type.Optional(Type.String({
          description: "[mail] 邮件正文；≤8000 字符。subject 与 body 不能同时为空。第一人称、贴角色口吻。",
        })),
        toAddress: Type.Optional(Type.String({
          description: "[mail] 收件人邮箱地址，可选。巡检里 agent 多半不知道收件人邮箱，留空让用户在确认时补；≤160 字符。",
        })),
        toName: Type.Optional(Type.String({
          description: "[mail] 收件人显示名，可选；≤80 字符。",
        })),
      }, { description: "module === 'mail' 时的字段。确认后写入 messages.jsonl 的 `drafts` 邮箱（草稿箱），fromKind 固定 'agent'——巡检产出的语义就是「TA 想给某人写一封信」。不接 fromKind 等字段。" })),
      files: Type.Optional(Type.Object({
        title: Type.String({
          description: "[files] 资料标题，必填，trim 后不能为空。≤160 字符。例：「关于诊所那条街的笔记」「整理：师父说过的几句话」。",
        }),
        body: Type.Optional(Type.String({
          description: "[files] 正文。第一人称、贴角色口吻；可放整理性的长文本，不要写元说明。≤8000 字符。",
        })),
        summary: Type.Optional(Type.String({
          description: "[files] 摘要，可选。一两句话总结正文。≤300 字符。",
        })),
        folderHint: Type.Optional(Type.String({
          description: "[files] 建议的文件夹**名字**（不是 id）——巡检里 agent 不知道用户私人的 folder uuid。UI 在 confirm 时按名字优先匹配同名 folder，匹配不上回退到「待确认」。常见名字：「世界观整理 / 人际关系 / 关于 user / 线索与发现 / 待确认」。≤80 字符。",
        })),
        tags: Type.Optional(Type.Array(Type.String(), {
          description: "[files] 标签，可选；最多 16 个，每个 ≤32 字符。",
        })),
      }, { description: "module === 'files' 时的字段。确认后写入 files/entries.jsonl；user 在 UI 上可改 folderId / title / body 再 confirm。" })),
      secret_space: Type.Optional(Type.Object({
        category: StringEnum([...SECRET_SPACE_DRAFT_ALLOWED_CATEGORIES], {
          description: "[secret_space] 目标分类。允许 state（此刻心境）/ dream（梦境）/ saved_item（摘录）。其它 category 走不同流程：draft_reply ≈ mail.draft；unsent_moment ≈ moments.draft；memory_fragment 走 MemoryCandidatePanel（**用户手动触发 AI 生成候选 + 人工 confirm/reject**，不是 agent 主动产出——后续可能接进本工具）。",
        }),
        title: Type.Optional(Type.String({
          description: "[secret_space] 标题，可选；为空时 UI 用 body 前几字。≤160 字符。",
        })),
        body: Type.String({
          description: "[secret_space] 正文，必填，trim 后不能为空。第一人称、贴角色口吻。≤4000 字符。",
        }),
        tags: Type.Optional(Type.Array(Type.String(), {
          description: "[secret_space] 标签（dream 用作意象关键词，saved_item 用作分类）。最多 8 个，每个 ≤32 字符。",
        })),
      }, { description: "module === 'secret_space' 时的字段。确认后通过 appendSecretSpaceRecord 写入 secret-space/{category}.jsonl。" })),
      reading_notes: Type.Optional(Type.Object({
        title: Type.String({
          description: "[reading_notes] 笔记标题，必填，trim 后不能为空。≤160 字符。例：「关于「不必逞强」这一段」「《xx》里某句话的回响」。",
        }),
        body: Type.String({
          description: "[reading_notes] 笔记正文，必填，trim 后不能为空。第一人称、贴角色口吻——写 TA 读到这一段后真实的思考/共鸣/质疑，不要写成读后感模板。≤4000 字符。",
        }),
        noteType: Type.Optional(StringEnum([...READING_NOTE_DRAFT_ALLOWED_TYPES], {
          description: "[reading_notes] 笔记类型；默认 'reading_note'。允许：'reading_note'（普通批注）、'question'（提问）。其他类型（want_to_read / pre_read）由用户在书目浏览阶段手动标，不在巡检草稿范围。",
        })),
        bookHint: Type.Optional(Type.String({
          description: "[reading_notes] 建议归属的书名（不是 id）——巡检里 agent 不知道用户书架的 bookId。UI 在 confirm 时按书名匹配最近一次导入的同名书；匹配不上 entry 就不带 bookId，落到「未归类批注」。如果是 TA 自己想读的、用户书架里没有的书，也可以写在这里给用户参考。≤120 字符。",
        })),
        quoteText: Type.Optional(Type.String({
          description: "[reading_notes] 原文引文，可选。如果这条批注是回应某段具体原文，可以把那段原文放在这里；UI 在 confirm 时包成 { text, source: 'manual' } 写入 metadata。≤600 字符。",
        })),
      }, { description: "module === 'reading_notes' 时的字段。确认后写入 apps/reading_notes/entries.jsonl；UI 渲染时会按 noteType 显示不同卡片样式。" })),
      divination: Type.Optional(Type.Object({
        agentQuestion: Type.String({
          description: "[divination] TA 此刻心里在问的事，必填，trim 后不能为空。第一人称、贴角色口吻。例：「我有没有把师父说的那句话听岔了？」「下次跟 user 见面之前我该不该先把某件事讲清楚？」≤200 字符。",
        }),
        content: Type.String({
          description: "[divination] TA 自己写下的「心象」——不是结构化占卜结果，而是 TA 凭直觉/感受得到的一段读出。短而具体；不要硬凑符号、卦象或塔罗术语（那些走正式占卜路径）。第一人称。例：「心里浮出一棵被风吹歪的小树，但根没动。我觉得是说……」≤2000 字符。",
        }),
        themeHint: Type.Optional(Type.String({
          description: "[divination] 主题关键词，可选。譬如「关系 / 工作 / 健康 / 远行」；UI 用作分类辅助。≤80 字符。",
        })),
      }, { description: "module === 'divination' 时的字段。语义偏移：草稿建模为 TA 的「心象提示」（method='oracle_generic'，symbols=[]，content 自由文本），不走 AI 生成的结构化占卜流程——那条路径仍归 PhoneDivinationApp 自己。心象提示的 entry 会和正式占卜并列出现在占卜历史里，UI 已支持空 symbols 的渲染。" })),
      memory_candidate: Type.Optional(Type.Object({
        content: Type.String({
          description: "[memory_candidate] 回忆的具体内容，必填，trim 后不能为空。一句话，写 TA 自己希望记住的事——人物、约定、画面、习惯。第一人称、贴角色口吻；不要写元说明（如「我建议把这件事记下来」），直接写回忆本身。≤600 字符。例：「user 怕黑——夜里走廊不会主动关灯」「师父常说的『不必逞强』」。",
        }),
        importance: Type.Optional(StringEnum([...MEMORY_CANDIDATE_DRAFT_ALLOWED_IMPORTANCE], {
          description: "[memory_candidate] 重要性档位；默认 'medium'。允许：'low' / 'medium' / 'high'。判断依据：这条回忆是否会反复影响 TA 对 user 的态度与判断——会 → high，零星提一次 → low，介于其间 → medium。用户后续在 memory_fragment 卡片上决定要不要把它「推到 pinned」时会参考这个档位。",
        })),
      }, { description: "module === 'memory_candidate' 时的字段。确认后写入 secret-space/memory_fragment.jsonl（TA 的私藏回忆列表）——**不会**自动写到 OpenHanako pinned。pinned 由 OpenHanako 内置 memory 单独维护；memory_fragment 是 TA 的「人类友好的回忆查看界面」，两者刻意分开。用户在卡片上可单独选择是否「推到 pinned」。" })),
      relationship_state: Type.Optional(Type.Object({
        affectionDelta: Type.Optional(Type.Number({
          description: "[relationship_state] 好感度变化，整数，范围 -100..150。零或不填代表不调整这一项。",
        })),
        trustDelta: Type.Optional(Type.Number({
          description: "[relationship_state] 信任变化，整数，范围 -100..100。",
        })),
        loyaltyDelta: Type.Optional(Type.Number({
          description: "[relationship_state] 忠诚变化，整数，范围 -100..100。",
        })),
        jealousyDelta: Type.Optional(Type.Number({
          description: "[relationship_state] 醋意变化，整数，范围 -100..100。",
        })),
        corruptionDelta: Type.Optional(Type.Number({
          description: "[relationship_state] 黑化值变化，整数，范围 -100..100。",
        })),
        mood: Type.Optional(Type.String({
          description: "[relationship_state] 此刻心情短语，可选；≤40 字符。例：「想他」「平淡」「轻飘飘」「警惕」。",
        })),
        stateSummary: Type.Optional(Type.String({
          description: "[relationship_state] 状态摘要，可选，一句话总结 TA 当前心理状态；≤200 字符。",
        })),
        reasonText: Type.Optional(Type.String({
          description: "[relationship_state] 变化原因（专给本模块用，比顶层 reason 更详细的内部理由）；≤500 字符。例：「她今天主动留下来等我吃完饭——这是她以前不会做的」。可与顶层 reason 并存，UI 优先展示 reasonText。",
        })),
      }, { description: "module === 'relationship_state' 时的字段。至少要有一个 delta 非零或 mood 非空；否则没有可应用的状态变化,会被拒。确认后通过 updateRelationshipState 应用到本地状态;并发布 relationship_state.applied 事件,与「手动 refresh → AI 建议 → 接受」路径共用同一最终落地点。" })),
      shopping: Type.Optional(Type.Object({
        itemName: Type.String({
          description: "[shopping] 物品名，必填，trim 后不能为空。≤80 字符。",
        }),
        status: Type.Optional(Type.String({
          description:
            "[shopping] 状态。**必须根据最近聊天/事件流的语义信号主动判断**，不要无脑用 'wanted'：" +
            "「想买/心动/在橱窗外看了好久」→ 'wanted'；" +
            "「在两件之间反复但是…」「价格让我犹豫」→ 'hesitating'；" +
            "「刚下单/订了/付了款/等发货」→ 'ordered'；" +
            "「到货了/拿到了/今天到的」→ 'received'；" +
            "「先收藏/不急着买/留着看看」→ 'favorite'；" +
            "「退了/不合适退掉了」→ 'returned'。" +
            "信号完全模糊或都不沾时才回退到 'wanted'（也是 enum 校验的回退值）。" +
            "**所有 6 个允许值都是 LLM 该主动用的**：wanted / hesitating / ordered / received / favorite / returned。",
        })),
        platformStyle: Type.Optional(Type.String({
          description: "[shopping] 平台风格（影响卡片配色），可选；允许：amazon / taobao / xianyu / generic。默认 'generic'。",
        })),
        category: Type.Optional(Type.String({
          description: "[shopping] 类别，可选；如「衣物 / 书 / 食材」。≤24 字符。",
        })),
        imaginedPrice: Type.Optional(Type.String({
          description: "[shopping] 想象的价格，自由文本，可选；≤40 字符。",
        })),
        content: Type.Optional(Type.String({
          description: "[shopping] 备注/正文，可选；≤2000 字符。如店铺、款式、颜色、为什么犹豫等。",
        })),
        tags: Type.Optional(Type.Array(Type.String(), {
          description: "[shopping] 标签，可选；最多 8 个，每个 ≤24 字符。",
        })),
      }, { description: "module === 'shopping' 时的字段。确认后写入 apps/shopping/entries.jsonl，metadata 记 status / platformStyle / category / imaginedPrice / reason / tags。" })),
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
        case "mail": {
          const mail = params?.mail && typeof params.mail === "object" ? params.mail : null;
          const subject = typeof mail?.subject === "string" ? mail.subject.trim() : "";
          const body = typeof mail?.body === "string" ? mail.body : "";
          if (!subject && !body.trim()) {
            return {
              content: [{ type: "text", text: "module=mail 至少需要 mail.subject 或 mail.body 之一非空；已拒绝写入草稿。" }],
              details: { ok: false, module: "mail", reason: "empty_subject_and_body" },
            };
          }
          try {
            const draft = await appendMailDraftServer({
              agentDir,
              agentId,
              input: {
                subject,
                body,
                toAddress: typeof mail.toAddress === "string" ? mail.toAddress : undefined,
                toName: typeof mail.toName === "string" ? mail.toName : undefined,
                reason,
                source: "xingye-heartbeat-tool",
                sourceEventIds,
              },
            });
            if (!draft) {
              return {
                content: [{ type: "text", text: "草稿写入失败：输入校验未通过（agentId / subject+body / source 不合法）。" }],
                details: { ok: false, module: "mail", reason: "validation_failed" },
              };
            }
            const label = draft.subject || draft.body.slice(0, 24);
            return {
              content: [{
                type: "text",
                text: `已写入邮件草稿 ${draft.id}（${label}…），待用户在小手机邮箱「待确认草稿」区确认。`,
              }],
              details: { ok: true, module: "mail", draftId: draft.id, subject: draft.subject || null },
            };
          } catch (err) {
            const msg = err?.message || String(err);
            return {
              content: [{ type: "text", text: `草稿写入失败：${msg}` }],
              details: { ok: false, module: "mail", error: msg },
            };
          }
        }
        case "files": {
          const files = params?.files && typeof params.files === "object" ? params.files : null;
          const title = typeof files?.title === "string" ? files.title.trim() : "";
          if (!title) {
            return {
              content: [{ type: "text", text: "module=files 缺少 files.title（或为空）；已拒绝写入草稿。" }],
              details: { ok: false, module: "files", reason: "empty_title" },
            };
          }
          try {
            const draft = await appendFilesDraftServer({
              agentDir,
              agentId,
              input: {
                title,
                body: typeof files.body === "string" ? files.body : undefined,
                summary: typeof files.summary === "string" ? files.summary : undefined,
                folderHint: typeof files.folderHint === "string" ? files.folderHint : undefined,
                tags: Array.isArray(files.tags) ? files.tags : undefined,
                reason,
                source: "xingye-heartbeat-tool",
                sourceEventIds,
              },
            });
            if (!draft) {
              return {
                content: [{ type: "text", text: "草稿写入失败：输入校验未通过（agentId / title / source 不合法）。" }],
                details: { ok: false, module: "files", reason: "validation_failed" },
              };
            }
            const hint = draft.folderHint ? `（建议入「${draft.folderHint}」）` : "";
            return {
              content: [{
                type: "text",
                text: `已写入资料柜草稿 ${draft.id}（${draft.title}${hint}），待用户在小手机资料柜「待确认草稿」区确认。`,
              }],
              details: { ok: true, module: "files", draftId: draft.id, title: draft.title, folderHint: draft.folderHint ?? null },
            };
          } catch (err) {
            const msg = err?.message || String(err);
            return {
              content: [{ type: "text", text: `草稿写入失败：${msg}` }],
              details: { ok: false, module: "files", error: msg },
            };
          }
        }
        case "secret_space": {
          const secret = params?.secret_space && typeof params.secret_space === "object" ? params.secret_space : null;
          const category = typeof secret?.category === "string" ? secret.category.trim() : "";
          if (!SECRET_SPACE_DRAFT_ALLOWED_CATEGORIES.includes(category)) {
            return {
              content: [{
                type: "text",
                text: `module=secret_space 不允许 category="${category || "(empty)"}"；允许：${SECRET_SPACE_DRAFT_ALLOWED_CATEGORIES.join(" / ")}。`,
              }],
              details: { ok: false, module: "secret_space", reason: "category_not_allowed" },
            };
          }
          const body = typeof secret?.body === "string" ? secret.body.trim() : "";
          if (!body) {
            return {
              content: [{ type: "text", text: "module=secret_space 缺少 secret_space.body（或为空）；已拒绝写入草稿。" }],
              details: { ok: false, module: "secret_space", reason: "empty_body" },
            };
          }
          try {
            const draft = await appendSecretSpaceDraftServer({
              agentDir,
              agentId,
              input: {
                category,
                title: typeof secret.title === "string" ? secret.title : undefined,
                body,
                tags: Array.isArray(secret.tags) ? secret.tags : undefined,
                reason,
                source: "xingye-heartbeat-tool",
                sourceEventIds,
              },
            });
            if (!draft) {
              return {
                content: [{ type: "text", text: "草稿写入失败：输入校验未通过（agentId / category / body / source 不合法）。" }],
                details: { ok: false, module: "secret_space", reason: "validation_failed" },
              };
            }
            const label = draft.title || draft.body.slice(0, 24);
            return {
              content: [{
                type: "text",
                text: `已写入秘密空间草稿 ${draft.id}（${draft.category}·${label}…），待用户在秘密空间「待确认草稿」区确认。`,
              }],
              details: { ok: true, module: "secret_space", draftId: draft.id, category: draft.category },
            };
          } catch (err) {
            const msg = err?.message || String(err);
            return {
              content: [{ type: "text", text: `草稿写入失败：${msg}` }],
              details: { ok: false, module: "secret_space", error: msg },
            };
          }
        }
        case "shopping": {
          const shopping = params?.shopping && typeof params.shopping === "object" ? params.shopping : null;
          const itemName = typeof shopping?.itemName === "string" ? shopping.itemName.trim() : "";
          if (!itemName) {
            return {
              content: [{ type: "text", text: "module=shopping 缺少 shopping.itemName（或为空）；已拒绝写入草稿。" }],
              details: { ok: false, module: "shopping", reason: "empty_item_name" },
            };
          }
          try {
            const draft = await appendShoppingDraftServer({
              agentDir,
              agentId,
              input: {
                itemName,
                status: typeof shopping.status === "string" ? shopping.status : undefined,
                platformStyle: typeof shopping.platformStyle === "string" ? shopping.platformStyle : undefined,
                category: typeof shopping.category === "string" ? shopping.category : undefined,
                imaginedPrice: typeof shopping.imaginedPrice === "string" ? shopping.imaginedPrice : undefined,
                content: typeof shopping.content === "string" ? shopping.content : undefined,
                tags: Array.isArray(shopping.tags) ? shopping.tags : undefined,
                reason,
                source: "xingye-heartbeat-tool",
                sourceEventIds,
              },
            });
            if (!draft) {
              return {
                content: [{ type: "text", text: "草稿写入失败：输入校验未通过（agentId / itemName / source 不合法）。" }],
                details: { ok: false, module: "shopping", reason: "validation_failed" },
              };
            }
            return {
              content: [{
                type: "text",
                text: `已写入购物草稿 ${draft.id}（${draft.status}·${draft.itemName}），待用户在小手机购物清单「待确认草稿」区确认。`,
              }],
              details: { ok: true, module: "shopping", draftId: draft.id, itemName: draft.itemName, status: draft.status },
            };
          } catch (err) {
            const msg = err?.message || String(err);
            return {
              content: [{ type: "text", text: `草稿写入失败：${msg}` }],
              details: { ok: false, module: "shopping", error: msg },
            };
          }
        }
        case "reading_notes": {
          const reading = params?.reading_notes && typeof params.reading_notes === "object" ? params.reading_notes : null;
          const title = typeof reading?.title === "string" ? reading.title.trim() : "";
          const body = typeof reading?.body === "string" ? reading.body.trim() : "";
          if (!title || !body) {
            return {
              content: [{ type: "text", text: "module=reading_notes 需要 reading_notes.title 和 reading_notes.body 两项；缺一项已拒绝写入。" }],
              details: { ok: false, module: "reading_notes", reason: "missing_required_fields" },
            };
          }
          try {
            const draft = await appendReadingNoteDraftServer({
              agentDir,
              agentId,
              input: {
                title,
                body,
                noteType: typeof reading.noteType === "string" ? reading.noteType : undefined,
                bookHint: typeof reading.bookHint === "string" ? reading.bookHint : undefined,
                quoteText: typeof reading.quoteText === "string" ? reading.quoteText : undefined,
                reason,
                source: "xingye-heartbeat-tool",
                sourceEventIds,
              },
            });
            if (!draft) {
              return {
                content: [{ type: "text", text: "草稿写入失败：输入校验未通过（agentId / title / body / source 不合法）。" }],
                details: { ok: false, module: "reading_notes", reason: "validation_failed" },
              };
            }
            const hint = draft.bookHint ? `（《${draft.bookHint}》）` : "";
            return {
              content: [{
                type: "text",
                text: `已写入读书批注草稿 ${draft.id}（${draft.noteType}·${draft.title}${hint}），待用户在小手机读书批注「待确认草稿」区确认。`,
              }],
              details: { ok: true, module: "reading_notes", draftId: draft.id, title: draft.title, noteType: draft.noteType, bookHint: draft.bookHint ?? null },
            };
          } catch (err) {
            const msg = err?.message || String(err);
            return {
              content: [{ type: "text", text: `草稿写入失败：${msg}` }],
              details: { ok: false, module: "reading_notes", error: msg },
            };
          }
        }
        case "divination": {
          const divination = params?.divination && typeof params.divination === "object" ? params.divination : null;
          const agentQuestion = typeof divination?.agentQuestion === "string" ? divination.agentQuestion.trim() : "";
          const content = typeof divination?.content === "string" ? divination.content.trim() : "";
          if (!agentQuestion || !content) {
            return {
              content: [{ type: "text", text: "module=divination 需要 divination.agentQuestion 和 divination.content 两项；缺一项已拒绝写入。" }],
              details: { ok: false, module: "divination", reason: "missing_required_fields" },
            };
          }
          try {
            const draft = await appendDivinationDraftServer({
              agentDir,
              agentId,
              input: {
                agentQuestion,
                content,
                themeHint: typeof divination.themeHint === "string" ? divination.themeHint : undefined,
                reason,
                source: "xingye-heartbeat-tool",
                sourceEventIds,
              },
            });
            if (!draft) {
              return {
                content: [{ type: "text", text: "草稿写入失败：输入校验未通过（agentId / agentQuestion / content / source 不合法）。" }],
                details: { ok: false, module: "divination", reason: "validation_failed" },
              };
            }
            return {
              content: [{
                type: "text",
                text: `已写入占卜（心象提示）草稿 ${draft.id}（${draft.agentQuestion.slice(0, 24)}…），待用户在小手机占卜「待确认草稿」区确认。`,
              }],
              details: { ok: true, module: "divination", draftId: draft.id, agentQuestion: draft.agentQuestion },
            };
          } catch (err) {
            const msg = err?.message || String(err);
            return {
              content: [{ type: "text", text: `草稿写入失败：${msg}` }],
              details: { ok: false, module: "divination", error: msg },
            };
          }
        }
        case "memory_candidate": {
          const memory = params?.memory_candidate && typeof params.memory_candidate === "object" ? params.memory_candidate : null;
          const content = typeof memory?.content === "string" ? memory.content.trim() : "";
          if (!content) {
            return {
              content: [{ type: "text", text: "module=memory_candidate 缺少 memory_candidate.content（或为空）；已拒绝写入草稿。" }],
              details: { ok: false, module: "memory_candidate", reason: "empty_content" },
            };
          }
          const importance = typeof memory?.importance === "string" ? memory.importance : undefined;
          if (importance && !MEMORY_CANDIDATE_DRAFT_ALLOWED_IMPORTANCE.includes(importance)) {
            return {
              content: [{
                type: "text",
                text: `module=memory_candidate 不允许 importance="${importance}"；允许：${MEMORY_CANDIDATE_DRAFT_ALLOWED_IMPORTANCE.join(" / ")}。`,
              }],
              details: { ok: false, module: "memory_candidate", reason: "importance_not_allowed" },
            };
          }
          try {
            const draft = await appendMemoryCandidateDraftServer({
              agentDir,
              agentId,
              input: {
                content,
                importance,
                reason,
                source: "xingye-heartbeat-tool",
                sourceEventIds,
              },
            });
            if (!draft) {
              return {
                content: [{ type: "text", text: "草稿写入失败：输入校验未通过（agentId / content / source 不合法）。" }],
                details: { ok: false, module: "memory_candidate", reason: "validation_failed" },
              };
            }
            return {
              content: [{
                type: "text",
                text: `已写入回忆草稿 ${draft.id}（${draft.importanceLevel}·${draft.content.slice(0, 24)}…），待用户在秘密空间 → 私藏回忆顶部「待确认草稿」区采纳。采纳后写入 memory_fragment，不会自动写入 pinned。`,
              }],
              details: { ok: true, module: "memory_candidate", draftId: draft.id, importanceLevel: draft.importanceLevel },
            };
          } catch (err) {
            const msg = err?.message || String(err);
            return {
              content: [{ type: "text", text: `草稿写入失败：${msg}` }],
              details: { ok: false, module: "memory_candidate", error: msg },
            };
          }
        }
        case "relationship_state": {
          const state = params?.relationship_state && typeof params.relationship_state === "object" ? params.relationship_state : null;
          if (!state) {
            return {
              content: [{ type: "text", text: "module=relationship_state 缺少 relationship_state 对象；已拒绝写入草稿。" }],
              details: { ok: false, module: "relationship_state", reason: "missing_payload" },
            };
          }
          /** 必须有至少一个 delta 非零或 mood 非空——server 端也校验，这里给更早的 fail。 */
          const deltaKeys = ["affectionDelta", "trustDelta", "loyaltyDelta", "jealousyDelta", "corruptionDelta"];
          const hasDelta = deltaKeys.some((k) => typeof state[k] === "number" && Number.isFinite(state[k]) && state[k] !== 0);
          const mood = typeof state.mood === "string" ? state.mood.trim() : "";
          if (!hasDelta && !mood) {
            return {
              content: [{ type: "text", text: "module=relationship_state 至少需要一个非零 delta 或 mood；已拒绝写入草稿。" }],
              details: { ok: false, module: "relationship_state", reason: "no_change" },
            };
          }
          try {
            const draft = await appendRelationshipStateDraftServer({
              agentDir,
              agentId,
              input: {
                affectionDelta: typeof state.affectionDelta === "number" ? state.affectionDelta : 0,
                trustDelta: typeof state.trustDelta === "number" ? state.trustDelta : 0,
                loyaltyDelta: typeof state.loyaltyDelta === "number" ? state.loyaltyDelta : 0,
                jealousyDelta: typeof state.jealousyDelta === "number" ? state.jealousyDelta : 0,
                corruptionDelta: typeof state.corruptionDelta === "number" ? state.corruptionDelta : 0,
                mood: typeof state.mood === "string" ? state.mood : undefined,
                stateSummary: typeof state.stateSummary === "string" ? state.stateSummary : undefined,
                reasonText: typeof state.reasonText === "string" ? state.reasonText : undefined,
                reason,
                source: "xingye-heartbeat-tool",
                sourceEventIds,
              },
            });
            if (!draft) {
              return {
                content: [{ type: "text", text: "草稿写入失败：输入校验未通过（agentId / 字段范围 / source 不合法，或所有 delta 与 mood 都为空）。" }],
                details: { ok: false, module: "relationship_state", reason: "validation_failed" },
              };
            }
            const deltaSummary = deltaKeys
              .filter((k) => draft[k] !== 0)
              .map((k) => `${k.replace("Delta", "")}${draft[k] > 0 ? "+" : ""}${draft[k]}`)
              .join(" ") || (draft.mood ? `mood=${draft.mood}` : "");
            return {
              content: [{
                type: "text",
                text: `已写入关系状态草稿 ${draft.id}（${deltaSummary}），待用户在 RelationshipStatePanel「待确认草稿」区确认。`,
              }],
              details: { ok: true, module: "relationship_state", draftId: draft.id },
            };
          } catch (err) {
            const msg = err?.message || String(err);
            return {
              content: [{ type: "text", text: `草稿写入失败：${msg}` }],
              details: { ok: false, module: "relationship_state", error: msg },
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
