import { describe, expect, it } from 'vitest';
import {
  DIVINATION_METHOD_IDS,
  getDivinationMethodLabel,
  isDivinationMethodId,
  resolveRecommendedDivinationMethod,
  type XingyeDivinationAgentLike,
} from './xingye-divination-method-resolver';

describe('xingye-divination-method-resolver (scoring)', () => {
  it('1. 林雾类战地医疗语料 → field_oracle，理由含战地/医疗/边境等', () => {
    const agent: XingyeDivinationAgentLike = {
      name: '林雾',
      backgroundSummary:
        '武器化火药、感染控制、基础外科缝合、止血、药物配给、紧急撤离、边境战乱、资源不足。在封锁区维持临时诊所。',
    };
    const r = resolveRecommendedDivinationMethod(agent);
    expect(r.method).toBe('field_oracle');
    expect(r.methodLabel).toMatch(/战地|行动签/);
    expect(r.autoSelected).toBe(true);
    expect(r.scores.field_oracle).toBeGreaterThanOrEqual(15);
    expect(r.matchedSignals.length).toBeGreaterThan(3);
    expect(r.resolverReason).toMatch(/命中线索|感染|边境|外科|止血|资源|撤离|战地/);
    expect(r.resolverReason).toMatch(/星座|星盘|都市日常|轻都市/);
  });

  it('2. 国风仙侠 → iching_liuyao', () => {
    const agent: XingyeDivinationAgentLike = {
      name: '云岫',
      identitySummary: '出身江湖门派，行走仙侠世界，修习八卦与剑术。',
      tags: ['古风', '修真'],
    };
    const r = resolveRecommendedDivinationMethod(agent);
    expect(r.method).toBe('iching_liuyao');
    expect(r.scores.iching_liuyao).toBeGreaterThanOrEqual(15);
    expect(r.resolverReason).toMatch(/国风|仙侠|东方|八卦/);
  });

  it('3. 中国古代 + 火药 → 仍为 iching_liuyao（不被火药单独带偏 field）', () => {
    const agent: XingyeDivinationAgentLike = {
      shortBio: '中国古代王朝下的火药应用与硝石配制研究，县衙档案记载。',
    };
    const r = resolveRecommendedDivinationMethod(agent);
    expect(r.method).toBe('iching_liuyao');
    expect(r.scores.field_oracle).toBeLessThan(r.scores.iching_liuyao);
  });

  it('4. 北欧维京卢恩 → runes', () => {
    const agent: XingyeDivinationAgentLike = {
      name: 'Eira',
      shortBio: '维京时代挪威海岸的战士，阿斯加德传说与卢恩符文石陪伴左右。',
      lore: ['冰岛符文石', '斯堪的纳维亚', '部族誓言'],
    };
    const r = resolveRecommendedDivinationMethod(agent);
    expect(r.method).toBe('runes');
    expect(r.resolverReason).toMatch(/北欧|维京|卢恩/);
  });

  it('5. 中世纪女巫魔法宫廷 → crystal_ball（或高权重水晶侧）', () => {
    const agent: XingyeDivinationAgentLike = {
      backgroundSummary: '中世纪欧洲古堡里的女巫，宫廷魔法、炼金术与水晶球预言。',
    };
    const r = resolveRecommendedDivinationMethod(agent);
    expect(r.method).toBe('crystal_ball');
    expect(r.resolverReason).toMatch(/女巫|水晶|宫廷|魔法|前现代/);
  });

  it('6. 近代沙龙灵媒纸牌雾都 → tarot', () => {
    const agent: XingyeDivinationAgentLike = {
      shortBio: '雾都沙龙里的灵媒用纸牌为顾客占卜，咖啡馆与剧院之间的神秘主义圈子。',
    };
    const r = resolveRecommendedDivinationMethod(agent);
    expect(r.method).toBe('tarot');
    expect(r.resolverReason).toMatch(/塔罗|纸牌|沙龙|灵媒|雾都/);
  });

  it('7. 现代校园都市手机社交媒体 → astrology', () => {
    const agent: XingyeDivinationAgentLike = {
      name: '小林',
      personalitySummary: '普通大学生，校园恋爱日常，通勤地铁与写字楼，刷手机看社交媒体与星座运势。',
      era: '当代都市',
    };
    const r = resolveRecommendedDivinationMethod(agent);
    expect(r.method).toBe('astrology');
    expect(r.resolverReason).toMatch(/都市|校园|现代|占星|星座/);
  });

  it('8. 废土撤离补给急救 → field_oracle', () => {
    const agent: XingyeDivinationAgentLike = {
      lore: ['废土聚落补给线中断', '大规模撤离', '急救站伤员不断'],
    };
    const r = resolveRecommendedDivinationMethod(agent);
    expect(r.method).toBe('field_oracle');
    expect(r.resolverReason).toMatch(/废土|撤离|补给|急救|灾后|风险/);
  });

  it('9. 模糊语料、分数低于阈值 → oracle_generic', () => {
    const agent: XingyeDivinationAgentLike = {
      name: '???',
      shortBio: 'qwertyuiopasdfghjkl',
    };
    const r = resolveRecommendedDivinationMethod(agent);
    expect(r.method).toBe('oracle_generic');
    expect(r.autoSelected).toBe(false);
    expect(r.resolverReason).toMatch(/阈值|低置信度|未达到/);
  });

  it('10. 输出含 matchedSignals 与 scores；resolverReason 含命中线索与背景判断', () => {
    const agent: XingyeDivinationAgentLike = {
      identitySummary: '仙侠宗门弟子，兼修易经八卦。',
    };
    const r = resolveRecommendedDivinationMethod(agent);
    expect(Array.isArray(r.matchedSignals)).toBe(true);
    expect(r.matchedSignals.length).toBeGreaterThan(0);
    expect(r.scores).toMatchObject({
      iching_liuyao: expect.any(Number),
      tarot: expect.any(Number),
      field_oracle: expect.any(Number),
      oracle_generic: expect.any(Number),
    });
    expect(r.resolverReason).toContain('命中线索');
    expect(r.resolverReason).toContain('背景判断');
  });

  it('11. 显式「塔罗」锁定 tarot；显式「易经」锁定 iching_liuyao', () => {
    const tar = resolveRecommendedDivinationMethod({
      shortBio: '完全古风世界但角色沉迷塔罗牌阵与命运之轮意象',
    });
    expect(tar.method).toBe('tarot');

    const yi = resolveRecommendedDivinationMethod({
      shortBio: '都市背景却日日研习易经八卦与六爻',
    });
    expect(yi.method).toBe('iching_liuyao');
  });

  it('12. null / 空语料 → oracle_generic，matchedSignals 为空', () => {
    const a = resolveRecommendedDivinationMethod(null);
    expect(a.method).toBe('oracle_generic');
    expect(a.matchedSignals).toEqual([]);
    const b = resolveRecommendedDivinationMethod(undefined);
    expect(b.method).toBe('oracle_generic');
  });

  it('exports seven method ids, field_oracle label, and type guard', () => {
    expect(DIVINATION_METHOD_IDS).toHaveLength(7);
    expect(DIVINATION_METHOD_IDS).toContain('field_oracle');
    expect(getDivinationMethodLabel('field_oracle')).toMatch(/战地|行动签/);
    expect(isDivinationMethodId('field_oracle')).toBe(true);
    expect(isDivinationMethodId('not-a-method')).toBe(false);
  });
});
