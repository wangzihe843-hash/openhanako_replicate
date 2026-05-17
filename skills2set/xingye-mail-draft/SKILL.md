---
name: xingye-mail-draft
description: "Propose a pending email draft to the in-character phone mail app during heartbeat patrol. 心跳巡检里向角色小手机邮箱提议一封「待确认」邮件草稿（确认后落到草稿箱）。Triggers: recent chat or the event stream surfaces a concrete letter the character wants to write — apology, gratitude, follow-up to a virtual contact, message to absent family — that would feel out of place as an SMS or moments post. 触发场景：最近聊天 / 事件流里出现 TA 想认真写一封信的具体动机（道歉、感谢、给虚拟联系人补一封跟进、写给远方的人），用短信或朋友圈承载会显得轻浮。Do NOT trigger for one-liners better suited to SMS, for spam/promotional fluff, for letters to anyone the character has no in-fiction reason to email, or when the character has no clear addressee in mind. 不在「随便发个消息」「广告腔的废话」「给世界观里没建立关系的人写信」「连写给谁都不清楚」的场景上触发。"
display-name-zh: 星野邮件草稿
display-name-zh-TW: 星野郵件草稿
display-name-ja: 星野メール下書き
display-name-ko: 호시노 메일 초안
---

# 小手机邮件草稿提议

让心跳巡检里的 agent 在合适时机向小手机邮箱提议一条**待用户确认的邮件草稿**。草稿落到 `apps/mail/drafts.jsonl`，不会出现在任何邮箱里，必须用户在 PhoneMailApp 主页「待确认草稿」分组点「确认生成」后才会写入 `messages.jsonl`，并落到 `drafts`（草稿箱）邮箱，`from.kind='agent'`。即使用户没立刻打开邮箱也不会丢。

注意命名歧义：

- 本 skill 产出的「待确认邮件草稿」是 **apps/mail/drafts.jsonl** 这一支——巡检提议、用户尚未确认；
- 用户视角的「草稿箱」（mailbox==='drafts' 的 messages 行）是**确认后**的成品，可以继续编辑/发送。两层结构。

## 什么时候触发

需要 **同时** 满足以下两条：

1. 最近聊天 / 上方「小手机事件」摘要里出现一个 **明确的、值得写信的对象与动机**：
   - 道歉 / 感谢 / 错过的话补一段
   - 给远方家人 / 老师 / 同事写一封正式一点的信
   - 给虚拟联系人补一封跟进（短信里没说完、留了悬念的）
   - TA 自己想认真整理一下心境写给某个具体的人
2. 这个动机**用一封 1–2 段的信承载比短信合适**——内容有起承转合，或者有需要慢慢说的话。

**不触发**：

- 一两句话能说完的、明显应该走 SMS / 群聊
- 「给世界发一封信」「给读者写信」之类没有具体收件人的事
- 广告 / 推广 / 系统通知风格（垃圾邮件、营销邮件不在草稿语义里）
- 给世界观里没建立关系的人写信
- 同一巡检轮里同一收件人 + 同一主题已经提议过

宁可不提议也不要硬凑——邮箱是个偏正式的场所，乱用会让角色显得 OOC。

## 字段约定

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `subject` | ⚠️ | 邮件主题，简短。≤200 字符。`subject` 与 `body` 不能 **同时** 为空；单独留主题或单独留正文都允许（与「漫长信件无主题」「极短便条」两类场景对应）。 |
| `body` | ⚠️ | 邮件正文，第一人称、贴角色口吻。≤8000 字符。`subject` 与 `body` 不能同时为空。 |
| `toAddress` | 可选 | 收件人邮箱地址。**巡检里 agent 多半不知道真实邮箱**——留空让用户在确认前手动补；硬编邮箱反而像在演戏。≤160 字符。 |
| `toName` | 可选 | 收件人显示名（不是邮箱地址）。≤80 字符。 |
| `reason` | 强烈建议 | 给用户看——一句话说清「为什么 TA 想写这封信」「源头是哪段聊天 / 哪个事件」。 |

确认时：

- 工具调用方（用户点确认）会把草稿搬到 `messages.jsonl`，`mailbox='drafts'`、`from.kind='agent'`，`from.address` 用 agent 自己的 mail profile（用户视角的草稿箱里能看到，可以继续编辑或模拟发送）。

## 调用样例

读完本 skill，调用 `xingye_propose_draft` 工具：

```
module: "mail"
reason: "晚饭聊到母亲生日，TA 在心里反复想着没寄出过的那封信，这次决定把它写下来"
sourceEventIds: ["<event-id>"]
mail:
  subject: "给妈妈"
  body: |
    妈，
    最近经常想起你做的那碗鸡蛋面。我已经一年没回家了，今年六月一定回去。
    你身体怎么样？……
  toName: "妈妈"
```

返回 `details.ok === true` 表示草稿已落盘到 `apps/mail/drafts.jsonl`；用户打开小手机邮箱主页会在顶部「待确认草稿 · 来自心跳巡检」区看到。

## 不要做什么

- **不要**直接写 `messages.jsonl`（那是「已生成」的邮件，含草稿箱）；也不要直接调 `/api/xingye/storage` 绕过本工具
- **不要**和 `notify` 重复：`notify` 是面向用户的提醒（「记得给妈妈回封信」），本 skill 是面向角色邮箱的内容草拟；同一动机二选一
- **不要**指定 `from`、`mailbox`、`fromKind`——巡检产出的语义就是「TA 自己想写的信」，全部由 confirm 路径固定
- **不要**编造一个 `toAddress`——宁可留空让用户填。胡乱填的邮箱在虚拟邮箱里也是噪音
- **不要**写广告 / 推广 / 系统邮件 / 钓鱼这些 fromKind 才合适的内容
- **不要**在同一巡检轮里对同一收件人 + 同一主题反复提议——看近期巡检日志 + 当前草稿列表先判重
