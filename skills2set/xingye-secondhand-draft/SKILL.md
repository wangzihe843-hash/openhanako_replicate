---
name: xingye-secondhand-draft
description: "Propose a pending second-hand (resale) draft to the in-character phone secondhand app during heartbeat patrol. 心跳巡检里向角色小手机二手清单提议一条「待确认」二手草稿。二手模块是购物模块的镜像：购物 = 买，二手 = 卖。Triggers: recent chat / event stream reveals a concrete thing the character wants to sell, part with, list, or has already let go of — something with a real referent (an old coat, a book, a kettle TA no longer uses), not vague decluttering urges. 触发场景：最近聊天 / 事件流里出现 TA 真的想出掉、转手、挂出去卖、或已经卖掉的具体物件（有指代对象的——某件旧外套、某本书、某只用不上的壶），不是「想清一清」「想断舍离」的空泛念头。Do NOT trigger for vague urges, in-fiction trades too heavy for the lightweight resale-list metaphor, or anything that's really a chat thread rather than a list item. 不在「想清东西」这种空话、世界观里份量更重的资产处置（卖房 / 卖车）、本质上应该是聊天而非清单的事情上触发。"
display-name-zh: 星野二手草稿
display-name-zh-TW: 星野二手草稿
display-name-ja: 星野中古下書き
display-name-ko: 호시노 중고 초안
---

# 小手机二手草稿提议

让心跳巡检里的 agent 在合适时机向小手机二手清单提议一条**待用户确认的二手草稿**。二手模块是购物模块的镜像——购物 = TA 想买什么，二手 = TA 想把自己的东西出掉什么。草稿落到 `apps/secondhand/drafts.jsonl`，不会出现在用户的「已生成」二手列表里，必须用户在 PhoneSecondhandApp 顶部「待确认草稿」分组点「确认生成」后才会真正写入 `apps/secondhand/entries.jsonl`。即使用户没立刻打开二手清单也不会丢。

## 什么时候触发

需要 **同时** 满足以下两条：

1. 最近聊天 / 上方「小手机事件」摘要里出现一个 **TA 想出掉的具体物件**：
   - 「想卖」：聊天里 TA 提到「想把 X 出掉」「这东西用不上了」「该处理掉了」
   - 「在谈」：有人来问 TA 的某件东西、在砍价、在谈价
   - 「已卖」：TA 提到某件东西已经卖掉 / 转给别人 / 被收走
   - 「留下 / 撤下」之类有清晰状态的事项（想了想又舍不得卖、挂了很久没卖掉）
2. 物件**有可指代的实体**——某件旧衣、某本书、某只用不上的壶，是 TA 自己拥有、现在想出手的东西。

**不触发**：

- 「想清一清」「想断舍离」「想换钱」这种纯念头叙述
- 世界观里份量太重的资产处置（卖房、卖车、卖祖产）——那是日记或秘密空间的范畴
- 没有指代物的「想出点旧东西」之类——除非 TA 自己已经具体到某件东西
- 本质上应该是 mm-chat / 群聊讨论的物件取舍过程
- 同一巡检轮里同一物品已经提议过
- 「想买 X」——那是 `module: "shopping"`，不是本模块

宁可不提议也不要硬凑。

