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

## 优先判断：update 还是 add？

调用 `xingye_propose_draft` 前**先翻心跳上下文里的「资料柜已有条目」段**（id · 文件夹 · 标题 — 摘要）：

- **同一主题已存在 entry** → 用 `action: "update"`，给 `targetEntryId`（或 `matchTitle` 备用），通过 `patch.bodyAppend` 追加新段落 / `patch.summary` 重写摘要 / `patch.tags` 整体替换标签。**不要**重写整条 body，也不要 add 一个几乎同名的新 entry。
- **确实是全新主题**（同 folder 内没有任何近似 title 的 entry） → `action: "add"`，按下方 add 字段表填。
- **不确定** → 宁可不提议；下一次心跳里再判断。

> 用户已经在 prompt 里看见已有条目列表了——你 add 一条「师父说过的几句话」时如果同 folder 已经有「师父说的几句话」，会被入库前的去重兜底硬拦下来（用户最多多点一次「仍然新建」）。直接做 update 是更省事的形态。

## 字段约定（按 action 区分）

### 通用字段（两种 action 都用）

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `action` | 可选 | `"add"`（默认）或 `"update"`。 |
| `reason` | 强烈建议 | 给用户看——一句话说清「为什么这条值得归档 / 更新」「源头是哪段聊天 / 哪个事件」。 |
| `sourceEventIds` | 强烈建议 | 触发本草稿的 event id 数组（让追溯方便）。 |

### `action: "add"` 字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `title` | ✅ | 资料标题。简洁可检索。≤160 字符。**必须明显区别于同 folder 内已有 entry 的 title**（不要 "师父说过的几句话" vs "师父说的几句话" 这种几乎同名）。 |
| `body` | 可选 | 正文。第一人称、贴角色口吻；不要写元说明（「这是关于…的笔记」）。≤8000 字符。 |
| `summary` | 可选 | 摘要，一两句话总结正文。≤300 字符。 |
| `folderHint` | 强烈建议 | 建议的文件夹**名字**（不是 id）。常见名字：「世界观整理 / 人际关系 / 关于 user / 线索与发现 / 待确认」。UI 在 confirm 时按名字优先匹配；匹配不上回退到「待确认」folder。≤80 字符。 |
| `tags` | 可选 | 标签，最多 16 个，每个 ≤32 字符。 |

### `action: "update"` 字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `targetEntryId` | 至少其一 | 要更新的 entry id（从「资料柜已有条目」段抄过来）。**优先用**。≤120 字符。 |
| `matchTitle` | 至少其一 | 备用：按 title 名字匹配（与已有 entry.title 比较，归一化后精确相等或前缀匹配）。 |
| `patch.bodyAppend` | update 时常用 | **追加到 body 末尾的段落**（不替换原文）。files 笔记是累积式的，新见解写一段加在后面。≤8000 字符。 |
| `patch.title` | 罕用 | 改名，整体替换；通常只用于修笔误。≤160 字符。 |
| `patch.summary` | 可选 | 重写摘要。≤300 字符。 |
| `patch.tags` | 可选 | **整体替换** tags 数组（不是增量）；空数组会被丢弃。 |

> 至少要含 `patch.bodyAppend / title / summary / tags` 中一个非空字段，否则草稿被拒。`patch` 里**不能传** `folderId`（agent 不知道用户私人的 folder uuid，挪柜子让用户在 confirm 弹窗里做）。

确认时：

- **add** 草稿：用户在 UI 上可以改 folderId（下拉里选）、title、body。默认按 folderHint 解析，解析不到回退到「待确认」。
- **update** 草稿：UI 上显示目标 entry 的 title + 你给的 patch；用户可编辑 patch 内容后确认；目标 entry 已被手动删除时按钮 disabled，用户须丢弃后重新整理。

## 调用样例

### 样例 A：新建条目（action='add'）

```
module: "files"
reason: "今天闲聊提到师父，TA 反复说过的几句家训以前没整理过；准备归档到「人际关系」夹"
sourceEventIds: ["<event-id>"]
files:
  action: "add"
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

### 样例 B：更新已有条目（action='update'）

心跳上下文里已经有：

```
- [fil-abc123] 人际关系 · 《师父说过的几句话》 — 整理师父反复说过的三句话以及我后来对它们的理解。
```

今天又听到师父一句新的，应该追加到原 entry：

```
module: "files"
reason: "今天又听到师父一句以前没整理进去的话，追加到原来的「师父说过的几句话」里"
sourceEventIds: ["<event-id>"]
files:
  action: "update"
  targetEntryId: "fil-abc123"
  patch:
    bodyAppend: |
      - 「先稳住自己，再去管别人。」
      这句是今天闲聊时 TA 顺嘴提到的，和前面那几句相通。
```

返回 `details.ok === true` 表示草稿已落盘到 `files/drafts.jsonl`（`details.action` 标记是 add 还是 update）；用户打开小手机资料柜首页会在顶部「待确认草稿」区看到。

## 不要做什么

- **不要**直接写 `files/entries.jsonl`（那是用户「已生成」列表）；也不要直接调 `/api/xingye/storage` 绕过本工具
- **不要**指定 `folderId` / `patch.folderId`——巡检里 agent 不知道用户私人的 folder uuid，只能给 `folderHint`（名字）
- **不要**为已有主题 add 一条新 entry——用 update + patch.bodyAppend 追加，让用户在 confirm 时决定
- **不要**和 `notify` 重复：`notify` 是面向用户的提醒，本 skill 是面向角色资料柜的归档草拟；同一动机二选一
- **不要**把短句、单行提醒落成 file —— 那种应该走 schedule 或 notify
- **不要**把日记 / 朋友圈 / 邮件该写的内容塞进 files —— 看准模块边界
- **不要**在同一巡检轮里对同一主题反复提议——看近期巡检日志 + 当前草稿列表先判重
