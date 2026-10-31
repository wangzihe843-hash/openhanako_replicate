/** @vitest-environment jsdom */
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { Hono } from 'hono';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callText } from '../core/llm-client';
import { createXingyeRoute } from '../server/routes/xingye.js';
import { hanaFetch } from '../desktop/src/react/hooks/use-hana-fetch';
import { RehearsalWorkshop } from '../desktop/src/react/xingye/RehearsalWorkshop';
import { emptyStudioSession, loadStudioSession, saveStudioSession } from '../desktop/src/react/xingye/lore-studio-session';
import { emptyRehearsalDraft } from '../desktop/src/react/xingye/rehearsal-workshop-state';
import type { StudioPlanLoreEntry, StudioSession } from '../desktop/src/react/xingye/lore-studio-types';
import { saveXingyeRoleProfile } from '../desktop/src/react/xingye/xingye-profile-store';
import { XINGYE_LORE_ENTRIES_STORAGE_KEY, type XingyeLoreCategory, type XingyeLoreEntry } from '../desktop/src/react/xingye/xingye-lore-store';

const state = vi.hoisted(() => ({ connection: { url: 'https://synthetic.invalid', token: 'synthetic' } }));
vi.mock('../core/llm-client', () => ({ callText: vi.fn() }));
vi.mock('../desktop/src/react/hooks/use-hana-fetch', () => ({ hanaFetch: vi.fn() }));
vi.mock('../desktop/src/react/stores', () => ({ useStore: { getState: () => ({}), subscribe: () => () => {} } }));
vi.mock('../desktop/src/react/services/server-connection', () => ({
  requireServerConnection: () => state.connection,
  hasServerConnection: () => true,
}));
vi.mock('../desktop/src/react/xingye/xingye-profile-store', () => ({
  saveXingyeRoleProfile: vi.fn(), xingyeProfileConnectionKey: () => 'synthetic-server-a',
}));
vi.mock('../desktop/src/react/xingye/lore-studio-session', () => ({
  emptyStudioSession: (agentId: string) => ({ version: 1, agentId, messages: [], backgroundStory: '', phase: 'intro', draftPlan: null, updatedAt: '' }),
  loadStudioSession: vi.fn(), saveStudioSession: vi.fn(),
}));

const output = { text: '合成试写正文', rationale: '合成行为理由', profilePatch: [{ field: 'values', value: '合成建议', rationale: '合成建议理由' }] };
const engine = {
  resolveUtilityConfig: () => ({ utility: 'synthetic-model', api: 'openai-completions', base_url: 'https://synthetic.invalid', api_key: 'synthetic-fixture' }),
  getAgent: vi.fn(), prompt: vi.fn(), createSession: vi.fn(),
};
const app = new Hono().route('/api', createXingyeRoute(engine));

function stored(id: string, category: XingyeLoreCategory, extra: Partial<XingyeLoreEntry> = {}): XingyeLoreEntry {
  return { id, agentId: 'a', title: `title-${id}`, content: `LORE_ONLY_${id}`, category, keywords: [], enabled: true,
    priority: 100, insertionMode: 'manual', visibility: 'canonical', createdAt: '', updatedAt: '', ...extra };
}
function seed(entries: XingyeLoreEntry[]) {
  window.localStorage.setItem(XINGYE_LORE_ENTRIES_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries.map(entry => [entry.id, entry]))));
}
function draft(category: XingyeLoreCategory, content = 'DRAFT_LORE_ONLY'): StudioPlanLoreEntry {
  return { title: '待确认关系', category, content, insertionMode: 'always', keywords: [] };
}
function session(entries: StudioPlanLoreEntry[]): StudioSession {
  return { ...emptyStudioSession('a'), draftPlan: { type: 'plan', summary: '作者草稿', loreEntries: entries,
    profilePatch: [{ field: 'values', value: 'PENDING_PROFILE_ONLY' }] } };
}
async function setup(mode: 'scene' | 'greeting' = 'scene') {
  render(<RehearsalWorkshop agentId="a" profile={{ values: 'ORIGINAL_PROFILE_ONLY', firstMessage: 'OLD_GREETING_ONLY' }} onAdopted={vi.fn()} onClose={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole('button', { name: /开始试写|根据反馈再试/ })).toBeEnabled());
  fireEvent.change(screen.getByLabelText('创作类型'), { target: { value: mode } });
  fireEvent.change(screen.getByLabelText('试演输入'), { target: { value: 'SCENE_INPUT_ONLY' } });
  fireEvent.change(screen.getByLabelText('试演反馈'), { target: { value: 'FEEDBACK_ONLY' } });
  fireEvent.click(screen.getByRole('button', { name: /开始试写|根据反馈再试/ }));
}
function requestBody() {
  return JSON.parse(String(vi.mocked(hanaFetch).mock.calls[0][1]?.body));
}
function finalLore() {
  const prompt = String(vi.mocked(callText).mock.calls[0][0].messages[0].content);
  return JSON.parse(prompt.split('[作者选用的设定素材；未确认内容仍是草稿]\n')[1].split('\n[当前情境]')[0]);
}
beforeEach(() => {
  vi.clearAllMocks(); window.localStorage.clear();
  (window as unknown as { __XINGYE_PERSISTENCE_DEV_LOCAL__?: boolean }).__XINGYE_PERSISTENCE_DEV_LOCAL__ = true;
  vi.mocked(loadStudioSession).mockResolvedValue(null);
  vi.mocked(saveStudioSession).mockResolvedValue(undefined);
  vi.mocked(callText).mockResolvedValue(JSON.stringify(output));
  vi.mocked(hanaFetch).mockImplementation(async (path, init) => {
    expect(path).toBe('/api/xingye/lore-studio/rehearsal');
    expect(init?.connection).toBe(state.connection);
    // Hono's request dispatcher does not create an HTTP server or open a socket.
    return app.request(String(path), { method: init?.method, headers: init?.headers, body: init?.body, signal: init?.signal });
  });
});
afterEach(() => {
  cleanup();
  delete (window as unknown as { __XINGYE_PERSISTENCE_DEV_LOCAL__?: boolean }).__XINGYE_PERSISTENCE_DEV_LOCAL__;
});

