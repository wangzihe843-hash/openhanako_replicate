import type { XingyeDivinationMethodId } from './xingye-divination-method-resolver';
import styles from './PhoneDivinationApp.module.css';

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
