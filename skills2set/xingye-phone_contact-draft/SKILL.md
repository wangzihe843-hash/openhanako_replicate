---
name: xingye-phone_contact-draft
description: "Propose a pending phone-contact field-update draft during heartbeat patrol. 心跳巡检里向小手机通讯录提议一条「对现有联系人字段的更新候选」（只更新 remark / impression / relationshipHint / tags / faction，不新增联系人，不拉黑/删除）。Triggers: recent chats or events reveal that TA's view of an existing contact has shifted in a stable, post-confirmable way—e.g. impression got clearer, a tag should be added/dropped, or the relationship-hint label no longer fits | 触发场景：最近聊天或事件让 TA 对一个**现有联系人**的看法发生稳定的、可被用户审阅认可的位移——印象变得更清晰、需要加/减某个标签、或现有的关系标签不再贴切。Do NOT trigger for new contacts (use AI generation), block/delete/restore (use manual incremental update), or one-off mood swings. 不在新增联系人（走 AI 生成）、拉黑/删除/恢复（走通讯录手动 AI 更新）、一次性情绪波动上触发。"
# 项目术语 xingye = 星野
display-name-zh: 星野通讯录更新候选草稿
display-name-zh-TW: 星野通訊錄更新候選草稿
display-name-ja: 星野連絡先更新候補下書き
display-name-ko: 호시노 연락처 갱신 후보 초안
---

# 通讯录更新候选草稿

让心跳巡检里的 agent 在合适时机向小手机通讯录提议一条**针对现有联系人的字段更新候选**，由用户审阅后合并到该联系人的 meta。

## 流程语义

```
agent 调 xingye_propose_draft({ module: "phone_contact", ... })
           ↓
落到 phone-contact/drafts.jsonl
           ↓
用户在小手机通讯录顶部「待确认草稿 · 来自心跳巡检」区看到
           ↓
点「采纳建议」→ savePhoneContactMeta 合并 patch（markManualFields=true）
           ↓
合并到现有联系人的 remark / impression / relationshipHint / tags / faction
```

**与其它路径的差异**：

- 「**新增联系人**」走小手机通讯录的「AI 生成 / 增量更新」路径（用户手动触发），不在本工具职责范围。**本工具不接受 add**。
- 「**拉黑 / 删除 / 恢复**」走小手机通讯录的手动 AI 更新（仅 virtual_contact 可由 AI 操作，agent / user 永远只能用户手动）。**本工具不接受 status 变化**。
- 本工具只做**更新候选**：对**现有联系人**的 5 个"印象 / 关系判断"字段做小步修正。

## 视角约定（重要）

通讯录是**当前角色（agent）**的私人通讯录。所有字段一律按 agent 视角写：

- `remark` / `impression` / `relationshipHint`：**当前角色对这位联系人**的备忘、相处印象、关系标签——第一人称、自然口吻。
- 对 `targetType=user` 这条特殊联系人**同样如此**：写"当前角色怎么看这位用户"，**不要**把用户原话或用户对角色的态度直接搬进 impression。用户的态度变化只是触发信号；字段值仍是角色视角的相处印象。

## 什么时候触发

需要 **同时** 满足这三条：

1. 最近聊天 / 「小手机事件」摘要里出现**针对某个现有联系人**的稳定信号，能让角色的看法发生明确位移，典型情况：
   - 印象更清晰：之前模糊的"邻居老张"在最近聊天里反复体现"靠谱、愿意帮忙"，可以 update `impression`
   - 标签变化：某联系人最近多次越界 → 把"亲近的人"换成"需要观察"（**对 agent / virtual_contact 必须用固定词表**：亲近的人 / 需要观察 / 不可靠 / 同伴 / 危险）
   - 关系状态：以前的"工作互信"在长期合作后更接近"利益往来"——可以 update `relationshipHint`
   - 对 user 这条：最近聊天体现用户尊重边界、配合度高等——可以 update user 这条的 tags（user 这条 tags 不用压固定词表，可自然短句）
