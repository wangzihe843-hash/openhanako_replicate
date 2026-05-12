/**
 * @vitest-environment jsdom
 */

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryCandidatePanel } from './MemoryCandidatePanel';
import { createXingyeMemoryCandidate, rejectXingyeMemoryCandidate } from './xingye-memory-candidate-store';

vi.mock('../hooks/use-hana-fetch', () => ({
  hanaUrl: (path: string) => path,
  hanaFetch: vi.fn(),
}));

const { hanaFetch } = await import('../hooks/use-hana-fetch');

describe('MemoryCandidatePanel', () => {
  const agentId = 'agent-panel-1';

  beforeEach(() => {
    window.localStorage.clear();
    vi.mocked(hanaFetch).mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('shows pending candidate and reject updates status', async () => {
    const c = createXingyeMemoryCandidate(agentId, { content: 'hello memory', target: 'pinned' });
    render(<MemoryCandidatePanel agentId={agentId} />);

    expect(screen.getByText('hello memory')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }));

    await waitFor(() => {
      expect(screen.getByTestId(`memory-candidate-status-${c.id}`)).toHaveTextContent('已拒绝');
    });
  });

  it('confirm calls pinned GET/PUT and hides confirm for written', async () => {
    const c = createXingyeMemoryCandidate(agentId, { content: 'pin me', target: 'pinned' });
    vi.mocked(hanaFetch)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ pins: [] }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) } as Response);

    render(<MemoryCandidatePanel agentId={agentId} />);

    fireEvent.click(screen.getByRole('button', { name: '确认写入 pinned' }));

    await waitFor(() => {
      expect(screen.getByTestId(`memory-candidate-status-${c.id}`)).toHaveTextContent('已写入');
    });
    expect(hanaFetch).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '确认写入 pinned' })).not.toBeInTheDocument();
  });

  it('confirm shows already-in-pinned flash when GET returns normalized match', async () => {
    createXingyeMemoryCandidate(agentId, { content: 'already there', target: 'pinned' });
    vi.mocked(hanaFetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ pins: ['already there'] }),
    } as Response);

    render(<MemoryCandidatePanel agentId={agentId} />);
    fireEvent.click(screen.getByRole('button', { name: '确认写入 pinned' }));

    await waitFor(() => {
      expect(screen.getByTestId('memory-candidate-flash')).toHaveTextContent('pinned 中已有相同内容');
    });
    expect(hanaFetch).toHaveBeenCalledTimes(1);
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
});
