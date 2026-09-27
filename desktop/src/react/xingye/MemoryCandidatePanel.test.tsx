/**
 * @vitest-environment jsdom
 */

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryCandidatePanel } from './MemoryCandidatePanel';
import { createXingyeMemoryCandidate, getXingyeMemoryCandidate, rejectXingyeMemoryCandidate } from './xingye-memory-candidate-store';
import { emitAgentPinnedMemoryChanged } from '../agent-pinned-memory';

vi.mock('../hooks/use-hana-fetch', () => ({
  hanaUrl: (path: string) => path,
  hanaFetch: vi.fn(),
}));

vi.mock('../stores', () => ({
  useStore: (fn: (s: { currentAgentId: string; agentName: string }) => unknown) =>
    fn({ currentAgentId: 'agent-panel-1', agentName: 'Panel Agent' }),
}));

vi.mock('../settings/store', () => ({
  useSettingsStore: (fn: (s: { settingsAgentId: null; currentAgentId: string; ready: boolean }) => unknown) =>
    fn({ settingsAgentId: null, currentAgentId: 'agent-panel-1', ready: false }),
}));

const { hanaFetch } = await import('../hooks/use-hana-fetch');

/** 模拟服务端 pinned 列表，随 PUT 更新 */
let mockPinnedServerPins: string[] = [];
let mockSceneValid = true;

