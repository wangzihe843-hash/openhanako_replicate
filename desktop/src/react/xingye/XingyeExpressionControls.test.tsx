/** @vitest-environment jsdom */
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { XingyeExpressionControls } from './XingyeExpressionControls';
import { ExpressionPresetFields, EffectiveExpressionPresets } from './ExpressionPresetFields';

const api = vi.hoisted(() => ({ fetch: vi.fn(), connection: { serverPort: 4000 } }));
vi.mock('../hooks/use-hana-fetch', () => ({ hanaFetch: api.fetch }));
vi.mock('../stores', () => ({ useStore: (select: (state: unknown) => unknown) => select(api.connection) }));
const state = (scene: unknown = null, sessionId = 's1') => ({ agentId: 'a1', sessionId, presets: { length: 'concise' }, scene });
const response = (data: unknown) => ({ json: async () => data });
async function openPanel() {
  fireEvent.click(screen.getByText(/场景与表达/));
  await screen.findByLabelText('临时场景指令');
  await waitFor(() => expect(screen.getByLabelText('临时场景指令')).toBeEnabled());
}

beforeEach(() => { api.fetch.mockReset(); api.fetch.mockResolvedValue(response(state())); });
afterEach(cleanup);

describe('expression fields', () => {
  it('replaces a group selection and retains unrelated groups', () => {
    const onChange = vi.fn();
    render(<ExpressionPresetFields value={{ length: 'concise', perspective: 'first' }} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('篇幅'), { target: { value: 'detailed' } });
    expect(onChange).toHaveBeenCalledWith({ length: 'detailed', perspective: 'first' });
  });
  it('shows temporary sources and restores base when the override disappears', () => {
    const { rerender } = render(<EffectiveExpressionPresets presets={{ length: 'concise' }} overrides={{ length: 'detailed' }} />);
    expect(screen.getByText('篇幅：细致 · 来源：临时场景覆盖')).toBeInTheDocument();
    rerender(<EffectiveExpressionPresets presets={{ length: 'concise' }} />);
    expect(screen.getByText('篇幅：简短 · 来源：会话预设')).toBeInTheDocument();
  });
});