## 字段约定

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `action` | 可选 | 草稿动作，默认 `add`。`add` = 新挂出一件清单里**还没有**的东西；`update` = 给一件**已有挂牌**打状态迁移补丁（见下方专门一节）。**物件状态变了（在谈→已售 等）请用 `update`，不要 `add` 重复条目。** |
| `itemName` | ✅ | 物品名，必填，trim 后不能为空。简洁、具体。例：「灰色长款风衣」「《长安的荔枝》」「米色 18cm 小锅」。≤80 字符。**`action='update'` 时**：写成与目标旧挂牌**一致**的名字（同时兼作 `matchName` 兜底）。 |
| `status` | 强烈建议主动判断 | 状态。**必须根据最近聊天 / 事件流的语义信号主动判断**——不要无脑默认 `to_sell`，否则「她刚把相机出手了」也被错记成「想卖」。具体规则见下方专门一节。允许：`to_sell` / `listed` / `negotiating` / `sold` / `kept` / `delisted`。判不出 / 上下文完全模糊时才回退 `to_sell`（也是 enum 校验的兜底）。 |
| `platformStyle` | 可选 | 平台风格（影响卡片配色），默认 `generic`。允许：`amazon`/`taobao`/`xianyu`/`generic`。 |
| `category` | 可选 | 类别，例：「衣物」「书」「旧物」「家居」。≤24 字符。 |
| `askingPrice` | 可选 | TA 想象里这件东西能卖出的价格感（自由文本），**必须用 TA 所在世界观对应的货币写法**（现代¥/$、古代两银子、民国大洋、西幻金币、未来信用点）。二手价通常低于新品价。≤40 字符。**不要写真实成交价**。 |
| `delta` | 可选 | 卖出落差短语，与 `askingPrice` 同一货币体系。例：「比当初买价低 ¥220」「卖不上价」「居然有人加价收」。≤32 字符。 |
| `buyer` | 可选 | TA 想象里来接手的买家 / 接手人口吻，例：「巷口的旧书客」「楼下收旧货的」。**不要**写真实电商平台名。≤24 字符。 |
| `content` | 可选 | 备注/正文，可写「这件东西的来历」「为什么不要了」「出掉时的心情」等。≤2000 字符。 |
| `reason` | 强烈建议 | 给用户看——一句话说清「为什么这件东西值得放进二手清单」「源头是哪段聊天 / 哪个事件」。**与 `content` 不同**：`reason` 是给用户看的元解释（巡检为什么提议），`content` 是 TA 自己的备注。 |
| `tags` | 可选 | 标签数组，最多 8 个，每个 ≤24 字符。 |

## `status` 怎么选（**重要**）

巡检产出最常见的语义不一定是「想卖」——具体要看聊天 / 事件流的信号。**LLM 必须主动选**，
不要让 server 端 fallback 替你决定。规则：

| 信号 | 选 |
| --- | --- |
| 「想出掉 / 打算挂出去 / 这东西用不上了 / 该处理掉了」 | `to_sell` |
| 「挂出去了 / 已经放到二手摊 / 上架了」 | `listed` |
| 「有人来问 / 在砍价 / 在谈价 / 有人想要」 | `negotiating` |
| 「卖掉了 / 出手了 / 成交了 / 被收走了 / 转给别人了」 | `sold` |
| 「想了想还是留着 / 舍不得卖 / 又不卖了」 | `kept` |
| 「撤下来了 / 没卖掉 / 挂了很久没人要 / 流拍了」 | `delisted` |

**判断流程**：先扫聊天里和这个物件相关的最近若干条消息，找到**最强信号词**——动词时态尤其
重要（"想卖" vs "挂出去了" vs "卖掉了" 完全不同 status）。如果信号都没出现、只是 TA 在
盘算某件东西要不要出，才回退 `to_sell`。

> 反例：「她说那只旧相机昨天被楼下收旧货的收走了」——这是 `sold`，不是 `to_sell`。
> 写错 status 会让用户在 PhoneSecondhandApp 的状态筛选里找不到这条。

## 改已有挂牌的状态（`action='update'`，**重要**）

当最近聊天 / 事件流说的是**一件清单里已经有的旧物状态变了**——典型是「在谈 → 已售」，也包括「想卖 → 挂出」「挂出 → 撤下」「在谈 → 留下」等——请用 `action='update'` 给那条**已有挂牌**打补丁，而**不是** `add` 一条几乎同名的新挂牌。

**为什么必须用 update**：

- `add` 会产生两条几乎同名的重复记录，用户在清单里看到一件东西出现两次。
- 旧挂牌在「在谈」阶段可能已经积累了**与买家的聊天记录**（按挂牌 entryId 存）。`add` 出来的是新 entryId，旧聊天对不上、成了孤儿；`update` 保持 entryId 不变，**聊天得以延续到成交**。

