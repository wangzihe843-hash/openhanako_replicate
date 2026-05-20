import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import { formatXingyeSpeakerContextForPrompt } from './xingye-speaker-context';

/**
 * 与 PhoneShoppingApp 的 ShoppingEntryStatus 对齐。
 */
export const SHOPPING_AI_STATUSES = [
  'wanted',
  'hesitating',
  'ordered',
  'received',
  'favorite',
  'returned',
] as const;

export const SHOPPING_AI_PLATFORM_STYLES = [
  'generic',
  'amazon',
  'taobao',
  'xianyu',
] as const;

/**
 * 构造「购物记录草稿」prompt：让模型扮演当前 agent，把最近聊天 / 状态 / 设定里的购物冲动整理成一条本地模拟记录。
 *
 * 重要约束：
 * - 第一人称，agent 自己写自己的购物清单。
 * - 不连接任何真实平台、价格、链接、推荐；价格只能是「TA 想象里的价格感」。
 * - 不写日记 / 日程 / 阅读笔记 / 邮件 / 资料柜条目。
 * - 任何输入块缺失都允许为「（无）」。
 */
export function buildShoppingDraftPrompt(args: {
  agent: Pick<Agent, 'id' | 'name' | 'yuan'>;
  userName?: string;
  profile: XingyeRoleProfile | null | undefined;
  /** 用户在弹窗里写下的购物意图（可空）。 */
  userIntent: string;
  recentSceneBlock: string;
  stableLoreBlock: string;
  keywordLoreBlock: string;
  relationshipBlock: string;
  heartbeatBlock: string;
  /**
   * 已有购物 entries 里出现过的 imaginedPrice / seller 样本。
   * 由 xingye-shopping-ai.ts 的 buildShoppingCurrencyAnchorBlock 计算后传入。
   * 跨次生成稳定货币 / 卖家口吻的关键——尤其对 lore 没显式定义货币的世界观
   * （仙侠、废土、未来），防止「今天灵石明天金锭」式漂移。
   *
   * 缺省（首次生成 / 历史读取失败）→ 空字符串，prompt 会渲染「（无；这是 TA 第一次写购物记录）」。
   */
  currencyAnchorBlock?: string;
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
    currencyAnchorBlock,
  } = args;

  const currentUserName = userName?.trim() || '用户';
  const currentAgentName = profile?.displayName?.trim() || agent.name || '当前角色';
  const speakerContextBlock = formatXingyeSpeakerContextForPrompt({
    userName: currentUserName,
    agentName: currentAgentName,
    gender: profile?.gender,
  });

  const parts: string[] = [
    '你是星野模式「小手机购物」记录草稿生成器。只返回严格 JSON，不要 Markdown，不要解释。',
    '',
    '生成目标：这是当前角色自己手机里的购物记录，由 TA 自己写出来；只是模拟，不会真的下单、付款、查价格、接外部商城。',
    '不是日记，不是日程，不是阅读笔记，不是资料柜条目。',
    '不要出现「根据聊天记录」「用户让我」「系统提示」「模型」「AI」「推荐你」等元叙述。',
    '不要使用 user 视角或第三人称视角；只能是 agent 第一人称想买 / 犹豫 / 收藏 / 已下单（虚构的）的口吻。',
    '不要出现真实链接 / 真实价格查询 / 折扣信息；imaginedPrice 只能是 TA 想象里的价格感，**且必须用 TA 所在世界观对应的货币写法**（详见下方「世界观货币写法指南」）。'
    + '**能给出明确金额时直接写数字 + 货币，不要加「约」**——「约」只在没有明确数字的 fallback 写法里出现（见下方第三步）。',
    '如果输入信息不足以判断 TA 想买什么，可以写成「最近想置办点小东西」之类的轻量物件，不要凭空捏造重大购买（车 / 房 / 奢侈品）。',
    '',
    '输出 JSON schema（仅此结构，字段名必须一致）：',
    JSON.stringify(
      {
        itemName: 'string',
        status: 'wanted',
        platformStyle: 'generic',
        category: 'string',
        imaginedPrice: 'string',
        delta: 'string',
        seller: 'string',
        reason: 'string',
        tags: ['string'],
        content: 'string',
      },
      null,
      2,
    ),
    '',
    '字段要求：',
    `- status 只能是 ${SHOPPING_AI_STATUSES.map((s) => `"${s}"`).join(' / ')} 之一；缺乏明确动作时默认 "wanted"。`,
    `- platformStyle 只能是 ${SHOPPING_AI_PLATFORM_STYLES.map((s) => `"${s}"`).join(' / ')} 之一；不确定时用 "generic"。`,
    '- itemName 必填，2–24 字的中文物品名；不要写品牌型号 SKU。',
    '- category 0–8 字（如「日用 / 文具 / 衣物 / 食物 / 礼物」），不确定可空字符串。',
    '- imaginedPrice 0–28 字；**必须用 TA 所在世界观对应的货币写法**（见下方「世界观货币写法指南」）。'
    + '**首选 · 明确金额**（能想出具体数字时一律走这条，不要加「约」）：'
    + '现代中国「¥1,280」/「168 ¥」；现代美国「$35」；西幻「5 枚金币」；中国古代「二两银子」/「八百文」；民国「三个大洋」；'
    + '未来「120 信用点」。'
    + '**fallback · 没有明确数字时**（只有 ① 你真的给不出量化数字，或 ② 设定里明确是以物易物 / 实物交换的世界观，才允许走这条）：'
    + '允许「约 + 等价物」描述「约一杯奶茶钱」「约一只相机的价位」「约一坛好酒」。**不要因为偷懒或求保险就用 fallback 模糊化能算出来的金额**。',
    '- delta 0–24 字，可空字符串；价格 delta 的口语短语，**和 imaginedPrice 同一货币体系**。例：'
    + '现代中国「比想象便宜 ¥220」；现代美国「比预算高 $5」；西幻「比预想多了 2 枚金币」；古代「省了半两」；'
    + '也可以无量化感觉「凑得起」「正好够」「有点拿不准」。没有特别感觉就留空。'
    + '**delta 跟 imaginedPrice 同样规则**：能给数字就给数字，别套「约」。',
    '- seller 0–12 字，可空字符串；TA 想象里的小店 / 卖家口吻（"光阴二手店" / "街口那家成衣" / "三鱼旧书" / "南山陶坊"）。'
    + '**不要**写真实电商平台名（淘宝 / 闲鱼 / 拼多多 / 京东 / Amazon / eBay）、品牌名（耐克 / 优衣库）、URL。可以是路边的小铺子、二手摊、手作者；'
    + '在古代背景下可以是「西市绸缎庄」「街口铁匠铺」；西幻背景可以是「巷尾杂货商」「神殿门口的吟游商人」；没有合适来源时留空，不要硬编。',
    '- reason 0–80 字一句话，写 TA 为什么想要 / 犹豫 / 收藏。',
    '- tags 0–5 个 2–6 字中文标签；不要复述 itemName 或 category。',
    '- content 30–200 字 agent 的备忘段落，可以写挑选时的心情、看到时的场合，但不要写真实购买动作。',
    '',
    '──────────────────',
    '【世界观货币写法指南】（imaginedPrice / delta 必读）',
    '──────────────────',
    '',
    '第一步 · 从 profile / 设定参考 / 最近聊天里识别 TA 所在的世界观分类，然后照搬下表对应的货币单位：',
    '',
    '◆ 现代国家（依国家选符号；agent 设定里没明示国别时，看城市名 / 地名 / 语言习惯推断）：',
    '   - 中国 / 龙国 / 华夏 / 中华 / 大陆 / 京沪粤川等省市 → **¥**（人民币 / 元）',
    '   - 美国 / 阿美 / A国 / 北美 / 纽约洛杉矶等城市 → **$**（美元）',
    '   - 日本 / 樱花国 / 东京大阪等 → **¥**（円；可写「円」「日元」避免与人民币混淆）',
    '   - 英国 / 不列颠 / 伦敦 → **£**（英镑）',
    '   - 欧洲 / 欧盟 / 法德意西 / 巴黎柏林等 → **€**（欧元）',
    '   - 韩国 / 大韩 → **₩**（韩元）',
    '   - 其它现代国家（俄罗斯 / 印度 / 巴西 / 中东 / 东南亚 / 北欧 …）→ **按该国实际货币符号**：'
    + '俄罗斯 ₽（卢布）/ 印度 ₹（卢比）/ 巴西 R$（雷亚尔）/ 沙特 ﷼（里亚尔）/ 泰国 ฿（泰铢）/ 越南 ₫ / 瑞士 CHF / 瑞典 kr 等。',
    '   - 现代背景但**国别完全无法推断**时 → 默认 **¥**（人民币）。',
    '',
    '◆ 中国古代（汉 / 唐 / 宋 / 元 / 明 / 清 / 三国 / 武侠江湖 …）→ 用「两银子」「钱」「文」体系：',
    '   - 主单位：**两银子**（也可写「两」「白银 N 两」）。',
    '   - 小额：**N 文（铜钱）** / **N 钱**（1 两 = 10 钱 = 1000 文）。',
    '   - 例：「二两银子」「半两不到」「八百文」「一钱碎银」。**不要加「约」**——古代价格本来就口语，「二两银子」就是 TA 心里的价。',
    '',
    '◆ 民国时期（1912–1949、北洋政府 / 国民政府 / 上海滩 / 老北京 …）→ **银元 / 大洋 / 法币**：',
    '   - 主单位：**银元** / **大洋** / **块大洋**（口语「N 块」）。也可用「N 法币」「N 角」。',
    '   - 例：「三个大洋」「半块银元」「八毛钱」。',
    '',
    '◆ 西幻 / 中世纪 / 文艺复兴 / 蒸汽朋克 / D&D 风格异世界 → **金币 / 银币 / 铜板** 三级体系：',
    '   - 主单位：**枚金币**（gold）；中等：**枚银币**（silver，1 金 ≈ 10 银）；零钱：**枚铜板 / 铜币**（1 银 ≈ 100 铜）。',
    '   - 例：「5 枚金币」「2 枚银币」「几枚铜板」。**不要加「约」**。',
    '',
    '◆ 未来 / 科幻 / 赛博朋克 / 太空歌剧 → 用设定氛围对应的虚构货币：',
    '   - 赛博朋克 / 反乌托邦 → **信用点**（credits）/ **Eddies**（夜城）',
    '   - 太空联邦 / 星际帝国 → **星币** / **联邦币** / **银河币** / **GalCoin**',
    '   - 反乌托邦 / 高压社会 → **配给券** / **能量单位** / **碳积分**',
    '   - 例：「120 信用点」「3 枚星币」「半张配给券」。**不要加「约」**。',
    '',
    '◆ 其它特殊背景（异世界 / 仙侠 / 修真 / 末日废土 / 蒸汽朋克）→ 看 lore 里有没有显式货币设定：',
    '   - 仙侠 / 修真 → 「灵石」/「下品灵石」/「金锭」',
    '   - 末日 / 废土 → 「瓶盖」/「子弹」/「物资点」/「水票」',
    '   - 完全无线索 → 自由编一个 2–4 字短语（「黯金」「币石」），全文保持一致。',
    '',
    '第二步 · 量级参考（让 imaginedPrice 的数字别离谱；以"一只二手胶片相机"为锚点）：',
    '',
    '   现代 ¥（人民币）：相机 ≈ ¥800–3,000；奶茶 ≈ ¥15–25；一顿便饭 ≈ ¥30–50；月房租 ≈ ¥2,000–8,000',
    '   现代 $（美元）：相机 ≈ $100–400；咖啡 ≈ $4–6；便饭 ≈ $12–20。换算粗略 $1 ≈ ¥7.2',
    '   现代 €（欧元）：粗略 €1 ≈ ¥7.8；相机 ≈ €90–380',
    '   现代 £（英镑）：粗略 £1 ≈ ¥9.2；相机 ≈ £80–320',
    '   现代円（日元）：粗略 100 円 ≈ ¥4.7；相机 ≈ 18,000–60,000 円',
    '   现代 ₩（韩元）：粗略 1,000 ₩ ≈ ¥5.2；相机 ≈ 150,000–550,000 ₩',
    '   现代 ₽（卢布）：粗略 1 ₽ ≈ ¥0.08；相机 ≈ 10,000–40,000 ₽',
    '   现代 ₹（卢比）：粗略 1 ₹ ≈ ¥0.087；相机 ≈ 9,000–35,000 ₹',
    '',
    '   中国古代「两银子」（清中后期购买力锚）：1 两 ≈ 现代 ¥200–300。相机这种东西在古代不存在，'
    + '对应物用「难得」「不止」之类描述感；具体物品：一匹绸缎 ≈ 5–10 两；一斤茶 ≈ 几钱；一壶酒 ≈ 数十文。',
    '   民国「银元 / 大洋」（1930s 上海购买力锚）：1 银元 ≈ 现代 ¥200–400（1934 上海一袋大米 ≈ 1 大洋）。'
    + '相机这种新奇玩意 ≈ 三五个大洋；一份报纸 ≈ 几分钱；一碗阳春面 ≈ 一两毛。',
    '   西幻「金币 / 银币 / 铜板」（D&D 风约定俗成）：1 金币 ≈ 一周工匠工资 ≈ 现代 ¥300–500；'
    + '一晚客栈 ≈ 1–2 银币；一把好剑 ≈ 5–20 金币；一匹马 ≈ 50–200 金币。',
    '   未来「信用点 / 星币」：自设量级，但**保持内部自洽**——比如一杯咖啡 ≈ 5 信用点，那相机就该在 800–3,000 信用点这个量级，不能跳到几百万。',
    '',
    '第三步 · imaginedPrice 的写法**严格分两档，优先用「首选」**，只有真的写不出数字时才退到 fallback：',
    '',
    '   ◆ 首选（明确金额）· 直接写数字 + 货币单位，**不要加「约」**',
    '     - 现代："¥1,280" / "168 ¥" / "$35" / "8,400 円"',
    '     - 古代："二两银子" / "八百文" / "一钱碎银"',
    '     - 民国："三个大洋" / "半块银元" / "八毛钱"',
    '     - 西幻："5 枚金币" / "2 枚银币" / "几枚铜板"',
    '     - 未来："120 信用点" / "3 枚星币"',
    '     只要你能基于物品 + 量级参考算出一个合理数字，就写到这一档。**首选档禁用「约」字**——「¥1,280」是 TA 心里的价，不需要再加「约」。',
    '',
    '   ◆ Fallback（没有明确数字）· 仅在以下两种情形才允许使用：',
    '     ① 你确实给不出量化数字（物品太抽象、世界观完全无货币线索）；',
    '     ② 设定里**明确**是以物易物 / 实物交换体系（部落 / 修真换灵药 / 末日换物资），不存在统一货币单位。',
    '     此时允许「约 + 等价物」写法："约一杯奶茶钱" / "约一只相机的价位" / "约一坛好酒" / "换两块电池的量"。',
    '     **不要因为偷懒、求安全或对量级不确定就跳到 fallback**——量级不确定时按上方「第二步 · 量级参考」中位数取整即可。',
    '',
    'delta 同样规则：能给数字就给数字，禁用「约」。现代用 ¥/$/£/€/円 + 数字；古代用「省了 X 钱」「贵了半两」；'
    + '西幻用「比预想多 N 枚铜板」；未来用「贵了 N 信用点」。也可以是非量化感觉「凑得起」「正好够」（任何世界观通用，不算 fallback）。',
    '',
    '──────────────────',
    '【货币选择优先级 · 三层兜底，必须严格按顺序判定】',
    '──────────────────',
    '',
    '**Layer 1（最高优先级）· lore 显式定义**',
    '   如果上方「星野设定参考」或「按需命中的设定库」里出现「货币」「钱」「银两」「灵石」「金币」'
    + '「信用点」「瓶盖」等明确指明 TA 所在世界用什么钱的条目——**必须 100% 沿用 lore 里写的货币体系**，'
    + '即使下方历史锚点用了别的也要服从 lore。',
    '',
    '**Layer 2 · 历史锚点（已有购物记录里用过的货币体系）**',
    '   如果下方【该角色已有购物记录里出现过的货币 / 卖家锚点】非空——**必须沿用样本里出现的同一货币体系**。',
    '   "同一货币体系"的含义按是否有面额分档来定：',
    '   ① 单档体系（一种世界观只用一个货币单位）：现代各国货币（¥ / $ / € / £ / 円 / ₩ …）/ 未来虚构货币（信用点 / 星币 / 联邦币 / Eddies）/'
    + '废土并行货币（瓶盖 / 子弹 / 水票 / 物资点 —— 每个聚落 / 势力通常只用一种）/ 仙侠（如 lore 只写「灵石」一档）'
    + '——**严格锁定同一单位**。不要这次写「灵石」下次写「金锭」，也不要这次写「信用点」下次写「星币」，更不要这次 ¥ 下次 $。',
    '   ② 多档体系（同一世界观内多档共用，按金额切档）：',
    '     - **中国古代「两 / 钱 / 文」**（1 两 = 10 钱 = 1000 文）—— 大额用两（绸缎、马匹）/ 中额用钱 / 小额用文（一壶酒 / 几个铜板）。'
    + '允许同一 agent 这次写「五两银子」下次写「二十文」，因为都在「白银 + 铜钱」这一**同一体系**里。'
    + '但**不要混入**「金锭」「碎银子」「元宝」「贯」这类不在锚点样本里出现的别档/别系统单位。',
    '     - **民国「银元 / 大洋 / 角 / 分 / 法币」**（1 银元 = 10 角 = 100 分；俗称大洋 / 毛 / 分）—— 大额银元 / 大洋，零钱角 / 分。'
    + '在同一体系内自由切档。',
    '     - **西幻 / 中世纪「金币 / 银币 / 铜板」**（1 金币 ≈ 10 银币，1 银币 ≈ 100 铜板）—— 大件 5–20 枚金币、客栈住宿 1–2 枚银币、'
    + '面包 / 蜡烛几枚铜板，都在同一体系内。**不要**改写成「金锭」「金块」这种非标准面额。',
    '   ③ 卖家口吻：可以多家小店并存（TA 会逛不同店），但语感稳定——古风背景就一直是「西市绸缎庄」「东街铁匠铺」这种古风名，'
    + '不要这次古风下次冒出「咖啡店」「便利店」。',
    '',
    '**Layer 3 · 首次创造（前两层都没有线索时才走这条）**',
    '   按上方「世界观货币写法指南」挑一个**货币体系**（不是单一单位），之后 TA 所有购物记录都用它——'
    + '这是 TA 的第一条购物记录，会成为后续记录的锚点。',
    '   单档世界观挑一个单位就锁死：仙侠优先「灵石」；废土优先「瓶盖」；未来 / 赛博朋克优先「信用点」；'
    + '太空歌剧优先「星币」；现代背景默认 ¥；其它按 lore 自由编 2–4 字短语。',
    '   多档世界观（古代 / 民国 / 西幻）挑整个**体系**（两钱文 / 银元角分 / 金银铜），后续按物品金额自由切档。',
    '',
    '──────────────────',
    '【该角色已有购物记录里出现过的货币 / 卖家锚点】',
    '──────────────────',
    currencyAnchorBlock && currencyAnchorBlock.trim()
      ? currencyAnchorBlock.trim()
      : '（无；这是 TA 第一次写购物记录，请按 Layer 3 规则挑一个单位并锁定）',
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
    '【用户输入的购物意图（若有；只是提示方向，不要照抄）】',
    userIntent.trim() || '（无）',
    '',
    '【最近 OpenHanako 聊天（可能藏着购物冲动；勿在输出里交代信息来源）】',
    recentSceneBlock.trim() || '（无）',
    '',
    '【星野核心设定摘录（stable lore；用来识别世界观分类——现代/古代/民国/西幻/未来——选对货币）】',
    stableLoreBlock.trim() || '（无）',
    '',
    '【按需命中的设定库关键词条目（仅命中项；可能含国别 / 时代 / 货币线索）】',
    keywordLoreBlock.trim() || '（无）',
    '',
    `【当前对 ${currentUserName} 的关系状态摘要（若有；情绪 / 边界参考）】`,
    relationshipBlock.trim() || '（无）',
    '',
    '【最近一次手机首页巡检结果（若有；仅作背景参考）】',
    heartbeatBlock.trim() || '（无）',
  ];

  return parts.join('\n');
}

