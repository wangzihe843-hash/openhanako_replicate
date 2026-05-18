---
name: xingye-phone_contact-draft
description: "Propose a pending phone-contact draft during heartbeat patrol—update an existing contact's fields, OR add a new virtual_contact, OR block/delete/restore a virtual_contact. 心跳巡检里向小手机通讯录提议一条「待用户审阅」的草稿：可以是更新现有联系人的 5 个字段（remark/impression/relationshipHint/tags/faction）、可以是新增虚拟联系人、也可以是对虚拟联系人的拉黑/删除/恢复。Triggers: recent chats or events justify a contact-level change that's worth surfacing to the user for review | 触发场景：最近聊天或事件让 TA 对某条联系人的判断发生足以让用户审阅的位移（印象稳定改变、出现明确新人、虚拟联系人确凿断联/越界/和解等）。HARD CONSTRAINTS: AI cannot block/delete/add/restore for `user` or real `agent` contacts—those types only allow `update`. Use 'add' ONLY for virtual_contact. 硬约束：对 user 与真实 agent 联系人，AI 只能 update，不能 add/block/delete/restore（那只能用户在通讯录界面手动操作）。"
# 项目术语 xingye = 星野
display-name-zh: 星野通讯录草稿
display-name-zh-TW: 星野通訊錄草稿
display-name-ja: 星野連絡先下書き
display-name-ko: 호시노 연락처 초안
---

# 通讯录草稿提议

让心跳巡检里的 agent 在合适时机向小手机通讯录提议一条**待用户审阅**的草稿，由用户审阅后才会真正应用。

## 流程语义

```
agent 调 xingye_propose_draft({ module: "phone_contact", action, ... })
           ↓
落到 phone-contact/drafts.jsonl
           ↓
用户在小手机通讯录顶部「待确认草稿 · 来自心跳巡检」区看到
           ↓
点「采纳建议 / 采纳新增 / 采纳拉黑 / 采纳删除 / 采纳恢复」
           ↓
按 action 应用：update → savePhoneContactMeta；
              add → applyAiGeneratedContacts（仅 virtual_contact）；
              block / delete / restore → blockPhoneContact / deletePhoneContact / restorePhoneContact
```

**关键认识**：本工具只产生「待审阅草稿」。**没有任何 action 会绕过用户直接生效**——包括 add / block / delete / restore，全都需要用户在 UI 上点采纳。所以你可以放心地"建议"——但仍然要写得有依据、有理由。

## 安全约束（硬性）

| targetType        | update | add | block | delete | restore |
|-------------------|--------|-----|-------|--------|---------|
| `user`            | ✓      | ✗   | ✗     | ✗      | ✗       |
| `agent`           | ✓      | ✗   | ✗     | ✗      | ✗       |
| `virtual_contact` | ✓      | ✓   | ✓     | ✓      | ✓       |

- **`user` / `agent` 只能 update**：AI 想新增 user / agent 是无意义的（user 由系统创建、agent 由真实角色注入），想拉黑/删除真实角色须由用户在通讯录界面手动操作。
- **`add` 仅限 virtual_contact**：批量造名单仍走「AI 生成联系人」路径；本工具只在剧情中明确出现了**单个**值得记下的新联系人时才 add。
- 违反组合 server 会拒、UI 也会拒。

## 视角约定（重要）

通讯录是**当前角色（agent）**的私人通讯录。所有字段一律按 agent 视角写：

- `remark` / `impression` / `relationshipHint`：**当前角色对这位联系人**的备忘、相处印象、关系标签——第一人称、自然口吻。
- 对 `targetType=user` **同样如此**：写"当前角色怎么看这位用户"，**不要**把用户原话或用户对角色的态度直接搬进 impression。

## 触发条件

需要满足以下其一，且**没在最近巡检里对同一目标重复提议过**：

### action = "update"
- 印象更清晰：之前模糊的联系人在最近聊天里反复体现稳定特征 → patch.impression
- 标签变化：联系人最近被反复观察到某种行为 → patch.tags（**对 agent / virtual_contact** 必须从固定词表选：亲近的人 / 需要观察 / 不可靠 / 同伴 / 危险；**对 user** 可自然短句）
- 关系状态：长期合作后关系发生质变 → patch.relationshipHint
- 阵营调整：从"中立"变"对立"等 → patch.faction

