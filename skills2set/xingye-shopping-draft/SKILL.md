---
name: xingye-shopping-draft
description: "Propose a pending shopping list draft to the in-character phone shopping app during heartbeat patrol. 心跳巡检里向角色小手机购物清单提议一条「待确认」购物草稿。Triggers: recent chat / event stream reveals a concrete thing the character wants to buy, hesitates over, or has decided to favorite — something with a real referent (a book, a coat, a kettle), not vague material desire. 触发场景：最近聊天 / 事件流里出现 TA 真的想买、犹豫、收藏的具体物件（有指代对象的——某本书、某件外套、某只壶），不是「想消费」「想花钱」的空泛欲望。Do NOT trigger for vague wants, in-fiction commerce that doesn't fit the lightweight shopping-list metaphor, or anything that's really a chat thread rather than a list item. 不在「想买东西」这种空话、世界观里份量更重的交易（结婚戒指 / 房子）、本质上应该是聊天而非清单的事情上触发。"
display-name-zh: 星野购物草稿
display-name-zh-TW: 星野購物草稿
display-name-ja: 星野ショッピング下書き
display-name-ko: 호시노 쇼핑 초안
---

# 小手机购物草稿提议

让心跳巡检里的 agent 在合适时机向小手机购物清单提议一条**待用户确认的购物草稿**。草稿落到 `apps/shopping/drafts.jsonl`，不会出现在用户的「已生成」购物列表里，必须用户在 PhoneShoppingApp 顶部「待确认草稿」分组点「确认生成」后才会真正写入 `apps/shopping/entries.jsonl`。即使用户没立刻打开购物清单也不会丢。

## 什么时候触发

需要 **同时** 满足以下两条：

1. 最近聊天 / 上方「小手机事件」摘要里出现一个 **具体的物件**：
   - 「想买」：聊天里 TA 提到「想要 X」或者读到 / 路过让 TA 心动的具体物
   - 「犹豫」：TA 在两件东西之间反复说「但是…」，值得收进清单慢慢想
   - 「收藏」：TA 想把某件东西记下来供以后看
   - 「想再买一次 / 想退掉」之类有清晰状态的事项
2. 物件**有可指代的实体**——某本书的书名、某种颜色的某件衣服、某个店的某道菜。

**不触发**：

- 「想买东西」「想花钱」「报复性消费」这种纯欲望叙述
- 世界观里份量太重的交易（婚戒、房子、车）——那是日记或秘密空间的范畴
- 没有指代物的「想要点甜的」之类——除非 TA 自己已经具体到「想要 X 牌的 Y」
- 本质上应该是 mm-chat / 群聊讨论的物件挑选过程
- 同一巡检轮里同一物品已经提议过

宁可不提议也不要硬凑。

## 字段约定

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `itemName` | ✅ | 物品名，必填，trim 后不能为空。简洁、具体。例：「灰色长款风衣」「《长安的荔枝》」「米色 Le Creuset 18cm 小锅」。≤80 字符。 |
| `status` | 强烈建议主动判断 | 状态。**必须根据最近聊天 / 事件流的语义信号主动判断**——不要无脑默认 `wanted`，否则「她刚下单」也被错记成「想买」。具体规则见下方专门一节。允许：`wanted` / `hesitating` / `ordered` / `received` / `favorite` / `returned`。判不出 / 上下文完全模糊时才回退 `wanted`（也是 enum 校验的兜底）。 |
| `platformStyle` | 可选 | 平台风格（影响卡片配色），默认 `generic`。允许：`amazon`/`taobao`/`xianyu`/`generic`。 |
| `category` | 可选 | 类别，例：「衣物」「书」「食材」「家居」。≤24 字符。 |
| `imaginedPrice` | 可选 | 角色心里想象的价格感（自由文本），例：「贵到要分两月预算」「便宜得让我心虚」。≤40 字符。**不要写真实价格** —— 这是 TA 的主观感受。 |
| `content` | 可选 | 备注/正文，可写「为什么犹豫」「店铺名」「款式细节」「在哪条街看到的」等。≤2000 字符。 |
| `reason` | 强烈建议 | 给用户看——一句话说清「为什么这件东西值得放进清单」「源头是哪段聊天 / 哪个事件」。**与 `content` 不同**：`reason` 是给用户看的元解释（巡检为什么提议），`content` 是 TA 自己的备注。 |
| `tags` | 可选 | 标签数组，最多 8 个，每个 ≤24 字符。 |

## `status` 怎么选（**重要**）

巡检产出最常见的语义不一定是「想买」——具体要看聊天 / 事件流的信号。**LLM 必须主动选**，
不要让 server 端 fallback 替你决定。规则：

| 信号 | 选 |
| --- | --- |
| 「想买 / 心动 / 在橱窗外看了好久 / 想要 X」 | `wanted` |
| 「在两件之间反复但是… / 价格让我犹豫 / 不知道该不该买」 | `hesitating` |
| 「刚下单 / 订了 / 付了款 / 等发货」 | `ordered` |
| 「到货了 / 拿到了 / 今天到的 / 拆开试穿了」 | `received` |
| 「先收藏 / 不急着买 / 留着看看 / 想到一个收藏的物件」 | `favorite` |
| 「退了 / 不合适退掉了 / 退货中」 | `returned` |

**判断流程**：先扫聊天里和这个物件相关的最近若干条消息，找到**最强信号词**——动词时态尤其
重要（"想买" vs "买了" vs "到了" 完全不同 status）。如果信号都没出现、只是 TA 在思考某件物件
的存在，才回退 `wanted`。

> 反例：「她刚拆开 Le Creuset 小锅，说颜色比想象的好」——这是 `received`，不是 `wanted`。
> 写错 status 会让用户在 PhoneShoppingApp 的状态筛选里找不到这条。

## 调用样例

读完本 skill，调用 `xingye_propose_draft` 工具：

```
module: "shopping"
reason: "晚饭聊到她在旧书店看到《长安的荔枝》摸了三次没买，她在心里其实很想要"
sourceEventIds: ["<event-id>"]
shopping:
  itemName: "《长安的荔枝》"
  status: "wanted"
  platformStyle: "generic"
  category: "书"
  imaginedPrice: "便宜，但她最近不太敢花钱"
  content: "在解放路的旧书店，封面是旧版，店主说还有两本。"
  tags: ["小说", "想读"]
```

返回 `details.ok === true` 表示草稿已落盘到 `apps/shopping/drafts.jsonl`；用户打开小手机购物会在顶部「待确认草稿 · 来自心跳巡检」区看到。

## 不要做什么

- **不要**直接写 `apps/shopping/entries.jsonl`（那是用户「已生成」清单）；也不要直接调 `/api/xingye/storage` 绕过本工具
- **不要**和 `notify` 重复：`notify` 是面向用户的提醒（「记得问问那本书」），本 skill 是面向角色购物清单的内容草拟；同一动机二选一
- **不要**编造真实商品 URL / 价格 / 商品 ID —— 这是 TA 的虚拟购物清单，不连接任何真实平台
- **不要**在 `imaginedPrice` 字段里写真数字（除非聊天里明确出现过）——它是「TA 的主观感受」，不是数据
- **不要**在同一巡检轮里对同一物品反复提议——看近期巡检日志 + 当前草稿列表先判重
- **不要**给世界观里份量太重的交易（婚戒、房子）用本 skill ——那是日记或秘密空间的事
