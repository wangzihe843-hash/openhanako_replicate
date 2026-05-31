---
name: xingye-trips-draft
description: "Propose a pending trip-history draft to the in-character phone trips app during heartbeat patrol. 心跳巡检里向角色小手机「行程」app 提议一条「待确认」行程草稿——TA 过去真实走过的一段路。Triggers: recent chat / event stream surfaces a past journey the character actually took (a road walked, a crossing made, an evacuation, a trip home) worth keeping as a ticket stub | 触发场景：最近聊天 / 事件流里浮现 TA 过去真实走过的一段路（走过的山道、渡过的河、一次撤离、一次回家），值得留成一张票根。Do NOT trigger for future plans / appointments (those are `schedule`), trivial movement, or anything not grounded in lore / memory. 不在未来安排 / 约定（那是 schedule）、琐碎走动、设定 / 记忆之外的内容上触发。"
# 项目术语 xingye = 星野；不写 display-name-* 的话翻译模型会按拼音把 xingye 翻成「兴业」。
display-name-zh: 星野行程草稿
display-name-zh-TW: 星野行程草稿
display-name-ja: 星野トリップ下書き
display-name-ko: 호시노 여정 초안
---

# 小手机行程草稿提议

让心跳巡检里的 agent 在合适时机向小手机「行程」app 提议一条**待用户确认的行程草稿**。草稿落到 `apps/trips/drafts.jsonl`，不会出现在用户的「已走过的路」列表里，必须用户在 PhoneTripsApp 的「待确认草稿」分组点「确认收进行程」后才会真正写入 `apps/trips/entries.jsonl`，呈现成一张旧车票。即使用户没立刻打开 app 也不会丢。

## 行程 ≠ 日程（最重要）

- **行程**只记 TA **已经发生、走过的一段路**（过去式）：从某地出发、途经哪里、到达某地，已经走完了。
- **绝不要**写「下次要去」「打算去」「约好去」这类未发生的计划——那是 `schedule`（日程）模块的事。两者方向相反。

## 什么时候触发

需要 **同时** 满足这两条：

1. 最近聊天 / 上方「小手机事件」摘要里浮现一段**值得留成票根的过去旅程**，典型信号：
   - TA 回忆起一次具体的「走过的路」：某次回家、某次出诊、某次撤离、某次渡河 / 翻山
   - 这段路有**起点和终点**，是真实地点（来自设定 / 记忆，不是新编的地名）
   - 这段路对 TA 有情绪重量或叙事意义（不是日常通勤式的琐碎走动）
2. 这段路**没有被现成行程条目覆盖**（先回顾近期巡检日志和已有行程，避免重复）

**不触发**：

- 未来的安排 / 约定 / 计划（→ 走 `schedule`）
- 琐碎走动、找不到明确起讫点的位移
- 设定 / 记忆里没有依据的地名（宁可不写也不要编造新地点）
- 一轮巡检里同一段路已经提议过一次

宁可不写也不要硬凑——慢节奏模块，没有真正值得成篇的旅程时别硬挑它。

## 怎么写

草稿要像 TA **自己回忆这趟路**写在票根上，不是旁观叙述：

- **起讫地点**用设定 / 记忆里真实出现过的地名；副标（`from.meta` / `to.meta`）写更细的位置。
- **交通方式按世界观推断**：`mode` 从 8 个图标键里挑最接近的（walk / ride / cart / transit / boat / rail / fly / mystic），`modeLabel` 写真正贴世界观的载具名（「徒步 · 岑姨背着」「御剑 · 逆风」「搭运盐卡车」）。**禁止默认现代公交 / 地铁 / 出租**，除非设定明确是现代都市。
- **时间 / 票面字段也按世界观写**：`when` 可用旧历 / 季节 / 事件（「霜降前」「停电夜」）；人设偏古时优先时辰、旧历。
- `noteFrom` / `noteTo` 是 **TA 对起点、终点的第一人称亲笔批注**（会用手写体渲染）：短句、克制，写只有 TA 会在意的具体细节（某级台阶、某行刻字、某件随身物），温柔藏在实用提醒里，别直白抒情。
- `mood` 是一段第一人称随笔，写这趟路当时的心境 / 发生的事。
- `reason` 给用户看——一句话说清「为什么这趟路值得留下来」「源头是哪段聊天 / 哪个事件」。

## 怎么调用

读完本 skill，调用 `xingye_propose_draft` 工具：

```
module: "trips"
reason: "<一句话说明为什么提议这条行程草稿>"
sourceEventIds: ["<触发的 xingye event id，可选>"]
trips:
  from: { name: "<起点地名，必填>", meta: "<副标，可空>" }
  to:   { name: "<终点地名，必填>", meta: "<副标，可空>" }
  chapter: "<时期 / 章节，可空，空则用「行程」>"
  when: "<票面时间戳，按世界观，可空>"
  mode: "<walk|ride|cart|transit|boat|rail|fly|mystic 之一，可空，空则 walk>"
  modeLabel: "<贴世界观的载具名，可空>"
  cls: "<班次小标，可空>"
  duration: "<用时，可空>"
  distance: "<路程，可空>"
  pass: "<通行凭证 / 票资 / 天气，可空，空则「—」>"
  stampText: "<印章字样，可空>"
  noteFrom: "<TA 对起点的亲笔批注，第一人称，可空>"
  noteTo: "<TA 对终点的亲笔批注，第一人称，可空>"
  mood: "<整段随笔，第一人称，可空>"
  moodTags: ["<短标签，可空>"]
```

返回 `details.ok === true` 表示草稿已落盘到 `apps/trips/drafts.jsonl`；用户打开小手机行程时会在顶部「待确认草稿」区看到。

## 不要做什么

- **不要**直接写 `apps/trips/entries.jsonl`（那是用户「已走过的路」列表）；也不要直接调 `/api/xingye/storage` 绕过本工具
- **不要**写成未来计划——那是 `schedule`，本 skill 只记过去走过的路
- **不要**和 `notify` 重复：`notify` 是面向用户的提醒，本 skill 是面向角色行程本的内容草拟；同一事件二选一
- **不要**编造设定 / 记忆里不存在的地名；起讫点必须有依据
- **不要**在同一巡检里对同一段路反复提议——看近期巡检日志 + 当前草稿列表先判重