**怎么写 update**：

| 字段 | 说明 |
| --- | --- |
| `action` | 填 `'update'`。 |
| `targetEntryId` | 若你从「小手机事件」摘要里知道目标挂牌的 entry id，优先填它。≤120 字符。 |
| `matchName` | 不知道 id 时按**物品名**匹配；缺省会回退用 `itemName`。所以最简单的做法：把 `itemName` 写成与原挂牌一致的名字即可。≤80 字符。 |
| `patch` | 状态迁移补丁，**至少含一个非空字段**。常用 `patch.status`（迁移到的新状态），可带 `patch.askingPrice`（最终成交价）、`patch.delta`、`patch.buyer`（成交后才知道是谁接手的）、`patch.contentAppend`（追加一句备注，不覆盖原文）。 |

`patch.status` 的取值与上面 status 表一致（`to_sell`/`listed`/`negotiating`/`sold`/`kept`/`delisted`）。

> 反例（**别这么做**）：上周提议过「灰色长款风衣 · 在谈」，这周聊天说「那件风衣卖掉了」——**不要**再 `add` 一条「灰色长款风衣 · 已售」，而要 `action='update'`, `itemName: '灰色长款风衣'`, `patch: { status: 'sold', buyer: '巷口收旧衣的' }`。

### update 调用样例

```
module: "secondhand"
reason: "她说上周挂的那件风衣昨天被人收走了，成交了"
sourceEventIds: ["<event-id>"]
secondhand:
  action: "update"
  itemName: "灰色长款风衣"          # 与原挂牌同名，兼作 matchName 兜底
  patch:
    status: "sold"
    buyer: "巷口收旧衣的"
    contentAppend: "最后 100 出的，对方挺爽快，没怎么压价。"
```

用户在二手清单「待确认草稿」区会看到一张「更新现有挂牌 · 灰色长款风衣 / 状态：在谈 → 已售出」的卡片，点「确认更新」即把补丁应用到原挂牌（entryId 不变）。

## 调用样例（新增挂牌 `action='add'`）

读完本 skill，调用 `xingye_propose_draft` 工具：

```
module: "secondhand"
reason: "晚饭聊到她那件穿不上的旧风衣，她说想出掉换点地方"
sourceEventIds: ["<event-id>"]
secondhand:
  itemName: "灰色长款风衣"
  status: "to_sell"
  platformStyle: "xianyu"
  category: "衣物"
  askingPrice: "¥120"
  delta: "比当初买价低一半"
  buyer: "巷口收旧衣的"
  content: "买回来只穿过两次，衣柜太挤了，留着也是占地方。"
  tags: ["旧衣", "断舍离"]
```

返回 `details.ok === true` 表示草稿已落盘到 `apps/secondhand/drafts.jsonl`；用户打开小手机二手会在顶部「待确认草稿 · 来自心跳巡检」区看到。

## 不要做什么

- **不要**直接写 `apps/secondhand/entries.jsonl`（那是用户「已生成」清单）；也不要直接调 `/api/xingye/storage` 绕过本工具
- **不要**和 `notify` 重复：`notify` 是面向用户的提醒，本 skill 是面向角色二手清单的内容草拟；同一动机二选一
- **不要**和 `module: "shopping"` 搞混：购物 = 想买，二手 = 想卖。「想买 X」永远走 shopping
- **不要**编造真实商品 URL / 成交价 / 平台佣金 —— 这是 TA 的虚拟二手清单，不连接任何真实平台
- **不要**在 `askingPrice` 字段里写真实标价 —— 它是「TA 想象里能卖的价格感」，不是数据
- **不要**在同一巡检轮里对同一物品反复提议——看近期巡检日志 + 当前草稿列表先判重
- **不要**给世界观里份量太重的资产处置（卖房、卖车）用本 skill ——那是日记或秘密空间的事
