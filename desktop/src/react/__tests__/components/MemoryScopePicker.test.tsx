// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryScopePicker } from '../../xingye/MemoryScopePicker';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), reload: vi.fn() }));
vi.mock('../../hooks/use-hana-fetch', () => ({ hanaFetch: mocks.fetch }));
vi.mock('../../stores/session-actions', () => ({ loadSessions: mocks.reload }));
const legacy = { version: 1, agentId: 'hana', realm: 'legacy', knowledge: 'shared' };
const response = (memoryScope: unknown, ok = true) => ({ ok, json: async () => ok ? { memoryScope } : { error: memoryScope } });
afterEach(cleanup);
beforeEach(() => { vi.clearAllMocks(); mocks.fetch.mockResolvedValue(response(legacy)); });

describe('MemoryScopePicker', () => {
  it('chooses private narrative scope explicitly and refreshes session actions after save', async () => {
    render(<MemoryScopePicker sessionId="s1" agentId="hana" />);
    await screen.findByRole('combobox', { name: '记忆范围类型' });
    fireEvent.change(screen.getByLabelText('记忆范围类型'), { target: { value: 'story' } });
    fireEvent.change(screen.getByLabelText('世界标识'), { target: { value: 'world-one' } });
    expect(screen.getByLabelText('新记忆可见性')).toHaveValue('character');
    fireEvent.click(screen.getByRole('button', { name: '保存范围' }));
    await waitFor(() => expect(mocks.reload).toHaveBeenCalledOnce());
    const body = JSON.parse(mocks.fetch.mock.calls[1][1].body);
    expect(body).toMatchObject({ sessionId: 's1', memoryScope: {
      realm: 'story', worldId: 'world-one', branchId: 'main', agentId: 'hana', knowledge: 'character', characterId: 'hana',
    } });
  });
  it('shows a rejected populated-session change without claiming it was saved', async () => {
    const changed = vi.fn();
    mocks.fetch.mockResolvedValueOnce(response(legacy)).mockResolvedValueOnce(response('已有对话不能直接改记忆范围', false));
    render(<MemoryScopePicker sessionId="s1" agentId="hana" onChange={changed} />);
    await screen.findByRole('button', { name: '保存范围' });
    fireEvent.click(screen.getByRole('button', { name: '保存范围' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('已有对话不能直接改记忆范围');
    expect(changed).not.toHaveBeenCalled();
    expect(mocks.reload).not.toHaveBeenCalled();
  });
  it('ignores a delayed scope response after switching sessions', async () => {
    let resolveOld!: (value: ReturnType<typeof response>) => void;
    mocks.fetch.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
      .mockResolvedValueOnce(response({ ...legacy, realm: 'reality' }));
    const view = render(<MemoryScopePicker sessionId="old" agentId="hana" />);
    view.rerender(<MemoryScopePicker sessionId="new" agentId="hana" />);
    await waitFor(() => expect(screen.getByLabelText('记忆范围类型')).toHaveValue('reality'));
    await act(async () => resolveOld(response(legacy)));
    expect(screen.getByLabelText('记忆范围类型')).toHaveValue('reality');
  });
});
