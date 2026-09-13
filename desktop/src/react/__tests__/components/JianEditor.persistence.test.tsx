// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JianEditor } from '../../components/desk/DeskEditor';
import { useStore } from '../../stores';
import { hanaFetch } from '../../hooks/use-hana-fetch';

vi.mock('../../hooks/use-hana-fetch', () => ({ hanaFetch: vi.fn() }));
vi.mock('../../stores/agent-actions', () => ({ clearChat: vi.fn() }));

describe('JianEditor persistence ownership', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.t = ((key: string) => key) as typeof window.t;
    useStore.setState({ serverPort: '3210', serverToken: 'test', activeServerConnection: null, deskWorkspaceMountId: null, deskBasePath: '/A', deskJianContent: 'A', currentAgentId: 'hana' });
    vi.mocked(hanaFetch).mockReset().mockResolvedValue({ ok: true, json: async () => ({ files: [] }) } as Response);
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('F2 flushes the old workspace on switch without changing the new workspace content', async () => {
    render(<JianEditor />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'A edited' } });
    await act(async () => { useStore.setState({ deskBasePath: '/B', deskJianContent: 'B' }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(800); });
    const writes = vi.mocked(hanaFetch).mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0][1]!.body as string)).toMatchObject({ dir: '/A', content: 'A edited' });
    expect(useStore.getState().deskJianContent).toBe('B');
  });
});
