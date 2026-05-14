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
   * include an explicit 【...】 label for it.
   */
  signSectionLabel: string;
};

export const DIVINATION_THEME_BY_METHOD: Record<XingyeDivinationMethodId, DivinationThemeDescriptor> = {
  field_oracle: {
    className: styles.themeField,
    listBarClassName: styles.themeFieldBar,
    listChipClassName: styles.themeFieldChip,
    listChipLabel: '战地',
    signSectionLabel: '行动签象',
  },
  iching_liuyao: {
    className: styles.themeIching,
    listBarClassName: styles.themeIchingBar,
    listChipClassName: styles.themeIchingChip,
    listChipLabel: '六爻',
    signSectionLabel: '卦象',
  },
  tarot: {
    className: styles.themeTarot,
    listBarClassName: styles.themeTarotBar,
    listChipClassName: styles.themeTarotChip,
    listChipLabel: '塔罗',
    signSectionLabel: '牌面',
  },
  crystal_ball: {
    className: styles.themeCrystal,
    listBarClassName: styles.themeCrystalBar,
    listChipClassName: styles.themeCrystalChip,
    listChipLabel: '水晶球',
    signSectionLabel: '签象',
  },
  runes: {
    className: styles.themeRunes,
    listBarClassName: styles.themeRunesBar,
    listChipClassName: styles.themeRunesChip,
    listChipLabel: '卢恩',
    signSectionLabel: '签象',
  },
  astrology: {
    className: styles.themeAstro,
    listBarClassName: styles.themeAstroBar,
    listChipClassName: styles.themeAstroChip,
    listChipLabel: '占星',
    signSectionLabel: '签象',
  },
  oracle_generic: {
    className: styles.themeGeneric,
    listBarClassName: styles.themeGenericBar,
    listChipClassName: styles.themeGenericChip,
    listChipLabel: '神谕',
    signSectionLabel: '签象',
  },
};

export function getDivinationTheme(methodId: XingyeDivinationMethodId | null | undefined): DivinationThemeDescriptor {
  if (methodId && DIVINATION_THEME_BY_METHOD[methodId]) {
    return DIVINATION_THEME_BY_METHOD[methodId];
  }
  return DIVINATION_THEME_BY_METHOD.oracle_generic;
}