describe('MemoryCandidatePanel', () => {
  const agentId = 'agent-panel-1';

  beforeEach(() => {
    (window as unknown as { __XINGYE_PERSISTENCE_DEV_LOCAL__?: boolean }).__XINGYE_PERSISTENCE_DEV_LOCAL__ = true;
    window.localStorage.clear();
    mockPinnedServerPins = [];
    mockSceneValid = true;
    vi.mocked(hanaFetch).mockReset();
    vi.mocked(hanaFetch).mockImplementation(async (path: string, opts?: RequestInit) => {
      if (path === '/api/xingye/scene-summary/validate') {
        return { ok: true, json: async () => ({ valid: mockSceneValid, reason: mockSceneValid ? null : 'source deleted' }) } as Response;
      }
      if (typeof path === 'string' && path.includes('/pinned') && opts?.method === 'PUT') {
        const body = opts?.body ? (JSON.parse(String(opts.body)) as { pins?: string[] }) : {};
        mockPinnedServerPins = Array.isArray(body.pins) ? [...body.pins] : [];
        return { ok: true, json: async () => ({ ok: true }) } as Response;
      }
      if (typeof path === 'string' && path.includes('/pinned')) {
        return { ok: true, json: async () => ({ pins: [...mockPinnedServerPins] }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });
  });

  afterEach(() => {
    delete (window as unknown as { __XINGYE_PERSISTENCE_DEV_LOCAL__?: boolean }).__XINGYE_PERSISTENCE_DEV_LOCAL__;
    cleanup();
  });

  it('shows pending candidate and reject updates status', async () => {
    const c = createXingyeMemoryCandidate(agentId, { content: 'hello memory', target: 'pinned' });
    render(<MemoryCandidatePanel agentId={agentId} />);

    expect(screen.getByText('hello memory')).toBeInTheDocument();
    expect(screen.getByTestId('memory-candidate-write-target')).toHaveTextContent('agent-panel-1');
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }));

    await waitFor(() => {
      expect(screen.getByTestId(`memory-candidate-status-${c.id}`)).toHaveTextContent('已拒绝');
    });
  });

  it('shows write target with agent name when provided', () => {
    createXingyeMemoryCandidate(agentId, { content: 'x', target: 'pinned' });
    render(<MemoryCandidatePanel agentId={agentId} agentName="星名" />);
    expect(screen.getByTestId('memory-candidate-write-target')).toHaveTextContent('星名 / agent-panel-1');
  });

  it('confirm calls pinned GET/PUT and hides confirm for written', async () => {
    const c = createXingyeMemoryCandidate(agentId, { content: 'pin me', target: 'pinned' });
    render(<MemoryCandidatePanel agentId={agentId} />);

    fireEvent.click(screen.getByRole('button', { name: '确认写入' }));

    await waitFor(() => {
      expect(screen.getByTestId(`memory-candidate-status-${c.id}`)).toHaveTextContent('已写入');
    });
    expect(hanaFetch).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '确认写入' })).not.toBeInTheDocument();
  });

  it('written candidate shows stale when pinned no longer contains content after refresh event', async () => {
    const c = createXingyeMemoryCandidate(agentId, { content: 'gone pin', target: 'pinned' });
    render(<MemoryCandidatePanel agentId={agentId} />);
    fireEvent.click(screen.getByRole('button', { name: '确认写入' }));
    await waitFor(() => {
      expect(screen.getByTestId(`memory-candidate-status-${c.id}`)).toHaveTextContent('已写入');
    });

    mockPinnedServerPins = [];
    emitAgentPinnedMemoryChanged({ agentId, source: 'settings', pinsCount: 0 });

    await waitFor(() => {
      expect(screen.getByTestId(`memory-candidate-pinned-stale-${c.id}`)).toHaveTextContent('已从 pinned 移除');
    });
  });

  it('confirm shows already-in-pinned flash when GET returns normalized match', async () => {
    createXingyeMemoryCandidate(agentId, { content: 'already there', target: 'pinned' });
    vi.mocked(hanaFetch).mockReset();
    vi.mocked(hanaFetch)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ pins: [] }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ pins: ['already there'] }) } as Response);

    render(<MemoryCandidatePanel agentId={agentId} />);
    fireEvent.click(screen.getByRole('button', { name: '确认写入' }));

    await waitFor(() => {
      expect(screen.getByTestId('memory-candidate-flash')).toHaveTextContent('pinned 中已有相同内容');
    });
    expect(hanaFetch).toHaveBeenCalled();
  });

  it('fact pending shows target label and blocked reason without confirm button', () => {
    const c = createXingyeMemoryCandidate(agentId, { content: 'fact line', target: 'fact' });
    render(<MemoryCandidatePanel agentId={agentId} />);

    expect(screen.getByTestId(`memory-candidate-target-${c.id}`)).toHaveTextContent(/事实/);
    expect(screen.getByTestId(`memory-candidate-blocked-${c.id}`)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '确认写入' })).not.toBeInTheDocument();
  });

  it('longterm pending shows target label and blocked reason without confirm button', () => {
    const c = createXingyeMemoryCandidate(agentId, { content: 'lt', target: 'longterm' });
    render(<MemoryCandidatePanel agentId={agentId} />);

    expect(screen.getByTestId(`memory-candidate-target-${c.id}`)).toHaveTextContent(/长期/);
    expect(screen.getByTestId(`memory-candidate-blocked-${c.id}`)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '确认写入' })).not.toBeInTheDocument();
  });

  it('status filter hides non-matching rows', async () => {
    createXingyeMemoryCandidate(agentId, { content: 'keep', target: 'pinned' });
    const gone = createXingyeMemoryCandidate(agentId, { content: 'reject-me', target: 'pinned' });
    rejectXingyeMemoryCandidate(agentId, gone.id);

    render(<MemoryCandidatePanel agentId={agentId} />);

    fireEvent.change(screen.getByLabelText('筛选候选状态'), { target: { value: 'pending' } });
    await waitFor(() => {
      expect(screen.getByText('keep')).toBeInTheDocument();
      expect(screen.queryByText('reject-me')).not.toBeInTheDocument();
    });
  });

  it('reviews a scene citation, downgrades edited direct text to inference, then archives without pinned writes', async () => {
    const c = createXingyeMemoryCandidate(agentId, {
      sourceDomain: 'scene_summary', sourceId: 'session-a', target: 'scene_archive',
      content: '关键事件：在月台见面',
      sceneSummary: {
        sessionId: 'session-a', validity: 'unknown',
        sourceRefs: [{ entryId: 'entry-1', hash: 'a'.repeat(64), role: 'user' }],
        sections: [{ kind: 'event', text: '在月台见面', inference: false, evidence: [{ entryId: 'entry-1', quote: '月台见面' }] }],
      },
    });
    const navigate = vi.fn(async () => {});
    render(<MemoryCandidatePanel agentId={agentId} onNavigateSceneSource={navigate} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '采纳场景' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /原文：月台见面/ }));
    expect(navigate).toHaveBeenCalledWith('session-a', 'entry-1');
    fireEvent.change(screen.getByLabelText('场景条目 1 内容'), { target: { value: '他们约定见面' } });
    expect(screen.queryByRole('button', { name: /原文：月台见面/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '采纳场景' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '保存场景修改' }));
    await waitFor(() => expect(getXingyeMemoryCandidate(c.id)?.sceneSummary?.sections[0]).toMatchObject({ inference: true, evidence: [] }));
    await waitFor(() => expect(screen.getByRole('button', { name: '采纳场景' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '采纳场景' }));
    await waitFor(() => expect(screen.getByTestId(`memory-candidate-status-${c.id}`)).toHaveTextContent('已采纳'));
    expect(vi.mocked(hanaFetch).mock.calls.filter(([path]) => String(path).includes('/pinned'))).toHaveLength(0);
  });

  it('marks a removed source stale and blocks scene adoption', async () => {
    mockSceneValid = false;
    const c = createXingyeMemoryCandidate(agentId, {
      sourceDomain: 'scene_summary', target: 'scene_archive', content: '场景',
      sceneSummary: {
        sessionId: 'session-a', validity: 'unknown',
        sourceRefs: [{ entryId: 'entry-1', hash: 'a'.repeat(64), role: 'user' }],
        sections: [{ kind: 'event', text: '场景', inference: false, evidence: [{ entryId: 'entry-1', quote: '原文' }] }],
      },
    });
    render(<MemoryCandidatePanel agentId={agentId} />);
    await waitFor(() => expect(getXingyeMemoryCandidate(c.id)?.sceneSummary?.validity).toBe('stale'));
    expect(screen.getByRole('button', { name: '采纳场景' })).toBeDisabled();
    expect(screen.getByText('source deleted')).toBeInTheDocument();
  });

});
