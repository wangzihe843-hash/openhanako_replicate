/**
 * 记账相关的金额 / 货币归一化助手。
 *
 * 购物、二手、记账三个模块共用：
 *  - 购物 / 二手的 `imaginedPrice` / `askingPrice` 是给人看的氛围文本（可含「约」「便宜」
 *    等修饰），`amount` + `currency` 是给记账模块求和用的机器可读伴随值，两者独立。
 *  - 不同世界观货币（现代 ¥/$ · 古代两银子 · 民国大洋 · 西幻金币 · 未来信用点 …）
 *    语义上不能跨币种相加，所以 `currency` 必须随 `amount` 一起保存，由记账模块按币种分组。
 */

/**
 * 解析任意值为非负有限金额，保留两位小数。
 * 非数字 / NaN / Infinity / 负数 → undefined（金额本身只表大小，正负由 direction 决定）。
 */
export function normalizeAmount(value: unknown): number | undefined {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value.trim())
        : NaN;
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n * 100) / 100;
}

/**
 * 解析用户输入框里的金额文本。
 * 宽容处理：去掉千分位逗号、空白与前导货币符号 / 文字，只取其中第一段数字。
 * 解析不出非负数字 → undefined。
 */
export function parseAmountText(text: unknown): number | undefined {
  if (typeof text !== 'string') return undefined;
  const cleaned = text.replace(/[,，\s]/g, '');
  if (!cleaned) return undefined;
  const match = cleaned.match(/-?\d+(?:\.\d+)?/);
  if (!match) return undefined;
  return normalizeAmount(match[0]);
}

/** 货币单位短文本：trim + 截断到 16 字符；空 → undefined。 */
export function normalizeCurrency(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, 16);
}

/**
 * 中文数字 → 整数。
 *
 * 处理 LLM 在「世界观货币」文本里常见的写法：
 *   - 单字：一/二/两/三/…/九/十/百/千/万 → 1/2/2/3/…/9/10/100/1000/10000
 *   - 复合：二十、二十五、一百二十、八百、一千二百
 *   - 特殊：半 → 0.5；零/〇 → 0；几（不定量）→ null（调用方应返回 null）
 *   - 大写数字（壹/贰/…）也支持
 *
 * 完全无法解析 → null。被 parseImaginedPriceToMoney 用来抠「二两银子」「八百文」
 * 「三个大洋」这类古风 / 民国 / 西幻 / 未来文本里的数字。
 */
export function parseChineseNumberToInt(text: string): number | null {
  const t = (text ?? '').trim();
  if (!t) return null;
  if (t === '半') return 0.5;
  if (t === '几') return null; // 不定量，故意拒绝
  if (t === '零' || t === '〇') return 0;

  const digitMap: Record<string, number> = {
    一: 1, 壹: 1,
    二: 2, 贰: 2, 两: 2,
    三: 3, 叁: 3,
    四: 4, 肆: 4,
    五: 5, 伍: 5,
    六: 6, 陆: 6,
    七: 7, 柒: 7,
    八: 8, 捌: 8,
    九: 9, 玖: 9,
    零: 0, 〇: 0,
  };
  const unitMap: Record<string, number> = {
    十: 10, 拾: 10,
    百: 100, 佰: 100,
    千: 1000, 仟: 1000,
  };

  // 处理「万」段：以「万」切分，各段独立解析后相加（避免 "一万二千" 之类的回退）。
  const wanParts = t.split(/[万萬]/);
  if (wanParts.length > 2 || wanParts.some((part) => part === '')) {
    // "一万二千": ["一","二千"]；"万": ["",""]；都先按宽容路径走，下面继续解析
  }

  function parseSection(section: string): number | null {
    if (!section) return 0;
    let total = 0;
    let current = 0;
    for (const ch of section) {
      if (ch in digitMap) {
        current = digitMap[ch];
      } else if (ch in unitMap) {
        const unit = unitMap[ch];
        // 「十」单独出现表示 10（不是 0×10）
        if (current === 0) current = 1;
        total += current * unit;
        current = 0;
      } else {
        return null;
      }
    }
    total += current;
    return total;
  }

  if (wanParts.length === 1) {
    const v = parseSection(wanParts[0]);
    return v;
  }
  // 有「万」字
  const high = parseSection(wanParts[0]) ?? 0;
  const low = parseSection(wanParts.slice(1).join('')) ?? 0;
  if (high === null || low === null) return null;
  const total = (high || 1) * 10000 + low;
  return total > 0 ? total : null;
}

