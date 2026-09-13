// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompiledMemoryViewer } from '../CompiledMemoryViewer';
import { useSettingsStore } from '../../store';
import { hanaFetch } from '../../api';

vi.mock('../../api', () => ({
  hanaFetch: vi.fn(),
}));

vi.mock('../../../hooks/use-mermaid-diagrams', () => ({
  useMermaidDiagrams: vi.fn(),
}));

describe('CompiledMemoryViewer editable facts', () => {
  beforeEach(() => {
    window.t = ((key: string) => key) as typeof window.t;
    window.i18n = {
      locale: 'zh-CN',
      defaultName: 'Hana',
      _data: {},
      _agentOverrides: {},
      load: vi.fn(async () => {}),
      setAgentOverrides: vi.fn(),
      t: ((key: string) => key) as typeof window.t,
    };
    useSettingsStore.setState({
      settingsAgentId: null,
      currentAgentId: 'hana',
      agents: [{ id: 'hana', name: 'Hana', isPrimary: true }],
    } as never);
    vi.mocked(hanaFetch).mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/memories/compiled?agentId=hana' && !init?.method) {
        return new Response(JSON.stringify({
          editableFactsEnabled: true,
          sections: {
            facts: '用户喜欢清晰边界。',
            today: '今天只读。',
            week: '本周只读。',
            longterm: '长期只读。',
          },
          content: '',
        }));
      }
      if (url === '/api/memories/compiled/week/days?agentId=hana' && !init?.method) {
        return new Response(JSON.stringify({
          days: [
            { date: '2026-07-01', body: '第一天的记录。' },
            { date: '2026-07-02', body: '第二天的记录。' },
          ],
        }));
      }
      if (url === '/api/memories/compiled/facts?agentId=hana' && init?.method === 'PUT') {
        return new Response(JSON.stringify({ ok: true, facts: '用户喜欢清晰边界。\n用户关注记忆系统。' }));
      }
      if (url === '/api/memories/compiled/today?agentId=hana' && init?.method === 'PUT') {
        return new Response(JSON.stringify({ ok: true, today: '编辑后的今天。' }));
      }
      if (url === '/api/memories/compiled/longterm?agentId=hana' && init?.method === 'PUT') {
        return new Response(JSON.stringify({ ok: true, longterm: '编辑后的长期情况。' }));
      }
      if (url === '/api/memories/compiled/week/days/2026-07-01?agentId=hana' && init?.method === 'PUT') {
        return new Response(JSON.stringify({ ok: true, date: '2026-07-01', body: '编辑后的第一天。' }));
      }
      throw new Error(`unexpected request ${url} ${init?.method || 'GET'}`);
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('F4 discards an old agent response after closing and reopening for another agent', async () => {
    let release!: (value: Response) => void;
    vi.mocked(hanaFetch).mockImplementation(async (url, init) => {
      if (url.includes('/week/days')) return new Response(JSON.stringify({ days: [] }));
      if (init?.method === 'PUT') return new Response(JSON.stringify({ ok: true }));
      if (url.endsWith('=hana')) return new Promise<Response>(resolve => { release = resolve; });
      return new Response(JSON.stringify({ sections: { facts: 'B facts' } }));
    });
    render(<CompiledMemoryViewer />);
    act(() => { window.dispatchEvent(new Event('hana-view-compiled-memory')); });
    fireEvent.click(screen.getByText('✕'));
    useSettingsStore.setState({ settingsAgentId: 'B' });
    act(() => { window.dispatchEvent(new Event('hana-view-compiled-memory')); });
    expect(await screen.findByText('B facts')).toBeTruthy();
    await act(async () => { release(new Response(JSON.stringify({ sections: { facts: 'A facts' } }))); });
    expect(screen.queryByText('A facts')).toBeNull();
    fireEvent.click(screen.getByText('settings.memory.editEntry'));
    fireEvent.change(screen.getByLabelText('settings.memory.editableFactsLabel'), { target: { value: 'B edited' } });
    fireEvent.click(screen.getByText('settings.memory.editSave'));
    await waitFor(() => expect(hanaFetch).toHaveBeenCalledWith('/api/memories/compiled/facts?agentId=B', expect.objectContaining({ body: JSON.stringify({ facts: 'B edited' }) })));
  });

  it('REVIEW prevents an edit/save from racing a pending clear', async () => {
    let finish!: (response: Response) => void;
    const original = vi.mocked(hanaFetch).getMockImplementation()!;
    vi.mocked(hanaFetch).mockImplementation((url, init) => init?.method === 'DELETE'
      ? new Promise<Response>(resolve => { finish = resolve; }) : original(url, init));
    render(<CompiledMemoryViewer />);
    act(() => { window.dispatchEvent(new Event('hana-view-compiled-memory')); });
    await screen.findByText('用户喜欢清晰边界。');
    fireEvent.click(screen.getByText('settings.memory.compiledClear'));
    expect(screen.getByText('settings.memory.editEntry')).toBeDisabled();
    expect(screen.getByText('settings.memory.compiledClear')).toBeDisabled();
    await act(async () => { finish(new Response(JSON.stringify({ ok: true }))); });
    expect(screen.getByText('settings.memory.editEntry')).toBeEnabled();
  });

  it('renders read-only memory sections outside edit mode', async () => {
    render(React.createElement(CompiledMemoryViewer));

    window.dispatchEvent(new Event('hana-view-compiled-memory'));

    expect(await screen.findByText('用户喜欢清晰边界。')).toBeTruthy();
    expect(screen.getByText('今天只读。')).toBeTruthy();
    expect(screen.getByText('本周只读。')).toBeTruthy();
    expect(screen.getByText('长期只读。')).toBeTruthy();
    expect(screen.queryByLabelText('settings.memory.editableFactsLabel')).toBeNull();
    expect(screen.queryByText('settings.memory.saveFacts')).toBeNull();
  });

  it('switches into edit mode with four editable sections and saves them from the header', async () => {
    render(React.createElement(CompiledMemoryViewer));

    window.dispatchEvent(new Event('hana-view-compiled-memory'));

    await screen.findByText('用户喜欢清晰边界。');
    fireEvent.click(screen.getByText('settings.memory.editEntry'));

    const todayInput = await screen.findByLabelText('settings.memory.sections.today');
    expect(todayInput).toHaveValue('今天只读。');
    const factsInput = screen.getByLabelText('settings.memory.editableFactsLabel');
    expect(factsInput).toHaveValue('用户喜欢清晰边界。');
    const longtermInput = screen.getByLabelText('settings.memory.sections.longterm');
    expect(longtermInput).toHaveValue('长期只读。');
    const dayOneInput = await screen.findByLabelText('2026-07-01');
    expect(dayOneInput).toHaveValue('第一天的记录。');
    const dayTwoInput = screen.getByLabelText('2026-07-02');
    expect(dayTwoInput).toHaveValue('第二天的记录。');
    expect(screen.queryByText('settings.memory.saveToday')).toBeNull();
    expect(screen.queryByText('settings.memory.saveFacts')).toBeNull();
    expect(screen.queryByText('settings.memory.saveLongterm')).toBeNull();
    expect(screen.queryByText('settings.memory.saveDay')).toBeNull();

    fireEvent.change(todayInput, { target: { value: '编辑后的今天。' } });
    fireEvent.change(factsInput, {
      target: { value: '用户喜欢清晰边界。\n用户关注记忆系统。' },
    });
    fireEvent.change(longtermInput, { target: { value: '编辑后的长期情况。' } });
    fireEvent.change(dayOneInput, { target: { value: '编辑后的第一天。' } });
    fireEvent.click(screen.getByText('settings.memory.editSave'));

    await waitFor(() => {
      expect(hanaFetch).toHaveBeenCalledWith('/api/memories/compiled/today?agentId=hana', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ today: '编辑后的今天。' }),
      });
    });

    await waitFor(() => {
      expect(hanaFetch).toHaveBeenCalledWith('/api/memories/compiled/facts?agentId=hana', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ facts: '用户喜欢清晰边界。\n用户关注记忆系统。' }),
      });
    });

    await waitFor(() => {
      expect(hanaFetch).toHaveBeenCalledWith('/api/memories/compiled/longterm?agentId=hana', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ longterm: '编辑后的长期情况。' }),
      });
    });

    await waitFor(() => {
      expect(hanaFetch).toHaveBeenCalledWith('/api/memories/compiled/week/days/2026-07-01?agentId=hana', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: '编辑后的第一天。' }),
      });
    });

    await waitFor(() => {
      expect(screen.queryByLabelText('settings.memory.sections.today')).toBeNull();
    });
  });
});
