import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import { formatXingyeSpeakerContextForPrompt } from './xingye-speaker-context';
import {
  ACCOUNTING_ALL_CATEGORY_HINTS,
  ACCOUNTING_ONLY_CATEGORIES,
  SHARED_SPENDING_BUCKETS,
  STRICT_MONTHLY_CATEGORIES,
} from './xingye-spending-categories';

/**
 * 与 xingye-accounting-drafts 的 AccountingDirection 对齐。
 */
export const ACCOUNTING_AI_DIRECTIONS = ['income', 'expense'] as const;

/**
 * 推荐分类候选 = SHARED_SPENDING_BUCKETS ∪ ACCOUNTING_ONLY_CATEGORIES。
 * 三模块共用的「物品 ↔ 支出场景」双语义类目 + 记账独有的"非物品现金流"。
 *
 * 模型可以挑或在世界观非现代时自由替换（俸禄 / 药资 / 法术耗材 …），
 * 但**同一 agent 内**记账 / 购物 / 二手必须口径一致，账本聚合才能合并到同一 bucket。
 * 详见 xingye-spending-categories.ts 顶部说明。
 */
export const ACCOUNTING_AI_CATEGORY_HINTS = ACCOUNTING_ALL_CATEGORY_HINTS;

/**
 * 构造「记账原生草稿」prompt：让模型扮演当前 agent，把最近聊天 / 状态 / 设定里
 * **购物 / 二手覆盖不到**的日常收支整理成 1–3 条草稿。
 *
 * 重要约束：
 * - 第一人称，agent 自己写自己的账本。
 * - 不要重复购物（具体某件物品的购买）和二手（具体闲置出手）能记录的内容——
 *   记账模块投影会自动把购物记成支出、二手记成收入。这里只补**剩下的人生**：
 *   工资、房租、餐饮、人情、利息、订阅等。
 * - 价格用 imaginedAmount 氛围文本，**必须是 TA 所在世界观对应的货币写法**，
 *   amount + currency 在调用方本地用 parseImaginedPriceToMoney 解析。
 * - 输出**数组**，1–3 条，每条独立的 direction / category。
 */