/**
 * 现代货币符号 → canonical 单位标签。
 * 用一个 map 而不是直接 return matched group，是因为 LLM 可能写「R$」「CHF」「kr」
 * 这种多字符前缀，跟单字符 ¥/$ 不同；统一通过 map 收口。
 */
const MODERN_PREFIX_CURRENCIES: Array<{ symbol: string; label: string }> = [
  // 多字符的放前面，避免被单字符吞掉
  { symbol: 'R$', label: 'R$' },
  { symbol: 'CHF', label: 'CHF' },
  { symbol: 'kr', label: 'kr' },
  { symbol: '¥', label: '¥' },
  { symbol: '$', label: '$' },
  { symbol: '£', label: '£' },
  { symbol: '€', label: '€' },
  { symbol: '₩', label: '₩' },
  { symbol: '₽', label: '₽' },
  { symbol: '₹', label: '₹' },
  { symbol: '฿', label: '฿' },
  { symbol: '₫', label: '₫' },
  { symbol: '﷼', label: '﷼' },
];

/**
 * 后置货币词（在数字后面）：「168 ¥」「8,400 円」「100 美元」。
 * 注意：必须穷尽 prompt 指南里列出的所有写法，否则数字 + 单位会被截成数字 + null。
 */
const MODERN_SUFFIX_CURRENCIES: Array<{ pattern: string; label: string }> = [
  // 现代符号
  { pattern: 'R$', label: 'R$' },
  { pattern: 'CHF', label: 'CHF' },
  { pattern: 'kr', label: 'kr' },
  { pattern: '¥', label: '¥' },
  { pattern: '$', label: '$' },
  { pattern: '£', label: '£' },
  { pattern: '€', label: '€' },
  { pattern: '₩', label: '₩' },
  { pattern: '₽', label: '₽' },
  { pattern: '₹', label: '₹' },
  { pattern: '฿', label: '฿' },
  { pattern: '₫', label: '₫' },
  { pattern: '﷼', label: '﷼' },
  // 中日韩文字写法
  { pattern: '元', label: '¥' }, // 人民币口语
  { pattern: '块钱', label: '¥' },
  { pattern: '块', label: '¥' }, // 但「N 块大洋 / N 块银元」会被前置规则先吃掉，所以这里 ¥ 是安全的
  { pattern: '円', label: '円' },
  { pattern: '日元', label: '円' },
  { pattern: '日圆', label: '円' },
  { pattern: '美元', label: '$' },
  { pattern: '美金', label: '$' },
  { pattern: '欧元', label: '€' },
  { pattern: '英镑', label: '£' },
  { pattern: '韩元', label: '₩' },
  { pattern: '卢布', label: '₽' },
  { pattern: '卢比', label: '₹' },
  { pattern: '雷亚尔', label: 'R$' },
  { pattern: '里亚尔', label: '﷼' },
  { pattern: '泰铢', label: '฿' },
  { pattern: '越南盾', label: '₫' },
  { pattern: '瑞士法郎', label: 'CHF' },
  { pattern: '瑞典克朗', label: 'kr' },
];

/**
 * 非现代货币体系：词 → canonical 单位 + 是否需要前置数字。
 * 顺序很重要：长词在前（"下品灵石" 在 "灵石" 前），多字符在前（"两银子" 在 "两" 前），
 * 否则会被短词先匹配掉。
 */
