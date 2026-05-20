import { describe, expect, it } from 'vitest';
import { buildSecretInterviewPrompt } from './xingye-secret-space-interview-prompts';

const baseArgs = {
  agent: { id: 'ag-1', name: '林雾', yuan: 'lin' } as const,
  userName: '小希',
  profile: {
    displayName: '林雾',
    shortBio: '边境医院的夜班医生',
    identitySummary: '',
    backgroundSummary: '',
    personalitySummary: '',
    relationshipLabel: '',
    speakingStyle: '',
    values: '',
    taboos: '',
    relationshipMode: '',
    behaviorLogic: '',
  } as unknown as Parameters<typeof buildSecretInterviewPrompt>[0]['profile'],
  recordedAtIso: '2026-05-20T10:00:00.000Z',
  continuityAnchorBlock: '',
  recentSceneBlock: '（无）',
  stableLoreBlock: '（无）',
  keywordLoreBlock: '（无）',
  relationshipBlock: '（无）',
};

describe('buildSecretInterviewPrompt', () => {
  it('包含核心结构性约束：5 题固定、弹幕三档 tag、backstage 必填', () => {
    const prompt = buildSecretInterviewPrompt(baseArgs);
    // 5 题
    expect(prompt).toMatch(/必须恰好 5 题/);
    // 弹幕 tag 三档
    expect(prompt).toMatch(/audience\s*\/\s*fan\s*\/\s*editor/);
    // backstage 是模块灵魂
    expect(prompt).toMatch(/backstage|相机关了/);
    // 第一人称受访的硬约束
    expect(prompt).toMatch(/第一人称/);
  });

  it('userQuestion 给定时：要求把题原样放进 questions 并设 userQuestionIndex', () => {
    const prompt = buildSecretInterviewPrompt({
      ...baseArgs,
      userQuestion: '有没有过想放弃的时刻？',
    });
    expect(prompt).toContain('有没有过想放弃的时刻？');
    expect(prompt).toMatch(/userQuestionIndex/);
    // 建议落到第 3 或第 4 题
    expect(prompt).toMatch(/index=2|index=3|第 3 题|第 4 题/);
  });

  it('userQuestion 为空时：不要求 userQuestionIndex（让模型自由出 5 题）', () => {
    const prompt = buildSecretInterviewPrompt({ ...baseArgs, userQuestion: undefined });
    expect(prompt).toMatch(/没有.*出题/);
    expect(prompt).toMatch(/不要.*设置 userQuestionIndex|不要设置 userQuestionIndex/);
  });

  it('schema 示例里出现 hostIntro / questions / backstage / userQuestionIndex 字段名', () => {
    const prompt = buildSecretInterviewPrompt(baseArgs);
    expect(prompt).toContain('hostIntro');
    expect(prompt).toContain('questions');
    expect(prompt).toContain('backstage');
    expect(prompt).toContain('userQuestionIndex');
    expect(prompt).toContain('danmaku');
  });

  it('禁元叙述声明出现（OpenHanako / AI / prompt 等）', () => {
    const prompt = buildSecretInterviewPrompt(baseArgs);
    expect(prompt).toMatch(/不要出现.*OpenHanako/);
    expect(prompt).toMatch(/AI|prompt/);
  });

  it('当前角色 / userName / agentName 注入到 prompt（让模型知道谁问谁答）', () => {
    const prompt = buildSecretInterviewPrompt(baseArgs);
    expect(prompt).toContain('林雾');
    expect(prompt).toContain('小希');
    expect(prompt).toContain('ag-1');
  });

  it('continuityAnchorBlock 为空时给出"第一期"占位文案', () => {
    const prompt = buildSecretInterviewPrompt(baseArgs);
    expect(prompt).toMatch(/第一期/);
  });

  it('editor 弹幕"至少 1 条 / 题"的硬约束写进 prompt', () => {
    const prompt = buildSecretInterviewPrompt(baseArgs);
    expect(prompt).toMatch(/editor.*至少|至少.*editor/);
  });
});
