import { describe, expect, it } from 'vitest';
import { buildScheduleDraftPrompt } from './xingye-schedule-prompts';

const baseArgs: Parameters<typeof buildScheduleDraftPrompt>[0] = {
  agent: { id: 'ag-1', name: '林雾', yuan: 'lin' },
  userName: '小希',
  profile: {
    agentId: 'ag-1',
    displayName: '林雾',
    shortBio: '边境医院的夜班医生',
    updatedAt: '2026-05-11T00:00:00.000Z',
  } as unknown as Parameters<typeof buildScheduleDraftPrompt>[0]['profile'],
  userIntent: '',
  recentSceneBlock: '（无）',
  stableLoreBlock: '（无）',
  keywordLoreBlock: '（无）',
  relationshipBlock: '（无）',
  heartbeatBlock: '（无）',
};

describe('buildScheduleDraftPrompt', () => {
  it('注入 continuityAnchorBlock 的内容', () => {
    const prompt = buildScheduleDraftPrompt({
      ...baseArgs,
      continuityAnchorBlock: '- 近期已有日程样本：\n  · 周三 14:00：开周会',
    });
    expect(prompt).toContain('跨期连续性锚点');
    expect(prompt).toContain('开周会');
  });

  it('continuityAnchorBlock 为空时给出"第一条日程"占位文案', () => {
    const prompt = buildScheduleDraftPrompt(baseArgs);
    // 占位文案要求出现
    expect(prompt).toMatch(/这是 TA 最近的第一条日程|无；这是/);
  });

  it('保留核心约束：只能 status=planned、category 五选一、JSON 严格', () => {
    const prompt = buildScheduleDraftPrompt(baseArgs);
    expect(prompt).toMatch(/status 只能是\s*"planned"/);
    expect(prompt).toContain('约定');
    expect(prompt).toContain('平常');
    expect(prompt).toMatch(/严格 JSON/);
  });

  it('注入 agent / userName 让模型知道谁的日程', () => {
    const prompt = buildScheduleDraftPrompt(baseArgs);
    expect(prompt).toContain('林雾');
    expect(prompt).toContain('小希');
    expect(prompt).toContain('ag-1');
  });
});
