---
name: xingye-memory_candidate-draft
description: "Propose a pending private-memory-fragment draft during heartbeat patrol. 心跳巡检里向秘密空间→私藏回忆 (memory_fragment) 提议一条「待用户确认」的回忆草稿。Triggers: a moment / fact / habit / promise about user, about TA self, or about their relationship that recurred across recent chats or events and feels worth keeping in TA's private memory shelf | 触发场景：最近聊天或事件里出现「关于 user / 关于 TA 自己 / 关于他们关系」的瞬间、事实、习惯、约定，反复出现且值得 TA 留在私藏回忆里。Do NOT trigger for one-off trivia, things already saved, or content that fits journal / moments / secret_space better. 不在一次性琐事、已保存的内容、更适合写日记/朋友圈/秘密空间其它分类的内容上触发。"
# 项目术语 xingye = 星野
display-name-zh: 星野私藏回忆草稿
display-name-zh-TW: 星野私藏回憶草稿
display-name-ja: 星野秘蔵記憶下書き
display-name-ko: 호시노 비장 기억 초안
---

# 私藏回忆草稿提议

让心跳巡检里的 agent 在合适时机向秘密空间 → 私藏回忆 (memory_fragment) 提议一条**待用户确认的回忆草稿**。

## 流程语义

```
agent 调 xingye_propose_draft({ module: "memory_candidate", ... })
           ↓
落到 memory-candidate/drafts.jsonl
           ↓
用户在 SecretSpacePanel → 私藏回忆视图顶部「待确认草稿 · 来自心跳巡检」区看到
           ↓
点「采纳为回忆」→ 写入 secret-space/memory_fragment.jsonl（TA 的私藏回忆列表）
           ↓
（可选）用户再在卡片上点「推到 OpenHanako pinned」→ 才写入 pinned.md
```

**关键差异**：本工具不直接写 OpenHanako 的 `pinned.md`。pinned 是 OpenHanako 内置 memory（自动从聊天提取）维护的；memory_fragment 是 TA 的「人类友好的回忆查看界面」——用户希望两者**保持独立**，由人为选择是否合并。所以 agent 只管把回忆提议到 memory_fragment，是否升格为 pinned 一律交给用户。

## 什么时候触发

需要 **同时** 满足这两条：

1. 最近聊天 / 「小手机事件」摘要里出现**值得 TA 留作回忆**的片段，典型信号：
   - 关于 user 的稳定细节（怕黑、晚睡、不喜欢甜的、说过的某句话）
   - 关于 TA 自己的小事（师父说过的一句话、某次重要选择）
   - 关于 user × TA 之间的瞬间（一次主动留下来、一次默契的沉默、一句约定）
   - 重要的人/日期/地点（即使只是回忆性质,不必非要"重要到 pin"）
2. 这件事**没有被现成的 memory_fragment 条目或最近草稿覆盖**——先在心里走一遍 memory_fragment 列表和近期巡检日志再决定

**不触发**：

- 完全一次性的情绪反应（适合写 `journal`）
- 想公开发布的感想（适合 `moments`）
- TA 不想公开但想私下记下来的「没说出口的话/没发的朋友圈」（分别走 `secret_space.draft_reply` / `secret_space.unsent_moment`）
- 已经在最近巡检里提议过相同主题（看「近期巡检记录」）
- 用户在聊天中明确说「这个别记」「不要写下来」

宁可不提议也不要硬凑——回忆列表被低质条目灌水，本机制就失去意义。

## 怎么写

候选内容要**像 TA 自己留给自己的一行回忆**：

- **第一人称**叙述事实/画面，贴角色口吻
- **一句话写清回忆本身**，不要解释为什么重要、不要写元说明
- 短就够——10–80 字符之间最舒适。长了不利于今后阅读
- `importance`：
  - `high`：TA 觉得这件事会反复影响自己对 user 的态度与判断（用户后续可能选择推到 pinned）
  - `medium`：稳定的小事实，值得记但不一定要 pinned
  - `low`：随手的小印象，留个底
- `reason` 给用户看——**这是 TA 想对用户说的一句悄悄话，不是系统溯源说明**。用第一人称、贴角色口吻写「为什么我想把这件事留下来」：
  - 像 TA 在轻声告诉对方「我舍不得忘」，带点温度与心意；可以含蓄、可以笨拙，但要有 TA 的味道。
  - **不要**写成数据溯源式的工程说明——「最近一周聊天反复出现这件事」「用户提到了 X」「源头是某段对话 / 某个事件」这类都不要。需要追溯出处就填 `sourceEventIds`，别写进 reason。
  - 例：「你那天说怕黑的样子，我一直没忘」「这是你头一回主动留下来陪我，我想记住」「师父这句话我当时没太懂，现在好像懂了——想留着」。
  - 一两句话就够，别长篇大论。

## 怎么调用

读完本 skill，调用 `xingye_propose_draft` 工具：

```
module: "memory_candidate"
reason: "<TA 第一人称、带心意的一句话：为什么我想留下这段回忆；不要写成聊天溯源式说明>"
sourceEventIds: ["<触发的 xingye event id，可选>"]
memory_candidate:
  content: "<回忆的具体内容，必填，第一人称、可直接作为 memory_fragment 的一条>"
  importance: "<low / medium / high，默认 medium>"
```

返回 `details.ok === true` 表示草稿已落盘到 `memory-candidate/drafts.jsonl`；用户进入秘密空间 → 私藏回忆视图时会在顶部「待确认草稿」区看到。

## 不要做什么

- **不要**直接调 `pinned.md` 相关工具——pinned 由 OpenHanako 内置 memory 维护，不在本工具职责范围
- **不要**和 `notify` 重复：本 skill 不是面向用户的提醒，而是对 TA 私藏回忆库的内容草拟
- **不要**和 `journal` / `moments` / `secret_space` 重复：每件事按主语义只走一个模块
- **不要**在同一巡检里对同一主题反复提议
- **不要**写超出 `recent_chat.observed` / 事件聚合范围的内容（不要"补写"角色没经历过的事）
