/** @vitest-environment jsdom */
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../types';
import type { XingyeLoreEntry } from './xingye-lore-store';
import type { XingyeHiddenFileEntry } from './xingye-files-secret-store';

// Keep the UI handler, lore store/selector, secret AI, prompt and dedupe real.
// Only persistence APIs and the final model transport use synthetic substitutes.
const mocks = vi.hoisted(() => ({
  hanaFetch: vi.fn(),
  listFileFolders: vi.fn(),
  listFileEntries: vi.fn(async () => []),
  listFileDrafts: vi.fn(async () => []),
  readHiddenFolderState: vi.fn(),
  listHiddenEntries: vi.fn(),
  appendHiddenEntry: vi.fn(),
  markHiddenFolderSeedGenerated: vi.fn(),
  getConfirmedVirtualContacts: vi.fn(),
  storage: new Map<string, string>(),
}));
vi.mock('../hooks/use-hana-fetch', () => ({ hanaFetch: mocks.hanaFetch }));
vi.mock('./xingye-files-store', async (importOriginal) => ({
  ...await importOriginal<typeof import('./xingye-files-store')>(),
  listFileFolders: mocks.listFileFolders,
  listFileEntries: mocks.listFileEntries,
  listFileDrafts: mocks.listFileDrafts,
}));
vi.mock('./xingye-files-secret-store', async (importOriginal) => ({
  ...await importOriginal<typeof import('./xingye-files-secret-store')>(),
  readHiddenFolderState: mocks.readHiddenFolderState,
  listHiddenEntries: mocks.listHiddenEntries,
  appendHiddenEntry: mocks.appendHiddenEntry,
  markHiddenFolderSeedGenerated: mocks.markHiddenFolderSeedGenerated,
}));
vi.mock('./xingye-phone-store', () => ({
  getConfirmedVirtualContacts: mocks.getConfirmedVirtualContacts,
}));
vi.mock('./xingye-persistence', () => ({
  getXingyePersistenceStorage: () => ({
    getItem: (key: string) => mocks.storage.get(key) ?? null,
    setItem: (key: string, value: string) => { mocks.storage.set(key, value); },
  }),
}));
vi.mock('../stores', () => {
  const state = { userName: '测试用户', stagedChatQuote: null, stageChatQuote: () => undefined };
  return { useStore: Object.assign(
    (selector: (value: typeof state) => unknown) => selector(state),
    { getState: () => state, subscribe: () => () => undefined },
  ) };
});

import { PhoneFilesApp } from './PhoneFilesApp';
import { XINGYE_LORE_ENTRIES_STORAGE_KEY } from './xingye-lore-store';
import { generateHiddenSeedsWithAI } from './xingye-files-secret-ai';

const agent: Agent = { id: 'owner-a', name: '测试角色', yuan: 'hanako', isPrimary: false, hasAvatar: false };
const now = '2026-10-31T00:00:00.000Z';
const hiddenState = { agentId: agent.id, locked: false, passwordHash: 'synthetic', seedGenerated: false, updatedAt: now };

function lore(id: string, partial: Partial<XingyeLoreEntry> = {}): XingyeLoreEntry {
  return {
    id, agentId: agent.id, title: `TITLE_${id}`, content: `BODY_${id}`,
    category: 'character', keywords: [], enabled: true, priority: 100,
    insertionMode: 'always', visibility: 'canonical', createdAt: now, updatedAt: now,
    ...partial,
  };
}

function setLore(entries: XingyeLoreEntry[]) {
  mocks.storage.set(XINGYE_LORE_ENTRIES_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries.map((entry) => [entry.id, entry]))));
}

async function generateFromDrawer(): Promise<string> {
  render(<PhoneFilesApp ownerAgent={agent} displayName={agent.name} onBack={vi.fn()} />);
  fireEvent.click(await screen.findByTestId('phone-files-hidden-folder-row'));
  await screen.findByTestId('phone-files-hidden-view');
  fireEvent.click(screen.getByTestId('phone-files-hidden-seed-button'));
  await waitFor(() => expect(mocks.markHiddenFolderSeedGenerated).toHaveBeenCalledTimes(1));
  expect(mocks.hanaFetch).toHaveBeenCalledTimes(1);
  const [url, options] = mocks.hanaFetch.mock.calls[0];
  expect(url).toBe('/api/xingye/phone-generate');
  const payload = JSON.parse(options.body as string);
  expect(payload).toMatchObject({ kind: 'files_secret_seed', ownerAgentId: agent.id, agentId: agent.id });
  expect(mocks.getConfirmedVirtualContacts).toHaveBeenCalledWith(agent.id, expect.anything());
  return payload.prompt as string;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.storage.clear();
  mocks.listFileFolders.mockResolvedValue([{
    id: 'folder', agentId: agent.id, name: '世界观整理', description: '合成资料夹',
    order: 0, createdAt: now, updatedAt: now,
  }]);
  mocks.readHiddenFolderState.mockResolvedValue(hiddenState);
  mocks.listHiddenEntries.mockResolvedValue([]);
  mocks.markHiddenFolderSeedGenerated.mockResolvedValue({ ...hiddenState, seedGenerated: true });
  mocks.getConfirmedVirtualContacts.mockReturnValue([{ id: 'confirmed', displayName: 'CONFIRMED_CONTACT', status: 'active' }]);
  mocks.hanaFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ ok: true, result: { entries: [{ kind: 'secret_plan', title: '夜航计划', body: '准备在月末独自出发。' }] } }),
  });
  mocks.appendHiddenEntry.mockImplementation(async (agentId: string, draft: Partial<XingyeHiddenFileEntry>) => ({
    id: 'new', key: 'new', agentId, createdAt: now, ...draft,
  }));
});
afterEach(cleanup);

