/**
 * 跨「购物」「二手」「记账」三模块共用的支出 / 物品类别词汇表。
 *
 * 为什么要共用一套词表：
 *   记账模块按 category 聚合（周视图按类目分桶、月视图 Top 类目）时，
 *   如果购物用「物品类型」（衣物 / 食物）、记账用「支出场景」（餐饮 / 服饰），
 *   同一类支出会被打散到不同 bucket——
 *     · 购物「买了一袋零食」→ 食物 ¥30
 *     · 记账「巷口面摊午饭」→ 餐饮 ¥80
 *   本来都属于"吃喝消费"，却分成两条。把三模块统一到同一词表后，二者合并为
 *   「餐饮 ¥110（2 笔）」，账本聚合才有意义。
 *
 * 选词原则：每个词必须**同时承担"物品类型"和"支出场景"两个角度**：
 *   - 「服饰」既是衣服这种物品，也是服饰类支出
 *   - 「数码」既是 gadget，也是数码消费
 *   - 「餐饮」既是食材买入，也是堂食消费
 *   这样购物 / 二手按物品归类时，和记账按场景归类时，落点天然一致。
 *
 * 世界观非现代时：这些 hints 只是 modern 灵感清单，prompt 仍允许世界观词替换
 *   （古风「俸禄 / 房钱 / 药资」、西幻「法术耗材」、未来「能量配给」），
 *   只要三模块在同一 agent 里口径自洽即可。
 */

/**
 * 三模块共用的「物品 ↔ 支出场景」双语义类目。
 * 购物 / 二手只从这里选；记账 expense 也优先从这里选。
 */
export const SHARED_SPENDING_BUCKETS = [
  // 吃喝
  '餐饮', '咖啡', '零食', '酒水',
  // 穿戴
  '服饰', '鞋包', '配饰',
  // 数码 / 家电 / 家具 / 家居用品 / 日用消耗
  //   - 数码：手机 / 耳机 / 平板
  //   - 家电（也叫"电器"）：冰箱 / 洗衣机 / 吹风机 / 电饭煲
  //   - 家具：床 / 沙发 / 书架 / 桌椅
  //   - 家居：床单被罩 / 抱枕 / 窗帘 / 装饰画 / 香薰（软装）
  //   - 日用：洗发水 / 纸巾 / 牙膏（高频消耗）
  '数码', '家电', '家具', '家居', '日用',
  // 学习文化
  '文具', '书报', '学习',
  // 健康美容
  '美容', '医疗', '药品',
  // 出行
  '交通', '出行', '旅行', '住宿',
  // 闲暇（玩具：玩偶 / 手办 / 桌游 / 积木；娱乐：电影 / 演出 / KTV；爱好：手作 / 摄影耗材）
  '玩具', '娱乐', '游戏', '爱好',
  // 社交
  '礼物', '人情',
] as const;

/**
 * 记账原生独有的「非物品现金流」类目，与 SHARED_SPENDING_BUCKETS 互补。
 * 这些不会出现在购物 / 二手里——你不会"买"一份工资，也不会"卖"一份房租。
 */
export const ACCOUNTING_ONLY_CATEGORIES = [
  // 收入
  '工资', '稿费', '奖金', '红包', '利息', '分红', '退款',
  // 固定支出 / 周期性账单
  '房租', '水电', '通讯', '订阅', '保险', '税', '学费',
] as const;

/**
 * 「每个自然月最多 1 条」的严格月度类目。
 *
 * Why：现实里 TA 一个月只交一次房租 / 水电 / 电话费 / 保险费，只领一次工资。
 * 反复批量生成时模型不知道之前生成过什么，会塞「这个月房租」给同一个月两次。
 * 这份白名单同时被：
 *   - prompt 端（喂给模型"这些 (年-月, 类目) 不要重复生成"的锚点）
 *   - 入库前的 dedupe filter（哪怕模型还是生了，落库前丢弃）
 * 两层共用，保证账本里同月不会出现两笔房租。
 *
 * 不收录 `订阅`（Netflix / Spotify 多个订阅同月正常）、`税` / `学费`（频率不规则）、
 * `稿费`（一个月可能多次结算）等——只锁定语义上明确「一月一次」的。
 */
export const STRICT_MONTHLY_CATEGORIES = [
  '房租', '水电', '通讯', '保险', '工资',
] as const;
export type StrictMonthlyCategory = typeof STRICT_MONTHLY_CATEGORIES[number];

const STRICT_MONTHLY_SET: ReadonlySet<string> = new Set(STRICT_MONTHLY_CATEGORIES);

/** category 是否属于「同月最多 1 条」白名单。已归一过的 category 字符串。 */
export function isStrictMonthlyCategory(category: string | null | undefined): boolean {
  if (!category) return false;
  return STRICT_MONTHLY_SET.has(category);
}

/** 记账模块完整 hint 集合：物品消费走 shared、人生现金流走 accounting-only。 */
export const ACCOUNTING_ALL_CATEGORY_HINTS = [
  ...SHARED_SPENDING_BUCKETS,
  ...ACCOUNTING_ONLY_CATEGORIES,
] as const;

export type SharedSpendingBucket = typeof SHARED_SPENDING_BUCKETS[number];
export type AccountingOnlyCategory = typeof ACCOUNTING_ONLY_CATEGORIES[number];

/**
 * 常见近义词 → 规范 bucket 的归一表。
 *
 * Why：账本聚合用的是 raw 字符串当 key（`${currency}::${direction}::${category}`）——
 * 模型这次回「家电」下次回「电器」，会被算成两个独立 bucket，
 * 金额就分散了。这层兜底把已知同义词在 projection 阶段映射回规范词，
 * **不改源模块写盘的原值**（源模块自己的列表里仍按用户/模型写的展示）。
 *
 * 只收录**纯同义词**（不同写法、同一概念）；语义模糊的（"食物"既可能是
 * 食材也可能是零食）不进这表，避免误归类。
 *
 * 新增条目原则：
 *   - 同一概念在中文里的常见写法变体 → 写进来
 *   - 语义有歧义需要判断的 → 不写，交给 prompt 让模型自己挑
 */
export const CATEGORY_ALIASES: Record<string, string> = {
  // 「电器」是「家电」的口语别名
  '电器': '家电',
  // 旧版购物 / 二手 prompt 留下的物品类型词 → 支出 bucket
  '衣物': '服饰',
  '鞋帽': '鞋包',
  // 口语化的写法
  '吃饭': '餐饮',
  '出租车': '交通',
  '打车': '交通',
  '通讯费': '通讯',
  // 「软装」是「家居」在装修语境的别名
  '软装': '家居',
};

/**
 * 把 raw category 字符串归一为规范 bucket。
 *  - null / 空字符串 → undefined（让上层走"未分类"分支）
 *  - 命中别名 → 返回规范词
 *  - 没命中 → 返回 trim 后原值（自由文本，比如世界观特有的"俸禄""法术耗材"）
 */
export function normalizeCategory(raw: string | null | undefined): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  const trimmed = String(raw).trim();
  if (!trimmed) return undefined;
  return CATEGORY_ALIASES[trimmed] ?? trimmed;
}
