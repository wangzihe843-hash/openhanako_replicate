import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  XINGYE_LORE_ENTRIES_STORAGE_KEY,
  createLoreEntry,
  deleteLoreEntry,
  listLoreEntries,
  toggleLoreEntry,
  updateLoreEntry,
} from './xingye-lore-store';

class MemoryStorage implements Storage {
  private values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

describe('xingye-lore-store', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  it('creates and lists canonical lore entries per agent', () => {
    const entry = createLoreEntry('agent-1', {
      title: '失落王国',
      content: '完整世界观背景保存在星野设定库，不直接进入 OpenHanako identity/ishiki。',
      category: 'worldview',
      keywords: ['王国', '世界观'],
      priority: 80,
      insertionMode: 'keyword',
      visibility: 'canonical',
    }, storage);

    expect(entry).toMatchObject({
      agentId: 'agent-1',
      title: '失落王国',
      category: 'worldview',
      keywords: ['王国', '世界观'],
      enabled: true,
      priority: 80,
      insertionMode: 'keyword',
      visibility: 'canonical',
    });
    expect(entry.id).toEqual(expect.any(String));
    expect(entry.createdAt).toEqual(expect.any(String));
    expect(entry.updatedAt).toEqual(expect.any(String));
    expect(listLoreEntries('agent-1', storage)).toEqual([entry]);
    expect(listLoreEntries('agent-2', storage)).toEqual([]);
    expect(storage.getItem(XINGYE_LORE_ENTRIES_STORAGE_KEY)).toContain('失落王国');
  });

  it('defaults insertionMode by category when not explicitly provided', () => {
    const bg = createLoreEntry('agent-1', { title: '背景', content: '角色背景。', category: 'background' }, storage);
    const rel = createLoreEntry('agent-1', { title: '关系', content: '用户身份与关系。', category: 'relationship' }, storage);
    const world = createLoreEntry('agent-1', { title: '世界观', content: '世界观设定。', category: 'worldview' }, storage);
    const evt = createLoreEntry('agent-1', { title: '事件', content: '某事件。', category: 'event' }, storage);
    // 不传 category → 默认 background → always
    const fallback = createLoreEntry('agent-1', { title: '无分类', content: '默认走背景分类。' }, storage);

    expect(bg.insertionMode).toBe('always');
    expect(rel.insertionMode).toBe('always');
    expect(world.insertionMode).toBe('keyword');
    expect(evt.insertionMode).toBe('manual');
    expect(fallback.insertionMode).toBe('always');

    // 显式传入的 insertionMode 仍优先于分类默认。
    const explicit = createLoreEntry(
      'agent-1',
      { title: '强制手动', content: '虽是背景但作者选手动。', category: 'background', insertionMode: 'manual' },
      storage,
    );
    expect(explicit.insertionMode).toBe('manual');
  });

  it('updates, toggles, and deletes lore entries without touching other agents', () => {
    const first = createLoreEntry('agent-1', {
      title: '初遇',
      content: '角色与用户初遇的完整事件。',
      category: 'event',
    }, storage);
    const second = createLoreEntry('agent-2', {
      title: '另一个角色',
      content: '其他 agent 的设定。',
      category: 'background',
    }, storage);

    const updated = updateLoreEntry(first.id, {
      title: '初遇事件',
      keywords: ['初遇', '约定'],
      priority: 30,
      visibility: 'private',
    }, storage);
    const toggled = toggleLoreEntry(first.id, storage);

    expect(updated).toMatchObject({
      id: first.id,
      title: '初遇事件',
      keywords: ['初遇', '约定'],
      priority: 30,
      visibility: 'private',
    });
    expect(toggled?.enabled).toBe(false);
    expect(deleteLoreEntry(first.id, storage)).toBe(true);
    expect(listLoreEntries('agent-1', storage)).toEqual([]);
    expect(listLoreEntries('agent-2', storage)).toHaveLength(1);
    expect(listLoreEntries('agent-2', storage)[0].id).toBe(second.id);
  });

  it('normalizes malformed stored lore content', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    storage.setItem(XINGYE_LORE_ENTRIES_STORAGE_KEY, JSON.stringify({
      bad: { title: 'missing agent id' },
      good: {
        id: 'entry-1',
        agentId: 'agent-1',
        title: '规则',
        content: '世界规则。',
        category: 'unknown',
        keywords: ['  ', '规则'],
        enabled: false,
        priority: 999,
        insertionMode: 'bad',
        visibility: 'bad',
        createdAt: '2026-05-10T00:00:00.000Z',
        updatedAt: '2026-05-10T00:00:00.000Z',
      },
    }));

    expect(listLoreEntries('agent-1', storage)).toMatchObject([{
      id: 'entry-1',
      agentId: 'agent-1',
      category: 'background',
      keywords: ['规则'],
      enabled: false,
      priority: 100,
      insertionMode: 'manual',
      visibility: 'canonical',
    }]);
  });

  it('maps removed legacy category strings to canonical categories when loading', () => {
    storage.setItem(XINGYE_LORE_ENTRIES_STORAGE_KEY, JSON.stringify({
      e1: {
        id: 'e1',
        agentId: 'agent-1',
        title: 'a',
        content: 'c',
        category: 'world',
        keywords: [],
        enabled: true,
        priority: 1,
        insertionMode: 'manual',
        visibility: 'canonical',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      e2: {
        id: 'e2',
        agentId: 'agent-1',
        title: 'b',
        content: 'c',
        category: 'memory',
        keywords: [],
        enabled: true,
        priority: 1,
        insertionMode: 'manual',
        visibility: 'canonical',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      e3: {
        id: 'e3',
        agentId: 'agent-1',
        title: 'c',
        content: 'c',
        category: 'other',
        keywords: [],
        enabled: true,
        priority: 1,
        insertionMode: 'manual',
        visibility: 'canonical',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    }));
    const list = listLoreEntries('agent-1', storage);
    expect(list.find((e) => e.id === 'e1')?.category).toBe('worldview');
    expect(list.find((e) => e.id === 'e2')?.category).toBe('background');
    expect(list.find((e) => e.id === 'e3')?.category).toBe('rule');
  });
});
