/** @vitest-environment jsdom */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentTopicCandidates } from '../AgentTopicCandidates';
import zh from '../../../../../locales/zh.json';

const fetchMock = vi.fn();
vi.mock('../../../api', () => ({ hanaFetch: (...args: unknown[]) => fetchMock(...args) }));

function response(body: unknown) { return { ok: true, json: async () => body }; }
function row(title: string) {
  return { id: title, title, reason: '用户选择', sourceType: 'reality_source',
    source: {}, status: 'pending', expiresAt: '2026-09-28T00:00:00Z', lastUsedAt: null };
}
const originalT = window.t;
beforeEach(() => {
  window.t = ((key: string, vars?: Record<string, string>) => {
    const value = key.split('.').reduce<unknown>((source, part) =>
      source && typeof source === 'object' ? (source as Record<string, unknown>)[part] : undefined, zh);
    if (typeof value !== 'string') return key;
    let translated = value;
    for (const [name, replacement] of Object.entries(vars || {})) translated = translated.replaceAll(`{${name}}`, replacement);
    return translated;
  }) as typeof window.t;
});
afterEach(() => { cleanup(); vi.clearAllMocks(); window.t = originalT; });

describe('AgentTopicCandidates agent isolation', () => {
  it('only exposes HTTP(S) links from persisted topic source data', async () => {
    fetchMock.mockImplementation((path: string) => Promise.resolve(response(path.includes('/pinned')
      ? { pins: [] }
      : { candidates: [
        { ...row('安全来源'), source: { url: 'https://example.org/article' } },
        { ...row('不安全来源'), source: { url: 'javascript:alert(1)' } },
      ] })));
    render(<AgentTopicCandidates agentId="agent-a" />);
    await screen.findByText('安全来源');
    const links = screen.getAllByRole('link', { name: '查看来源' });
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe('https://example.org/article');
    expect(links[0].getAttribute('rel')).toContain('noopener');
  });

  it('ignores late requests from the previous agent', async () => {
    let finishOld!: (value: ReturnType<typeof response>) => void;
    const oldTopics = new Promise<ReturnType<typeof response>>(resolve => { finishOld = resolve; });
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/agent-a/topic-candidates')) return oldTopics;
      if (url.includes('/agent-a/pinned')) return Promise.resolve(response({ pins: ['A 的私密记忆'] }));
      if (url.includes('/agent-b/topic-candidates')) return Promise.resolve(response({ candidates: [row('B 的候选')] }));
      return Promise.resolve(response({ pins: ['B 的记忆'] }));
    });
    const view = render(<AgentTopicCandidates agentId="agent-a" />);
    view.rerender(<AgentTopicCandidates agentId="agent-b" />);
    await screen.findByText('B 的候选');
    await act(async () => { finishOld(response({ candidates: [row('A 的旧候选')] })); });
    expect(screen.queryByText('A 的旧候选')).toBeNull();
    fireEvent.change(screen.getByLabelText('话题来源类型'), { target: { value: 'shared_memory' } });
    expect(screen.queryByRole('option', { name: 'A 的私密记忆' })).toBeNull();
    expect(screen.getByRole('option', { name: 'B 的记忆' })).toBeTruthy();
  });

  it('clears old pin choices immediately while the next agent loads', async () => {
    let finishNew!: (value: ReturnType<typeof response>) => void;
    const newTopics = new Promise<ReturnType<typeof response>>(resolve => { finishNew = resolve; });
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/agent-a/topic-candidates')) return Promise.resolve(response({ candidates: [] }));
      if (url.includes('/agent-a/pinned')) return Promise.resolve(response({ pins: ['A 的私密记忆'] }));
      if (url.includes('/agent-b/topic-candidates')) return newTopics;
      return Promise.resolve(response({ pins: ['B 的记忆'] }));
    });
    const view = render(<AgentTopicCandidates agentId="agent-a" />);
    fireEvent.change(screen.getByLabelText('话题来源类型'), { target: { value: 'shared_memory' } });
    await waitFor(() => expect(screen.getByRole('option', { name: 'A 的私密记忆' })).toBeTruthy());
    view.rerender(<AgentTopicCandidates agentId="agent-b" />);
    expect(screen.queryByRole('option', { name: 'A 的私密记忆' })).toBeNull();
    await act(async () => { finishNew(response({ candidates: [] })); });
    fireEvent.change(screen.getByLabelText('话题来源类型'), { target: { value: 'shared_memory' } });
    expect(screen.getByRole('option', { name: 'B 的记忆' })).toBeTruthy();
  });

  it('does not clear a new agent form after an old add finishes', async () => {
    let finishOld!: (value: ReturnType<typeof response>) => void;
    const oldPost = new Promise<ReturnType<typeof response>>(resolve => { finishOld = resolve; });
    fetchMock.mockImplementation((url: string, options?: { method?: string }) => {
      if (url.includes('/agent-a/topic-candidates') && options?.method === 'POST') return oldPost;
      return Promise.resolve(response(url.includes('/pinned') ? { pins: [] } : { candidates: [] }));
    });
    const view = render(<AgentTopicCandidates agentId="agent-a" />);
    fireEvent.change(screen.getByLabelText('现实来源话题'), { target: { value: 'A 的话题' } });
    fireEvent.change(screen.getByLabelText('现实来源网址'), { target: { value: 'https://example.org/a' } });
    fireEvent.change(screen.getByLabelText('提供理由'), { target: { value: 'A 的理由' } });
    fireEvent.change(screen.getByLabelText('有效期'), { target: { value: '2026-09-28T12:00' } });
    fireEvent.click(screen.getByRole('button', { name: '加入话题候选' }));
    view.rerender(<AgentTopicCandidates agentId="agent-b" />);
    fireEvent.change(screen.getByLabelText('现实来源话题'), { target: { value: 'B 的话题' } });
    await act(async () => { finishOld(response({ candidate: row('A 的话题') })); });
    expect((screen.getByLabelText('现实来源话题') as HTMLInputElement).value).toBe('B 的话题');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText(/正文未读取或验证/)).toBeTruthy();
  });

  it('does not show an old status-change error on the new agent', async () => {
    let finishOld!: (value: { ok: boolean; json: () => Promise<unknown> }) => void;
    const oldPatch = new Promise<{ ok: boolean; json: () => Promise<unknown> }>(resolve => { finishOld = resolve; });
    fetchMock.mockImplementation((url: string, options?: { method?: string }) => {
      if (url.includes('/agent-a/topic-candidates/') && options?.method === 'PATCH') return oldPatch;
      if (url.includes('/pinned')) return Promise.resolve(response({ pins: [] }));
      return Promise.resolve(response({ candidates: [row(url.includes('/agent-a/') ? 'A 的候选' : 'B 的候选')] }));
    });
    const view = render(<AgentTopicCandidates agentId="agent-a" />);
    await screen.findByText('A 的候选');
    fireEvent.click(screen.getByRole('button', { name: '跳过' }));
    view.rerender(<AgentTopicCandidates agentId="agent-b" />);
    await screen.findByText('B 的候选');
    await act(async () => { finishOld({ ok: false, json: async () => ({ error: 'A 的旧错误' }) }); });
    expect(screen.queryByText('A 的旧错误')).toBeNull();
    expect((screen.getByRole('button', { name: '跳过' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
