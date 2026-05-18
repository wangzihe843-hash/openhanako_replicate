---
name: xingye-sms-draft
description: "Propose a pending SMS draft to the in-character phone SMS app during heartbeat patrol. 心跳巡检里向角色小手机短信提议一条「待确认」短信草稿（直接发给某 virtual_contact / 其他 agent）。Triggers: recent chat or the event stream surfaces a short, conversational message the character wants to actively send to a specific contact — a quick check-in, an apology fragment, a one-line follow-up — that fits an SMS bubble rather than a letter or a moments post. 触发场景：最近聊天 / 事件流里出现 TA 想主动给某个具体联系人发的、像真实手机短信那样简短口语化的消息——一句问候、一句道歉、一句跟进——用邮件载体太正式、用朋友圈又太公开。Do NOT trigger when the message should go to the user (use normal conversation instead), when there is no clear addressee, when the content is long enough to need email, or when it's an inbound message the character would imagine receiving (that path is auto-handled by contact-change driven sms generation). 不在「应该直接跟 user 说的话」「不知道收件人是谁」「内容长到该用邮件」「想象对方会发给 TA 什么」的场景上触发——最后那条由通讯录变更触发的 SMS 自动补全路径处理，不走草稿。"
display-name-zh: 星野短信草稿
display-name-zh-TW: 星野短信草稿
display-name-ja: 星野ショートメール下書き
display-name-ko: 호시노 단문 초안
---

# 小手机短信草稿提议

让心跳巡检里的 agent 在合适时机向小手机短信 App 提议一条**待用户确认的短信草稿**。草稿落到 `apps/sms/drafts.jsonl`，不会出现在任何 SMS thread 里，必须用户在 PhoneSmsApp 主页「待确认草稿」分组点「确认发送」后才会作为 outgoing message 进入对应联系人的 SMS thread（写入 localStorage），并发 `phone.sms_appended`。即使用户没立刻打开短信 App 也不会丢。

## 这条 skill 的语义边界

短信草稿的语义是「**TA 真的想给某个具体联系人发出去的一句话**」，方向固定 outgoing。和其它模块的区别：

| 模块 | 语义 | 和 sms 的差别 |
| --- | --- | --- |
| `mail` | TA 想给某人**认真写一封信**（道歉、感谢、长篇跟进） | 邮件载体重、可以长、有主题；短信短、口语化、像手机里随手发的 |
| `moments` | TA 想发**给所有联系人看**的朋友圈动态 | 朋友圈是公开的，短信只发给一个人 |
| `secret_space.draft_reply` | TA **想说但终于没说出口**的话——永远不会发 | sms 草稿是 TA **真的要发出去**的话——本 skill 的核心前提 |
| 通讯录变更后的 SMS 自动补全 | 通讯录改完，自动生成对方"应该会发给 TA"的短信 | 那一路径不走草稿、direction 可能是 incoming；本 skill 只接 outgoing |

## 收件人约束（重要）

- **允许的 targetType**：`agent`（其它角色）/ `virtual_contact`（虚拟联系人）
- **不允许 targetType=user**——agent 不该用 propose-draft 绕过 user 直接发短信；想跟 user 说话请走正常对话
- 必须给出 `targetId` 或 `matchName` 之一来定位收件人；优先用 `targetId`

## 什么时候触发

需要 **同时** 满足以下三条：

1. 最近聊天 / 上方「小手机事件」摘要里出现一段 **TA 主动想用短信形式发给某个具体联系人**的契机——一句问候 / 一句道歉 / 一句跟进 / 一句确认。
2. 内容形态像**真实手机短信**：短、口语化、可以是半句；不是论述、不是抒情段、不是邮件长度。
3. 收件人**不是 user**，并且**在通讯录里能定位到**（你知道 targetId，或至少能给一个 displayName 让用户匹配）。

**不触发**：

- 内容应该跟 user 说 → 直接回 user，不要走 SMS 草稿
- 内容太长 / 太正式 → 用 `module: "mail"`
- 想象对方会发给 TA 什么 → 不走这条；那一路径由通讯录变更自动处理
- 内容是"想说但终于没说"的——TA 不会真发 → 用 `module: "secret_space"` 的 `draft_reply` category
- 不知道发给谁 / 收件人是虚构的不在通讯录里 → 不要硬凑收件人
- 同一巡检轮里已经向同一联系人提议过短信

宁可不提议也不要硬凑——SMS 的"主动发起"是一个比邮件更轻、比朋友圈更私密的动作，强行写会显得 OOC。

## 字段约定

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `targetType` | ✅ | `agent` / `virtual_contact` 二选一。**不允许 user**。 |
| `targetId` | 二选一 | 收件人 targetId；agent 用 agent.id，virtual_contact 用 virtualContact.id。≤160 字符。 |
| `matchName` | 二选一 | 备用匹配名（当只知道显示名时用）。≤80 字符。targetId 与 matchName **至少一个**。 |
| `displayName` | 可选 | 当前显示名，仅给草稿 UI 让用户一眼认出是给谁。≤80 字符。 |
| `content` | ✅ | 短信正文，必填，trim 后非空。第一人称、口语化，像手机里随手发的真实短信。≤240 字符。**不要写「为什么要发」**——那放 reason；content 是 TA 真的会按发送键的那段话。 |
| `reason` | 强烈建议 | 给用户看——一句话说清「为什么 TA 想发这条短信」「源头是哪段聊天 / 哪个事件」。 |

## 调用样例（agent 给 virtual_contact 发跟进短信）

```
module: "sms"
reason: "刚才聊到那家诊所的护士换班了，TA 想问一句"
sourceEventIds: ["<event-id>"]
sms:
  targetType: "virtual_contact"
  targetId: "vc-hospital-nurse-li"
  displayName: "李护士"
  content: "李姐今天换班吗？我下午想过去一趟。"
```

## 调用样例（agent 给其他 agent 发短信，只知道名字）

```
module: "sms"
reason: "TA 想跟师姐道个歉，但只知道她的名字"
sms:
  targetType: "agent"
  matchName: "苏师姐"
  displayName: "苏师姐"
  content: "之前那件事是我没考虑周全，等回去再当面说一下。"
```

返回 `details.ok === true` 表示草稿已落盘到 `apps/sms/drafts.jsonl`；用户打开短信 App 会在主页「待确认草稿」区看到，确认后作为 outgoing 消息写入对应 thread。

## 不要做什么

- **不要**用 `targetType: "user"`——工具会拒绝；想跟 user 说话请走正常对话
- **不要**用本工具直接写 SMS thread——那是 confirm 阶段 UI 的事
- **不要**把"想象对方发给 TA 什么"放进来——那是 incoming 方向，由通讯录变更触发的自动补全处理
- **不要**把长篇内容塞进 content——超过两三句就该用 `module: "mail"`
- **不要**把"TA 选择不发"的话写成 sms 草稿——那是 `secret_space.draft_reply`
- **不要**对同一联系人在同一巡检轮里反复提议——看近期事件 / 当前草稿列表先判重
- **不要**虚构收件人——必须是通讯录里已经存在的 agent 或 virtual_contact
