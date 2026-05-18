import type { XingyeDivinationMethodId } from './xingye-divination-method-resolver';
import styles from './PhoneDivinationApp.module.css';

/**
 * 运势评分四分类标签（综合 + 事业 / 恋情 / 财富 三个分项）的占法分化。
 * field_oracle 偏战地语境，所以分项名走「行动 / 协同 / 物资」；其它占法基本沿用通用语义。
 */
export type DivinationFortuneLabels = {
  overall: string;
  career: string;
  love: string;
  wealth: string;
};

/** 宜忌两行的占法分化文案。field_oracle 用「可行 / 不可行」更贴战地决策语义。 */
export type DivinationOmenLabels = {
  good: string;
  bad: string;
};

export type DivinationThemeDescriptor = {
  /** Root class applied to detail / generation card surfaces. */
  className: string;
  /** Left-edge color bar applied to list rows. */
  listBarClassName: string;
  /** Pill chip next to the entry meta in list rows. */
  listChipClassName: string;
  /** Short label shown inside the list-row chip. */
  listChipLabel: string;
  /**
   * Header label rendered on the "sign" section card when the AI body did not
   * include an explicit 【...】 label for it. 例：iching 是「卦象」、tarot 是「牌面」、
   * field_oracle 是「行动签象」。
   */
  signSectionLabel: string;
  /**
   * Header label rendered on the "action" section card (第 4 小块——AI 给出的
   * 行动/牌意/卦辞建议）。每种占法不一样：
   *   - field_oracle 用「行动签」（这是它本身的符号系统名）
   *   - iching 用「卦辞」、tarot 用「牌意指引」等
   * 不能所有占法都叫"行动签"——那是 field_oracle 专属概念。
   */
  actionSectionLabel: string;
  /**
   * generation card 顶部大标题（默认场景下的卡片名）。例：iching 是「起一卦」、
   * tarot 是「抽一张牌」、field_oracle 是「听一次战地签」。不能所有占法都叫
   * "占一卦"——「卦」是 iching 的概念。
   */
  generationLabel: string;
  /**
   * 生成按钮文案（一般是 `让 TA <动作>` 形态）。例：「让 TA 起一卦」「让 TA 抽一张牌」。
   */
  generationButtonLabel: string;
  /**
   * 空态文案（"还没有占卜记录。点 …" 末尾的 call-to-action）。
   */
  emptyCtaLabel: string;
  /** 运势评分四个分类（综合 + 三分项）的小标题。 */
  fortuneLabels: DivinationFortuneLabels;
  /** 宜 / 忌 两行小标题。 */
  omenLabels: DivinationOmenLabels;
  /** 「幸运方位」一行的小标题。field_oracle 用「朝向」更合战地语义。 */
  luckyDirectionLabel: string;
  /** 「幸运色」一行的小标题。field_oracle 用「标识色」。 */
  luckyColorLabel: string;
};

