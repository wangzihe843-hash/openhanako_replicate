/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { WorkflowCard } from '../WorkflowCard';

const mockState: any = { currentSessionPath: '/s/a.jsonl', agentActivitiesBySession: {} };
vi.mock('../../../stores', () => ({
  useStore: (selector: (s: any) => any) => selector(mockState),
}));

const mk = (over: any) => ({
  id: 'x', kind: 'workflow', status: 'running', sessionPath: '/s/a.jsonl',
  agentId: null, agentName: null, summary: 's', childSessionPath: null, startedAt: 1, finishedAt: null, ...over,
});

describe('WorkflowCard', () => {
  it('无 workflow 返回 null（subagent 不算）', () => {
    mockState.agentActivitiesBySession = { '/s/a.jsonl': [mk({ id: 's1', kind: 'subagent' })] };
    const { container } = render(<WorkflowCard />);
    expect(container.querySelector('.jian-card')).toBeNull();
  });

  it('只渲染 workflow，running 优先', () => {
    mockState.agentActivitiesBySession = {
      '/s/a.jsonl': [
        mk({ id: 'w2', kind: 'workflow', status: 'done', summary: '完成的', startedAt: 1, finishedAt: 2 }),
        mk({ id: 'w1', kind: 'workflow', status: 'running', summary: '跑着的', startedAt: 3 }),
        mk({ id: 's1', kind: 'subagent', status: 'running', summary: 'sub-only', startedAt: 4 }),
      ],
    };
    const { container } = render(<WorkflowCard />);
    const rows = container.querySelectorAll('[data-status]');
    expect(rows).toHaveLength(2); // 只 workflow，不含 subagent
    expect(rows[0].getAttribute('data-status')).toBe('running'); // running 优先
    expect(container.textContent).toContain('跑着的');
    expect(container.textContent).not.toContain('sub-only');
  });
});
