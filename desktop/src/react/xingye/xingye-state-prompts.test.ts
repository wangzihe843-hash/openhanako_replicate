/**
 * 关系状态 prompt 的去重锚点接线验证。
 *
 * dedupe 函数本体由 `xingye-state-dedupe.test.ts` 覆盖；这里只验
 * prompt 端把 continuityAnchorBlock 正确拼到「反套路锚点」section、
 * 空时显示「（无；这是首次刷新——尚无历史可参考）」占位。
 */
import { describe, expect, it } from 'vitest';
import { buildRelationshipStatePrompt } from './xingye-state-prompts';
import type { XingyeRelationshipState } from './xingye-state-store';

function mkState(): XingyeRelationshipState {
  return {
    agentId: 'hanako',
    targetType: 'user',
    targetId: '__user__',
    affection: 30,
    trust: 20,
    loyalty: 10,
    jealousy: 0,
    corruption: 0,
    mood: '平静',
    relationshipKey: 'friend',
    relationshipLabel: '君子之交',
    stateSummary: '互动稳定。',
    lastReason: '上下文充足。',
    updatedAt: '2026-05-20T00:00:00.000Z',
  };
}

const baseArgs: Parameters<typeof buildRelationshipStatePrompt>[0] = {
  agent: { id: 'hanako', name: '花子', yuan: 'hana' },
  userName: '小希',
  profile: { displayName: '花子' },
  state: mkState(),
  trigger: 'manual_refresh',
};

describe('buildRelationshipStatePrompt continuity anchor 接线', () => {
  it('无 anchor → 显示「首次刷新」占位文案', () => {
    const prompt = buildRelationshipStatePrompt({ ...baseArgs, continuityAnchorBlock: '' });
    expect(prompt).toContain('反套路锚点');
    expect(prompt).toContain('首次刷新');
  });

  it('有 anchor → 原文落进 prompt，占位文本被替换', () => {
    const anchor = [
      '- 近期几次状态摘录（请换不同角度描述心绪，不要复用相同套话 / 同义改写）：',
      '  · [2026-05-18] mood=愉快 ｜ summary=今天的对话很顺 ｜ reason=user 主动关心了 TA',
    ].join('\n');
    const prompt = buildRelationshipStatePrompt({ ...baseArgs, continuityAnchorBlock: anchor });
    expect(prompt).toContain('今天的对话很顺');
    expect(prompt).toContain('user 主动关心了 TA');
    expect(prompt).not.toContain('首次刷新——尚无历史可参考');
  });

  it('anchor section 在 speakerContext 之后、输入 JSON 之前（结构稳定）', () => {
    const prompt = buildRelationshipStatePrompt(baseArgs);
    const anchorIdx = prompt.indexOf('反套路锚点');
    const inputIdx = prompt.indexOf('输入：');
    expect(anchorIdx).toBeGreaterThan(-1);
    expect(inputIdx).toBeGreaterThan(anchorIdx);
  });
});