/**
 * 构造「润色购物草稿价格」prompt：
 *
 * 用在 agent 自动巡检产出草稿 → 用户在 PhoneShoppingApp 草稿卡上点「确认并润色价格」
 * 的二段式流程里。**只重写 imaginedPrice / delta / seller 三个字段**，其它字段
 * （itemName / status / category / content / reason / tags）都被锁定，模型不应也无法改。
 *
 * 与 buildShoppingDraftPrompt 的区别：
 *  - 不重新创作，不需要 recentScene / relationship / heartbeat 这些"灵感来源"块；
 *  - 只需要 stable lore + keyword lore（识别世界观）+ currencyAnchor（已有历史货币体系）；
 *  - 输出 schema 收窄到三字段；
 *  - 货币规则用浓缩版指南（不是完整 100 行），让模型聚焦在"用对货币体系"这一件事。
 */
export function buildShoppingPolishPrompt(args: {
  agent: Pick<Agent, 'id' | 'name' | 'yuan'>;
  userName?: string;
  profile: XingyeRoleProfile | null | undefined;
  /** 当前 draft 的全部字段（已包含用户在草稿卡上的临时编辑）。 */
  draft: {
    itemName: string;
    status: string;
    category?: string;
    content?: string;
    reason?: string;
    tags?: string[];
    imaginedPrice?: string;
    delta?: string;
    seller?: string;
  };
  stableLoreBlock: string;
  keywordLoreBlock: string;
  /** 由 buildShoppingCurrencyAnchorBlock 计算后传入；缺省视作"首次"。 */
  currencyAnchorBlock?: string;
}): string {
  const {
    agent,
    userName,
    profile,
    draft,
    stableLoreBlock,
    keywordLoreBlock,
    currencyAnchorBlock,
  } = args;

  const currentUserName = userName?.trim() || '用户';
  const currentAgentName = profile?.displayName?.trim() || agent.name || '当前角色';
  const speakerContextBlock = formatXingyeSpeakerContextForPrompt({
    userName: currentUserName,
    agentName: currentAgentName,
    gender: profile?.gender,
  });

  const lockedDraft = {
    itemName: draft.itemName,
    status: draft.status,
    category: draft.category ?? '',
    content: draft.content ?? '',
    reason: draft.reason ?? '',
    tags: draft.tags ?? [],
  };

  const currentPriceFields = {
    imaginedPrice: draft.imaginedPrice ?? '',
    delta: draft.delta ?? '',
    seller: draft.seller ?? '',
  };

  const parts: string[] = [
    '你是星野模式「购物草稿价格润色器」。只返回严格 JSON，不要 Markdown，不要解释。',
    '',
    '任务：当前角色刚由 agent 自动巡检产出一条购物草稿，但 imaginedPrice / delta / seller 三个字段可能空缺、口吻不稳，或没用对世界观货币。',
    '你**只**重写这三个字段，让它们符合 TA 所在世界观的货币体系。**不要**改动 itemName / status / category / content / reason / tags ——那些是 TA 自己写的，已经定稿。',
    '',
    '输出 JSON schema（仅此三字段；其它字段不要出现在输出里）：',
    JSON.stringify({ imaginedPrice: 'string', delta: 'string', seller: 'string' }, null, 2),
    '',
    '字段要求：',
    '- imaginedPrice ≤28 字。**首选**：能基于物品 + 量级算出合理数字时直接写「数字 + 货币单位」，**禁用「约」字**。'
    + '例：现代「¥1,280」/「$35」/「8,400 円」；古代「二两银子」/「八百文」；民国「三个大洋」；西幻「5 枚金币」；未来「120 信用点」。'
    + '**Fallback**（只在 ① 实在写不出数字 ② 设定明确是以物易物体系 时用）：「约一杯奶茶钱」「约一只相机的价位」「换两块电池的量」。',
    '- delta ≤24 字，可空。**和 imaginedPrice 同一货币体系**，禁用「约」。例：「比想象便宜 ¥220」「省了半两」「贵了 30 信用点」。'
    + '无量化感觉「凑得起」「正好够」也可。**没把握时留空字符串**——空字符串永远是安全选项。',
    '- seller ≤12 字，可空。TA 想象里的小店 / 卖家口吻；与 itemName 所在世界观匹配（古风「西市绸缎庄」/ 现代「巷口杂货铺」/ 西幻「神殿门口的吟游商人」）。'
    + '**禁止**真实电商平台名（淘宝 / 闲鱼 / 京东 / Amazon / eBay）、品牌名（耐克 / 优衣库）、URL。'
    + '没合适来源就留空字符串——别硬编。',
    '',
    '──────────────────',
    '【世界观货币速查（浓缩版）】',
    '──────────────────',
    '◆ 现代中国 → ¥（人民币）；现代美国 → $；现代日本 → ¥円（写「円」避歧义）；现代英国 → £；现代欧盟 → €；现代韩国 → ₩；其它现代国家按该国货币符号；现代但国别不明 → 默认 ¥。',
    '◆ 中国古代（汉/唐/宋/明/清/武侠江湖）→「两银子 / 钱 / 文」（1 两 = 10 钱 = 1000 文）。',
    '◆ 民国（1912–1949 / 上海滩 / 老北京）→「银元 / 大洋 / 角 / 分」。',
    '◆ 西幻 / 中世纪 / D&D 风 →「金币 / 银币 / 铜板」（1 金 ≈ 10 银，1 银 ≈ 100 铜）。',
    '◆ 未来 / 赛博朋克 / 太空歌剧 →「信用点 / 星币 / Eddies / 配给券」（自设量级，内部自洽）。',
    '◆ 仙侠 / 修真 →「灵石 / 下品灵石 / 金锭」；末日 / 废土 →「瓶盖 / 子弹 / 物资点 / 水票」。',
    '',
    '──────────────────',
    '【货币选择优先级 · 三层兜底（严格按顺序判定）】',
    '──────────────────',
    '**Layer 1 · lore 显式定义**：上方设定参考里出现明示货币的条目（「货币 = 灵石」「用大洋」等）→ 100% 沿用。',
    '**Layer 2 · 历史锚点**：下方【历史货币 / 卖家锚点】非空 → **严格沿用样本里出现的同一货币体系**。'
    + '单档体系（现代各国 ¥/$、未来信用点、仙侠灵石、废土瓶盖）锁定同一单位，不要换。'
    + '多档体系（古代两/钱/文、民国银元/角/分、西幻金/银/铜板）锁体系，按金额自由切档。',
    '**Layer 3 · 首次创造**：前两层都没线索 → 按上方速查表挑货币体系，**这一条会成为后续锚点**。',
    '',
    '──────────────────',
    '【该角色已有购物记录里出现过的货币 / 卖家锚点（Layer 2 数据）】',
    '──────────────────',
    currencyAnchorBlock && currencyAnchorBlock.trim()
      ? currencyAnchorBlock.trim()
      : '（无；这是 TA 第一条购物记录，请按 Layer 3 规则挑一个货币体系并锁定）',
    '',
    '──────────────────',
    '',
    speakerContextBlock,
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
    '【星野核心设定摘录（用来识别世界观分类——现代/古代/民国/西幻/未来——选对货币）】',
    stableLoreBlock.trim() || '（无）',
    '',
    '【按需命中的设定库关键词条目（仅命中项；可能含国别 / 时代 / 货币线索）】',
    keywordLoreBlock.trim() || '（无）',
    '',
    '──────────────────',
    '【锁定字段 · 不要改，只是给你看上下文】',
    '──────────────────',
    JSON.stringify(lockedDraft, null, 2),
    '',
    '──────────────────',
    '【当前价格字段 · 你要重写的就是这三个】',
    '──────────────────',
    JSON.stringify(currentPriceFields, null, 2),
    '',
    '记住：只输出 { imaginedPrice, delta, seller } 三个字段；imaginedPrice 首选明确数字、禁用「约」；不能改 itemName/status/content 等。',
  ];

  return parts.join('\n');
}
