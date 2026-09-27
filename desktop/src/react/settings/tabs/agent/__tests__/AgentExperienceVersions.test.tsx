/** @vitest-environment jsdom */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentExperienceVersions } from '../AgentExperienceVersions';
import zh from '../../../../../locales/zh.json';

const fetchMock = vi.fn();
vi.mock('../../../api', () => ({ hanaFetch: (...args: unknown[]) => fetchMock(...args) }));
const response = (body: unknown) => ({ ok: true, json: async () => body });
function version(id: string) {
  return { id, groupId: id, version: 1, category: 'review', content: `${id} 的经验`,
    scope: { kind: 'workspace', path: `C:\\work\\${id}` },
    source: { reference: `${id} task`, result: 'partial' },
    verification: { method: '检查产物', evidence: null as string | null },
    status: 'proposed' as 'proposed' | 'verified' | 'active', replacesId: null };
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

describe('reviewable experience versions UI', () => {
  it('requires actual verification evidence before activation', async () => {
    const row = version('a');
    fetchMock.mockImplementation((_url: string, options?: { body?: string }) => {
      if (options?.body) {
        const body = JSON.parse(options.body);
        if (body.action === 'verify') { row.status = 'verified'; row.verification.evidence = body.evidence; }
        if (body.action === 'activate') row.status = 'active';
        return Promise.resolve(response({ version: row }));
      }
      return Promise.resolve(response({ versions: [row] }));
    });
    render(<AgentExperienceVersions agentId="a" enabled />);
    await screen.findByText('a 的经验');
    expect((screen.getByRole('button', { name: '确认验证' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('a 验证证据'), { target: { value: '已打开产物并逐项核对' } });
    fireEvent.click(screen.getByRole('button', { name: '确认验证' }));
    await waitFor(() => expect(screen.getByText('验证证据：已打开产物并逐项核对')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '在此工作区生效' }));
    await waitFor(() => expect(screen.getByText(/生效中/)).toBeTruthy());
    expect(fetchMock.mock.calls.filter(call => call[1]?.method === 'PATCH')).toHaveLength(2);
  });

  it('discards a late response when switching agents', async () => {
    let finishOld!: (value: ReturnType<typeof response>) => void;
    const old = new Promise<ReturnType<typeof response>>(resolve => { finishOld = resolve; });
    fetchMock.mockImplementation((url: string) => url.includes('/a/experience-versions')
      ? old : Promise.resolve(response({ versions: [version('b')] })));
    const view = render(<AgentExperienceVersions agentId="a" enabled />);
    view.rerender(<AgentExperienceVersions agentId="b" enabled />);
    await screen.findByText('b 的经验');
    await act(async () => { finishOld(response({ versions: [version('a')] })); });
    expect(screen.queryByText('a 的经验')).toBeNull();
    expect(screen.getByText('b 的经验')).toBeTruthy();
  });

  it('does not leak a late verification error into another agent', async () => {
    let finishOld!: (value: { ok: boolean; json: () => Promise<unknown> }) => void;
    const oldPatch = new Promise<{ ok: boolean; json: () => Promise<unknown> }>(resolve => { finishOld = resolve; });
    fetchMock.mockImplementation((url: string, options?: { method?: string }) => {
      if (url.includes('/a/experience-versions/') && options?.method === 'PATCH') return oldPatch;
      return Promise.resolve(response({ versions: [version(url.includes('/a/') ? 'a' : 'b')] }));
    });
    const view = render(<AgentExperienceVersions agentId="a" enabled />);
    await screen.findByText('a 的经验');
    fireEvent.change(screen.getByLabelText('a 验证证据'), { target: { value: 'A 的核对证据' } });
    fireEvent.click(screen.getByRole('button', { name: '确认验证' }));
    view.rerender(<AgentExperienceVersions agentId="b" enabled />);
    await screen.findByText('b 的经验');
    await act(async () => { finishOld({ ok: false, json: async () => ({ error: 'A 的旧错误' }) }); });
    expect(screen.queryByText('A 的旧错误')).toBeNull();
    expect((screen.getByLabelText('b 验证证据') as HTMLInputElement).value).toBe('');
    expect((screen.getByRole('button', { name: '撤销' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