export const DIVINATION_THEME_BY_METHOD: Record<XingyeDivinationMethodId, DivinationThemeDescriptor> = {
  field_oracle: {
    className: styles.themeField,
    listBarClassName: styles.themeFieldBar,
    listChipClassName: styles.themeFieldChip,
    listChipLabel: '战地',
    signSectionLabel: '行动签象',
    actionSectionLabel: '行动签',
    generationLabel: '听一次战地签',
    generationButtonLabel: '让 TA 听一次战地签',
    emptyCtaLabel: '点「让 TA 听一次战地签」，由 TA 自己决定此刻想确认的事。',
    fortuneLabels: { overall: '综合形势', career: '行动', love: '协同', wealth: '物资' },
    omenLabels: { good: '可行', bad: '不可行' },
    luckyDirectionLabel: '朝向',
    luckyColorLabel: '标识色',
  },
  iching_liuyao: {
    className: styles.themeIching,
    listBarClassName: styles.themeIchingBar,
    listChipClassName: styles.themeIchingChip,
    listChipLabel: '六爻',
    signSectionLabel: '卦象',
    actionSectionLabel: '卦辞',
    generationLabel: '起一卦',
    generationButtonLabel: '让 TA 起一卦',
    emptyCtaLabel: '点「让 TA 起一卦」，由 TA 自己决定此刻想确认的事。',
    fortuneLabels: { overall: '综合卦象', career: '事业', love: '感情', wealth: '财运' },
    omenLabels: { good: '宜', bad: '忌' },
    luckyDirectionLabel: '吉位',
    luckyColorLabel: '吉色',
  },
  tarot: {
    className: styles.themeTarot,
    listBarClassName: styles.themeTarotBar,
    listChipClassName: styles.themeTarotChip,
    listChipLabel: '塔罗',
    signSectionLabel: '牌面',
    actionSectionLabel: '牌意指引',
    generationLabel: '抽一张牌',
    generationButtonLabel: '让 TA 抽一张牌',
    emptyCtaLabel: '点「让 TA 抽一张牌」，由 TA 自己决定此刻想确认的事。',
    fortuneLabels: { overall: '综合牌势', career: '事业', love: '恋情', wealth: '财富' },
    omenLabels: { good: '宜', bad: '忌' },
    luckyDirectionLabel: '幸运方位',
    luckyColorLabel: '幸运色',
  },
  crystal_ball: {
    className: styles.themeCrystal,
    listBarClassName: styles.themeCrystalBar,
    listChipClassName: styles.themeCrystalChip,
    listChipLabel: '水晶球',
    signSectionLabel: '签象',
    actionSectionLabel: '影像提示',
    generationLabel: '凝视一次水晶球',
    generationButtonLabel: '让 TA 凝视水晶球',
    emptyCtaLabel: '点「让 TA 凝视水晶球」，由 TA 自己决定此刻想确认的事。',
    fortuneLabels: { overall: '综合影像', career: '事业', love: '恋情', wealth: '财富' },
    omenLabels: { good: '宜', bad: '忌' },
    luckyDirectionLabel: '幸运方位',
    luckyColorLabel: '幸运色',
  },
  runes: {
    className: styles.themeRunes,
    listBarClassName: styles.themeRunesBar,
    listChipClassName: styles.themeRunesChip,
    listChipLabel: '卢恩',
    signSectionLabel: '签象',
    actionSectionLabel: '符意建议',
    generationLabel: '投一次符',
    generationButtonLabel: '让 TA 投一次符',
    emptyCtaLabel: '点「让 TA 投一次符」，由 TA 自己决定此刻想确认的事。',
    fortuneLabels: { overall: '综合符意', career: '事业', love: '感情', wealth: '财运' },
    omenLabels: { good: '宜', bad: '忌' },
    luckyDirectionLabel: '幸运方位',
    luckyColorLabel: '幸运色',
  },
  astrology: {
    className: styles.themeAstro,
    listBarClassName: styles.themeAstroBar,
    listChipClassName: styles.themeAstroChip,
    listChipLabel: '占星',
    signSectionLabel: '签象',
    actionSectionLabel: '星象建议',
    generationLabel: '看一次星象',
    generationButtonLabel: '让 TA 看一次星象',
    emptyCtaLabel: '点「让 TA 看一次星象」，由 TA 自己决定此刻想确认的事。',
    fortuneLabels: { overall: '综合星象', career: '事业', love: '恋情', wealth: '财富' },
    omenLabels: { good: '宜', bad: '忌' },
    luckyDirectionLabel: '幸运方位',
    luckyColorLabel: '幸运色',
  },
  oracle_generic: {
    className: styles.themeGeneric,
    listBarClassName: styles.themeGenericBar,
    listChipClassName: styles.themeGenericChip,
    listChipLabel: '神谕',
    signSectionLabel: '签象',
    /**
     * oracle_generic 是"心象/神谕"流派，没有强结构化的占符；action 段是"心象提示"，
     * 与心象草稿语义对齐。
     */
    actionSectionLabel: '心象提示',
    generationLabel: '听一段心象',
    generationButtonLabel: '让 TA 听一段心象',
    emptyCtaLabel: '点「让 TA 听一段心象」，由 TA 自己决定此刻想确认的事。',
    fortuneLabels: { overall: '综合分数', career: '事业', love: '恋情', wealth: '财富' },
    omenLabels: { good: '宜', bad: '忌' },
    luckyDirectionLabel: '幸运方位',
    luckyColorLabel: '幸运色',
  },
};

/** action section label 的辅助 getter，与 getDivinationTheme 同款回退到 oracle_generic。 */
export function getDivinationActionSectionLabel(methodId: XingyeDivinationMethodId | null | undefined): string {
  return getDivinationTheme(methodId).actionSectionLabel;
}

export function getDivinationTheme(methodId: XingyeDivinationMethodId | null | undefined): DivinationThemeDescriptor {
  if (methodId && DIVINATION_THEME_BY_METHOD[methodId]) {
    return DIVINATION_THEME_BY_METHOD[methodId];
  }
  return DIVINATION_THEME_BY_METHOD.oracle_generic;
}
