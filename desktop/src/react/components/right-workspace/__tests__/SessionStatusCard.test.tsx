/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { SessionStatusCard } from '../SessionStatusCard';

const mockState: any = {
  currentSessionPath: null,
  deskBasePath: '/Users/x/OH-WorkSpace',
  currentModel: { id: 'gpt-x', provider: 'openai' },
  sessionModelsByPath: {},
  sessionRegistryFilesByPath: {},
};
vi.mock('../../../stores', () => ({
  useStore: (selector: (s: any) => any) => selector(mockState),
}));

describe('SessionStatusCard', () => {
  it('无当前对话返回 null（welcome 态不显示）', () => {
    mockState.currentSessionPath = null;
    const { container } = render(<SessionStatusCard />);
    expect(container.querySelector('.jian-card')).toBeNull();
  });

  it('有对话时渲染工作目录 / 模型 / 文件数', () => {
    mockState.currentSessionPath = '/s/a.jsonl';
    mockState.sessionRegistryFilesByPath = { '/s/a.jsonl': [{}, {}, {}] };
    const { container } = render(<SessionStatusCard />);
    expect(container.querySelector('.jian-card')).toBeTruthy();
    expect(container.textContent).toContain('gpt-x'); // 模型 id
    expect(container.textContent).toContain('3');      // 文件数
  });

  it('per-session 模型优先于全局 currentModel', () => {
    mockState.currentSessionPath = '/s/a.jsonl';
    mockState.sessionModelsByPath = { '/s/a.jsonl': { id: 'claude-x', provider: 'anthropic' } };
    const { container } = render(<SessionStatusCard />);
    expect(container.textContent).toContain('claude-x');
    mockState.sessionModelsByPath = {}; // 复位
  });
});
