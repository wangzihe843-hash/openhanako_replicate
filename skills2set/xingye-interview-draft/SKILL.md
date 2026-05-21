---
name: xingye-interview-draft
description: "Propose a pending exclusive-interview draft to the in-character secret-space interview module during heartbeat patrol. 心跳巡检里向角色秘密空间「TA 的独家专访」模块提议一条「待确认」录制意图草稿。Triggers: a real turning point / unresolved feeling has surfaced that the character would meaningfully open up about in a sit-down interview — and no interview has been recorded for a while. 触发场景：出现了一个 TA 真会在受访时认真袒露的转折 / 心结，且专访模块已有一阵子没录新的一期。This is an INTENT draft only — you write at most one `userQuestion`; the full 5-question interview is generated when the user clicks 确认录制. 这是「意图草稿」——你最多写一题 `userQuestion`，整期 5 题专访在用户点「确认录制」时才生成。Do NOT trigger every patrol, do NOT trigger on small talk, and do NOT write the interview Q&A yourself. 不要每轮巡检都提议、闲聊小事上不要提议、不要自己写专访问答。"
display-name-zh: 星野独家专访草稿
display-name-zh-TW: 星野獨家專訪草稿
display-name-ja: 星野独占インタビュー下書き
display-name-ko: 호시노 단독 인터뷰 초안
---

# 秘密空间 · 独家专访录制意图草稿提议

让心跳巡检里的 agent 在合适时机向秘密空间「TA 的独家专访」模块提议一条**待用户确认的录制意图草稿**。

与「草稿即成品」的模块**不同**：一期专访是固定 5 题 + 每题弹幕 + 「相机关了之后」幕后彩蛋的重型结构化生成。本工具只写一条**意图**（TA 愿意接受一次专访、用户想被问到的那一题），草稿落 `secret-space/interview-drafts.jsonl`。整期专访在用户于专访面板「待确认草稿」区点「确认录制」时，UI 才现场生成。**不要尝试自己写专访问答。**

## 什么时候触发

需要 **同时** 满足：

1. 最近聊天 / 事件流里出现一个 TA **真会在受访时认真袒露**的转折 / 心结 / 阶段性回望——值得用一整期专访来展开。
2. 专访模块**已有一阵子没录新的一期**（看近期巡检日志 / 小手机事件摘要里有没有近期的 `独家专访新增`）。

**不触发**：

- 每轮巡检都提议——专访是慢节奏模块，频繁录制会稀释它的分量
- 只是闲聊小事、没有够分量的心结或转折
- 本质上是一条日记 / 朋友圈 / 秘密空间 saved_item 内容，硬塞成专访
- 当前已经有一条未确认的专访意图草稿挂着（先让用户处理掉）

宁可这轮不提议，也不要为了凑数录专访。

## 字段约定

`module: "interview"`，模块字段只有一个，且**可选**：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `interview.userQuestion` | 可选 | 这次专访里想被问到的那一题。一句话，确认时作为 `userQuestion` 传给生成端，会落在 5 题中的某一题位置。例：「关于那次离开，你后悔过吗」。留空＝由生成端自拟全部 5 题。≤200 字符。**不要在这里写答案 / 其它 4 题**——只写想被问到的那一题。 |
| `reason` | 强烈建议 | 给用户看——一句话说清「为什么这轮想录一期专访」「攒了哪个值得展开的心结 / 转折」。与 `userQuestion` 不同：`reason` 是给用户的元解释，`userQuestion` 是给生成模型的那道题。 |

## 调用样例

读完本 skill，调用 `xingye_propose_draft` 工具：

```
module: "interview"
reason: "这两周 TA 反复提起那年冬天离开边境的事，像是终于想认真讲一次"
sourceEventIds: ["<event-id>"]
interview:
  userQuestion: "关于那次离开，你后悔过吗"
```

返回 `details.ok === true` 表示意图草稿已落盘到 `secret-space/interview-drafts.jsonl`；用户打开秘密空间「TA 的独家专访」会在「待确认草稿 · TA 想接受一次专访」区看到，点「确认录制」后 UI 才生成整期专访。

## 不要做什么

- **不要**自己写专访的问答 / 弹幕 / 幕后——本工具只接收一句 `userQuestion`，整期内容是 confirm 时生成的
- **不要**直接写 `secret-space/interview.jsonl`，也不要直接调 `/api/xingye/storage` 或 `/api/xingye/phone-generate` 绕过本工具
- **不要**每轮巡检都录专访——专访是慢节奏模块
- **不要**和 `notify` 重复：同一动机二选一
- **不要**在已有未确认专访草稿时再叠一条——先看当前草稿列表判重
