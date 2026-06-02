/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { SessionTodoCard } from '../SessionTodoCard';

const mockState: any = { currentSessionPath: '/s/a.jsonl', sessionTodos: [] };
vi.mock('../../../stores', () => ({
  useStore: (selector: (s: any) => any) => selector(mockState),
}));

describe('SessionTodoCard', () => {
  it('无 todo 返回 null', () => {
    mockState.currentSessionPath = '/s/a.jsonl';
    mockState.sessionTodos = [];
    const { container } = render(<SessionTodoCard />);
    expect(container.querySelector('.jian-card')).toBeNull();
  });

  it('渲染三态 + 完成计数，in_progress 用 activeForm', () => {
    mockState.sessionTodos = [
      { content: '写代码', activeForm: '写代码中', status: 'in_progress' },
      { content: '测试', activeForm: '测试中', status: 'pending' },
      { content: '提交', activeForm: '提交中', status: 'completed' },
    ];
    const { container } = render(<SessionTodoCard />);
    expect(container.querySelectorAll('[data-status]')).toHaveLength(3);
    expect(container.textContent).toContain('1/3'); // 完成 1/3
    expect(container.textContent).toContain('写代码中'); // in_progress → activeForm
  });

  it('无对话返回 null', () => {
    mockState.currentSessionPath = null;
    mockState.sessionTodos = [{ content: 'x', activeForm: 'x', status: 'pending' }];
    const { container } = render(<SessionTodoCard />);
    expect(container.querySelector('.jian-card')).toBeNull();
    mockState.currentSessionPath = '/s/a.jsonl';
  });
});
