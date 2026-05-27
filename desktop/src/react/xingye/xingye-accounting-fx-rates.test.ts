import { describe, expect, it, vi } from 'vitest';

// 把 storage api mock 掉，否则 backend 会去试图发 fetch。
vi.mock('./xingye-storage-api', () => ({
  postXingyeStorage: vi.fn().mockResolvedValue({}),
}));

import {
  DEFAULT_FX_RATES,
  FX_ANCHOR_CURRENCY,
  convertCurrency,
  inferDisplayCurrencyFromProfile,
  mergeWithDefaults,
  pickDisplayCurrency,
  resolveFxState,
  type XingyeFxConfig,
} from './xingye-accounting-fx-rates';

const emptyConfig: XingyeFxConfig = { version: 1, displayCurrency: '', rates: {} };

describe('xingye-accounting-fx-rates', () => {
  describe('DEFAULT_FX_RATES', () => {
    it('anchor currency ¥ maps to 1', () => {
      expect(DEFAULT_FX_RATES[FX_ANCHOR_CURRENCY]).toBe(1);
    });

    it('covers the major worldview currencies users will plausibly see', () => {
      // 现实
      expect(DEFAULT_FX_RATES['$']).toBeGreaterThan(0);
      expect(DEFAULT_FX_RATES['€']).toBeGreaterThan(0);
      // 古代
      expect(DEFAULT_FX_RATES['两银子']).toBeGreaterThan(0);
      expect(DEFAULT_FX_RATES['文']).toBeGreaterThan(0);
      // 西幻
      expect(DEFAULT_FX_RATES['金币']).toBeGreaterThan(0);
      expect(DEFAULT_FX_RATES['铜板']).toBeGreaterThan(0);
      // 仙侠
      expect(DEFAULT_FX_RATES['灵石']).toBeGreaterThan(0);
      // 未来
      expect(DEFAULT_FX_RATES['信用点']).toBeGreaterThan(0);
      // 末日
      expect(DEFAULT_FX_RATES['瓶盖']).toBeGreaterThan(0);
    });

    it('古代多档体系内的比率是一致的（1 两 = 10 钱 = 1000 文）', () => {
      expect(DEFAULT_FX_RATES['两']).toBeCloseTo(DEFAULT_FX_RATES['钱'] * 10);
      expect(DEFAULT_FX_RATES['钱']).toBeCloseTo(DEFAULT_FX_RATES['文'] * 100);
    });

    it('西幻金/银/铜板比率（1 金 ≈ 10 银 ≈ 100 铜）', () => {
      expect(DEFAULT_FX_RATES['金币']).toBeCloseTo(DEFAULT_FX_RATES['银币'] * 10);
      expect(DEFAULT_FX_RATES['银币']).toBeCloseTo(DEFAULT_FX_RATES['铜板'] * 10);
    });
  });

  describe('mergeWithDefaults', () => {
    it('保留默认表，用户表覆盖单个币种', () => {
      const merged = mergeWithDefaults({
        version: 1,
        displayCurrency: '',
        rates: { $: 8.0 },
      });
      expect(merged['$']).toBe(8.0);
      expect(merged['€']).toBe(DEFAULT_FX_RATES['€']);
    });

    it('强制 ¥ 锚位 = 1，即使用户表写了别的', () => {
      const merged = mergeWithDefaults({
        version: 1,
        displayCurrency: '',
        rates: { '¥': 999 },
      });
      expect(merged['¥']).toBe(1);
    });
  });

  describe('convertCurrency', () => {
    const rates = mergeWithDefaults(emptyConfig);

    it('同币种原样返回', () => {
      const r = convertCurrency(100, '¥', '¥', rates);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.amount).toBe(100);
    });

    it('未标注币种视作目标币种（最常见的 "amount: 80, currency: null" 兜底）', () => {
      const r = convertCurrency(80, null, '¥', rates);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.amount).toBe(80);
    });

    it('¥ → $：除以 USD 速率', () => {
      const r = convertCurrency(720, '¥', '$', rates);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.amount).toBeCloseTo(720 / rates['$']);
    });

    it('两银子 → ¥：乘以两的速率', () => {
      const r = convertCurrency(3, '两银子', '¥', rates);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.amount).toBeCloseTo(3 * rates['两银子']);
    });

    it('金币 → 两银子：通过 ¥ 锚做两段除法', () => {
      const r = convertCurrency(1, '金币', '两银子', rates);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.amount).toBeCloseTo(rates['金币'] / rates['两银子']);
      }
    });

    it('未知币种 → ok=false', () => {
      const r = convertCurrency(100, '某种不存在的怪币', '¥', rates);
      expect(r.ok).toBe(false);
    });

    it('目标币种未知 → ok=false', () => {
      const r = convertCurrency(100, '¥', '不存在的目标', rates);
      expect(r.ok).toBe(false);
    });

    it('空目标币种 → ok=false', () => {
      const r = convertCurrency(100, '¥', '', rates);
      expect(r.ok).toBe(false);
    });
  });

  describe('pickDisplayCurrency', () => {
    it('saved 优先于其它一切', () => {
      const picked = pickDisplayCurrency({
        saved: '金币',
        ledgerCurrencyCounts: { '¥': 100 },
        profile: { agentId: 'a', updatedAt: '', backgroundSummary: '武侠江湖' },
      });
      expect(picked).toBe('金币');
    });

    it('没有 saved 时，挑账本里最常出现的币种', () => {
      const picked = pickDisplayCurrency({
        ledgerCurrencyCounts: { '¥': 5, $: 8, '两银子': 3 },
      });
      expect(picked).toBe('$');
    });

    it('账本空 → 嗅探 profile 推断', () => {
      const picked = pickDisplayCurrency({
        profile: {
          agentId: 'a',
          updatedAt: '',
          backgroundSummary: '清朝大理寺断案，江湖恩怨',
        },
      });
      expect(picked).toBe('两银子');
    });

    it('账本空 + profile 也没线索 → ¥ 兜底', () => {
      const picked = pickDisplayCurrency({});
      expect(picked).toBe(FX_ANCHOR_CURRENCY);
    });
  });

  describe('inferDisplayCurrencyFromProfile', () => {
    it('修真 / 仙侠 → 灵石', () => {
      const c = inferDisplayCurrencyFromProfile({
        agentId: 'a',
        updatedAt: '',
        backgroundSummary: '筑基期修真者，宗门弟子',
      });
      expect(c).toBe('灵石');
    });

    it('西幻 / 中世纪 → 金币', () => {
      const c = inferDisplayCurrencyFromProfile({
        agentId: 'a',
        updatedAt: '',
        backgroundSummary: '中世纪精灵法师',
      });
      expect(c).toBe('金币');
    });

    it('赛博朋克 → Eddies', () => {
      const c = inferDisplayCurrencyFromProfile({
        agentId: 'a',
        updatedAt: '',
        backgroundSummary: '夜之城义体改造的网客',
      });
      expect(c).toBe('Eddies');
    });

    it('民国 → 银元', () => {
      const c = inferDisplayCurrencyFromProfile({
        agentId: 'a',
        updatedAt: '',
        backgroundSummary: '上海滩租界年间的舞女',
      });
      expect(c).toBe('银元');
    });

    it('没有命中关键词 → 空串', () => {
      const c = inferDisplayCurrencyFromProfile({
        agentId: 'a',
        updatedAt: '',
        backgroundSummary: '一个普通的上班族',
      });
      expect(c).toBe('');
    });

    it('profile 为 null / 空字段 → 空串', () => {
      expect(inferDisplayCurrencyFromProfile(null)).toBe('');
      expect(inferDisplayCurrencyFromProfile({ agentId: 'a', updatedAt: '' })).toBe('');
    });
  });

  describe('resolveFxState', () => {
    it('返回带兜底的 displayCurrency 和 merged rates', () => {
      const state = resolveFxState({ config: emptyConfig });
      expect(state.displayCurrency).toBe(FX_ANCHOR_CURRENCY);
      expect(state.effectiveRates['¥']).toBe(1);
      expect(state.effectiveRates['$']).toBeGreaterThan(0);
    });

    it('用户保存的 displayCurrency 被尊重', () => {
      const state = resolveFxState({
        config: { version: 1, displayCurrency: '金币', rates: {} },
      });
      expect(state.displayCurrency).toBe('金币');
    });
  });
});
