import { describe, expect, it } from 'vitest';
import {
  CORRUPTION_SEED_BY_TENDENCY,
  corruptionSeedFromTendency,
  deriveInitialLoyaltyFromAffection,
  deriveInitialTrustFromAffection,
  detectCorruptionTendencyFromText,
  resolveInitialCorruption,
} from './xingye-state-init';

describe('信任 / 忠诚：机械从好感推', () => {
  it('关系越深，信任 / 忠诚基线越高', () => {
    expect(deriveInitialTrustFromAffection(90)).toBe(45); // 恋人 90×0.5
    expect(deriveInitialLoyaltyFromAffection(90)).toBe(31); // 90×0.35=31.4999…→31（浮点）
    expect(deriveInitialTrustFromAffection(30)).toBe(15); // 朋友
    expect(deriveInitialTrustFromAffection(90)).toBeGreaterThan(deriveInitialTrustFromAffection(30));
  });
  it('信任可为负（仇敌 distrust），忠诚不为负（陌生人 = 0）', () => {
    expect(deriveInitialTrustFromAffection(-80)).toBe(-40);
    expect(deriveInitialLoyaltyFromAffection(-80)).toBe(0); // 不是「负忠诚」
    expect(deriveInitialLoyaltyFromAffection(0)).toBe(0);
  });
  it('钳制在合法区间', () => {
    expect(deriveInitialTrustFromAffection(300)).toBe(100);
    expect(deriveInitialLoyaltyFromAffection(400)).toBe(100);
  });
});

describe('黑化关键词检测', () => {
  it('明显信号 → marked', () => {
    expect(detectCorruptionTendencyFromText('设定：典型病娇，占有欲极强')).toBe('marked');
    expect(detectCorruptionTendencyFromText('a classic yandere who will not let you leave')).toBe('marked');
  });
  it('较轻信号 → latent', () => {
    expect(detectCorruptionTendencyFromText('她有点占有欲，缺乏安全感，容易吃醋')).toBe('latent');
  });
  it('无信号 / 空文本 → none', () => {
    expect(detectCorruptionTendencyFromText('温和、理性、尊重边界的搭档')).toBe('none');
    expect(detectCorruptionTendencyFromText('')).toBe('none');
    expect(detectCorruptionTendencyFromText('   ')).toBe('none');
  });
  it('marked 优先于 latent（「占有欲极强」不被「占有欲」截胡）', () => {
    expect(detectCorruptionTendencyFromText('占有欲极强')).toBe('marked');
  });
});

describe('档位 → 初值基线', () => {
  it('none/latent/marked 映射到 0/12/28', () => {
    expect(corruptionSeedFromTendency('none')).toBe(0);
    expect(corruptionSeedFromTendency('latent')).toBe(CORRUPTION_SEED_BY_TENDENCY.latent);
    expect(corruptionSeedFromTendency('marked')).toBe(28);
    expect(corruptionSeedFromTendency('latent')).toBeGreaterThan(0);
    expect(corruptionSeedFromTendency('marked')).toBeGreaterThan(corruptionSeedFromTendency('latent'));
  });
});

describe('resolveInitialCorruption：LLM 档位优先 + 关键词兜底', () => {
  it('显式档位优先，压过文本里的关键词', () => {
    // 文本明明像 marked，但 LLM 显式判 none → 听 LLM（防关键词误命中）
    expect(resolveInitialCorruption('none', '病娇，占有欲极强')).toBe(0);
    // 显式 marked 即便文本平淡也按 marked
    expect(resolveInitialCorruption('marked', '温和的人')).toBe(28);
  });
  it('无显式档位 → 关键词扫描兜底', () => {
    expect(resolveInitialCorruption(undefined, '典型病娇')).toBe(28);
    expect(resolveInitialCorruption(undefined, '有点占有欲')).toBe(corruptionSeedFromTendency('latent'));
    expect(resolveInitialCorruption(undefined, '温和理性')).toBe(0);
  });
});