export function buildAccountingDraftPrompt(args: {
  agent: Pick<Agent, 'id' | 'name' | 'yuan'>;
  userName?: string;
  profile: XingyeRoleProfile | null | undefined;
  /** 用户在弹窗里写下的记账意图（可空，例："最近这周的开销" / "这个月的进账"）。 */
  userIntent: string;
  recentSceneBlock: string;
  stableLoreBlock: string;
  keywordLoreBlock: string;
  relationshipBlock: string;
  heartbeatBlock: string;
  /**
   * 已有记账 entries 里出现过的货币 / 分类 / 对手方样本。
   * 由 xingye-accounting-ai.ts 的 buildAccountingAnchorBlock 计算后传入。
   * 用来跨次生成稳定货币体系和分类口吻——尤其是在没有 lore 显式定义货币的
   * 世界观（仙侠、废土、未来），防止「今天灵石明天金锭」式漂移。
   */
  anchorBlock?: string;
  /**
   * 已有购物 / 二手 entries 的概要（itemName + status 摘要）。
   * 作为"已被其它模块覆盖"的反面 anchor 喂给模型，
   * 防止 LLM 又生成出"买了相机 ¥1200"这种和购物模块重复的记录。
   */
  coveredByOthersBlock?: string;
  /**
   * 「每个自然月已记录的严格月度类目」清单（房租 / 水电 / 通讯 / 保险 / 工资 …）。
   * 由 xingye-accounting-ai.ts 的 buildMonthlyCoverageBlock 计算后传入。
   *
   * Why：现实里一个月只交一次房租、领一次工资。反复点「批量新增」时若不告诉
   * 模型这些月份已经记过哪些月度类目，会被反复塞「这个月房租」给同一个月两次。
   * 入库前还有一道 dedupe 兜底（见 PhoneAccountingApp.runBulkGeneration），
   * 但 prompt 端告知能减少浪费、提高用户实际拿到的有效条数。
   */
  monthlyCoverageBlock?: string;
  /**
   * 「近 14 天每天已记的 title 摘要」。由 buildRecentTitlesBlock 计算后传入。
   *
   * Why：用户反复点「批量新增」时，AI 在两次独立调用里偶尔会各自生成
   * `"巷口面摊午饭 / 餐饮 / ¥18"` —— 同标题同金额，等于一天吃了两顿一模一样的午饭。
   * 把"这天已经记过这些 title"告诉模型，让它从源头避开。
   * 入库前还有 filterSameDayDuplicates 做硬兜底。
   */
  recentTitlesBlock?: string;
  /**
   * agent 是否有兼职 / 倒班 / 跑单 / 外卖员等"一天多次通勤"职业。
   * true → prompt 端不强求"一天一次通勤"约束，让模型自由生成；
   * false / 未传 → 加上"通勤一天最多去班 1 次 + 下班 1 次"硬规则。
   *
   * 由 hasMultipleJobsByProfile(ownerProfile) 在调用方算好后传入。
   */
  agentHasMultipleJobs?: boolean;
  /** 期望生成几条草稿。默认 3，常规调用上限 3；historyMode 时上限 12。 */
  desiredCount?: number;
  /**
   * 「批量历史生成」模式专用上下文：
   *  - mode='initial'：首次打开 app 时的 bootstrap，应主要吃 lore（"在 TA 这种世界观/身份下
   *    过去 N 天最可能发生的现金流"），最近聊天/关系/心跳作为弱锚；
   *  - mode='recent'：用户主动批量新增，挑过去几天最近的日常；
   *  - mode='gap_fill'：补齐 lastBulkAt 到今天的空白，dayRangeHint 描述区间。
   *
   *  无 historyMode 时走原单条/三条 propose-draft 路径（保持向下兼容）。
   */
  historyMode?: {
    kind: 'initial' | 'recent' | 'gap_fill';
    dayRangeHint: string;
    startDays: number;
    endDays: number;
  };
}): string {
  const {
    agent,
    userName,
    profile,
    userIntent,
    recentSceneBlock,
    stableLoreBlock,
    keywordLoreBlock,
    relationshipBlock,
    heartbeatBlock,
    anchorBlock,
    coveredByOthersBlock,
    monthlyCoverageBlock,
    recentTitlesBlock,
    agentHasMultipleJobs,
    desiredCount = 3,
    historyMode,
  } = args;

  const isHistory = Boolean(historyMode);
  const countMax = isHistory ? 12 : 3;
  const count = Math.max(1, Math.min(countMax, Math.floor(desiredCount)));
  const currentUserName = userName?.trim() || '用户';
  const currentAgentName = profile?.displayName?.trim() || agent.name || '当前角色';
  const speakerContextBlock = formatXingyeSpeakerContextForPrompt({
    userName: currentUserName,
    agentName: currentAgentName,
    gender: profile?.gender,
  });

  const parts: string[] = [
    '你是星野模式「小手机记账」原生收支草稿生成器。只返回严格 JSON，不要 Markdown，不要解释。',
    '',
    `生成目标：这是当前角色自己手机里的账本。请一次性产出 ${count} 条**互不重复**的收支条目草稿`
    + (isHistory ? `（"历史批量"模式：${historyMode!.dayRangeHint}）` : '')
    + '，由 TA 自己写出来；只是模拟，不会真的连银行 / 钱包 / 支付平台。',
    '不是日记，不是日程，不是阅读笔记，不是资料柜条目。',
    '不要出现「根据聊天记录」「用户让我」「系统提示」「模型」「AI」等元叙述。',
    '不要使用 user 视角或第三人称视角；只能是 agent 第一人称记自己的账。',
    '',
    '──────────────────',
    '【绝对禁区 · 不要重复购物 / 二手模块覆盖的内容】',
    '──────────────────',
    '记账模块和购物 / 二手是**互补**的——购物条目自动投影成支出、二手条目自动投影成收入，',
    '所以这里**只**记购物 / 二手覆盖不到的「原生收支」：',
    '',
    '◆ **不要**生成"买了 XX"型支出（具体物品的购买行为）→ 那归购物模块。',
    '◆ **不要**生成"卖掉了 XX"型收入（具体闲置出手）→ 那归二手模块。',
    '◆ **应该**生成的是 TA 人生里购物 / 二手之外的现金流：',
    '   - 收入类：工资 / 稿费 / 分红 / 利息 / 退款 / 红包 / 报销 / 奖金 / 房租收入 / 接活 / 打赏 …',
    '   - 支出类：房租 / 水电 / 通讯费 / 订阅 / 餐饮 / 咖啡 / 打车 / 加油 / 医疗 / 药费 / 学费 / 书报 / '
    + '理发 / 请客 / 生日礼 / 随份子 / 保险 / 税 / 还款 …',
    '◆ 餐饮和咖啡是边界例子——它们是**消费场景**而非"购买具体物品"，属于记账（"巷口面摊 ¥18"算餐饮支出，',
    '   "买了一台咖啡机 ¥1200"才算购物支出）。',
    '',
    '──────────────────',
    '【输出 JSON schema】',
    '──────────────────',
    `只输出一个 JSON 对象，其中 drafts 字段是恰好 ${count} 条草稿的数组：`,
    JSON.stringify(
      {
        drafts: [
          {
            title: 'string',
            direction: `<one of: ${ACCOUNTING_AI_DIRECTIONS.join(' | ')}>`,
            category: 'string',
            imaginedAmount: 'string',
            counterparty: 'string',
            occurredAtHint: 'string',
            reason: 'string',
            content: 'string',
          },
        ],
      },
      null,
      2,
    ),
    '',
    '字段要求：',
    `- drafts 数组长度必须是 ${count}，每条**互不重复**——不要全是工资，也不要全是餐饮；`
    + '至少在收入 / 支出 / 分类 / 对手方四个维度里有差异。',
    '- title 必填，2–24 字的简短摘要，如「五月薪俸」「这个月房租」「巷口面摊午饭」「东家发的奖金」。',
    `- direction 只能是 ${ACCOUNTING_AI_DIRECTIONS.map((d) => `"${d}"`).join(' / ')} 之一；`
    + 'income = 钱进（工资 / 利息 / 红包 / 退款），expense = 钱出（房租 / 餐饮 / 订阅 / 人情）。',
    '- category 0–12 字，分类名，**不要复述 title**。**优先从下面这份共用词表里选**，'
    + '让记账聚合时能和购物 / 二手按 category 合并到同一 bucket：'
    + ''
    + `  ◆ 涉及具体物品消费的 expense（餐厅 / 咖啡馆 / 打车 / 看电影 / 买票），从 SHARED 选——${SHARED_SPENDING_BUCKETS.join(' / ')}；`
    + `  ◆ 人生现金流（工资 / 房租 / 水电这类**不是买东西**的），从 ACCOUNTING-ONLY 选——${ACCOUNTING_ONLY_CATEGORIES.join(' / ')}。`
    + ''
    + '判断要点：「巷口面摊午饭」→ "餐饮"（SHARED，因为是吃喝消费）；'
    + '「电话费」→ "通讯"（ACCOUNTING-ONLY，周期性账单不是物品）；'
    + '「房东收的房租」→ "房租"（ACCOUNTING-ONLY）；'
    + '「打车去医院」→ "交通"（SHARED）；'
    + '「公司发的工资」→ "工资"（ACCOUNTING-ONLY income）。'
    + '不要新造词覆盖已有 bucket，**严格用列表里的原词**：'
    + '"吃饭"→"餐饮"、"出租车 / 打车"→"交通"、"电器"→"家电"、"衣物"→"服饰"、"通讯费"→"通讯"——'
    + '同概念两种写法会让账本按 category 聚合时裂成两个 bucket，金额算不对。'
    + '世界观非现代时可用对应口吻替换（古风「俸禄 / 房钱 / 药资」、西幻「法术耗材」、未来「能量配给」），'
    + '只要同一 agent 内三模块（购物 / 二手 / 记账）口径自洽。',
    '- imaginedAmount 必填，0–28 字；**必须用 TA 所在世界观对应的货币写法**'
    + '（见下方「世界观货币写法指南」）。'
    + '**首选 · 明确金额**：现代「¥3,500」/「168 ¥」/「$2,800」；古代「八两银子」/「三百文」；'
    + '民国「二十大洋」/「三角五分」；西幻「12 枚金币」；未来「2,400 信用点」。'
    + '**不要写「约」「大概」**——记账要的就是明确金额，模糊化无法对账。'
    + '只有在世界观明确是以物易物 / 无统一货币（部落 / 末日某些聚落）时才允许 fallback 写法，'
    + '此时 amount 会解析失败、本条草稿会被前端丢弃。',
    '- counterparty 0–20 字，付款方 / 收款方口吻，可空字符串；'
    + 'income 的 counterparty 是付款方（"东家""杂志社""房客""利息——票号"），'
    + 'expense 的 counterparty 是收款方（"房东""巷口面摊""城南书肆""药铺")；'
    + '**不要**写真实商家平台名（淘宝 / 闲鱼 / 美团 / 滴滴 / 微信 / 支付宝）、品牌名、URL。',
    '- occurredAtHint 0–16 字，TA 心里这笔账发生的时间感，自然语言即可：'
    + '"今天""昨天""上周二""这个月初""三天前""上个月 15 号"。'
    + (isHistory
      ? `**本次历史批量必填**且必须分布在【${historyMode!.dayRangeHint}】范围内，`
        + '不同条目之间日期要错开（不要全部"昨天"或全部"3 天前"），'
        + '推荐写法：相对短语「N 天前」（N ≤ '
        + `${Math.max(historyMode!.endDays, 1)}）或具体日期。`
        + '**不要**写"今后""下周"等未来时态。'
      : '可空字符串（前端解析不出来就回退 createdAt，不影响草稿）。'),
    '- reason 0–80 字一句话，写 TA 为什么记下这笔账 / 这笔账的小情境，可空。',
    '- content 20–180 字 agent 备忘段落，写当时的心情 / 场合 / 备注。',
    '',
    '──────────────────',
    '【世界观货币写法指南】（imaginedAmount 必读 · 浓缩版）',
    '──────────────────',
    '',
    '◆ 现代中国 → ¥（人民币）；现代美国 → $；现代日本 → 円；现代英国 → £；现代欧盟 → €；'
    + '现代韩国 → ₩；其它现代国家按该国货币符号（俄罗斯 ₽ / 印度 ₹ / 巴西 R$ 等）；'
    + '现代背景**国别不明** → 默认 ¥。',
    '◆ 中国古代（汉/唐/宋/明/清/武侠江湖）→「两银子 / 钱 / 文」'
    + '（1 两 = 10 钱 = 1000 文）。例：「三两银子」「八百文」「二钱碎银」。',
    '◆ 民国（1912–1949 / 上海滩 / 老北京）→「银元 / 大洋 / 角 / 分 / 法币」'
    + '（1 银元 = 10 角 = 100 分）。例：「二十大洋」「三角」「八分钱」。',
    '◆ 西幻 / 中世纪 / D&D 风 →「金币 / 银币 / 铜板」'
    + '（1 金 ≈ 10 银，1 银 ≈ 100 铜）。例：「12 枚金币」「30 枚铜板」。',
    '◆ 未来 / 赛博朋克 / 太空歌剧 →「信用点 / 星币 / 联邦币 / Eddies / 配给券」（自设量级，内部自洽）。',
    '◆ 仙侠 / 修真 →「灵石 / 下品灵石 / 金锭」；末日 / 废土 →「瓶盖 / 子弹 / 物资点 / 水票」。',
    '',
    '量级参考（避免 imaginedAmount 数字离谱；以"一个月房租"为锚）：',
    '   现代 ¥：单人房租 ≈ ¥2,000–8,000；一份工资 ≈ ¥5,000–30,000；餐饮 / 顿 ≈ ¥20–80；咖啡 ≈ ¥15–35',
    '   现代 $：房租 ≈ $800–3,000；工资 ≈ $3,000–15,000；餐饮 ≈ $10–25',
    '   中国古代「两银子」：清中后期 1 两 ≈ 现代 ¥200–300；月房钱 ≈ 1–3 两；一壶酒 ≈ 几十文；俸禄因官阶 1 两–百两',
    '   民国「银元 / 大洋」：1934 上海 1 大洋 ≈ 现代 ¥200–400；月房租 ≈ 3–10 大洋；月薪 ≈ 20–80 大洋',
    '   西幻：1 金币 ≈ 一周工匠工资；月房租 / 食宿 ≈ 1–5 金币；佣兵接活 ≈ 5–30 金币',
    '   未来：自设量级，但与"一杯咖啡 ≈ 5 信用点"为锚保持内部自洽（房租量级 1,000–5,000）',
    '',
    '──────────────────',
    '【货币选择优先级 · 三层兜底】',
    '──────────────────',
    '**Layer 1 · lore 显式定义**：「星野设定参考」或「按需命中的设定库」里出现明示货币 → 100% 沿用。',
    '**Layer 2 · 历史锚点**：下方【历史货币 / 分类 / 对手方锚点】非空 → **严格沿用样本里出现的同一货币体系**。'
    + '同一 agent 不要这次写「灵石」下次写「金锭」，不要这次 ¥ 下次 $。'
    + '多档体系（古代两/钱/文、民国银元/角/分、西幻金/银/铜板）锁体系，按金额自由切档。',
    '**Layer 3 · 首次创造**：前两层都没线索 → 按上方指南挑货币体系，**这批草稿会成为后续锚点**。',
    '',
    '──────────────────',
    '【该角色已有记账记录的货币 / 分类 / 对手方锚点】',
    '──────────────────',
    anchorBlock && anchorBlock.trim()
      ? anchorBlock.trim()
      : '（无；这是 TA 第一次记账，请按 Layer 3 规则挑货币体系并锁定）',
    '',
    '──────────────────',
    '【月度账单类目防重复 · 重要】',
    '──────────────────',
    `下列 category **每个自然月最多 1 条**——现实里一个月只交一次房租 / 水电 / 电话费 / 保险，只领一次工资：${STRICT_MONTHLY_CATEGORIES.join(' / ')}。`,
    '下方"已记录"列出过去几个月里 TA 账本中已存在的 (年-月, 月度类目) 组合，**生成时绕开这些组合**——',
    '不要再给同一个 (年-月) 塞一条相同 category 的草稿，否则会被入库前的去重过滤丢弃。',
    monthlyCoverageBlock && monthlyCoverageBlock.trim()
      ? monthlyCoverageBlock.trim()
      : '（无；过去几个月里 TA 还没记过房租 / 水电 / 通讯 / 保险 / 工资 这类月度类目）',
    '',
    '──────────────────',
    '【近 14 天每天已记的 title · 同天去重双重规则】',
    '──────────────────',
    '下方列出近 14 天里每天 TA 已经记过的 title。生成时**两条硬规则**：',
    '',
    '  ◆ **规则 1 · 同 title 不重复**：同一天里不要再生成与列出 title 完全相同的草稿——',
    '    AI 反复批量生成时最容易出现「同一天两顿一模一样的午饭」（同 title + 同金额 + 同对手方）。',
    '',
    '  ◆ **规则 2 · 早 / 午 / 晚饭一天最多 1 顿**：检查列出 title 里是否已经有当天的「早饭 /',
    '    早餐 / 早点」「午饭 / 午餐 / 中饭」「晚饭 / 晚餐」——如果某一餐已经记过，**不要再生成**',
    '    同一天同一餐的草稿，哪怕换了餐厅 / title / 金额。',
    '    例：当天已有「巷口面摊午饭」→ 不要再生成「卤肉饭午饭」「公司食堂午餐」「外卖盖饭」（都是 lunch）。',
    '    例外（不算三餐，可同日多次）：咖啡 / 奶茶 / 下午茶 / 宵夜 / 零食 / 水果——这些独立频次自由。',
    '',
    agentHasMultipleJobs
      ? '  ◆ **规则 3 · 通勤无限制（TA 有兼职 / 倒班 / 跑单）**：TA 的身份是跑单类'
        + '（外卖员 / 配送员 / 网约车 / 代驾 / 倒班工 …），一天会通勤好几趟，'
        + '所以"打车去上班 + 地铁去上班 + 共享单车去上班"在同一天是允许的，'
        + '不要刻意避开。'
      : '  ◆ **规则 3 · 通勤一天最多去班 1 次 + 下班 1 次**：检查列出 title 里是否已经有当天的'
        + '「上班 / 上学 / 去公司 / 去办公室」或「下班 / 放学 / 收工」。'
        + '如果"去班"已经记过，**不要再生成**同一天另一条"去班"的草稿，哪怕换了交通方式 /'
        + ' 金额——「打车去上班」「骑共享单车去上班」「地铁去上班」同一天只能留 1 条。'
        + '同理"下班 / 放学 / 收工"也只能 1 条。'
        + '例外：去开会 / 出差 / 出门办事 / 接送朋友 / 周末逛街——这些不算通勤，不受限制。',
    '',
    '违反规则的草稿会被入库前去重过滤丢弃，浪费生成。',
    '一天能吃三顿、喝两杯咖啡都没问题；只是每个 slot（餐次、通勤段）只占一次。',
    '',
    recentTitlesBlock && recentTitlesBlock.trim()
      ? recentTitlesBlock.trim()
      : '（无；近 14 天 TA 还没记过账）',
    '',
    '──────────────────',
    '【已被购物 / 二手覆盖的记录 · 不要重复这些 itemName 主题】',
    '──────────────────',
    coveredByOthersBlock && coveredByOthersBlock.trim()
      ? coveredByOthersBlock.trim()
      : '（无；TA 还没用过购物 / 二手模块）',
    '',
    '──────────────────',
    '',
    speakerContextBlock,
    `- 视角：把 TA 写成「我」，把 ${currentUserName} 写成「${currentUserName}」；不要写成「TA / 她 / 他」或「您」。`,
    '',
    '当前角色（基础身份）：',
    JSON.stringify(
      {
        id: agent.id,
        name: currentAgentName,
        yuan: agent.yuan,
        profile: profile ?? null,
      },
      null,
      2,
    ),
    '',
    '【用户输入的记账意图（若有；只是提示方向，不要照抄）】',
    userIntent.trim() || '（无）',
    '',
    '【最近 OpenHanako 聊天（可能藏着收支信号；勿在输出里交代信息来源）】',
    recentSceneBlock.trim() || '（无）',
    '',
    '【星野核心设定摘录（stable lore；识别世界观分类——现代/古代/民国/西幻/未来——选对货币）】',
    stableLoreBlock.trim() || '（无）',
    '',
    '【按需命中的设定库关键词条目（仅命中项；可能含国别 / 时代 / 货币 / 职业线索）】',
    keywordLoreBlock.trim() || '（无）',
    '',
    `【当前对 ${currentUserName} 的关系状态摘要（若有；情绪 / 边界参考）】`,
    relationshipBlock.trim() || '（无）',
    '',
    '【最近一次手机首页巡检结果（若有；仅作背景参考）】',
    heartbeatBlock.trim() || '（无）',
    '',
    `记住：只输出 { drafts: [...] } 一个 JSON 对象；drafts 长度 = ${count}；每条 direction / category 互不重复；imaginedAmount 必须明确数字，禁用「约」。`,
    isHistory
      ? `**历史批量额外要求**：所有 ${count} 条 occurredAtHint 必填，分布在【${historyMode!.dayRangeHint}】，`
        + '不同条目日期错开。'
        + ''
        + `**类目多样性硬指标**：${count} 条草稿至少覆盖 ${Math.max(3, Math.ceil(count / 2))} 个**不同**的 category；`
        + '收入 / 支出两个方向都要有（除非 TA 设定明确没有收入来源，比如学生 / 退休）；'
        + `不要 ${count} 条全是"餐饮"或全是"工资"——这是账本，不是日记。`
        + (historyMode!.kind === 'initial'
          ? '这是 TA 首次使用账本，请主要参考【星野核心设定】和【设定库】里的身份 / 职业 / 世界观'
            + '推断"过去 14 天里 TA 最有可能发生的现金流"，最近聊天 / 关系 / 心跳作为弱参考。'
            + '**典型分布参考**（按 TA 身份调整）：1–2 条收入（工资 / 稿费 / 红包）、'
            + '2–3 条固定支出（房租 / 水电 / 通讯 / 订阅）、'
            + '4–6 条日常消费（餐饮 / 咖啡 / 交通 / 服饰 / 娱乐 / 医疗 …各挑不同 bucket）、'
            + '1–2 条人情支出（礼物 / 请客 / 随份子）。'
          : historyMode!.kind === 'gap_fill'
            ? '这是补齐之前几天的空白，请按"日常作息会发生的事"分布，不要全堆在某一天，'
              + '也不要全押在同一类目上——TA 这几天既会吃饭也会通勤还会偶尔买东西。'
            : '')
      : '',
  ];

  return parts.join('\n');
}