describe('session expression controls', () => {
  it('refreshes a collapsed scene counter after an accepted turn expires', async () => {
    api.fetch.mockResolvedValueOnce(response(state({ text: 'stay', remainingTurns: 1, presets: {} })));
    const { rerender } = render(<XingyeExpressionControls agentId="a1" sessionId="s1" busy={false} />);
    await screen.findByText('场景与表达 · 剩余 1 轮');
    rerender(<XingyeExpressionControls agentId="a1" sessionId="s1" busy />);
    rerender(<XingyeExpressionControls agentId="a1" sessionId="s1" busy={false} />);
    await waitFor(() => expect(screen.getByText('场景与表达')).toBeInTheDocument());
    expect(screen.queryByText(/剩余 1 轮/)).not.toBeInTheDocument();
  });

  it('saves single group choices without touching temporary instructions', async () => {
    render(<XingyeExpressionControls agentId="a1" sessionId="s1" busy={false} />);
    await openPanel();
    fireEvent.change(screen.getByLabelText('篇幅'), { target: { value: 'detailed' } });
    api.fetch.mockResolvedValueOnce(response({ ...state(), presets: { length: 'detailed' } }));
    fireEvent.click(screen.getByText('保存会话预设'));
    await screen.findByText('篇幅：细致 · 来源：会话预设');
    const [, options] = api.fetch.mock.calls.find(([, options]) => options?.method === 'PUT')!;
    expect(JSON.parse(options.body)).toEqual({ agentId: 'a1', sessionId: 's1', presets: { length: 'detailed' } });
  });

  it('preserves unsaved scene edits across turn completion', async () => {
    const { rerender } = render(<XingyeExpressionControls agentId="a1" sessionId="s1" busy={false} />);
    await openPanel();
    fireEvent.change(screen.getByLabelText('临时场景指令'), { target: { value: 'unsaved direction' } });
    rerender(<XingyeExpressionControls agentId="a1" sessionId="s1" busy />);
    rerender(<XingyeExpressionControls agentId="a1" sessionId="s1" busy={false} />);
    await waitFor(() => expect(screen.getByLabelText('临时场景指令')).toBeEnabled());
    expect(screen.getByLabelText('临时场景指令')).toHaveValue('unsaved direction');
  });

  it('ignores a response from the previous session after switching', async () => {
    let finish!: (value: unknown) => void;
    api.fetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const { rerender } = render(<XingyeExpressionControls agentId="a1" sessionId="s1" busy={false} />);
    api.fetch.mockResolvedValue(response(state(null, 's2')));
    rerender(<XingyeExpressionControls agentId="a1" sessionId="s2" busy={false} />);
    await openPanel();
    await act(async () => { finish(response(state({ text: 'OLD', remainingTurns: 5, presets: { length: 'detailed' } }))); });
    expect(screen.getByLabelText('临时场景指令')).toHaveValue('');
    expect(screen.queryByText(/OLD/)).not.toBeInTheDocument();
  });

  it('applies a preset-only temporary scene and restores the base when closed', async () => {
    render(<XingyeExpressionControls agentId="a1" sessionId="s1" busy={false} />);
    await openPanel();
    fireEvent.change(screen.getByLabelText('临时篇幅'), { target: { value: 'detailed' } });
    fireEvent.change(screen.getByLabelText('场景有效期'), { target: { value: '3' } });
    api.fetch.mockResolvedValueOnce(response(state({ text: '', remainingTurns: 3, presets: { length: 'detailed' } })));
    fireEvent.click(screen.getByText('应用临时场景'));
    await screen.findByText('篇幅：细致 · 来源：临时场景覆盖');
    const [, options] = api.fetch.mock.calls.find(([, options]) => options?.method === 'PUT')!;
    expect(JSON.parse(options.body).scene).toEqual({ text: '', remainingTurns: 3, presets: { length: 'detailed' } });
    api.fetch.mockResolvedValueOnce(response(state()));
    fireEvent.click(screen.getByText('关闭临时场景'));
    await screen.findByText('篇幅：简短 · 来源：会话预设');
    expect(screen.getByLabelText('临时篇幅')).toHaveValue('');
  });

  it('keeps a successful delayed save visible when collapsed during the request', async () => {
    render(<XingyeExpressionControls agentId="a1" sessionId="s1" busy={false} />);
    await openPanel();
    fireEvent.change(screen.getByLabelText('临时场景指令'), { target: { value: 'new direction' } });
    let finish!: (value: unknown) => void;
    api.fetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    fireEvent.click(screen.getByText('应用临时场景'));
    fireEvent.click(screen.getByText('场景与表达'));
    await waitFor(() => expect(screen.queryByLabelText('临时场景指令')).not.toBeInTheDocument());
    await act(async () => { finish(response(state({ text: 'new direction', remainingTurns: 1, presets: {} }))); });
    expect(await screen.findByText('场景与表达 · 剩余 1 轮')).toBeInTheDocument();
    expect(api.fetch).toHaveBeenCalledTimes(2);
    await openPanel();
    expect(screen.getByLabelText('临时场景指令')).toHaveValue('new direction');
  });

  it('refreshes consumption when a turn completes before the save response arrives', async () => {
    const { rerender } = render(<XingyeExpressionControls agentId="a1" sessionId="s1" busy={false} />);
    await openPanel();
    fireEvent.change(screen.getByLabelText('临时场景指令'), { target: { value: 'one turn' } });
    let finish!: (value: unknown) => void;
    api.fetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    fireEvent.click(screen.getByText('应用临时场景'));
    rerender(<XingyeExpressionControls agentId="a1" sessionId="s1" busy />);
    rerender(<XingyeExpressionControls agentId="a1" sessionId="s1" busy={false} />);
    await act(async () => { finish(response(state({ text: 'one turn', remainingTurns: 1, presets: {} }))); });
    await waitFor(() => expect(api.fetch).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.getByText('场景与表达')).toBeInTheDocument());
    expect(screen.queryByText(/剩余 1 轮/)).not.toBeInTheDocument();
  });

  it('shows API failures and keeps controls disabled before loading state', async () => {
    api.fetch.mockRejectedValue(new Error('unsupported'));
    render(<XingyeExpressionControls agentId="a1" sessionId="s1" busy={false} />);
    fireEvent.click(screen.getByText('场景与表达'));
    expect(await screen.findByRole('alert')).toHaveTextContent('读取失败');
    expect(screen.getByText('保存会话预设')).toBeDisabled();
  });
});
