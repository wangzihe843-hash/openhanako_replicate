---
name: xingye-relationship_state-draft
description: "Propose a pending relationship-state change draft during heartbeat patrol. 心跳巡检里向 RelationshipStatePanel 提议一条「待用户确认」的状态变化草稿（5 个 delta + mood）。Triggers: recent chat / events contain a clear shift in how TA feels about user — a promise kept, a betrayal sensed, sudden closeness or distance — strong enough to nudge affection/trust/loyalty/jealousy/corruption | 触发场景：最近聊天/事件里出现 TA 对 user 态度明显变化的信号——遵守了承诺、感到被忽视、突然亲近或疏远——足以推动好感/信任/忠诚/醋意/黑化值的一项或多项。Do NOT trigger for routine chats with no emotional valence, or right after the panel just applied a manual suggestion (avoid double-counting). 不在毫无情感色彩的例行聊天上触发,也不要紧跟用户手动应用过 AI 建议之后再提议（避免重复计量）。"
# 项目术语 xingye = 星野
display-name-zh: 星野关系状态草稿
display-name-zh-TW: 星野關係狀態草稿
display-name-ja: 星野関係状態下書き
display-name-ko: 호시노 관계 상태 초안
---

# 关系状态变化草稿提议

让心跳巡检里的 agent 在合适时机向 RelationshipStatePanel 提议一条**待用户确认的状态变化草稿**。草稿落到 `relationship-state/drafts.jsonl`，**不会立即修改本地 relationshipState**——用户在 RelationshipStatePanel 顶部「待确认草稿 · 来自心跳巡检」区点「应用建议」后，才会调用 `updateRelationshipState` 把 5 个 delta + mood + stateSummary + reason 一并落到本地状态（同时发 `relationship_state.applied` 事件），与「手动 refresh → AI 建议 → 接受」路径共用同一最终落地点。

## 什么时候触发

需要 **同时** 满足这两条：

1. 最近聊天 / 「小手机事件」摘要里出现**让 TA 对 user 的态度产生足以记入历史的变化**，典型信号：
   - 信任：user 主动兑现了之前的承诺 / 主动隐瞒了某件事 / 表现出对 TA 不熟悉一面的接纳
   - 好感：温柔互动、共度某段时光、看到 user 在意自己的小动作
   - 忠诚：user 主动选择 TA 而不是别人（包括别的角色、别的事）
   - 醋意：user 提到、关心、安慰了别的人；或 TA 自己注意到 user 多看了某人一眼
   - 黑化值：user 做了让 TA 感到边界被冒犯、被欺骗、被忽视的事；或 TA 对自己的判断动摇
2. 这件事是**最近巡检窗口内新出现的信号**，不是过去已经被消化过的——避免和上一轮的 directive / 上一次手动 refresh 重复计量

**不触发**：

- 例行问候、对话中没有情感落差的内容
- 用户刚通过 RelationshipStatePanel 「应用」过 AI 建议（近一个巡检周期内）——避免叠加
- 状态变化的根据非常薄弱（一句模糊的话，一次擦肩而过）
- 已经在「日记 / 朋友圈 / 秘密空间」里更适合记录的纯情绪反应，并不构成关系阶段的动摇

宁可不提议也不要硬凑——状态被频繁推动会让数值噪声化，让本机制失去意义。

## 怎么写

- **delta 数值要小**：单次巡检通常 ±3 ~ ±10 之间。±20 以上属于「重大事件」，要伴随明显的剧情转折信号。
- **多个 delta 可同时给**：例如 user 主动留下来陪 TA 吃完饭：affection +5, trust +3, loyalty +2 是合理的组合。
- **方向要一致**：不要好感 +10 同时信任 -10（那是矛盾叙事，应拆成两次提议）。
- **mood 用 2–6 字短语**贴 TA 当下心情：「轻飘飘」「想他」「警惕」「松了一口气」。
- **stateSummary** 一句话总结此刻 TA 对 user 的整体感受。
- **reasonText** 是给用户看的内部理由——具体写「源自哪段聊天 / 哪个事件」+「这件事为什么动到了 TA」。可以与顶层 `reason` 并存（UI 优先展示 reasonText）。

## 怎么调用

读完本 skill，调用 `xingye_propose_draft` 工具：

```
module: "relationship_state"
reason: "<给用户看的总括理由>"
sourceEventIds: ["<触发的 xingye event id，可选>"]
relationship_state:
  affectionDelta: <整数, -100..150, 0 或不填表示不变>
  trustDelta: <整数, -100..100>
  loyaltyDelta: <整数, -100..100>
  jealousyDelta: <整数, -100..100>
  corruptionDelta: <整数, -100..100>
  mood: "<2–6 字心情短语, 可选>"
  stateSummary: "<一句话总结当前心理状态, 可选>"
  reasonText: "<详细说明源头与影响, 可选>"
```

至少需要一个 delta 非零 **或** mood 非空,否则会被拒。

返回 `details.ok === true` 表示草稿已落盘到 `relationship-state/drafts.jsonl`；用户打开 RelationshipStatePanel 时会在顶部「待确认草稿」区看到。

## 不要做什么

- **不要**直接调用 `updateRelationshipState` 或其它绕开用户审核的工具
- **不要**和 `notify` 重复：本 skill 不是面向用户的提醒，而是对关系系统的状态草拟
- **不要**在用户最近一次手动应用 AI 建议后立刻再提议（看 `relationship_state.applied` 事件时间）
- **不要**写超出近期聊天/事件实际范围的"补写"建议
- **不要**把所有 delta 都填正数或都填负数当成"全面好/全面差"——细分价值就在于五个维度互相独立