2. **目标联系人在通讯录里确实已存在**（你能在 contacts 列表里找到对应 targetId）——本工具不接受新建。
3. 这次变更**不重复**最近巡检里同一联系人的同一字段（避免灌水）。

**不触发**：

- 一次性的情绪波动（"今天有点不爽"），等沉淀后再说
- 仅是想加一条联系人（→ 通讯录手动 AI 生成）
- 要 block / delete / restore（→ 通讯录手动 AI 更新）
- 要改 displayName / kind / shortBio / avatarDataUrl / linkedAgentId / status / originalName（本工具不接受这些字段）
- 用户在聊天里明确说"别记下来 / 这事算了"
- 你不确定 targetId 是哪一条——猜测 add 一条新联系人**不被允许**

宁可不提议，也不要硬凑。通讯录被低质 patch 灌水会让用户失去对本机制的信任。

## 怎么写

**patch 至少要有一个字段，且只能含这 5 个之一/多个**：

- `remark`（≤120 字符）：备忘性短句（"楼下小卖部老板娘 / 周末才在"）
- `impression`（≤600 字符）：相处印象——第一人称自然口语，不要写元说明（"我决定把这事记下"），写**事实+感受**（"她每次接话都比我快半拍，我现在懒得搭"）
- `relationshipHint`（≤120 字符）：关系状态短语（"工作互信" / "谨慎合作" / "利益往来" / "关系紧张" / "旧识"…）
- `tags`（数组，**整体替换**——不是增量）：
  - **对 agent / virtual_contact**：仅从固定词表选——`亲近的人 / 需要观察 / 不可靠 / 同伴 / 危险`，1–3 个最佳
  - **对 user**：可自然短句（"尊重边界" / "不逞强" / "愿意配合"）
- `faction`：仅 `自己人 / 中立 / 对立 / 未知`

**reason（顶层）必须填**：一句话告诉用户"为什么提议这条 patch"，包括依据的聊天信号——这是用户决定要不要采纳的核心。

## 怎么调用

读完本 skill，调用 `xingye_propose_draft` 工具：

```
module: "phone_contact"
reason: "<一句话说明为什么提议这条 patch，包含触发信号>"
sourceEventIds: ["<触发的 xingye event id，可选>"]
phone_contact:
  targetType: "agent" | "virtual_contact" | "user"
  targetId: "<该联系人的 id；user 用 \"__user__\">"
  displayName: "<UI 展示用的当前名字，可选；让用户一眼认出是谁>"
  patch:
    impression: "<可选，agent 对该联系人的最新相处印象>"
    remark: "<可选>"
    relationshipHint: "<可选>"
    tags: ["<可选；agent/virtual_contact 须用固定词表，user 可自然短句>"]
    faction: "自己人" | "中立" | "对立" | "未知"  # 可选
```

返回 `details.ok === true` 表示草稿已落盘到 `phone-contact/drafts.jsonl`；用户进入小手机通讯录时会在顶部「待确认草稿」区看到。

## 不要做什么

- **不要**通过本工具新增联系人（targetType+targetId 必须指向**现有**联系人）
- **不要**通过本工具修改 status（block / delete / restore）—— 走通讯录手动 AI 更新
- **不要**改 displayName / kind / shortBio / avatarDataUrl / linkedAgentId / originalName—— 这些字段即使传也会被忽略
- **不要**把用户原话搬进 impression / remark / relationshipHint—— 始终用 agent 第一人称视角的自然措辞改写
- **不要**和 `relationship_state` 重复——那个是"关系状态 5 个 delta"，与通讯录字段不重叠；同一信号若同时触发两类候选，请只发**更贴近主语义**的一条
- **不要**在同一巡检里对同一联系人同一字段反复提议
- **不要**为凑数量批量 update —— 默认每轮 0–2 条，宁缺毋滥
