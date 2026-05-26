---
name: xingye-accounting-draft
description: "Propose a pending ledger draft to the in-character phone accounting app during heartbeat patrol. 心跳巡检里向角色小手机记账提议一条「待确认」记账草稿。Triggers: recent chat / event stream reveals a concrete cash-flow event that is NOT a shopping or secondhand transaction — salary, rent, utilities, meals, favors / gifts, interest, refunds. 触发场景：最近聊天 / 事件流里出现具体的、购物 / 二手覆盖不到的现金流——工资 / 房租 / 水电 / 餐饮 / 人情 / 利息 / 退款 / 奖金。Do NOT trigger for 'bought X' (those go to shopping) or 'sold X' (those go to secondhand); do NOT trigger on vague money anxiety or in-fiction commerce that's better as journal/secret_space. 不在「买了 X」（属购物）「卖了 X」（属二手）上触发；不在含糊的「钱不够 / 想搞钱」叙述上触发；世界观里份量太重的金钱事件（赔了一大笔 / 倾家荡产）走日记或秘密空间。"
display-name-zh: 星野记账草稿
display-name-zh-TW: 星野記賬草稿
display-name-ja: 星野家計簿下書き
display-name-ko: 호시노 가계부 초안
---

# 小手机记账草稿提议

让心跳巡检里的 agent 在合适时机向小手机记账提议一条**待用户确认的记账草稿**。草稿落到 `apps/accounting/drafts.jsonl`，不会出现在用户的「已生成」账本里，必须用户在 PhoneAccountingApp 顶部「待确认草稿」分组点「确认生成」后才会真正写入 `apps/accounting/entries.jsonl`。即使用户没立刻打开账本也不会丢。

## 模块定位（重要 · 与购物 / 二手互补）

记账模块和购物 / 二手**互补，不重叠**：

- 购物模块自动把 entry 投影成支出 → **「买了 X」相关现金流由购物模块负责**，不要在 accounting 重复记。
- 二手模块自动把 entry 投影成收入 → **「卖了 X」相关现金流由二手模块负责**，不要在 accounting 重复记。
- 记账模块只记 TA 人生里购物 / 二手之外的「原生收支」：
  - **收入类**：工资 / 稿费 / 分红 / 利息 / 退款 / 红包 / 报销 / 奖金 / 房租收入 / 接活 / 打赏 / 中奖
  - **支出类**：房租 / 水电 / 通讯费 / 订阅 / 餐饮 / 咖啡 / 打车 / 加油 / 医疗 / 药费 / 学费 / 书报 / 理发 / 请客 / 生日礼 / 随份子 / 保险 / 税 / 还款

**餐饮和咖啡的边界**：它们是"消费场景"而非"购买具体物品"，属于记账（「巷口面摊 ¥18」是餐饮支出 → accounting；「买了一台咖啡机 ¥1200」是购物支出 → shopping）。

## 什么时候触发

需要**同时**满足以下两条：

1. 最近聊天 / 上方「小手机事件」摘要里出现一笔**有数值可估算的现金流事件**：
   - 「TA 拿到 X」「TA 给了 X」「TA 付了 X」「TA 收到了 X」
   - 「房东又来催 / 月末发了工资 / 给师父送了礼」
2. 这笔钱**不属于购物 / 二手**——不是某件具体商品的买 / 卖。

**不触发**：

- 「我想要 X / 我买了 X」「我把 X 卖掉了」——那是购物 / 二手范畴
- 含糊的「钱不够 / 想搞钱 / 这个月手头紧」——没有具体笔账可记
- 世界观里份量太重的金钱事件（输光家产 / 一夜暴富 / 巨额债务）——那是日记或秘密空间
- 同一巡检轮里同一笔账已经提议过
- 数额完全无法估算的「不知道花了多少」——金额必填，估不出就别提议

宁可不提议也不要硬凑。

