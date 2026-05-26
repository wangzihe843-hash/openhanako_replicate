import { describe, expect, it } from 'vitest';
import {
  normalizeAmount,
  normalizeCurrency,
  parseAmountText,
  parseChineseNumberToInt,
  parseImaginedPriceToMoney,
} from './xingye-money';

describe('normalizeAmount', () => {
  it('keeps non-negative finite numbers, rounded to 2 decimals', () => {
    expect(normalizeAmount(99)).toBe(99);
    expect(normalizeAmount(0)).toBe(0);
    expect(normalizeAmount(99.999)).toBe(100);
    expect(normalizeAmount(12.345)).toBe(12.35);
  });

  it('parses numeric strings', () => {
    expect(normalizeAmount('88')).toBe(88);
    expect(normalizeAmount('  99.5 ')).toBe(99.5);
  });

  it('rejects negatives, NaN, Infinity, and non-numeric values', () => {
    expect(normalizeAmount(-5)).toBeUndefined();
    expect(normalizeAmount(Number.NaN)).toBeUndefined();
    expect(normalizeAmount(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(normalizeAmount('abc')).toBeUndefined();
    expect(normalizeAmount('')).toBeUndefined();
    expect(normalizeAmount(null)).toBeUndefined();
    expect(normalizeAmount(undefined)).toBeUndefined();
    expect(normalizeAmount({})).toBeUndefined();
  });
});

describe('parseAmountText', () => {
  it('extracts a non-negative number from lenient user input', () => {
    expect(parseAmountText('99')).toBe(99);
    expect(parseAmountText('¥1,280')).toBe(1280);
    expect(parseAmountText('约 99 元')).toBe(99);
    expect(parseAmountText('1,234.5')).toBe(1234.5);
  });

  it('returns undefined when no number is present', () => {
    expect(parseAmountText('')).toBeUndefined();
    expect(parseAmountText('   ')).toBeUndefined();
    expect(parseAmountText('便宜')).toBeUndefined();
    expect(parseAmountText(42 as unknown as string)).toBeUndefined();
  });
});

describe('normalizeCurrency', () => {
  it('trims and keeps short worldview currency labels', () => {
    expect(normalizeCurrency('¥')).toBe('¥');
    expect(normalizeCurrency('  两银子 ')).toBe('两银子');
  });

  it('truncates to 16 chars and drops empty / non-string values', () => {
    expect(normalizeCurrency('x'.repeat(40))).toHaveLength(16);
    expect(normalizeCurrency('')).toBeUndefined();
    expect(normalizeCurrency('   ')).toBeUndefined();
    expect(normalizeCurrency(null)).toBeUndefined();
  });
});

describe('parseChineseNumberToInt', () => {
  it('reads single-digit Chinese numerals', () => {
    expect(parseChineseNumberToInt('一')).toBe(1);
    expect(parseChineseNumberToInt('二')).toBe(2);
    expect(parseChineseNumberToInt('两')).toBe(2);
    expect(parseChineseNumberToInt('五')).toBe(5);
    expect(parseChineseNumberToInt('九')).toBe(9);
  });

  it('reads tens / hundreds / thousands compounds', () => {
    expect(parseChineseNumberToInt('十')).toBe(10);
    expect(parseChineseNumberToInt('二十')).toBe(20);
    expect(parseChineseNumberToInt('二十五')).toBe(25);
    expect(parseChineseNumberToInt('八百')).toBe(800);
    expect(parseChineseNumberToInt('一百二十')).toBe(120);
    expect(parseChineseNumberToInt('一千二百')).toBe(1200);
  });

  it('handles 半 as 0.5 and 几 as null (indefinite quantity refused)', () => {
    expect(parseChineseNumberToInt('半')).toBe(0.5);
    expect(parseChineseNumberToInt('几')).toBeNull();
  });

  it('returns null for empty / non-numeric / mixed-with-text', () => {
    expect(parseChineseNumberToInt('')).toBeNull();
    expect(parseChineseNumberToInt('  ')).toBeNull();
    expect(parseChineseNumberToInt('abc')).toBeNull();
    expect(parseChineseNumberToInt('一abc')).toBeNull();
  });
});

describe('parseImaginedPriceToMoney', () => {
  describe('modern currencies (prefix symbol)', () => {
    it('parses ¥ / $ / £ / € / ₩ / ₽ / ₹', () => {
      expect(parseImaginedPriceToMoney('¥1,280')).toEqual({ amount: 1280, currency: '¥' });
      expect(parseImaginedPriceToMoney('$35')).toEqual({ amount: 35, currency: '$' });
      expect(parseImaginedPriceToMoney('£99')).toEqual({ amount: 99, currency: '£' });
      expect(parseImaginedPriceToMoney('€42')).toEqual({ amount: 42, currency: '€' });
      expect(parseImaginedPriceToMoney('₩50000')).toEqual({ amount: 50000, currency: '₩' });
      expect(parseImaginedPriceToMoney('₽1000')).toEqual({ amount: 1000, currency: '₽' });
      expect(parseImaginedPriceToMoney('₹500')).toEqual({ amount: 500, currency: '₹' });
    });

    it('parses multi-char Western prefixes (R$ / CHF / kr)', () => {
      expect(parseImaginedPriceToMoney('R$30')).toEqual({ amount: 30, currency: 'R$' });
      expect(parseImaginedPriceToMoney('CHF 20')).toEqual({ amount: 20, currency: 'CHF' });
      expect(parseImaginedPriceToMoney('kr 100')).toEqual({ amount: 100, currency: 'kr' });
    });

    it('parses decimals', () => {
      expect(parseImaginedPriceToMoney('¥99.5')).toEqual({ amount: 99.5, currency: '¥' });
      expect(parseImaginedPriceToMoney('$12.99')).toEqual({ amount: 12.99, currency: '$' });
    });
  });

  describe('modern currencies (suffix word)', () => {
    it('parses 元 / 円 / 美元 / 欧元 / 英镑 / 韩元', () => {
      expect(parseImaginedPriceToMoney('168 元')).toEqual({ amount: 168, currency: '¥' });
      expect(parseImaginedPriceToMoney('8,400 円')).toEqual({ amount: 8400, currency: '円' });
      expect(parseImaginedPriceToMoney('35 美元')).toEqual({ amount: 35, currency: '$' });
      expect(parseImaginedPriceToMoney('42 欧元')).toEqual({ amount: 42, currency: '€' });
      expect(parseImaginedPriceToMoney('99 英镑')).toEqual({ amount: 99, currency: '£' });
      expect(parseImaginedPriceToMoney('50000 韩元')).toEqual({ amount: 50000, currency: '₩' });
    });

    it('parses suffix-symbol form 168 ¥ / 100 $', () => {
      expect(parseImaginedPriceToMoney('168 ¥')).toEqual({ amount: 168, currency: '¥' });
      expect(parseImaginedPriceToMoney('100 $')).toEqual({ amount: 100, currency: '$' });
    });

    it('disambiguates 日元 (円) from 元 (¥)', () => {
      expect(parseImaginedPriceToMoney('500 日元')).toEqual({ amount: 500, currency: '円' });
      expect(parseImaginedPriceToMoney('99 元')).toEqual({ amount: 99, currency: '¥' });
    });
  });

  describe('Chinese ancient (两 / 钱 / 文)', () => {
    it('parses 二两银子 → amount 2, currency 两银子', () => {
      expect(parseImaginedPriceToMoney('二两银子')).toEqual({ amount: 2, currency: '两银子' });
    });

    it('parses 八百文 → amount 800, currency 文', () => {
      expect(parseImaginedPriceToMoney('八百文')).toEqual({ amount: 800, currency: '文' });
    });

    it('parses 半两 → amount 0.5, currency 两银子', () => {
      expect(parseImaginedPriceToMoney('半两')).toEqual({ amount: 0.5, currency: '两银子' });
    });

    it('parses 一钱碎银 → amount 1, currency 钱', () => {
      expect(parseImaginedPriceToMoney('一钱碎银')).toEqual({ amount: 1, currency: '钱' });
    });
  });

  describe('Republican (大洋 / 银元 / 角 / 分)', () => {
    it('parses 三个大洋 → amount 3, currency 大洋', () => {
      expect(parseImaginedPriceToMoney('三个大洋')).toEqual({ amount: 3, currency: '大洋' });
    });

    it('parses 半块银元 → amount 0.5, currency 银元', () => {
      expect(parseImaginedPriceToMoney('半块银元')).toEqual({ amount: 0.5, currency: '银元' });
    });

    it('parses 八毛钱 → amount 8, currency 角 (毛 normalized to 角)', () => {
      expect(parseImaginedPriceToMoney('八毛钱')).toEqual({ amount: 8, currency: '角' });
    });
  });

  describe('Western fantasy (金币 / 银币 / 铜板)', () => {
    it('parses Arabic digit + 枚 + currency', () => {
      expect(parseImaginedPriceToMoney('5 枚金币')).toEqual({ amount: 5, currency: '金币' });
      expect(parseImaginedPriceToMoney('2 枚银币')).toEqual({ amount: 2, currency: '银币' });
    });

    it('parses Chinese numeral + currency', () => {
      expect(parseImaginedPriceToMoney('五枚金币')).toEqual({ amount: 5, currency: '金币' });
    });

    it('refuses indefinite 几枚铜板 (几 = unspecified)', () => {
      expect(parseImaginedPriceToMoney('几枚铜板')).toBeNull();
    });

    it('normalizes 铜币 → 铜板', () => {
      expect(parseImaginedPriceToMoney('3 枚铜币')).toEqual({ amount: 3, currency: '铜板' });
    });
  });

  describe('future / cyberpunk (信用点 / 星币 / Eddies / 配给券)', () => {
    it('parses 120 信用点', () => {
      expect(parseImaginedPriceToMoney('120 信用点')).toEqual({ amount: 120, currency: '信用点' });
    });

    it('parses 3 枚星币', () => {
      expect(parseImaginedPriceToMoney('3 枚星币')).toEqual({ amount: 3, currency: '星币' });
    });

    it('parses 半张配给券', () => {
      expect(parseImaginedPriceToMoney('半张配给券')).toEqual({ amount: 0.5, currency: '配给券' });
    });
  });

  describe('cultivation / wasteland (灵石 / 瓶盖 / 物资点)', () => {
    it('parses 5 灵石', () => {
      expect(parseImaginedPriceToMoney('5 灵石')).toEqual({ amount: 5, currency: '灵石' });
    });

    it('parses 100 瓶盖', () => {
      expect(parseImaginedPriceToMoney('100 瓶盖')).toEqual({ amount: 100, currency: '瓶盖' });
    });

    it('parses 30 物资点', () => {
      expect(parseImaginedPriceToMoney('30 物资点')).toEqual({ amount: 30, currency: '物资点' });
    });
  });

  describe('fallback / unparseable text returns null', () => {
    it('returns null for 约 + 等价物 fallback writing', () => {
      expect(parseImaginedPriceToMoney('约一杯奶茶钱')).toBeNull();
      expect(parseImaginedPriceToMoney('约一只相机的价位')).toBeNull();
      expect(parseImaginedPriceToMoney('约一坛好酒')).toBeNull();
    });

    it('returns null for barter-style 换 + 等价物', () => {
      expect(parseImaginedPriceToMoney('换两块电池的量')).toBeNull();
    });

    it('returns null for non-quantified delta phrases', () => {
      expect(parseImaginedPriceToMoney('凑得起')).toBeNull();
      expect(parseImaginedPriceToMoney('正好够')).toBeNull();
      expect(parseImaginedPriceToMoney('小几百')).toBeNull();
    });

    it('returns null for non-string / empty inputs', () => {
      expect(parseImaginedPriceToMoney('')).toBeNull();
      expect(parseImaginedPriceToMoney('   ')).toBeNull();
      expect(parseImaginedPriceToMoney(null)).toBeNull();
      expect(parseImaginedPriceToMoney(undefined)).toBeNull();
      expect(parseImaginedPriceToMoney(42)).toBeNull();
    });
  });
});
