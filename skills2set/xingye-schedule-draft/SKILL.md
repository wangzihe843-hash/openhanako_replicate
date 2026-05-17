---
name: xingye-schedule-draft
description: "Propose a pending schedule entry draft to the in-character phone schedule app during heartbeat patrol. 心跳巡检里向角色小手机日程本提议一条「待确认」日程草稿。Triggers: a concrete promise / appointment / commitment / deadline / decision-with-a-time surfaced in recent chat or the event stream worth putting on the character's calendar | 触发场景：最近聊天 / 事件流里出现具体的约定、约会、承诺、截止、有时点的决定，值得写到角色的日历里。Do NOT trigger for vague aspirations ('we should meet sometime'), private thoughts, or anything that does not have a concrete time anchor. 不在「找时间一起」这种空话、纯内心活动、没有具体时点的事项上触发。"
display-name-zh: 星野日程草稿
display-name-zh-TW: 星野日程草稿
display-name-ja: 星野スケジュール下書き
display-name-ko: 호시노 일정 초안
---

# 小手机日程草稿提议

让心跳巡检里的 agent 在合适时机向小手机日程本提议一条**待用户确认的日程草稿**。草稿落到 `schedule/drafts.jsonl`，不会出现在用户的「已生成」日程列表里，必须用户在 PhoneScheduleApp 的「待确认草稿」分组点「确认生成」后才会真正写入 `schedule/entries.jsonl`。即使用户没立刻打开日程也不会丢。

## 什么时候触发

需要 **同时** 满足以下两条：

1. 最近聊天 / 上方「小手机事件」摘要里出现**具体的、有时点锚定的事项**，典型信号：
   - 约定/约会：彼此说好 X 时间做 Y 事
   - 承诺/任务：角色（或对方）承诺要在某时点前完成某事
   - 截止/提醒：「下周三之前」「明天早上」「下次去诊所前」这类时点
   - 决定+时点：角色今天决定下次某事在什么时候做
2. 这件事**没有被现成日程条目覆盖**（先回顾巡检日志和近期日程，避免重复）

**不触发**：

- 空话（「找时间一起」「以后再说」）—— 没有具体时点不要硬塞日期
- 纯内心活动 / 情绪（那是日记的范畴，看 `xingye-journal-draft`）
- 已经在「秘密空间」「关系建议」「记忆候选」里更适合落的内容
- 同一巡检轮里同一主题已经提议过一次（看「近期巡检记录」与上一轮草稿）

宁可不提议也不要硬凑。

## 字段约定

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `title` | ✅ | 简短的事项名，例：「晚自习」「下次去诊所」「给师父寄信」。≤80 字符。 |
| `dateLabel` | ✅ | 日期文本，**自由格式**——既可以是「今天」「明天上午」「下次去诊所前」，也可以是「2026-05-20」。前端 `parseDateLabel` 会尽力解析；解析不出的自由文本也会保留。≤80 字符。 |
| `content` | ✅ | 具体内容/详情，第一人称、贴角色口吻。≤2000 字符。 |
| `timeText` | 可选 | 时间，自由格式：「上午」「19:30」「睡前」。≤80 字符。 |
| `note` | 可选 | 备注，可写「为什么」「需要带什么」「联系谁」等。≤500 字符。 |
| `category` | 可选 | 类别，建议从「约定 / 提醒 / 自己定的 / 也许吧 / 平常」里选，前端用它配色。其它字符串也允许，但配色会回退到红色「未分类」。 |
| `reason` | 强烈建议 | 给用户看——一句话说清「为什么这件事值得放进日程」「源头是哪段聊天 / 哪个事件」。 |

## 调用样例

读完本 skill，调用 `xingye_propose_draft` 工具：

```
module: "schedule"
reason: "晚饭时她答应明天上午陪我去诊所，落到日程里免得忘"
sourceEventIds: ["<event-id>"]
schedule:
  title: "陪我去诊所"
  dateLabel: "明天上午"
  timeText: "上午"
  content: "她说会陪我一起。要带上社保卡和上次的体检报告。"
  note: "她最近也累，看下要不要错开她的工作时间"
  category: "约定"
```

返回 `details.ok === true` 表示草稿已落盘到 `schedule/drafts.jsonl`；用户打开小手机日程会在顶部「待确认草稿 · 来自心跳巡检」区看到。

## 不要做什么

- **不要**直接写 `schedule/entries.jsonl`（那是用户「已生成」列表）；也不要直接调 `/api/xingye/storage` 绕过本工具
- **不要**和 `notify` 重复：`notify` 是面向用户的提醒（「记得明天上午陪她去诊所」），本 skill 是面向角色日程本的内容草拟；同一事件二选一
- **不要**在同一巡检轮里对同一时点反复提议——看近期巡检日志 + 当前草稿列表先判重
- **不要**编造时点：聊天里没说「什么时候」就不要硬给个 `dateLabel`；宁可不提议
- **不要**把空话（「以后再说」「找时间一起」）落成日程