## 字段约定

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `title` | ✅ | 2–24 字的简短摘要，例：「五月薪俸」「这个月房租」「巷口面摊午饭」「东家发的奖金」「师父的药资」。≤80 字符。**不要**复述 category，也不要写「记一笔账」之类的任务句。 |
| `direction` | ✅ | `income`（钱进）或 `expense`（钱出）。**严禁**用负数 amount 表达 expense——正负由 direction 表达。 |
| `amount` | ✅ | 非负数值金额。**与 imaginedAmount 配对**：imaginedAmount 写「¥520」时 amount 写 520；古代「二两银子」就按 lore 里的换算（1 两 ≈ ? 文）折算，或直接写 2 配 currency='两银子'。保留 2 位小数。 |
| `currency` | 推荐 | 货币单位短文本，**必须与 TA 所在世界观一致**。≤16 字符。 |
| `imaginedAmount` | 可选 | 给小手机卡片展示用的氛围金额文本，例：「¥520」「三两银子」「2 枚金币」「120 信用点」。≤80 字符。缺省时 UI 会用 amount + currency 自动渲染。 |
| `category` | 推荐 | 0–12 字的分类名，按 TA 世界观自由文本（古风用「俸禄 / 房钱 / 药资」；西幻用「法术耗材 / 接活报酬」；未来用「能量配给 / 任务报酬」）。**不要**复述 title。 |
| `counterparty` | 可选 | 付款方 / 收款方口吻，例：「东家」「房东」「巷口面摊」「师父」「公会」。≤40 字符。**不要**写真实电商平台、品牌、URL。 |
| `occurredAt` | 可选 | 交易发生日，ISO 字符串或可被 Date.parse 解析的文本。模糊词「昨天 / 三天前」请先在心跳层解析成 ISO 再传，否则会被丢弃。 |
| `content` | 可选 | 备注/正文，可写场景 / 心情 / 这笔钱的来龙去脉。≤2000 字符。 |
| `reason` | 强烈建议 | 给用户看——一句话说清「为什么这笔账值得记下」「源头是哪段聊天 / 哪个事件」。 |

## 货币写法（关键）

`currency` + `imaginedAmount` **必须用 TA 所在世界观对应的货币写法**——按照 profile / lore / 最近聊天里的线索识别世界观：

- 现代中国：¥（「¥1,280」「168 ¥」）
- 现代美国 / 加拿大：$（「$35」）
- 日本：円 / ¥（「8,400 円」）
- 英国 £ / 欧元 € / 韩国 ₩ / 其它现代国家用该国货币符号
- 中国古代：「两银子 / 钱 / 文」（「二两银子」「八百文」）
- 民国：「银元 / 大洋 / 角 / 分」（「三个大洋」「八毛钱」）
- 西幻 / 中世纪：「金币 / 银币 / 铜板」（「5 枚金币」「2 枚银币」）
- 未来 / 科幻：「信用点 / 星币 / 配给券 / 联邦币」（「120 信用点」）
- 仙侠：「灵石 / 金锭」（「3 块灵石」）
- 废土：「瓶盖 / 水票 / 子弹」（「20 瓶盖」）

**跨次稳定**：如果 lore 已写明货币体系，沿用 lore；否则尽量沿用 TA 历史记账记录里用过的**同一货币体系**。单档体系（现代¥/$、未来信用点、仙侠灵石）严格锁单位；多档体系（古代两/钱/文、民国银元/角/分、西幻金币/银币/铜板）锁体系，可按金额自由切档。

## 调用样例

读完本 skill，调用 `xingye_propose_draft` 工具：

```
module: "accounting"
reason: "晚上她在厨房里跟我说东家这个月又压了她的工钱，只发了七成"
sourceEventIds: ["<event-id>"]
accounting:
  title: "五月薪俸（七成）"
  direction: "income"
  amount: 35
  currency: "两银子"
  imaginedAmount: "三十五两银子（本应五十）"
  category: "俸禄"
  counterparty: "东家"
  occurredAt: "2026-05-26"
  content: "东家说今年生意不好，让她再忍忍——她笑着应了，没在我面前发火。"
```

返回 `details.ok === true` 表示草稿已落盘到 `apps/accounting/drafts.jsonl`；用户打开小手机记账会在顶部「待确认草稿 · 来自心跳巡检」区看到。

## 不要做什么

- **不要**直接写 `apps/accounting/entries.jsonl`（那是用户「已生成」账本）；也不要直接调 `/api/xingye/storage` 绕过本工具
- **不要**用 accounting 记「买了 X」「卖了 X」——那是购物 / 二手的范畴，记账模块的投影会自动覆盖
- **不要**用负数 amount 表达 expense——正负由 direction 表达
- **不要**编造精确到分的真实交易金额——这是 TA 的虚拟账本，所有数额都是 TA 主观估算
- **不要**和 `notify` 重复：`notify` 是面向用户的提醒，本 skill 是面向角色账本的内容草拟
- **不要**在同一巡检轮里对同一笔账反复提议
- **不要**给世界观里份量太重的金钱事件（巨额债务 / 输光家产 / 巨额遗产）用本 skill —— 那是日记或秘密空间的事
