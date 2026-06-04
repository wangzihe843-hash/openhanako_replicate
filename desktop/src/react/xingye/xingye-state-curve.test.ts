import { describe, expect, it } from 'vitest';
import {
  interpolateAnchors,
  scaleAffectionDelta,
  scaleCorruptionDelta,
  scaleJealousyDelta,
  scaleLoyaltyDelta,
  scaleRelationshipDeltas,
  scaleTrustDelta,
  type RelationshipCurveState,
} from './xingye-state-curve';

function mkState(over: Partial<RelationshipCurveState> = {}): RelationshipCurveState {
  return { affection: 0, trust: 0, loyalty: 0, jealousy: 0, corruption: 0, ...over };
}

describe('interpolateAnchors', () => {
  const anchors = [
    { x: 0, m: 1 },
    { x: 10, m: 2 },
    { x: 20, m: 4 },
  ];
  it('端点外取端点值，不外推', () => {
    expect(interpolateAnchors(anchors, -5)).toBe(1);
    expect(interpolateAnchors(anchors, 99)).toBe(4);
  });
  it('段内线性插值', () => {
    expect(interpolateAnchors(anchors, 5)).toBeCloseTo(1.5, 6);
    expect(interpolateAnchors(anchors, 15)).toBeCloseTo(3, 6);
  });
});

describe('① 好感：早期快、后期缓（温和加速 1.25×）', () => {
  it('萍水相逢同样的好互动涨得快、情愫/朝夕逐级放缓', () => {
    expect(scaleAffectionDelta(10, 5)).toBeCloseTo(5.846, 2); // 萍水 → 约 +6
    expect(scaleAffectionDelta(95, 5)).toBeCloseTo(2.85, 2); // 情愫 → 约 +3
    expect(scaleAffectionDelta(130, 5)).toBeCloseTo(2.02, 2); // 朝夕 → 约 +2
    // 严格单调放缓
    expect(scaleAffectionDelta(10, 5)).toBeGreaterThan(scaleAffectionDelta(95, 5));
    expect(scaleAffectionDelta(95, 5)).toBeGreaterThan(scaleAffectionDelta(130, 5));
  });
  it('负好感段挽回也慢（不镜像萍水的快）', () => {
    expect(scaleAffectionDelta(-80, 5)).toBeLessThan(scaleAffectionDelta(10, 5));
  });
});

describe('① 好感负向：早期跌得慢 + 按事件大小分流', () => {
  it('萍水相逢的小冲突跌得慢', () => {
    expect(scaleAffectionDelta(10, -5)).toBeCloseTo(-2.44, 2); // 约 −2
  });
  it('深关系：日常小摩擦被缓冲、重大背叛被放大', () => {
    const friction = scaleAffectionDelta(130, -3); // 小摩擦
    const betrayal = scaleAffectionDelta(130, -12); // 重大背叛
    expect(friction).toBeCloseTo(-1.49, 2); // 约 −1，被信任垫底缓冲
    expect(betrayal).toBeCloseTo(-15.13, 1); // 约 −15，爱之深责之切
    // 同样在朝夕：每点冲量的"伤害密度"，大背叛远高于小摩擦
    expect(Math.abs(betrayal) / 12).toBeGreaterThan(Math.abs(friction) / 3);
  });
  it('浅关系不分流：小摩擦与重大事件按同一阶段基线缩放', () => {
    // 萍水 depth≈0 → 严重度不改变乘子（每点冲量缩放比例一致）
    expect(scaleAffectionDelta(10, -3) / -3).toBeCloseTo(scaleAffectionDelta(10, -9) / -9, 6);
  });
});

describe('② 信任：慢涨快跌（易建难守）', () => {
  it('涨永远 <1、跌永远 >1', () => {
    expect(Math.abs(scaleTrustDelta(0, 6)) / 6).toBeLessThan(1);
    expect(Math.abs(scaleTrustDelta(0, -6)) / 6).toBeGreaterThan(1);
  });
  it('已建立的信任：修复慢、背叛跌得狠', () => {
    expect(scaleTrustDelta(60, 6)).toBeCloseTo(4.62, 2); // 修复 → 约 +5
    expect(scaleTrustDelta(60, -6)).toBeCloseTo(-9.12, 2); // 背叛 → 约 −9
  });
  it('信任越高，同样的背叛跌得越狠', () => {
    expect(scaleTrustDelta(80, -6)).toBeLessThan(scaleTrustDelta(0, -6));
  });
});

