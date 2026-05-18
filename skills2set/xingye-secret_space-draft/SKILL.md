---
name: xingye-secret_space-draft
description: "Propose a pending secret-space draft to the in-character secret space panel during heartbeat patrol. 心跳巡检里向角色秘密空间提议一条「待确认」内容草稿（state / dream / saved_item / draft_reply / unsent_moment 五个分类之一）。Triggers: recent chat / event stream reveals an interior moment the character wants to privately keep — a state/mood snapshot, a dream, a sentence/quote, a half-typed reply the character deleted instead of sending, or a moments-style line the character wrote but never posted. 触发场景：最近聊天 / 事件流里出现 TA 想私下记下的内心片段——当下的状态/心境、梦境、想收藏的一句话、打了一半又删掉的回复、想发朋友圈但终于没发的那句。Do NOT trigger when the content belongs to journal (longer reflection), moments (truly going to be posted), mail (truly to be sent), or schedule (an event). 不在更适合 journal（长篇心事）/ moments（要真的发出去）/ mail（要真的寄出去）/ schedule（有时点）的内容上触发。"
display-name-zh: 星野秘密空间草稿
display-name-zh-TW: 星野秘密空間草稿
display-name-ja: 星野秘密空間下書き
display-name-ko: 호시노 비밀 공간 초안
---

# 秘密空间草稿提议

让心跳巡检里的 agent 在合适时机向秘密空间提议一条**待用户确认的内容草稿**。草稿落到 `secret-space/drafts.jsonl`（跨 category 共用一个文件，用 `category` 字段区分），不会出现在任何分类的「已生成」列表里，必须用户在 SecretSpacePanel 主页「待确认草稿」分组点「确认生成」后才会写入 `secret-space/{category}.jsonl`。即使用户没立刻打开秘密空间也不会丢。

## 允许的分类（重要）

只允许这五个 category，其它会被工具拒绝。**五个的共同前提是「永远只属于秘密空间、不会自动外发」**——这是和 mail / moments 模块的根本分界：

| category | 中文 | 内容形态 |
| --- | --- | --- |
| `state` | 此刻心境 / 状态 | 随手记下的状态备忘——TA 现在是什么样子、在想什么。一句话的版本，不是日记式长篇反思。 |
| `dream` | 梦境 | 简短的梦境记录；象征化、碎片化，不要写成完整小说，不要解梦说教。 |
| `saved_item` | 收藏 / 摘录 | TA 想留下的一句话、一段对话、一个瞬间。 |
| `draft_reply` | 没发出去的话 | 聊天里 TA 打到一半又删掉的回复、或反复想说却始终没说出口的那句话。**永远不会真的发出去**——存在意义是「TA 选择了沉默」。短句、第一人称、像输入框里按了删除的草稿。 |
| `unsent_moment` | 只有 TA 自己能看见的朋友圈 | 想发朋友圈但终于没发的瞬间，或某个心情/画面想分享却按下了删除的草稿。**永远只属于秘密空间不公开**——和「真的要发」的朋友圈不同。短文本、TA 的内心独白口吻。 |

**为什么 draft_reply / unsent_moment 不走 mail / moments 模块**：

- `mail.draft` 是**真要寄出去**的信——有明确收件人、有发送意图、之后可能真的点发送。
- `moments.draft` 是**真要发布**的朋友圈——会进朋友圈 feed 给联系人看。
- 而 `draft_reply` / `unsent_moment` 的内核是「**永远不发**」：是 TA 内心保留下来的、没说出口的话。把它们放进 mail/moments 模块会给用户一个"是不是要点发送"的错觉；放进秘密空间才贴合"只有 TA 自己能看见的抽屉"这一语义。

**为什么排除 memory_fragment**：

- `memory_fragment` 走 MemoryCandidatePanel。Agent 想提议回忆请用 `module: "memory_candidate"`（同一个 xingye_propose_draft 工具的另一个 module），**不要**把回忆塞到 secret_space 里。

## 什么时候触发

需要 **同时** 满足以下两条：

