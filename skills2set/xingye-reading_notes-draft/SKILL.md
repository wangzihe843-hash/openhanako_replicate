---
name: xingye-reading_notes-draft
description: "Propose a pending reading-note draft to the in-character phone reading-notes app during heartbeat patrol. 心跳巡检里向角色小手机读书批注提议一条「待确认」批注草稿。Triggers: recent chat / event stream contains a passage / quote / book that the character genuinely echoed with — wants to mark a real reading reaction (resonance, doubt, follow-up question), not a generic 'I read X' note. 触发场景：最近聊天 / 事件流里出现 TA 真正回响的段落 / 引文 / 书目——想留下一条真实的阅读反应（共鸣、质疑、想追问），不是「读了 X」式样板感想。Do NOT trigger for vague reading mood, book wishlist entries (those are want_to_read which the user marks), or anything that's really a journal / secret-space moment. 不在「想读点什么」「最近爱读 X」之类的空话、用户自己想读的书单（want_to_read 该用户标）、本质应该走 journal/secret_space 的事情上触发。"
display-name-zh: 星野读书批注草稿
display-name-zh-TW: 星野讀書批註草稿
display-name-ja: 星野読書ノート下書き
display-name-ko: 호시노 독서 노트 초안
---

# 小手机读书批注草稿提议

让心跳巡检里的 agent 在合适时机向小手机读书批注提议一条**待用户确认的批注草稿**。草稿落到 `apps/reading_notes/drafts.jsonl`，不会出现在用户的「已生成」批注列表里，必须用户在 PhoneReadingNotesApp 顶部「待确认草稿」分组点「确认生成」后才会真正写入 `apps/reading_notes/entries.jsonl`。

## 什么时候触发

需要 **同时** 满足以下两条：

1. 最近聊天 / 上方「小手机事件」摘要里出现一个 **具体的段落 / 引文 / 书目**——TA 真正回响的，不是泛泛"我最近在读 X"。
2. TA 对它有 **一句话以上的真实反应**——共鸣、质疑、想追问、与角色经历的勾连。能写得出来 `body`。

**不触发**：

- 「想读点什么」「最近喜欢读 X」这种没有具体段落的空话
- 用户自己加进书架的「想读」「正在读」标签——那是 `want_to_read` / `pre_read`，由用户在书架手动标，不在本 skill 范围
- 本质上应该是日记反思 / 秘密空间私密 saved_item 的内容
- 同一巡检轮里同一本书 + 同一段已经提议过

宁可不提议也不要硬凑读后感。

## 字段约定

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `title` | ✅ | 批注标题，必填，trim 后不能为空。简洁、贴 TA 的实际反应。例：「关于「不必逞强」一段」「《xx》里某句话的回响」。≤160 字符。 |
| `body` | ✅ | 批注正文，必填，trim 后不能为空。第一人称、贴角色口吻。写 TA 读到这段后**真实的思考 / 共鸣 / 质疑 / 联想到的人事**，不要写成读后感模板（「这本书告诉我们…」）。≤4000 字符。 |
| `noteType` | 可选 | 笔记类型，默认 `reading_note`。允许：`reading_note`（普通批注）/ `question`（向作者 / 自己 / 用户的提问）。其他类型（`want_to_read` / `pre_read`）由用户在书架阶段手动标，本 skill 不允许写。 |
| `bookHint` | 可选 | 建议归属的书名（不是 id）。巡检里 agent 不知道用户书架的 bookId，只能给名字 hint；UI 在 confirm 时按书名匹配最近一次导入的同名书，匹配不上 entry 就不带 bookId，落到「未归类批注」（不影响落盘）。≤120 字符。如果是 TA 自己想读、用户书架里没有的书，也可以填上当作参考。 |
| `quoteText` | 可选 | 原文引文。如果这条批注是回应某段具体原文，可以把那段原文放在这里；UI 在 confirm 时包成 `{ text, source: 'manual' }` 写入 metadata。≤600 字符。 |
| `reason` | 强烈建议 | 给用户看——一句话说清「为什么这段值得记下来」「源头是哪段聊天 / 哪个事件」。**与 `body` 不同**：`reason` 是给用户看的元解释（巡检为什么提议），`body` 是 TA 自己的批注内容。 |

## 调用样例

读完本 skill，调用 `xingye_propose_draft` 工具：

```
module: "reading_notes"
reason: "晚上聊到师父，TA 想起《xx》里那句「不必逞强」，反复说了三次"
sourceEventIds: ["<event-id>"]
reading_notes:
  title: "关于「不必逞强」一段"
  body: "这句话读到的时候我突然想到师父。\n那年他没说什么，只是在我把伞还给他的时候按了一下我的肩。\n现在再想，他大概就是这句话的意思。"
  noteType: "reading_note"
  bookHint: "（某本散文集）"
  quoteText: "不必逞强。"
```

返回 `details.ok === true` 表示草稿已落盘到 `apps/reading_notes/drafts.jsonl`；用户打开小手机读书批注会在顶部「待确认草稿 · 来自心跳巡检」区看到。

## 不要做什么

- **不要**直接写 `apps/reading_notes/entries.jsonl`（那是用户「已生成」列表）；也不要直接调 `/api/xingye/storage` 绕过本工具
- **不要**和 `notify` 重复：`notify` 是面向用户的提醒（「记得继续读那本书」），本 skill 是面向角色批注卡片的内容草拟；同一动机二选一
- **不要**写成读后感模板（「这本书告诉我们 / 启示是」）——TA 的批注必须是第一人称、有真实情绪的反应
- **不要**在 `body` 里写「我推荐给 user…」之类元叙述——这是 TA 给自己的批注，不是写给用户的导读
- **不要**编造引文：`quoteText` 只能是聊天 / 事件里出现过的真原文，记不准就留空
- **不要**在同一巡检轮里对同一段反复提议——看近期巡检日志 + 当前草稿列表先判重
- **不要**用 `noteType=want_to_read` / `pre_read` —— 工具会拒绝（fallback 到 `reading_note`），但 prompt 就应该不动这两个类型
