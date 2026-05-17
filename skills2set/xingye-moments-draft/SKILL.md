---
name: xingye-moments-draft
description: "Propose a pending moments post draft during heartbeat patrol. 心跳巡检里向角色朋友圈提议一条「待确认」短动态草稿。Triggers: an emotional beat, scenic moment, small celebration, or shareable feeling surfaced in recent chat or event stream that the character would plausibly post about — public-facing, performative, audience-aware | 触发场景：最近聊天 / 事件流里出现角色会想发朋友圈的瞬间——情绪节拍、一个画面、一件小小值得说出口的事——是带表演性、面向观众的，不是私密日记。Do NOT trigger for content that is private / vulnerable / intimate (that's the journal), or for repeated mundane updates. 不在私密内容、脆弱情绪、纯日常流水账上触发——那是日记的范畴。"
display-name-zh: 星野朋友圈草稿
display-name-zh-TW: 星野朋友圈草稿
display-name-ja: 星野モーメント下書き
display-name-ko: 호시노 모먼트 초안
---

# 朋友圈草稿提议

让心跳巡检里的 agent 在合适时机向角色的朋友圈提议一条**待用户确认的短动态草稿**。草稿落到 `apps/moments/drafts.jsonl`，不会出现在用户的「已发表」朋友圈里，必须用户在朋友圈面板的「待确认草稿」区点「确认发表」后才会真正发出去。即使用户没立刻打开朋友圈也不会丢。

## 朋友圈 vs 日记的边界（重要）

这两条 skill 经常会被同一段聊天触发，**只选一条调**：

| 维度 | 朋友圈（本 skill） | 日记（`xingye-journal-draft`） |
| --- | --- | --- |
| 受众 | 公开/半公开，**带表演性** | 只有角色自己看 |
| 情绪强度 | 适中、可分享 | 强烈、私密、脆弱也行 |
| 内容性质 | 一个画面、一句俏皮话、一件小事 | 内心起伏、当天的真实感受 |
| 长度 | 短，≤280 个码点 | 可长可短 |
| 角色口气 | 面对观众的口气（哪怕是写给特定那一两个人看） | 写给自己 |

判断不准就**两个都不调**。

## 什么时候触发

需要 **同时** 满足以下三条：

1. 上下文里出现**值得拿出来分享**的瞬间——一段对白的好笑/感动、一个画面、一件让人会心一笑的事、一次小成就
2. 角色性格上**愿意**发这样的内容（看角色设定 / 关系 / 当前心情；内向 / 不爱表达的角色门槛要高）
3. **没有近期同题材的朋友圈或草稿**

**不触发**：

- 私密、脆弱、不愿意被别人看到的内容 → 走日记
- 平淡流水账（「今天又下雨了」之类）—— 除非角色真的喜欢发这种
- 用户明显说「这个别发」之类
- 同一巡检轮已经提议过一次同主题

## 字段约定

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `content` | ✅ | 朋友圈正文。第一人称，贴角色口吻。≤280 个码点（超会截断加省略号）。可以是一句话、可以是几行小诗、可以是一段场景描述。不需要硬塞 hashtag。 |
| `reason` | 强烈建议 | 给用户看——为什么觉得这条值得发，源头是哪段聊天 / 哪个事件 |

**注意**：草稿层只承诺 `content`。点赞和评论（`seedLikes` / `seedComments`）依赖通讯录和 peer roster，agent 在巡检上下文里很难稳定填对——保留给用户在 MomentComposer 用「AI 生成」路径现拉。如果用户想要 AI 生成互动者，确认草稿后再点 MomentComposer 的「AI 生成」即可。

## 调用样例

读完本 skill，调用 `xingye_propose_draft` 工具：

```
module: "moments"
reason: "刚才聊天时她笑得很自然，这个画面她应该愿意留下来"
sourceEventIds: ["<event-id>"]
moments:
  content: "晚风从灯塔后面绕过来，她说『笑一个』时我没躲。"
```

返回 `details.ok === true` 表示草稿已落盘到 `apps/moments/drafts.jsonl`；用户打开朋友圈面板会在顶部「待确认草稿 · 来自心跳巡检」区看到。

## 不要做什么

- **不要**直接写 `apps/moments/posts.jsonl`（那是用户「已发表」列表）；也不要直接调 `/api/xingye/storage` 绕过本工具
- **不要**和 `xingye-journal-draft` 同时调——按上面那张「朋友圈 vs 日记」表二选一
- **不要**和 `notify` 重复
- **不要**在 `content` 里塞 likes / comments —— 那不是草稿层的事
- **不要**编造场景：聊天里没发生的事不要往里写
- **不要**在同一巡检轮里对同一主题反复提议
