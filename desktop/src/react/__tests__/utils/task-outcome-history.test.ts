import { describe, expect, it } from 'vitest';
import { buildItemsFromHistory } from '../../utils/history-builder';

describe('TaskOutcome history recovery', () => {
  it('restores a persisted tool result card after reconnect', () => {
    const outcome = {
      taskId: 'tool:read-1', revision: 1, kind: 'web_read', lifecycle: 'completed',
      goalResult: 'partial', goalScope: 'single_response_text',
      actions: [{ id: 'read-1', label: 'web_fetch', status: 'partial' }],
      evidence: [{ kind: 'read_coverage', reference: 'https://example.org', status: 'partial', missingReasons: ['media_not_read'] }],
      pendingDecisions: ['review_missing_coverage'],
    };
    const items = buildItemsFromHistory({
      messages: [{ id: 'a1', role: 'assistant', content: '', toolCalls: [{ id: 'read-1', name: 'web_fetch', status: 'succeeded' }] }],
      blocks: [{ type: 'task_outcome', afterIndex: 0, outcome }],
    });
    expect(items[0]).toMatchObject({ type: 'message', data: { blocks: [
      { type: 'tool_group' }, { type: 'task_outcome', outcome: { goalResult: 'partial', taskId: 'tool:read-1' } },
    ] } });
  });
});
