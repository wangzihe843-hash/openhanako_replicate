import { describe, expect, it } from 'vitest';
import { buildStateContinuityAnchorBlock } from './xingye-state-dedupe';
import type {
  XingyeRelationshipState,
  XingyeRelationshipStateHistoryItem,
} from './xingye-state-store';

function mkHistory(
  partial: Partial<XingyeRelationshipStateHistoryItem>,
): XingyeRelationshipStateHistoryItem {
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
    stateSummary: '最近聊得很多，心情不错。',
    lastReason: '上下文充足，互动稳定。',
    updatedAt: '2026-05-20T00:00:00.000Z',
    ...partial,
  };
}

function mkState(partial: Partial<XingyeRelationshipState>): XingyeRelationshipState {
  return {
    ...mkHistory({}),
    ...partial,
  } as XingyeRelationshipState;
}

describe('buildStateContinuityAnchorBlock', () => {
  it('空 history → 空字符串', () => {
    expect(buildStateContinuityAnchorBlock(undefined)).toBe('');
    expect(buildStateContinuityAnchorBlock(null)).toBe('');
    expect(buildStateContinuityAnchorBlock([])).toBe('');
  });

  it('state 无 previousStates → 空字符串', () => {
    const state = mkState({ previousStates: undefined });
    expect(buildStateContinuityAnchorBlock(state)).toBe('');
  });

  it('state.previousStates 含一条 → 至少 1 行样本', () => {
    const state = mkState({
      previousStates: [
        mkHistory({
          mood: '愉快',
          stateSummary: '今天的对话很顺。',
          lastReason: 'user 主动关心了 TA。',
          updatedAt: '2026-05-18T00:00:00.000Z',
        }),
      ],
    });
    const block = buildStateContinuityAnchorBlock(state);
    expect(block).not.toBe('');
    const lines = block.split('\n');
    // header + 至少一条样本 + 结尾的「注意」行
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines[0]).toContain('近期几次状态摘录');
    expect(block).toContain('愉快');
    expect(block).toContain('今天的对话很顺');
    expect(block).toContain('user 主动关心了 TA');
    expect(block).toContain('2026-05-18');
  });

  it('直接传 history 数组也工作', () => {
    const history: XingyeRelationshipStateHistoryItem[] = [
      mkHistory({ mood: '警惕', stateSummary: '互相试探。' }),
    ];
    const block = buildStateContinuityAnchorBlock(history);
    expect(block).toContain('警惕');
    expect(block).toContain('互相试探');
  });

  it('按 updatedAt 倒序（最近的在前）', () => {
    const block = buildStateContinuityAnchorBlock([
      mkHistory({ stateSummary: '旧条', updatedAt: '2026-05-01T00:00:00.000Z' }),
      mkHistory({ stateSummary: '新条', updatedAt: '2026-05-20T00:00:00.000Z' }),
    ]);
    expect(block.indexOf('新条')).toBeLessThan(block.indexOf('旧条'));
  });

  it('截断超长 stateSummary / lastReason', () => {
    const longSummary = '套话'.repeat(60);
    const block = buildStateContinuityAnchorBlock([
      mkHistory({ stateSummary: longSummary }),
    ]);
    expect(block).toContain('…');
    expect(block).not.toContain(longSummary);
  });

  it('所有 history 字段都为空 → 视为无内容，返回空串', () => {
    const block = buildStateContinuityAnchorBlock([
      mkHistory({ mood: '', stateSummary: '', lastReason: '' }),
    ]);
    expect(block).toBe('');
  });

  it('limit 控制条数', () => {
    const history: XingyeRelationshipStateHistoryItem[] = [];
    for (let i = 0; i < 8; i += 1) {
      history.push(
        mkHistory({
          stateSummary: `第${i}条总结。`,
          updatedAt: `2026-05-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
        }),
      );
    }
    const block = buildStateContinuityAnchorBlock(history, { limit: 3 });
    const sampleLines = block.split('\n').filter((l) => l.startsWith('  · '));
    expect(sampleLines.length).toBe(3);
  });

  it('末尾追加「请换不同切口」的硬要求行', () => {
    const block = buildStateContinuityAnchorBlock([
      mkHistory({ stateSummary: 'x' }),
    ]);
    expect(block).toContain('避开历史中已经写过');
  });
});
