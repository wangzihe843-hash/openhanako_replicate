---
name: xingye-news-draft
description: "Propose a pending newspaper-issue draft to the in-character phone news app during heartbeat patrol. 心跳巡检里向角色小手机「报纸」模块提议一条「待确认」出报意图草稿。Triggers: enough world / relationship developments have accumulated since the last issue that a fresh multi-section tabloid would feel earned — and the news app has not had a new issue for a while. 触发场景：自上一期报纸以来，世态 / 感情线确实攒下了够成一整期小报的进展，且报纸模块已有一阵子没出新期。This is an INTENT draft only — you write at most a one-line `angle`; the full multi-section issue is generated when the user clicks 确认出版. 这是「意图草稿」——你最多写一句 `angle`，整期报纸在用户点「确认出版」时才生成。Do NOT trigger every patrol, do NOT trigger when nothing of substance happened, and do NOT try to write the newspaper content yourself. 不要每轮巡检都提议、没有实质进展时不要提议、不要自己动手写报纸正文。"
display-name-zh: 星野报纸出报草稿
display-name-zh-TW: 星野報紙出報草稿
display-name-ja: 星野新聞発行下書き
display-name-ko: 호시노 신문 발행 초안
---

# 小手机报纸 · 出报意图草稿提议

让心跳巡检里的 agent 在合适时机向小手机「报纸」模块提议一条**待用户确认的出报意图草稿**。

与日记 / 朋友圈这类「草稿即成品」的模块**不同**：一期报纸是多板块的重型结构化生成。本工具只写一条**意图**（你想出一期报纸、想从什么角度切入），草稿落 `apps/news/drafts.jsonl`。整期报纸在用户于 PhoneNewsApp「待确认草稿」区点「确认出版」时，UI 才现场生成。**不要尝试自己写报纸正文。**

## 什么时候触发

需要 **同时** 满足：

1. 自上一期报纸以来，世态 / TA 与用户的关系线确实**攒下了够成一整期的进展**——有头版世界线大事可写，也有感情视角可落。
2. 报纸模块**已有一阵子没出新期**（看近期巡检日志 / 小手机事件摘要里有没有近期的 `报纸新增`）。

**不触发**：

- 每轮巡检都提议——报纸是慢节奏模块，频繁出报会稀释它的分量
- 这一轮没有任何实质进展，只是「想出一期」的空冲动
- 本质上是一条日记 / 朋友圈 / 秘密空间内容，硬塞成报纸
- 当前已经有一条未确认的报纸意图草稿挂着（先让用户处理掉）

宁可这轮不提议，也不要为了凑数出报。

## 字段约定

`module: "news"`，模块字段只有一个，且**可选**：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `news.angle` | 可选 | TA 这一期想从什么角度切入。一句话弱提示，确认时作为生成报纸的 `userIntent`。例：「想看看城里最近的世态」「关注那桩没人提起的旧案」。留空＝没有特定角度、照常出一期。≤400 字符。**不要在这里写报纸正文 / 板块内容**——只写切入角度。 |
| `reason` | 强烈建议 | 给用户看——一句话说清「为什么这轮想出一期报纸」「攒了哪些值得成篇的进展」。与 `angle` 不同：`reason` 是给用户的元解释，`angle` 是给生成模型的创作提示。 |

## 调用样例

读完本 skill，调用 `xingye_propose_draft` 工具：

```
module: "news"
reason: "这周边境医院的事、和用户那场没说开的对话，都够攒成一期了；报纸上次出还是十几天前"
sourceEventIds: ["<event-id>"]
news:
  angle: "想从边境近来的人事变动切入，感情专栏可以提一句那场没说开的对话"
```

返回 `details.ok === true` 表示意图草稿已落盘到 `apps/news/drafts.jsonl`；用户打开小手机报纸会在列表顶部「待确认草稿 · TA 想出一期报纸」区看到，点「确认出版」后 UI 才生成整期报纸。

## 不要做什么

- **不要**自己写报纸正文 / 板块 / 标题——本工具只接收一句 `angle`，整期内容是 confirm 时生成的
- **不要**直接写 `apps/news/entries.jsonl`，也不要直接调 `/api/xingye/storage` 或 `/api/xingye/phone-generate` 绕过本工具
- **不要**每轮巡检都出报——报纸是慢节奏模块
- **不要**和 `notify` 重复：同一动机二选一
- **不要**在已有未确认报纸草稿时再叠一条——先看当前草稿列表判重