describe('hidden drawer lore reaches the real phone-generate prompt', () => {
  it('uses the same owner’s allowed lore body, absent from profile and title', async () => {
    const constraint = '此角色只能在蓝盐潮汐期间离开港口_CANARY_HF01';
    setLore([lore('allowed', { category: 'rule', content: constraint }), lore('npc')]);
    const prompt = await generateFromDrawer();
    expect(prompt).toContain(constraint);
    expect(prompt).toContain('TITLE_npc');
    expect(prompt).toContain('CONFIRMED_CONTACT');
    expect(mocks.appendHiddenEntry).toHaveBeenCalledWith(agent.id, expect.objectContaining({ title: '夜航计划', source: 'ai_seed' }), undefined);
  });

  it('excludes forbidden lore titles and bodies from every final prompt block', async () => {
    const forbidden = [
      lore('other_owner', { agentId: 'owner-b' }),
      lore('story', { memoryScope: { version: 1, agentId: agent.id, realm: 'story', worldId: 'world-a', branchId: 'branch-a', knowledge: 'shared' } }),
      lore('reality', { memoryScope: { version: 1, agentId: agent.id, realm: 'reality', knowledge: 'shared' } }),
      lore('author', { memoryScope: { version: 1, agentId: agent.id, realm: 'legacy', knowledge: 'author' } }),
      lore('invalid_scope', { memoryScope: { realm: 'invalid' } }),
      lore('stale', { sourceStatus: 'stale' }),
      lore('derived', { origin: 'derived' }),
      lore('private', { visibility: 'private' }),
      lore('draft', { visibility: 'draft' }),
      lore('manual', { insertionMode: 'manual' }),
      lore('keyword', { insertionMode: 'keyword', keywords: ['测试角色'] }),
      lore('disabled', { enabled: false }),
    ];
    setLore([lore('allowed'), ...forbidden]);
    const prompt = await generateFromDrawer();
    for (const entry of forbidden) {
      expect(prompt, entry.id).not.toContain(entry.title);
      expect(prompt, entry.id).not.toContain(entry.content);
    }
    expect(prompt).toContain('BODY_allowed');
  });

  it('bounds lore text at the actual drawer handler', async () => {
    setLore([
      lore('short', { category: 'rule', content: '必须遵守短规则_CANARY_HF01' }),
      lore('long', { priority: 50, content: `${'长正文'.repeat(2000)}END_OF_UNBOUNDED_CANARY` }),
    ]);
    const prompt = await generateFromDrawer();
    const stableBlock = prompt.split('── 稳定 lore ──\n')[1].split('\n\n── 周围')[0];
    expect(stableBlock).toContain('必须遵守短规则_CANARY_HF01');
    expect(stableBlock.length).toBeLessThanOrEqual(2010); // 2000 body + existing renderer heading
    expect(prompt).not.toContain('END_OF_UNBOUNDED_CANARY');
  });

  it('retains the existing-entry anchor and duplicate filtering contract', async () => {
    const existing: XingyeHiddenFileEntry[] = [{
      id: 'existing', key: 'existing', agentId: agent.id, kind: 'weakness', title: '旧弱点锚点_CANARY',
      body: '旧正文', source: 'manual', createdAt: now,
    }];
    mocks.hanaFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { entries: [
        { kind: 'weakness', title: '旧弱点锚点_CANARY', body: '重复项应被过滤' },
        { kind: 'secret_plan', title: '夜航计划', body: '准备在月末独自出发。' },
      ] } }),
    });
    const drafts = await generateHiddenSeedsWithAI({ agent, profile: null, existingEntries: existing });
    const prompt = JSON.parse(mocks.hanaFetch.mock.calls[0][1].body as string).prompt as string;
    expect(prompt).toContain('旧弱点锚点_CANARY');
    expect(drafts).toEqual([{ kind: 'secret_plan', title: '夜航计划', body: '准备在月末独自出发。' }]);
  });
});
