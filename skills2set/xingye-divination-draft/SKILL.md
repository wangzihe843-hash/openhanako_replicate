---
name: xingye-divination-draft
description: "Propose a pending divination 'intuitive reading' (心象提示) draft to the in-character phone divination app during heartbeat patrol. 心跳巡检里向角色小手机占卜提议一条「待确认」心象提示草稿。Triggers: the character has a real question they're holding (about a relationship, a decision, a wait) AND has an intuitive image / feeling they can put into words — not a formal divination (no symbols, no tarot, no I-Ching). 触发场景：角色心里真的揣着一个具体问题（关系、抉择、等待），并且对它有一段可以用语言写下的直觉性心象——不是正式占卜（不抽符、不出卦、不出塔罗）。Do NOT trigger as a substitute for the formal divination flow (which is AI-generated structured reading), for vague 'I wonder what will happen' moods, or for things that are really a journal entry / secret-space dream. 不在「替代正式占卜」「想知道未来怎么样」之类的泛模糊语境上触发，也不在本质是日记反思 / 秘密空间梦境的事情上触发。"
display-name-zh: 星野占卜（心象）草稿
display-name-zh-TW: 星野占卜（心象）草稿
display-name-ja: 星野占い（心象）下書き
display-name-ko: 호시노 점복（심상）초안
---

# 小手机占卜「心象提示」草稿提议

让心跳巡检里的 agent 在合适时机向小手机占卜面板提议一条**待用户确认的心象提示草稿**。

## 重要：心象 ≠ 正式占卜

PhoneDivinationApp 有两种"占卜"语义：

1. **正式占卜**（PhoneDivinationApp 主流程，**不归本 skill**）：用户点界面按钮 → AI 跑 `generateDivinationReadingWithAI` 出结构化 reading（method=tarot / iching_liuyao / runes / …，symbols 完整，content 是 AI 写的卦象/牌阵解读）。
2. **心象提示**（本 skill 写的）：TA 自己心里有个具体问题，凭直觉得到一段印象/画面/感觉，**没有抽符、没有出卦**。落地 entry 时 `method='oracle_generic'`、`methodLabel='心象提示'`、`symbols=[]`，content 是 TA 自己写的直觉读出。和正式占卜并列在占卜历史里，但卡片视觉应能区分。

如果你判断本轮的"想问"够具体、够清晰、有结构化象征系统支撑，那这件事就不该走本 skill——让用户自己去开正式占卜流程。本 skill 只接：**TA 自己写下来给自己看的直觉心象**。

## 什么时候触发

需要 **同时** 满足以下三条：

1. TA 心里真的揣着一个 **具体问题**——能写成一句话的 agentQuestion（「我有没有把师父那句话听岔了？」「下次见面前我该不该先把某件事讲清楚？」），不是"想知道未来如何"的泛叹。
2. TA 对这个问题有 **一段可写下的心象**——画面、感觉、隐喻，能用 100-300 字第一人称写出来。**不能硬凑符号或卦象术语**。
3. 这件事 **不适合走正式占卜**：要么是 TA 自己内省式的（不想抽符）、要么是太具体不需要象征系统的、要么就是 TA 此刻想用直觉。

**不触发**：

- 想要正经一卦——让用户自己开 PhoneDivinationApp 抽
- 「最近运势如何」这种泛模糊问题
- 已经能写成日记反思的事情——走 `journal` skill
- 本质是梦境记录——走 `secret_space` 的 `dream` category
- 用户没问，TA 也没在心里反复想的事情——别替用户算
- 同一巡检轮里类似问题已经提议过

宁可不提议也不要硬凑心象。

## 字段约定

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `agentQuestion` | ✅ | TA 此刻心里在问的事，必填，trim 后不能为空。第一人称、贴角色口吻。一句话，不要列举多个。例：「我有没有把师父那句话听岔了？」「下次跟 user 见面之前我该不该先把某件事讲清楚？」≤200 字符。 |
| `content` | ✅ | TA 自己写下的「心象」——一段直觉性的读出。**不要硬凑塔罗 / 易经 / 卢恩术语**，那是正式占卜的活；用画面、感觉、隐喻、回忆来表达。短而具体。第一人称。例：「心里浮出一棵被风吹歪的小树，但根没动。我觉得是说：现在动摇是真的，但根没断。」≤2000 字符。 |
| `themeHint` | 可选 | 主题关键词。譬如「关系」「工作」「健康」「远行」「过去」「自我」。UI 用作分类辅助。≤80 字符。 |
| `reason` | 强烈建议 | 给用户看——一句话说清「为什么 TA 此刻在问这件事」「源头是哪段聊天 / 哪个事件」。**与 `content` 不同**：`reason` 是给用户看的元解释，`content` 是 TA 自己的心象读出。 |

## 调用样例

读完本 skill，调用 `xingye_propose_draft` 工具：

```
module: "divination"
reason: "晚上反复想师父那句话，TA 心里不安，没法睡前直接问 user，但又揣着这个疑问"
sourceEventIds: ["<event-id>"]
divination:
  agentQuestion: "我有没有把师父那句话听岔了？"
  content: "心里浮出一棵被风吹歪的小树，但根没动。\n我觉得是说：现在动摇是真的，但根没断——那句话本意可能就是要我先稳着。"
  themeHint: "关系"
```

返回 `details.ok === true` 表示草稿已落盘到 `apps/divination/drafts.jsonl`；用户打开小手机占卜会在顶部「待确认草稿 · 来自心跳巡检」区看到。确认后心象 entry 进占卜历史，和正式占卜并列展示。

## 不要做什么

- **不要**直接写 `apps/divination/entries.jsonl`（那是占卜历史）；也不要直接调 `/api/xingye/storage` 绕过本工具
- **不要**尝试通过本 skill 走 AI 生成的结构化占卜（method='tarot' / 'iching_liuyao' 等）——那是 PhoneDivinationApp 主流程的事，需要 user 自己触发抽符
- **不要**在 `content` 里硬凑「我抽到了什么牌 / 卦」——心象提示不带 symbols，硬凑会让用户混淆
- **不要**和 `notify` 重复：本 skill 是 TA 写给自己的心象，不是要提醒用户做什么；要提醒用户走 `notify`
- **不要**替用户算事——本 skill 仅在 **TA 自己心里有问题** 的语境下用
- **不要**在同一巡检轮里反复提议类似问题
- **不要**用 `agentQuestion` 写成一长串多个问题——一次只能问一个具体问题