### action = "add"（仅 virtual_contact）
- 最近聊天里出现一个**具体可识别**的新联系人，且与现有联系人**无法视为同一人**
- 是个**单个**联系人，不是批量造名单（批量请走通讯录手动 AI 生成）
- contact.tags / faction / impression 等字段**必须非空**，且 tags 用固定词表
- contact.generatedReason 写**为什么 add**——不要写进 impression / shortBio / remark

### action = "block"（仅 virtual_contact）
- 最近聊天明确出现纠缠 / 威胁 / 越界 / 明确拒绝往来等信号
- 顶层 `reason` 写清依据，提供可核对的事由
- 证据不足时，请用 update 改 tags 加「需要观察」「危险」，不要 block

### action = "delete"（仅 virtual_contact）
- 最近聊天明确出现断联 / 旧号失效 / 渠道作废等信号
- 与 block 的语义区分：纠缠/威胁/越界 → block；自然断联/失效 → delete

### action = "restore"（仅 virtual_contact）
- 之前 blocked / deleted 的联系人，最近聊天出现明确和解 / 恢复往来
- 顶层 `reason` 写清和解依据

**不触发**：

- 一次性情绪波动
- 已经在最近巡检里提议过同一目标同一动作
- 用户在聊天里明确说「这事别记」
- 要 block / delete / restore user 或 agent（**禁止**）
- 要 add user 或 agent（**禁止**——user / agent 是系统注入的，不由 AI 建议添加）

宁可不提议，也不要硬凑。草稿被低质内容灌水会让用户失去信任。

## 写作要点

**对 update**：
- patch 至少要有一个非空字段
- 不要传 status / displayName / kind / shortBio / linkedAgentId / originalName / avatarDataUrl——会被忽略
- impression 第一人称自然口语，不要写元说明（"我决定把这事记下"），写**事实+感受**

**对 add**：
- displayName 必填，像真实通讯录里的称呼（可匿名："夜班同事" / "老患者" / "供货商王姐"），禁止写"新增一个…"等任务句式
- kind 从允许列表选；不确定写 'unknown'
- tags 非空数组，仅固定词表
- faction 非空，4 选一
- impression 或 shortBio 至少一项是具象生活化内容（不要模板空话）
- generatedReason 给用户看为什么需要 add 这个人

**对 block / delete / restore**：
- 优先用 targetId 精确定位；不知道 id 才用 matchName
- 顶层 reason 必填，写清触发的具体聊天信号

**reason（顶层）始终建议填**：一句话告诉用户"为什么提议这条草稿"，包括依据的聊天信号——这是用户决定要不要采纳的核心。

## 调用方式

读完本 skill，调用 `xingye_propose_draft` 工具：

```
module: "phone_contact"
reason: "<一句话说明为什么提议这条草稿，含触发信号>"
sourceEventIds: ["<触发的 xingye event id，可选>"]
phone_contact:
  action: "update" | "add" | "block" | "delete" | "restore"   # 默认 update
  targetType: "agent" | "virtual_contact" | "user"
  targetId: "<现有联系人 id；action='add' 时可省略；user 用 \"__user__\">"
  matchName: "<targetId 不可用时的备用名字匹配（仅 virtual_contact 生效）>"
  displayName: "<UI 展示用的当前名字，可选>"
  patch: { remark, impression, relationshipHint, tags, faction }   # action='update' 用
  contact: { displayName, kind, shortBio, impression, relationshipHint, tags, faction, status, generatedReason, remark }   # action='add' 用
```

返回 `details.ok === true` 表示草稿已落盘。

## 不要做什么

- **不要**对 user 或真实 agent 提议 add / block / delete / restore（server 会拒）
- **不要**用本工具批量造联系人——单批最多 0–2 条 add，多了请走通讯录手动 AI 生成
- **不要**把用户原话或对方原话直接搬进 impression / remark / relationshipHint—— 始终用 agent 第一人称视角的自然措辞改写
- **不要**和 `relationship_state` 重复——那个是关系状态 delta，与通讯录字段不重叠；同一信号若同时触发两类候选，只发**更贴近主语义**的一条
- **不要**在同一巡检里对同一联系人同一字段反复提议
- **不要**为凑数量批量 update —— 默认每轮 0–2 条，宁缺毋滥
