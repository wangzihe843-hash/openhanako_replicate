---
name: xingye-secret_space-draft
description: "Propose a pending secret-space draft to the in-character secret space panel during heartbeat patrol. 心跳巡检里向角色秘密空间提议一条「待确认」内容草稿（state / dream / saved_item 三个分类之一）。Triggers: recent chat / event stream reveals an interior moment the character wants to privately save — a snapshot of the character's current state/mood, a dream the character had, or a sentence/quote the character wants to keep for themself. 触发场景：最近聊天 / 事件流里出现 TA 想私下记下的内心片段——当下的状态/心境快照、梦境记录、想收藏的一句话。Do NOT trigger when the content belongs to journal (longer reflection), moments (public posting), mail (a letter), or schedule (an event). 不在更适合 journal（长篇心事）/ moments（要发布）/ mail（要写信）/ schedule（有时点）的内容上触发。"
display-name-zh: 星野秘密空间草稿
display-name-zh-TW: 星野秘密空間草稿
display-name-ja: 星野秘密空間下書き
display-name-ko: 호시노 비밀 공간 초안
---

# 秘密空间草稿提议

让心跳巡检里的 agent 在合适时机向秘密空间提议一条**待用户确认的内容草稿**。草稿落到 `secret-space/drafts.jsonl`（跨 category 共用一个文件，用 `category` 字段区分），不会出现在任何分类的「已生成」列表里，必须用户在 SecretSpacePanel 主页「待确认草稿」分组点「确认生成」后才会写入 `secret-space/{category}.jsonl`。即使用户没立刻打开秘密空间也不会丢。

## 允许的分类（重要）

只允许这三个 category，其它会被工具拒绝：

| category | 中文 | 内容形态 |
| --- | --- | --- |
| `state` | 此刻心境 / 状态 | 随手记下的状态备忘——TA 现在是什么样子、在想什么。 |
| `dream` | 梦境 | 简短的梦境记录；象征化、碎片化，不要写成完整小说，不要解梦说教。 |
| `saved_item` | 收藏 / 摘录 | TA 想留下的一句话、一段对话、一个瞬间。 |

**为什么排除其它 category**：

- `draft_reply` ≈ `mail.draft`（写给某人的信）—— 用 `module: "mail"` 提议
- `unsent_moment` ≈ `moments.draft`（朋友圈草稿）—— 用 `module: "moments"` 提议
- `memory_fragment` 走 MemoryCandidatePanel + xingye_save_memory_candidate——**目前是用户手动点 AI 生成候选 + 人工 confirm/reject 的二阶段流程，不是 agent 自动产出**。这条以后可能也接进 xingye_propose_draft 让 agent 在巡检里主动提议 memory candidate；现阶段如果想"记一段重要的事"，请走 secret_space 的 `saved_item` 或本工具的 `journal` 模块。

## 什么时候触发

需要 **同时** 满足以下两条：

1. 最近聊天 / 上方「小手机事件」摘要里出现一段 **TA 自己内心想留下来的片段**，而且**不适合任何对外可见的模块**（journal / moments / mail / schedule）。
2. 类型对得上下面三种 category 之一：
   - **state**：TA 当下的状态 / 心情 / 关系快照（一句话的版本，不是日记式长篇反思）
   - **dream**：聊天里 TA 提到做了个梦 / 半梦半醒里看到什么，值得记下来
   - **saved_item**：聊天里 TA 引用 / 提到 / 反复回到的一句话、一段对话、一个瞬间，TA 想私藏

**不触发**：

- 长篇情绪反思 / 心事 → 用 `module: "journal"`
- 要发出去 / 公开的 → 用 `module: "moments"` 或 `module: "mail"`
- 有具体时点的事项 → 用 `module: "schedule"`
- 同一巡检轮里同一主题已经提议过

宁可不提议也不要硬凑——秘密空间是 TA 自己的内心抽屉，乱塞会显得 OOC。

## 字段约定

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `category` | ✅ | `state` / `dream` / `saved_item` 三选一。 |
| `title` | 可选 | 标题。≤160 字符；为空时 UI 用 body 前几字代替。 |
| `body` | ✅ | 正文，必填，trim 后不能为空。第一人称、贴角色口吻。≤4000 字符。 |
| `tags` | 可选 | 标签。`dream` 用作意象关键词（「水」「回不去的车」），`saved_item` 用作分类（「句子 / 对话 / 瞬间 / 片段」）。最多 8 个，每个 ≤32 字符。 |
| `reason` | 强烈建议 | 给用户看——一句话说清「为什么 TA 想私下记下来」「源头是哪段聊天 / 哪个事件」。 |

## 调用样例（state）

```
module: "secret_space"
reason: "她说完那句之后 TA 沉默了很久，状态明显从安然变成想着她"
sourceEventIds: ["<event-id>"]
secret_space:
  category: "state"
  body: "今晚听她说完那句话，胸口像被人轻轻按住。原本以为今天可以安安稳稳过完。"
```

## 调用样例（dream）

```
module: "secret_space"
reason: "TA 早上聊到昨夜的梦境片段，象征比较强，值得留下来"
secret_space:
  category: "dream"
  body: "我在站台上等车，车一直没来。雨开始下，但伞撑不开。她在另一边的站台，我看到她，但叫不出名字。"
  tags: ["车", "雨", "叫不出名字"]
```

## 调用样例（saved_item）

```
module: "secret_space"
reason: "她转述老师讲过的一句话，TA 反复回到这句，想留下来"
secret_space:
  category: "saved_item"
  title: "老师讲过的一句话"
  body: "「不要把日子过成一道证明题。」"
  tags: ["句子"]
```

返回 `details.ok === true` 表示草稿已落盘到 `secret-space/drafts.jsonl`；用户打开秘密空间会在 home 顶部「待确认草稿」区看到。

## 不要做什么

- **不要**直接写 `secret-space/{category}.jsonl`（那是用户「已生成」列表）；也不要直接调 `/api/xingye/storage` 绕过本工具
- **不要**用 `category: "draft_reply"` / `"unsent_moment"` / `"memory_fragment"`——工具会直接拒绝；这三个分类有专门的模块
- **不要**和 `notify` 重复：`notify` 是面向用户的提醒，本 skill 是面向角色内心抽屉的内容草拟
- **不要**把适合 journal 的长篇心事塞进 state —— state 是状态笔记，不是日记
- **不要**在同一巡检轮里对同一主题反复提议——看近期巡检日志 + 当前草稿列表先判重
- **不要**虚构梦境 / saved_item —— 必须有聊天 / 事件流里的具体源头