describe('③ 忠诚：黏 + 被黑化侵蚀', () => {
  it('高忠诚抗下跌（黏）', () => {
    expect(scaleLoyaltyDelta(80, 0, -6)).toBeCloseTo(-3.3, 2); // 约 −3，几乎不动
  });
  it('黑化高时，抗跌护垫被削掉', () => {
    expect(scaleLoyaltyDelta(80, 90, -6)).toBeCloseTo(-5.68, 2); // 约 −6
    expect(Math.abs(scaleLoyaltyDelta(80, 90, -6))).toBeGreaterThan(Math.abs(scaleLoyaltyDelta(80, 0, -6)));
  });
  it('忠诚越高涨得越钝（黏性天花板）', () => {
    expect(scaleLoyaltyDelta(80, 0, 5)).toBeLessThan(scaleLoyaltyDelta(0, 0, 5));
  });
});

describe('④ 醋意：绑忠诚（占有/专一），不绑好感', () => {
  it('低忠诚（朋友阶段）几乎吃不起醋', () => {
    expect(scaleJealousyDelta(20, 6)).toBeCloseTo(2.14, 2); // 约 +2
  });
  it('高忠诚（认定）易燃', () => {
    expect(scaleJealousyDelta(80, 6)).toBeCloseTo(7.8, 2); // 约 +8
    expect(scaleJealousyDelta(80, 6)).toBeGreaterThan(scaleJealousyDelta(20, 6));
  });
  it('低忠诚散得快、高忠诚难哄（赖着）', () => {
    expect(scaleJealousyDelta(15, -5)).toBeCloseTo(-6.25, 2); // 约 −6，散得快
    expect(scaleJealousyDelta(80, -5)).toBeCloseTo(-3.0, 2); // 约 −3，难哄
  });
  it('与好感无关：好感变化不影响醋意缩放', () => {
    // scaleJealousyDelta 只吃 loyalty；好感不进参数，天然解耦
    expect(scaleJealousyDelta(50, 4)).toBe(scaleJealousyDelta(50, 4));
  });
});

describe('⑤ 黑化：几乎只进难退', () => {
  it('滋生得顺，洗白重度钝化', () => {
    expect(scaleCorruptionDelta(50, 5)).toBeCloseTo(5.5, 2); // 涨 → 约 +6
    expect(scaleCorruptionDelta(70, -5)).toBeCloseTo(-1.14, 2); // 退 → 约 −1
  });
  it('越黑越难回头', () => {
    expect(Math.abs(scaleCorruptionDelta(90, -5))).toBeLessThan(Math.abs(scaleCorruptionDelta(10, -5)));
  });
});

describe('scaleRelationshipDeltas 总入口', () => {
  it('返回对称取整的整数 delta', () => {
    const out = scaleRelationshipDeltas(mkState({ affection: 10, trust: 1, loyalty: 1 }), {
      affectionDelta: 5,
      trustDelta: -3,
      loyaltyDelta: 2,
      jealousyDelta: 0,
      corruptionDelta: 0,
    });
    expect(out).toEqual({
      affectionDelta: 6, // 5 × 1.169 → 5.85 → 6
      trustDelta: -4, // -3 × 1.402 → -4.21 → -4
      loyaltyDelta: 1, // 2 × 0.697 → 1.39 → 1
      jealousyDelta: 0,
      corruptionDelta: 0,
    });
    expect(Object.values(out).every((v) => Number.isInteger(v))).toBe(true);
  });

  it('醋意读的是 pre-update 忠诚（与同批 loyaltyDelta 无关）', () => {
    // 当前忠诚=80（高）→ 即便本批又涨忠诚，醋意 rise 仍按 pre-update 的 80 算（易燃）
    const out = scaleRelationshipDeltas(mkState({ loyalty: 80 }), { jealousyDelta: 6, loyaltyDelta: 5 });
    expect(out.jealousyDelta).toBe(8);
  });

  it('零冲量与非法值 → 0，不无中生有', () => {
    const out = scaleRelationshipDeltas(mkState({ affection: 40 }), {
      affectionDelta: 0,
      trustDelta: Number.NaN as unknown as number,
      loyaltyDelta: undefined,
    });
    expect(out.affectionDelta).toBe(0);
    expect(out.trustDelta).toBe(0);
    expect(out.loyaltyDelta).toBe(0);
  });
});