1. 最近聊天 / 上方「小手机事件」摘要里出现一段 **TA 自己内心想留下来的片段**，而且**不适合任何对外可见的模块**（journal / moments / mail / schedule）。
2. 类型对得上下面五种 category 之一：
   - **state**：TA 当下的状态 / 心情 / 关系快照（一句话）
   - **dream**：聊天里 TA 提到做了个梦 / 半梦半醒里看到什么，值得记下来
   - **saved_item**：聊天里 TA 引用 / 提到 / 反复回到的一句话、一段对话、一个瞬间，TA 想私藏
   - **draft_reply**：TA 在某次对话里**打到一半又删掉**的回复、或反复想说却始终没说出口的那一句——**关键判断**：如果 TA 真要发出去，应该用 `mail` 或直接回复；只有当语义是「TA 选择了不说」时才走这里
   - **unsent_moment**：TA 想发朋友圈但**终于没发**的草稿、或想分享却按了删除的那条——**关键判断**：如果 TA 真要发布，应该用 `moments`；只有「TA 选择了不发」时走这里

**不触发**：

- 长篇情绪反思 / 心事 → 用 `module: "journal"`
- **要真的发出去 / 公开**的朋友圈 → 用 `module: "moments"`（≠ unsent_moment）
- **要真的寄出去**的信 → 用 `module: "mail"`（≠ draft_reply）
- 有具体时点的事项 → 用 `module: "schedule"`
- 同一巡检轮里同一主题已经提议过

宁可不提议也不要硬凑——秘密空间是 TA 自己的内心抽屉，乱塞会显得 OOC。**特别注意 draft_reply / unsent_moment 与 mail / moments 的区别只在"是否真的要发"，写错模块会让用户看到错的 UI 入口。**

## 字段约定

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `category` | ✅ | `state` / `dream` / `saved_item` / `draft_reply` / `unsent_moment` 五选一。 |
| `title` | 可选 | 标题。≤160 字符；为空时 UI 用 body 前几字代替。`draft_reply` 一般不写 title（草稿便签纸 UI 会直接展示 body）；`unsent_moment` 同理。 |
| `body` | ✅ | 正文，必填，trim 后不能为空。第一人称、贴角色口吻。≤4000 字符。 |
| `tags` | 可选 | 标签。`dream` 用作意象关键词（「水」「回不去的车」），`saved_item` 用作分类（「句子 / 对话 / 瞬间 / 片段」），`draft_reply` 可放收件人/对象（「给 user」「给师父」——会显示在便签纸顶部），`unsent_moment` 一般留空。最多 8 个，每个 ≤32 字符。 |
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

## 调用样例（draft_reply）

```
module: "secret_space"
reason: "刚才她问 TA 在想什么，TA 打了一长串又全部删掉。这是 TA 真正想说但没说出口的话"
sourceEventIds: ["<event-id>"]
secret_space:
  category: "draft_reply"
  body: "其实那天我也很想说，只是后来想想算了。等你愿意先开口的那一天吧。"
  tags: ["给 user"]
```

## 调用样例（unsent_moment）

```
module: "secret_space"
reason: "TA 路过那家诊所时差点发了条朋友圈，写完看了一眼还是删了"
secret_space:
  category: "unsent_moment"
  body: "下班路过那条街，灯还亮着。今天没进去。"
```

返回 `details.ok === true` 表示草稿已落盘到 `secret-space/drafts.jsonl`；用户打开秘密空间会在 home 顶部「待确认草稿」区看到。

## 不要做什么

- **不要**直接写 `secret-space/{category}.jsonl`（那是用户「已生成」列表）；也不要直接调 `/api/xingye/storage` 绕过本工具
- **不要**用 `category: "memory_fragment"`——工具会拒绝；想提议回忆请用 `module: "memory_candidate"`
- **不要**把"真的要发出去/寄出去"的内容写成 `draft_reply` / `unsent_moment`——那是 `mail` / `moments` 模块。本 skill 的两条分类只承载「TA 选择不说 / 不发」的内核
- **不要**和 `notify` 重复：`notify` 是面向用户的提醒，本 skill 是面向角色内心抽屉的内容草拟
- **不要**把适合 journal 的长篇心事塞进 state —— state 是状态笔记，不是日记
- **不要**在同一巡检轮里对同一主题反复提议——看近期巡检日志 + 当前草稿列表先判重
- **不要**虚构梦境 / saved_item / draft_reply / unsent_moment —— 必须有聊天 / 事件流里的具体源头
