/**
 * 健康 prompt 的去重锚点接线验证。
 *
 * dedupe 函数本体由 `xingye-health-dedupe.test.ts` 覆盖（slot 识别 / 摘录 /
 * 边界条件）；这里只验「prompt 端把 continuityAnchorBlock 正确拼到了
 * 「近期已给出的健康建议样本（请避免重复）」section、空时显示占位文本」。
 */
import { describe, expect, it } from 'vitest';
import { buildHealthDayPrompt } from './xingye-health-prompts';

const baseArgs: Parameters<typeof buildHealthDayPrompt>[0] = {
  agent: { id: 'ag-1', name: '林雾', yuan: 'lin' },
  userName: '小希',
  profile: {
    displayName: '林雾',
    shortBio: '边境医院的夜班医生',
  } as Parameters<typeof buildHealthDayPrompt>[0]['profile'],
  isoDate: '2026-05-27',
  recentSceneBlock: '（无）',
  hasRecentChats: true,
  stableLoreBlock: '（无）',
  keywordLoreBlock: '（无）',
  relationshipBlock: '（无）',
  heartbeatBlock: '（无）',
};

describe('buildHealthDayPrompt continuity anchor 接线', () => {
  it('无历史 → 显示「（无；这是 TA 第一次拿到健康建议）」占位', () => {
    const prompt = buildHealthDayPrompt({ ...baseArgs, continuityAnchorBlock: '' });
    expect(prompt).toContain('近期已给出的健康建议样本');
    expect(prompt).toContain('第一次拿到健康建议');
  });

  it('continuityAnchorBlock 不为空 → 原文落到 prompt 中', () => {
    const anchor = [
      '- 最近 3 天 advice 已覆盖的话题槽：喝水、睡眠',
      '- 最近 advice 摘录：',
      '  · 2026-05-26 [喝水] 今日分析：今天补水充足……',
    ].join('\n');
    const prompt = buildHealthDayPrompt({ ...baseArgs, continuityAnchorBlock: anchor });
    expect(prompt).toContain('最近 3 天 advice 已覆盖的话题槽');
    expect(prompt).toContain('喝水');
    expect(prompt).toContain('2026-05-26');
    // 占位文案不应该再出现
    expect(prompt).not.toContain('第一次拿到健康建议');
  });

  it('section 出现在 prompt 末尾区域（不会被中间逻辑挤掉）', () => {
    const prompt = buildHealthDayPrompt(baseArgs);
    // 该 section 出现位置应在 heartbeatBlock 之后
    const heartbeatIdx = prompt.indexOf('最近一次手机首页巡检结果');
    const anchorIdx = prompt.indexOf('近期已给出的健康建议样本');
    expect(heartbeatIdx).toBeGreaterThan(-1);
    expect(anchorIdx).toBeGreaterThan(heartbeatIdx);
  });
});