const WORLDVIEW_CURRENCIES: Array<{ pattern: string; label: string }> = [
  // 中国古代（多档体系：1 两 = 10 钱 = 1000 文）
  // "两银子" / "两白银" / "两" + 后续可能跟 "银子" → 统一标签 "两银子"
  { pattern: '两银子', label: '两银子' },
  { pattern: '两白银', label: '两银子' },
  { pattern: '钱碎银', label: '钱' }, // "一钱碎银" → 一钱
  { pattern: '碎银', label: '两银子' }, // 模糊"碎银"按银算
  { pattern: '两', label: '两银子' },
  { pattern: '钱', label: '钱' },
  { pattern: '铜钱', label: '文' },
  { pattern: '文', label: '文' },

  // 民国
  { pattern: '大洋', label: '大洋' },
  { pattern: '银元', label: '银元' },
  { pattern: '法币', label: '法币' },
  { pattern: '角钱', label: '角' },
  { pattern: '毛钱', label: '角' }, // 口语「N 毛钱」= N 角
  { pattern: '角', label: '角' },
  { pattern: '毛', label: '角' },
  { pattern: '分钱', label: '分' },
  { pattern: '分', label: '分' },

  // 西幻 / D&D
  { pattern: '下品灵石', label: '下品灵石' },
  { pattern: '金币', label: '金币' },
  { pattern: '银币', label: '银币' },
  { pattern: '铜板', label: '铜板' },
  { pattern: '铜币', label: '铜板' },
  { pattern: '金锭', label: '金锭' },
  { pattern: '金块', label: '金锭' },

  // 未来 / 赛博朋克 / 太空歌剧
  { pattern: '信用点', label: '信用点' },
  { pattern: 'credits', label: '信用点' },
  { pattern: 'Eddies', label: 'Eddies' },
  { pattern: '联邦币', label: '联邦币' },
  { pattern: '银河币', label: '银河币' },
  { pattern: 'GalCoin', label: 'GalCoin' },
  { pattern: '星币', label: '星币' },
  { pattern: '配给券', label: '配给券' },
  { pattern: '能量单位', label: '能量单位' },
  { pattern: '碳积分', label: '碳积分' },

  // 仙侠 / 修真
  { pattern: '灵石', label: '灵石' },

  // 末日 / 废土
  { pattern: '瓶盖', label: '瓶盖' },
  { pattern: '物资点', label: '物资点' },
  { pattern: '水票', label: '水票' },
  { pattern: '子弹', label: '子弹' },

  // 其它自定义短语（黯金 / 币石 等不固定，覆盖不了；fallback 由调用方处理）
];

