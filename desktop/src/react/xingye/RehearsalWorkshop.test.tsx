/** @vitest-environment jsdom */
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RehearsalWorkshop } from './RehearsalWorkshop';
import { emptyStudioSession, loadStudioSession, saveStudioSession } from './lore-studio-session';
import { postRehearsalTurn } from './rehearsal-workshop-api';
import { saveXingyeRoleProfile } from './xingye-profile-store';
import { emptyRehearsalDraft } from './rehearsal-workshop-state';
const state = vi.hoisted(() => ({ key: 'server-a', subscribers: new Set<() => void>() }));
vi.mock('../stores', () => ({ useStore: { getState: () => ({}), subscribe: (fn: () => void) => { state.subscribers.add(fn); return () => state.subscribers.delete(fn); } } }));
vi.mock('../services/server-connection', () => ({ requireServerConnection: () => ({ url: state.key }) }));
vi.mock('./xingye-profile-store', () => ({ saveXingyeRoleProfile: vi.fn(), xingyeProfileConnectionKey: () => state.key }));
vi.mock('./xingye-lore-store', () => ({ listLoreEntries: () => [], createLoreEntry: vi.fn(), updateLoreEntry: vi.fn() }));
vi.mock('./rehearsal-workshop-api', () => ({ postRehearsalTurn: vi.fn() }));
vi.mock('./lore-studio-session', () => ({
  emptyStudioSession: (agentId: string) => ({ version: 1, agentId, messages: [], backgroundStory: '', phase: 'intro', draftPlan: null, updatedAt: '' }),
  loadStudioSession: vi.fn(), saveStudioSession: vi.fn(),
}));
const result = { text: '我陪你散步，但朋友的秘密不能说。', rationale: '重视陪伴，同时守诺。', profilePatch: [{ field: 'values' as const, value: '守诺，承担被误解的代价。', rationale: '来自反馈' }] };
beforeEach(() => {
  vi.clearAllMocks(); state.key = 'server-a'; state.subscribers.clear();
  vi.mocked(loadStudioSession).mockResolvedValue(null);
  vi.mocked(saveStudioSession).mockResolvedValue(undefined);
  vi.mocked(postRehearsalTurn).mockResolvedValue(result);
  vi.mocked(saveXingyeRoleProfile).mockResolvedValue({ agentId: 'a', updatedAt: '' });
});
afterEach(cleanup);
async function setup() {
  const onAdopted = vi.fn(); const onClose = vi.fn();
  const rendered = render(<RehearsalWorkshop agentId="a" profile={{ displayName: '林雾', values: '守诺', firstMessage: '原开场', messageExample: '原示例' }} onAdopted={onAdopted} onClose={onClose} />);
  await waitFor(() => expect(screen.getByRole('button', { name: '开始试写' })).toBeEnabled());
  return { ...rendered, onAdopted, onClose };
}
async function generate() { fireEvent.click(screen.getByRole('button', { name: /开始试写|根据反馈再试/ })); await screen.findByDisplayValue(result.text); }
describe('rehearsal workshop author workflow', () => {
  it('edits three scenes, compares versions, and sends feedback without formal writes', async () => {
    await setup();
    for (const [index, label] of ['日常', '冲突', '边界'].entries()) {
      fireEvent.click(screen.getByRole('button', { name: label }));
      fireEvent.change(screen.getByLabelText('试演输入'), { target: { value: `${label}自定义输入` } });
      fireEvent.change(screen.getByLabelText('试演反馈'), { target: { value: `${label}保持动机` } });
      await generate();
      expect(postRehearsalTurn).toHaveBeenLastCalledWith(expect.objectContaining({ input: `${label}自定义输入`, feedback: `${label}保持动机`, previousText: index ? result.text : '' }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
      await waitFor(() => expect(screen.getByLabelText('选择试演草稿').querySelectorAll('option')).toHaveLength(index + 1));
    }
    expect(saveXingyeRoleProfile).not.toHaveBeenCalled();
    expect(screen.getAllByText(/对照稿/)).toHaveLength(2);
    expect(saveStudioSession).toHaveBeenLastCalledWith(expect.objectContaining({ rehearsal: expect.objectContaining({ variants: expect.any(Array) }) }), { strict: true, expectedConnectionKey: 'server-a' });
  });
  it('only explicitly adopted edited fields or texts reach the formal profile', async () => {
    const { onAdopted } = await setup(); await generate();
    expect(saveXingyeRoleProfile).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('价值观补丁'), { target: { value: '作者修订的价值观' } });
    fireEvent.click(screen.getByRole('checkbox', { name: '采纳价值观' }));
    fireEvent.click(screen.getByRole('button', { name: '采纳勾选的人设补丁' }));
    await waitFor(() => expect(onAdopted).toHaveBeenCalledWith({ values: '作者修订的价值观' }));
    expect(saveXingyeRoleProfile).toHaveBeenLastCalledWith('a', { values: '作者修订的价值观' });
    fireEvent.change(screen.getByLabelText('试演正文'), { target: { value: '作者编辑的开场' } });
    fireEvent.click(screen.getByRole('button', { name: '采纳为新聊天默认开场' }));
    await screen.findByText('已采纳为未来新聊天的默认开场，已有聊天保持原样。');
    expect(saveXingyeRoleProfile).toHaveBeenLastCalledWith('a', { firstMessage: '作者编辑的开场' });
    fireEvent.click(screen.getByRole('button', { name: '采纳为角色示例对白' }));
    await waitFor(() => expect(saveXingyeRoleProfile).toHaveBeenLastCalledWith('a', { messageExample: expect.stringContaining('{{char}}: 作者编辑的开场') }));
  });
  it('reports adoption failure without a success callback', async () => {
    const { onAdopted } = await setup(); await generate();
    vi.mocked(saveXingyeRoleProfile).mockRejectedValue(new Error('disk full'));
    fireEvent.click(screen.getByRole('button', { name: '采纳为新聊天默认开场' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('采纳失败');
    expect(onAdopted).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
  it('aborts on cancel and discards an already pending late result', async () => {
    let finish!: (value: typeof result) => void;
    vi.mocked(postRehearsalTurn).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await setup(); fireEvent.click(screen.getByRole('button', { name: '开始试写' }));
    fireEvent.click(screen.getByRole('button', { name: '取消生成' }));
    expect(vi.mocked(postRehearsalTurn).mock.calls[0][1].signal.aborted).toBe(true);
    await act(async () => finish(result));
    expect(screen.queryByLabelText('试演正文')).not.toBeInTheDocument();
    expect(saveXingyeRoleProfile).not.toHaveBeenCalled();
  });
  it('aborts and suppresses results after switching connection or closing', async () => {
    let finish!: (value: typeof result) => void;
    vi.mocked(postRehearsalTurn).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { unmount } = await setup(); fireEvent.click(screen.getByRole('button', { name: '开始试写' }));
    act(() => { state.key = 'server-b'; state.subscribers.forEach(fn => fn()); });
    expect(vi.mocked(postRehearsalTurn).mock.calls[0][1].signal.aborted).toBe(true);
    unmount(); await act(async () => finish(result));
    expect(saveXingyeRoleProfile).not.toHaveBeenCalled();
    expect(vi.mocked(saveStudioSession).mock.calls.every(([, options]) => options?.expectedConnectionKey === 'server-a')).toBe(true);
  });
  it('restores per-role draft without replaying generation or adopting it', async () => {
    vi.mocked(loadStudioSession).mockResolvedValue({ ...emptyStudioSession('a'), rehearsal: { ...emptyRehearsalDraft(), variants: [{ ...result, id: 'v1', scene: 'daily', mode: 'scene', input: '旧情境', feedback: '' }], selectedId: 'v1' } });
    render(<RehearsalWorkshop agentId="a" profile={{}} onAdopted={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByLabelText('试演正文')).toHaveValue(result.text);
    expect(postRehearsalTurn).not.toHaveBeenCalled(); expect(saveXingyeRoleProfile).not.toHaveBeenCalled();
  });
  it('does not overwrite unreadable drafts and makes failed saves visible', async () => {
    vi.mocked(loadStudioSession).mockRejectedValue(new Error('invalid JSON'));
    const first = render(<RehearsalWorkshop agentId="a" profile={{}} onAdopted={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('无法读取草稿');
    expect(saveStudioSession).not.toHaveBeenCalled(); first.unmount();
    vi.mocked(loadStudioSession).mockResolvedValue(null); vi.mocked(saveStudioSession).mockRejectedValue(new Error('disk full'));
    await setup(); expect(await screen.findByRole('alert')).toHaveTextContent('草稿尚未保存');
  });
});