describe('rehearsal DOM → serialized API → real route → final model prompt', () => {
  it.each(['scene', 'greeting'] as const)('preserves stored and pending lore categories in %s', async mode => {
    seed([stored('WORLDVIEW_SENTINEL', 'worldview'), stored('STORED_DRAFT_SENTINEL', 'event', { visibility: 'draft' })]);
    vi.mocked(loadStudioSession).mockResolvedValue(session([draft('relationship')]));
    await setup(mode);
    expect(await screen.findByLabelText('试演正文')).toHaveValue(output.text);
    expect(finalLore()).toEqual([
      expect.objectContaining({ category: 'worldview', content: 'LORE_ONLY_WORLDVIEW_SENTINEL' }),
      expect.objectContaining({ category: 'event', content: 'LORE_ONLY_STORED_DRAFT_SENTINEL' }),
      expect.objectContaining({ category: 'relationship', content: 'DRAFT_LORE_ONLY' }),
    ]);
    expect(requestBody().loreEntries.map((entry: { category: string }) => entry.category)).toEqual(['worldview', 'event', 'relationship']);
    expect(requestBody().mode).toBe(mode);
    const modelRequest = vi.mocked(callText).mock.calls[0][0];
    expect(modelRequest).not.toHaveProperty('tools');
    expect(modelRequest.messages[0].content).toContain(mode === 'greeting' ? '产出供未来新聊天选择的开场白' : '产出短场景中角色的一次回应');
    for (const text of ['PENDING_PROFILE_ONLY', 'SCENE_INPUT_ONLY', 'FEEDBACK_ONLY']) expect(modelRequest.messages[0].content).toContain(text);
    expect(modelRequest.messages[0].content).not.toContain('ORIGINAL_PROFILE_ONLY');
    expect(requestBody().previousText).toBe(mode === 'greeting' ? 'OLD_GREETING_ONLY' : '');
    expect(engine.prompt).not.toHaveBeenCalled(); expect(engine.createSession).not.toHaveBeenCalled();
    expect(saveXingyeRoleProfile).not.toHaveBeenCalled();
    await waitFor(() => expect(saveStudioSession).toHaveBeenLastCalledWith(expect.objectContaining({
      rehearsal: expect.objectContaining({ variants: [expect.objectContaining({ text: output.text, rationale: output.rationale, profilePatch: output.profilePatch })] }),
    }), { strict: true, expectedConnectionKey: 'synthetic-server-a' }));
  });

  it('supports every legal category without changing stored order or the twelve-entry cap', async () => {
    const categories: XingyeLoreCategory[] = ['background', 'worldview', 'relationship', 'event', 'location', 'organization', 'character', 'rule'];
    seed(categories.map((category, index) => stored(`legal-${index}`, category, { priority: 100 - index })));
    vi.mocked(loadStudioSession).mockResolvedValue(session(Array.from({ length: 6 }, (_, index) => draft('rule', `DRAFT_${index}`))));
    await setup(); await screen.findByLabelText('试演正文');
    expect(finalLore().map((entry: { category: string }) => entry.category)).toEqual([...categories, 'rule', 'rule', 'rule', 'rule']);
    expect(requestBody().loreEntries).toHaveLength(12);
    expect(finalLore().map((entry: { content: string }) => entry.content)).not.toContain('DRAFT_4');
  });

  it('excludes private, disabled and other-owner entries, and the route still rejects an illegal draft category', async () => {
    seed([stored('private', 'rule', { visibility: 'private' }), stored('disabled', 'rule', { enabled: false }), stored('other-owner', 'rule', { agentId: 'b' })]);
    vi.mocked(loadStudioSession).mockResolvedValue(session([draft('illegal' as XingyeLoreCategory, 'ILLEGAL_CATEGORY_ONLY')]));
    await setup(); await screen.findByLabelText('试演正文');
    expect(requestBody().loreEntries).toEqual([{ title: '待确认关系', category: 'illegal', content: 'ILLEGAL_CATEGORY_ONLY' }]);
    expect(finalLore()).toEqual([]);
  });

  it('keeps stale, unconfirmed-derived and unreadable scopes out before the twelve-entry cap', async () => {
    seed([
      ...Array.from({ length: 14 }, (_, index) => stored(`stale-crowd-${index}`, 'rule', { sourceStatus: 'stale' })),
      stored('stale', 'worldview', { sourceStatus: 'stale' }),
      stored('derived-unconfirmed', 'worldview', { origin: 'derived' }),
      stored('wrong-scope-owner', 'worldview', { memoryScope: { version: 1, agentId: 'b', realm: 'legacy', knowledge: 'shared' } }),
      stored('other-world', 'worldview', { memoryScope: { version: 1, agentId: 'a', realm: 'story', worldId: 'w', branchId: 'b', knowledge: 'shared' } }),
      stored('corrupt-scope', 'worldview', { memoryScope: {} }),
      stored('author-only', 'worldview', { memoryScope: { version: 1, agentId: 'a', realm: 'legacy', knowledge: 'author' } }),
      stored('active-derived', 'worldview', { origin: 'derived', sourceStatus: 'active' }),
      stored('legacy-derived', 'worldview', { origin: 'derived', memoryScope: { version: 1, agentId: 'a', realm: 'legacy', knowledge: 'shared' } }),
    ]);
    await setup(); await screen.findByLabelText('试演正文');
    expect(requestBody().loreEntries.map((entry: { content: string }) => entry.content)).toEqual(['LORE_ONLY_active-derived', 'LORE_ONLY_legacy-derived']);
    expect(finalLore().map((entry: { content: string }) => entry.content)).toEqual(['LORE_ONLY_active-derived', 'LORE_ONLY_legacy-derived']);
  });

  it('generates and keeps drafts when no legal lore exists', async () => {
    await setup(); expect(await screen.findByLabelText('试演正文')).toHaveValue(output.text);
    expect(requestBody().loreEntries).toEqual([]); expect(finalLore()).toEqual([]);
    expect(saveXingyeRoleProfile).not.toHaveBeenCalled();
  });

  it('propagates cancellation through the actual API and ignores the late route response', async () => {
    let finish!: (text: string) => void;
    vi.mocked(callText).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await setup(); await waitFor(() => expect(callText).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: '取消生成' }));
    expect(vi.mocked(hanaFetch).mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(vi.mocked(callText).mock.calls[0][0].signal?.aborted).toBe(true);
    await act(async () => { finish(JSON.stringify(output)); });
    expect(screen.queryByLabelText('试演正文')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('本次生成已取消');
    expect(saveXingyeRoleProfile).not.toHaveBeenCalled();
  });

  it('keeps an existing draft on invalid model output without adopting or adding a successful draft', async () => {
    vi.mocked(loadStudioSession).mockResolvedValue({ ...emptyStudioSession('a'), rehearsal: {
      ...emptyRehearsalDraft(), selectedId: 'existing', variants: [{ id: 'existing', scene: 'daily', mode: 'scene',
        input: 'OLD_INPUT_ONLY', feedback: '', text: 'EXISTING_DRAFT_ONLY', rationale: '原理由', profilePatch: [] }],
    } });
    vi.mocked(callText).mockResolvedValue('not JSON');
    await setup();
    expect(await screen.findByRole('alert')).toHaveTextContent('试演生成失败');
    expect(screen.getByLabelText('试演正文')).toHaveValue('EXISTING_DRAFT_ONLY');
    expect(screen.getByLabelText('选择试演草稿').querySelectorAll('option')).toHaveLength(1);
    expect(saveXingyeRoleProfile).not.toHaveBeenCalled();
  });
});