function reEscape(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 把 "1,280" / "1,234.5" / "1280" 形式的数字字符串转 number；失败 → null。 */
function arabicToNumber(raw: string): number | null {
  const cleaned = raw.replace(/[,，\s]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * 把「想象价格 / 要价」氛围文本解析成 { amount, currency }，给记账模块按币种求和。
 *
 * 设计原则（遵循 feedback_ai_payload_minimization）：
 *  - LLM 只产 imaginedPrice / askingPrice 这类**定性核心文本**；
 *  - 数值 + 货币单位由本函数**本地确定性提取**，不让模型多产一对结构化字段；
 *  - 解析不出来（fallback 写法「约一杯奶茶钱」/ 纯语气「凑得起」）→ 返回 null，
 *    账本进 missingAmountCount，不强凑数字。
 *
 * 覆盖 prompt 指南列举的所有写法：
 *   现代各国（¥1,280 / $35 / 8,400 円 / 168 ¥ / 100 美元 / …）
 *   中国古代（二两银子 / 八百文 / 半两 / 一钱碎银）
 *   民国（三个大洋 / 半块银元 / 八毛钱）
 *   西幻（5 枚金币 / 2 枚银币 / 几枚铜板 → 「几」拒绝）
 *   未来（120 信用点 / 3 枚星币 / 半张配给券）
 *   仙侠 / 废土（5 灵石 / 100 瓶盖）
 *
 * 不覆盖：
 *   - 「约 + 等价物」fallback 写法（按设计就该 null，由账本走待补金额路径）
 *   - 用户自创的 lore 货币（「黯金」「币石」之类）—— 调用方可手动改 currency
 */
export function parseImaginedPriceToMoney(
  text: unknown,
): { amount: number; currency: string } | null {
  if (typeof text !== 'string') return null;
  const raw = text.trim();
  if (!raw) return null;

  // fallback 短语早返回——「约一杯奶茶钱」「换两块电池的量」「凑得起」「正好够」
  // 这些里也可能含「两」「电池」之类的"假"货币词，必须先拦掉，避免误匹配。
  // 注意：「约」只在 fallback 出现（prompt 明令不让在首选档加「约」），所以含「约」就跳。
  // 但「凑得起」「亏一点」之类完全无数字的也跳——下面 Arabic + Chinese 都抠不到数字时自然 return null。
  if (/^约/.test(raw)) return null;
  if (/^换/.test(raw)) return null; // 「换两块电池的量」
  if (/^相当于/.test(raw)) return null;

  // ── 1. 现代前置符号：¥1,280 / $35 / R$30 / CHF 20 ──
  for (const { symbol, label } of MODERN_PREFIX_CURRENCIES) {
    const re = new RegExp(`^${reEscape(symbol)}\\s*([\\d,，]+(?:\\.\\d+)?)`);
    const m = raw.match(re);
    if (m) {
      const n = arabicToNumber(m[1]);
      if (n !== null) return { amount: n, currency: label };
    }
  }

  // ── 2. 现代后置词：「168 ¥」「100 美元」「8,400 円」──
  // 先按长度倒序排（避免「日元」被「元」截胡）。
  const suffixSorted = [...MODERN_SUFFIX_CURRENCIES].sort((a, b) => b.pattern.length - a.pattern.length);
  for (const { pattern, label } of suffixSorted) {
    const re = new RegExp(`([\\d,，]+(?:\\.\\d+)?)\\s*${reEscape(pattern)}`);
    const m = raw.match(re);
    if (m) {
      const n = arabicToNumber(m[1]);
      if (n !== null) return { amount: n, currency: label };
    }
  }

  // ── 3. 阿拉伯数字 + 世界观货币词：「5 枚金币」「120 信用点」「3 灵石」──
  // 中间允许可选量词「枚/块/个/张/颗」。
  const worldSorted = [...WORLDVIEW_CURRENCIES].sort((a, b) => b.pattern.length - a.pattern.length);
  for (const { pattern, label } of worldSorted) {
    const re = new RegExp(`([\\d,，]+(?:\\.\\d+)?)\\s*[枚块个张颗份]?\\s*${reEscape(pattern)}`);
    const m = raw.match(re);
    if (m) {
      const n = arabicToNumber(m[1]);
      if (n !== null) return { amount: n, currency: label };
    }
  }

  // ── 4. 中文数字 + 世界观货币词：「二两银子」「八百文」「五枚金币」「半两」──
  // 中文数字段：一二三四五六七八九十百千万零〇半两壹贰叁…加 "几" 但 "几" 会触发拒绝
  // 注意 "两" 既是数字 2、又是单位「两银子」——必须靠"先吃多字符货币词"区分：
  //   「两银子」整体作为 currency，前面剩下的字符再喂 parseChineseNumberToInt；
  //   纯「两」作为 currency 时，前面必须是「一/二/…/半」等数字才匹配。
  for (const { pattern, label } of worldSorted) {
    const reChinese = new RegExp(
      `([零〇一二两三四五六七八九十百千万半壹贰叁肆伍陆柒捌玖拾佰仟]+)\\s*[枚块个张颗份]?\\s*${reEscape(pattern)}`,
    );
    const m = raw.match(reChinese);
    if (m) {
      // 防御性：如果货币词 pattern 本身以「两」开头，且数字段恰好以「两」结尾，避免误吞
      // （目前不会发生：pattern「两」会让正则贪婪吞掉数字尾的「两」，但 reChinese 用的是
      // 字符集而不是 word boundary，需要靠 worldSorted 按长度排序保证「两银子」先匹配）。
      const n = parseChineseNumberToInt(m[1]);
      if (n !== null && n > 0) return { amount: n, currency: label };
    }
  }

  // ── 5. 中文数字 + 「枚/块/个/张」+ 现代币种（少见但合理）「五个 ¥」──
  // 实际不会出现，跳过。

  return null;
}
