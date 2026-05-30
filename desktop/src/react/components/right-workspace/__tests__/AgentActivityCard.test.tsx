/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { AgentActivityCard } from '../AgentActivityCard';

// mock 整个 store：组件只用 useStore（currentSessionPath + selectAgentActivities）
const mockState: any = { currentSessionPath: '/s/a.jsonl', agentActivitiesBySession: {} };
vi.mock('../../../stores', () => ({
  useStore: (selector: (s: any) => any) => selector(mockState),
}));

describe('AgentActivityCard', () => {
  it('无活动时返回 null（desk 撑满）', () => {
    mockState.agentActivitiesBySession = {};
    const { container } = render(<AgentActivityCard />);
    expect(container.querySelector('.jian-card')).toBeNull();
  });

  it('只渲染当前 session 的活动，running 优先排序', () => {
    mockState.agentActivitiesBySession = {
      '/s/a.jsonl': [
        { id: 'd2', kind: 'subagent', status: 'done', sessionPath: '/s/a.jsonl', agentId: null, agentName: '毛毛', summary: '调研完成', childSessionPath: null, startedAt: 1000, finishedAt: 2000 },
        { id: 'd1', kind: 'subagent', status: 'running', sessionPath: '/s/a.jsonl', agentId: null, agentName: '小黎', summary: '点评咖啡', childSessionPath: null, startedAt: 3000, finishedAt: null },
      ],
      '/s/b.jsonl': [
        { id: 'other', kind: 'subagent', status: 'running', sessionPath: '/s/b.jsonl', agentId: null, agentName: '别的', summary: '别的对话', childSessionPath: null, startedAt: 9000, finishedAt: null },
      ],
    };
    const { container } = render(<AgentActivityCard />);
    const rows = container.querySelectorAll('[data-status]');
    expect(rows).toHaveLength(2); // 只当前 session，不含 /s/b.jsonl
    expect(rows[0].getAttribute('data-status')).toBe('running'); // running 优先
    expect(container.textContent).toContain('小黎');
    expect(container.textContent).toContain('点评咖啡');
    expect(container.textContent).not.toContain('别的对话');
  });

  it('无当前 session 时返回 null', () => {
    mockState.currentSessionPath = null;
    mockState.agentActivitiesBySession = { '/s/a.jsonl': [{ id: 'x', kind: 'workflow', status: 'running', sessionPath: '/s/a.jsonl', agentId: null, agentName: 'a', summary: 's', childSessionPath: null, startedAt: 1, finishedAt: null }] };
    const { container } = render(<AgentActivityCard />);
    expect(container.querySelector('.jian-card')).toBeNull();
    mockState.currentSessionPath = '/s/a.jsonl'; // 复位
  });
});
