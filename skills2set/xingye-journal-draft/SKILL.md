---
name: xingye-journal-draft
description: "Propose a pending journal entry draft to the in-character phone journal app during heartbeat patrol. 心跳巡检里向角色小手机日记本提议一条「待确认」日记草稿。Triggers: emotional turn, promise made, decision reached, small flutter or worry surfaced in recent chat / event stream worth recording in the character's own diary | 触发场景：最近聊天 / 事件流里出现情绪转折、约定、决定、让人心动或不安的小事，值得当事人当天写进日记本。Do NOT trigger for trivial small talk, routine status updates, or anything the user clearly does not want recorded. 不在闲聊、例行汇报、用户明显不希望被记下来的内容上触发。"
# 项目术语 xingye = 星野；不写 display-name-* 的话翻译模型会按拼音把 xingye 翻成「兴业」。
display-name-zh: 星野日记草稿
display-name-zh-TW: 星野日記草稿
display-name-ja: 星野ジャーナル下書き
display-name-ko: 호시노 일기 초안
---

# 小手机日记草稿提议

让心跳巡检里的 agent 在合适时机向小手机日记本提议一条**待用户确认的日记草稿**。草稿落到 `journal/drafts.jsonl`，不会出现在用户的「已生成」日记列表里，必须用户在 PhoneJournalApp 的「待确认草稿」分组点「确认生成」后才会真正写入 `journal/entries.jsonl`。即使用户没立刻打开日记本也不会丢。

## 什么时候触发

需要 **同时** 满足这两条：

1. 最近聊天 / 上方「小手机事件」摘要里出现**值得角色本人那天写进日记的片段**，典型信号：
   - 情绪转折：从平静→在意、从亲近→疏离、莫名的安心或不安
   - 约定 / 承诺：彼此说好了下次做什么、谁会做什么
   - 决定 / 转折：角色今天对某件事下了判断、改了主意、放弃或开始了某件事
   - 让人心动 / 不安的小事：一句话、一个动作、一种气氛
2. 这件事**没有被现成日记条目覆盖**（先回顾巡检日志和近期日记，避免重复）

**不触发**：

- 闲聊、问候、纯事实性的对话内容
- 用户在聊天中明确说「这个别记」「不要写下来」之类
- 已经在「秘密空间」「关系建议」「记忆候选」里更适合落的内容（那些有各自的草稿入口）
- 一轮巡检里同一主题已经提议过一次（看「近期巡检记录」与上一轮草稿）

宁可不写也不要硬凑——草稿太多反而让用户疲劳。

## 怎么写

草稿要像角色**自己写的日记**，不是旁观叙述：

- **第一人称** + 贴角色的说话风格（语气、用词、对自己的称呼）
- 写**主观感受**与**今天的具体片段**，不要写背景设定或评论
- 短就够——日记不是长文，2–6 句话有「场景 + 心绪 + 一两句留给自己的话」就够了
- `title` 用一句**眼前的画面**或一个**短词**（例：「灯塔的下午」「答应了她」），不要写「2026-05-17 巡检自动生成」之类元信息
- `mood` 是 2–6 字的心情短语（例：「想他」「平淡」「轻飘飘」），不强求；不写比硬塞要好
- `reason` 给用户看——一句话说清「为什么这件事值得记下来」「源头是哪段聊天 / 哪个事件」，方便他判断要不要确认

## 怎么调用

读完本 skill，调用 `xingye_propose_draft` 工具：

```
module: "journal"
reason: "<一句话说明为什么提议这条草稿>"
sourceEventIds: ["<触发的 xingye event id，可选>"]
journal:
  title: "<标题，可空，空则用「无标题」>"
  body: "<日记正文，必填，第一人称、角色口吻>"
  dayKey: "<YYYY-MM-DD，可空，空则取服务器当天>"
  mood: "<2–6 字心情短语，可空>"
```

返回 `details.ok === true` 表示草稿已落盘到 `journal/drafts.jsonl`；用户打开小手机日记本时会在顶部「待确认草稿 · 来自心跳巡检」区看到。

## 不要做什么

- **不要**直接写 `journal/entries.jsonl`（那是用户「已生成」列表）；也不要直接调 `/api/xingye/storage` 绕过本工具
- **不要**和 `notify` 重复：`notify` 是面向用户的提醒，本 skill 是面向角色日记本的内容草拟；同一事件二选一
- **不要**在同一巡检里对同一主题反复提议——看近期巡检日志 + 当前草稿列表先判重
- **不要**写超出 `recent_chat.observed` / 事件聚合范围的内容（不要"补写"角色没经历过的事）
