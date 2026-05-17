---
name: xingye-files-draft
description: "Propose a pending file-cabinet draft to the in-character phone files app during heartbeat patrol. 心跳巡检里向角色小手机资料柜提议一条「待确认」文件草稿（确认后落到指定文件夹的 entries）。Triggers: recent chat / event stream surfaces a piece of organized knowledge the character wants to file — a worldbuilding note, a relationship observation, a clue about user, a lead worth following up. 触发场景：最近聊天 / 事件流里出现 TA 想整理归档的知识片段——世界观设定、关系观察、关于 user 的资料、线索发现。Do NOT trigger for vague impressions, ephemeral feelings (those go to journal), single-line reminders (use schedule/notify), or content that belongs in moments/mail. 不在「印象」「情绪」（→ journal）「单行提醒」（→ schedule/notify）「想发的内容」（→ moments/mail）上触发。"
display-name-zh: 星野资料柜草稿
display-name-zh-TW: 星野資料櫃草稿
display-name-ja: 星野資料庫下書き
display-name-ko: 호시노 자료함 초안
---

# 小手机资料柜草稿提议

让心跳巡检里的 agent 在合适时机向小手机资料柜提议一条**待用户确认的资料柜草稿**。草稿落到 `files/drafts.jsonl`，不会出现在任何文件夹的「已生成」列表里，必须用户在 PhoneFilesApp 主页「待确认草稿」分组点「确认生成」后才会写入 `files/entries.jsonl`（并落到用户挑选的文件夹）。即使用户没立刻打开资料柜也不会丢。

## 什么时候触发

需要 **同时** 满足以下两条：

1. 最近聊天 / 上方「小手机事件」摘要里出现一段 **值得归档的、可重复利用的知识片段**：
   - 世界观整理：TA 所处世界的设定、规则、地理、机构
   - 人际关系：TA 接触过的人、彼此分寸感、关系网状态
   - 关于 user：TA 视角里整理的、关于 user 的资料
   - 线索与发现：日常聊天里 TA 留意到的具体线索片段
   - 待确认：不确定真假、想再核实的事
2. 这段知识**有可重复检索的价值**——下次类似话题出现时，TA 自己回头翻这条记录会比凭记忆复述更可靠。

**不触发**：

- 「印象」「情绪」「TA 现在的感受」（→ journal）
- 「下周三要做 X」一类的提醒（→ schedule / notify）
- 「想发的朋友圈 / 想写的信」（→ moments / mail）
- 一句话能说完的、明显应该走 SMS
- 同一巡检轮里同一条目已经提议过

宁可不提议也不要硬凑。

## 字段约定

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `title` | ✅ | 资料标题，必填，trim 后不能为空。简洁可检索。例：「关于诊所那条街的笔记」「师父说过的几句话」。≤160 字符。 |
| `body` | 可选 | 正文，可放整理性的长文本。第一人称、贴角色口吻；不要写元说明（「这是关于…的笔记」）。≤8000 字符。 |
| `summary` | 可选 | 摘要，一两句话总结正文。≤300 字符。 |
| `folderHint` | 强烈建议 | 建议的文件夹**名字**（不是 id）。常见名字：「世界观整理 / 人际关系 / 关于 user / 线索与发现 / 待确认」。UI 在 confirm 时按名字优先匹配；匹配不上回退到「待确认」folder。≤80 字符。 |
| `tags` | 可选 | 标签，可选；最多 16 个，每个 ≤32 字符。 |
| `reason` | 强烈建议 | 给用户看——一句话说清「为什么这条值得归档」「源头是哪段聊天 / 哪个事件」。 |

确认时：

- 用户在 UI 上可以**改 folderId**（下拉里选）。默认按 folderHint 解析，解析不到回退到「待确认」。
- title / body 也能编辑。

## 调用样例

读完本 skill，调用 `xingye_propose_draft` 工具：

```
module: "files"
reason: "晚上聊到师父，TA 提到几句以前没整理过的家训；值得放进「人际关系」夹"
sourceEventIds: ["<event-id>"]
files:
  title: "师父说过的几句话"
  body: |
    - 「不必逞强，慢一点没事。」
    - 「先看清楚，再决定。」
    - 「想退就退，没人逼你。」
    我以前没认真听，最近回想起来才品出一点意思。
  summary: "整理师父反复说过的三句话以及我后来对它们的理解。"
  folderHint: "人际关系"
  tags: ["师父", "家训"]
```

返回 `details.ok === true` 表示草稿已落盘到 `files/drafts.jsonl`；用户打开小手机资料柜首页会在顶部「待确认草稿」区看到。

## 不要做什么

- **不要**直接写 `files/entries.jsonl`（那是用户「已生成」列表）；也不要直接调 `/api/xingye/storage` 绕过本工具
- **不要**指定 `folderId`——巡检里 agent 不知道用户私人的 folder uuid，只能给 `folderHint`（名字）
- **不要**和 `notify` 重复：`notify` 是面向用户的提醒，本 skill 是面向角色资料柜的归档草拟；同一动机二选一
- **不要**把短句、单行提醒落成 file —— 那种应该走 schedule 或 notify
- **不要**把日记 / 朋友圈 / 邮件该写的内容塞进 files —— 看准模块边界
- **不要**在同一巡检轮里对同一主题反复提议——看近期巡检日志 + 当前草稿列表先判重
