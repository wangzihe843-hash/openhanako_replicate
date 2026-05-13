import { beforeEach, describe, expect, it } from 'vitest';
import {
  XINGYE_LORE_ENTRIES_STORAGE_KEY,
  createLoreEntry,
  updateLoreEntry,
  type XingyeLoreEntry,
} from './xingye-lore-store';
import {
  buildXingyeLoreRuntimeQueryText,
  collectXingyeLoreRuntimeContext,
  formatXingyeLoreRuntimeContextBlock,
  type XingyeLoreRuntimeContextPurpose,
} from './xingye-lore-runtime-context';

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

describe('buildXingyeLoreRuntimeQueryText', () => {
  it('joins non-empty parts with single spaces and dedupes whitespace + duplicates', () => {
    const text = buildXingyeLoreRuntimeQueryText([
      '  最近 OpenHanako   聊天  ',
      null,
      undefined,
      '',
      '联系人: 老王',
      '联系人: 老王',
    ]);
    expect(text).toBe('最近 OpenHanako 聊天 联系人: 老王');
  });

  it('returns empty string when no usable input', () => {
    expect(buildXingyeLoreRuntimeQueryText([null, undefined, '', '  '])).toBe('');
  });
});

describe('collectXingyeLoreRuntimeContext — selection rules', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  function makeEntry(partial: Partial<XingyeLoreEntry> & { title: string }, agentId = 'agent-1'): XingyeLoreEntry {
    return createLoreEntry(
      agentId,
      {
        title: partial.title,
        content: partial.content ?? `内容：${partial.title}`,
        category: partial.category ?? 'background',
        keywords: partial.keywords ?? [],
        enabled: partial.enabled ?? true,
        priority: partial.priority ?? 50,
        insertionMode: partial.insertionMode ?? 'always',
        visibility: partial.visibility ?? 'canonical',
      },
      storage,
    );
  }

  it('includes always + canonical + enabled entries by default', () => {
    const entry = makeEntry({
      title: '王国基本背景',
      content: '边境医院的世界观核心设定。',
      insertionMode: 'always',
      visibility: 'canonical',
      enabled: true,
    });
    const context = collectXingyeLoreRuntimeContext('agent-1', {}, storage);
    expect(context.entries.map(e => e.id)).toEqual([entry.id]);
    expect(context.entries[0].reason).toBe('always');
  });

  it('excludes disabled entries', () => {
    const entry = makeEntry({
      title: '禁用条目',
      insertionMode: 'always',
      visibility: 'canonical',
      enabled: true,
    });
    updateLoreEntry(entry.id, { enabled: false }, storage);
    const context = collectXingyeLoreRuntimeContext('agent-1', {}, storage);
    expect(context.entries).toHaveLength(0);
  });

  it('excludes draft and private visibilities', () => {
    makeEntry({ title: '草稿', insertionMode: 'always', visibility: 'draft' });
    makeEntry({ title: '私密', insertionMode: 'always', visibility: 'private' });
    makeEntry({ title: '正稿', insertionMode: 'always', visibility: 'canonical' });
    const context = collectXingyeLoreRuntimeContext('agent-1', {}, storage);
    expect(context.entries.map(e => e.title)).toEqual(['正稿']);
  });

  it('includes keyword entries only when keywords hit (case-insensitive substring, Chinese ok)', () => {
    makeEntry({
      title: '黑市渠道',
      insertionMode: 'keyword',
      keywords: ['黑市', 'Black Market'],
    });
    const miss = collectXingyeLoreRuntimeContext('agent-1', { queryText: '今天天气很好' }, storage);
    expect(miss.entries).toHaveLength(0);

    const hitChinese = collectXingyeLoreRuntimeContext('agent-1', { queryText: '黑市那条线又断了' }, storage);
    expect(hitChinese.entries.map(e => e.title)).toEqual(['黑市渠道']);
    expect(hitChinese.entries[0].matchedKeywords).toContain('黑市');

    const hitEnglishLower = collectXingyeLoreRuntimeContext('agent-1', { queryText: 'visited the black market today' }, storage);
    expect(hitEnglishLower.entries.map(e => e.title)).toEqual(['黑市渠道']);
  });

  it('matches keywords also via options.keywords array', () => {
    makeEntry({ title: '夜班医院', insertionMode: 'keyword', keywords: ['夜班'] });
    const context = collectXingyeLoreRuntimeContext('agent-1', { keywords: ['夜班'] }, storage);
    expect(context.entries.map(e => e.title)).toEqual(['夜班医院']);
  });

  it('never auto-includes manual entries even when keywords match', () => {
    makeEntry({ title: '手动条目', insertionMode: 'manual', keywords: ['手动'] });
    const context = collectXingyeLoreRuntimeContext('agent-1', { queryText: '手动手动手动' }, storage);
    expect(context.entries).toHaveLength(0);
  });

  it('orders entries by priority desc, with low priority last', () => {
    const low = makeEntry({ title: '低优先级', priority: 10, insertionMode: 'always' });
    const midA = makeEntry({ title: '中优先级 A', priority: 50, insertionMode: 'always' });
    const high = makeEntry({ title: '高优先级', priority: 90, insertionMode: 'always' });
    const context = collectXingyeLoreRuntimeContext('agent-1', {}, storage);
    const ids = context.entries.map(e => e.id);
    expect(ids[0]).toBe(high.id);
    expect(ids[ids.length - 1]).toBe(low.id);
    expect(ids).toContain(midA.id);
  });

  it('respects maxChars by skipping low-priority entries that would overflow', () => {
    const longContent = '充分长'.repeat(80); // ~240 chars
    makeEntry({ title: '高优先级', priority: 90, insertionMode: 'always', content: longContent });
    makeEntry({ title: '次优先级', priority: 50, insertionMode: 'always', content: longContent });
    makeEntry({ title: '末优先级', priority: 10, insertionMode: 'always', content: longContent });

    const tight = collectXingyeLoreRuntimeContext('agent-1', { maxChars: 300 }, storage);
    expect(tight.entries.length).toBeLessThan(3);
    expect(tight.truncated).toBe(true);
    expect(tight.totalChars).toBeLessThanOrEqual(300);

    const loose = collectXingyeLoreRuntimeContext('agent-1', { maxChars: 5_000 }, storage);
    expect(loose.entries).toHaveLength(3);
    expect(loose.truncated).toBe(false);
  });

  it('does not leak entries between agents', () => {
    makeEntry({ title: 'agent-1 own', insertionMode: 'always' }, 'agent-1');
    makeEntry({ title: 'agent-2 own', insertionMode: 'always' }, 'agent-2');
    const ctx1 = collectXingyeLoreRuntimeContext('agent-1', {}, storage);
    const ctx2 = collectXingyeLoreRuntimeContext('agent-2', {}, storage);
    expect(ctx1.entries.map(e => e.title)).toEqual(['agent-1 own']);
    expect(ctx2.entries.map(e => e.title)).toEqual(['agent-2 own']);
  });

  it('returns empty result when agentId is missing or storage empty', () => {
    expect(collectXingyeLoreRuntimeContext(null, {}, storage).entries).toEqual([]);
    expect(collectXingyeLoreRuntimeContext(undefined, {}, storage).entries).toEqual([]);
    expect(collectXingyeLoreRuntimeContext('', {}, storage).entries).toEqual([]);
    expect(collectXingyeLoreRuntimeContext('no-such-agent', {}, storage).entries).toEqual([]);
  });

  it('supports includeAlways=false and includeKeyword=false toggles', () => {
    makeEntry({ title: '总是出现', insertionMode: 'always' });
    makeEntry({ title: '关键词出现', insertionMode: 'keyword', keywords: ['触发'] });
    const both = collectXingyeLoreRuntimeContext('agent-1', { queryText: '触发' }, storage);
    expect(both.entries.map(e => e.title).sort()).toEqual(['关键词出现', '总是出现']);
    const onlyKeyword = collectXingyeLoreRuntimeContext('agent-1', { queryText: '触发', includeAlways: false }, storage);
    expect(onlyKeyword.entries.map(e => e.title)).toEqual(['关键词出现']);
    const onlyAlways = collectXingyeLoreRuntimeContext('agent-1', { queryText: '触发', includeKeyword: false }, storage);
    expect(onlyAlways.entries.map(e => e.title)).toEqual(['总是出现']);
  });

  it('accepts every secret_space_* purpose without throwing or branching errors', () => {
    makeEntry({ title: '通用条目', insertionMode: 'always' });
    const purposes: XingyeLoreRuntimeContextPurpose[] = [
      'phone_contacts',
      'phone_sms',
      'secret_space_dream',
      'secret_space_draft_reply',
      'secret_space_unsent_moment',
      'secret_space_saved_item',
      'secret_space_memory_fragment',
      'relationship_state',
      'journal_draft',
      'mm_chat',
      'generic',
    ];
    for (const purpose of purposes) {
      const ctx = collectXingyeLoreRuntimeContext('agent-1', { purpose }, storage);
      expect(ctx.purpose).toBe(purpose);
      expect(ctx.entries.map(e => e.title)).toEqual(['通用条目']);
    }
  });

  it('formats canonical entries into a 【星野设定参考】 block', () => {
    makeEntry({
      title: '边境医院',
      category: 'location',
      content: '主角任职的小型医院。',
      insertionMode: 'always',
    });
    const ctx = collectXingyeLoreRuntimeContext('agent-1', {}, storage);
    const block = formatXingyeLoreRuntimeContextBlock(ctx);
    expect(block).toContain('【星野设定参考】');
    expect(block).toContain('标题：边境医院');
    expect(block).toContain('分类：地点');
    expect(block).toContain('内容：主角任职的小型医院。');
  });

  it('returns empty string from formatter when no entries are selected', () => {
    expect(formatXingyeLoreRuntimeContextBlock(null)).toBe('');
    expect(formatXingyeLoreRuntimeContextBlock(undefined)).toBe('');
    const empty = collectXingyeLoreRuntimeContext('agent-1', {}, storage);
    expect(formatXingyeLoreRuntimeContextBlock(empty)).toBe('');
  });

  it('uses the bare storage key consistent with xingye-lore-store', () => {
    makeEntry({ title: '可读条目', insertionMode: 'always' });
    expect(storage.getItem(XINGYE_LORE_ENTRIES_STORAGE_KEY)).toContain('可读条目');
  });
});
