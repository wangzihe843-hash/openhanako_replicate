/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoreDiagnostics } from './LoreDiagnostics';
import { collectXingyeLoreRuntimeContext } from './xingye-lore-runtime-context';
import { XINGYE_LORE_ENTRIES_STORAGE_KEY, type XingyeLoreEntry } from './xingye-lore-store';
import * as loreContext from '../../../../shared/xingye-lore-context.js';
import type { XingyeLoreDecision, XingyeLoreSourceEntry } from '../../../../shared/xingye-lore-context.js';

function entry(id: string, overrides: Partial<XingyeLoreEntry & XingyeLoreSourceEntry> = {}): XingyeLoreEntry {
  return { id, agentId: 'a', title: id, category: 'worldview', content: '正文', keywords: ['灯塔'], enabled: true,
    priority: 50, insertionMode: 'keyword', visibility: 'canonical', createdAt: '2026-09-21', updatedAt: '2026-09-21', ...overrides };
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('lore diagnostics', () => {
  it('distinguishes scope and source exclusions without changing stored entries', () => {
    const entries = [
      entry('范围不符', { memoryScope: { realm: 'reality' }, sourceStatus: 'stale', origin: 'derived' }),
      entry('来源过时', { sourceStatus: 'stale', origin: 'derived', enabled: false }),
      entry('来源待确认', { origin: 'derived' }),
    ];
    const before = JSON.stringify(entries);
    const writes = vi.spyOn(Storage.prototype, 'setItem');
    render(<LoreDiagnostics agentId="a" entries={entries} />);
    fireEvent.click(screen.getByText('设定选择诊断（模拟预览）'));
    for (const name of ['共享始终设定选择器', '共享关键词选择器']) {
      const region = within(screen.getByRole('region', { name }));
      expect(region.getByText('范围不符').closest('li')).toHaveTextContent('作用范围无效或角色、世界、分支、知情范围不匹配');
      expect(region.getByText('来源过时').closest('li')).toHaveTextContent('来源已过时');
      expect(region.getByText('来源过时').closest('li')).not.toHaveTextContent('范围不匹配');
      expect(region.getByText('来源待确认').closest('li')).toHaveTextContent('派生来源尚未确认有效');
    }
    expect(writes).not.toHaveBeenCalled();
    expect(JSON.stringify(entries)).toBe(before);
  });

  it('accepts old decision records without a detail and uses a general scope/source label', () => {
    const legacy: XingyeLoreDecision = { id: 'legacy', title: '旧诊断', reason: 'scope', matchedKeywords: [], blockChars: 0 };
    vi.spyOn(loreContext, 'selectXingyeLoreEntries').mockImplementation((options) => {
      options.onDecision?.(legacy);
      return { selected: [], candidateCount: 0, usedChars: 0, truncated: false };
    });
    render(<LoreDiagnostics agentId="a" entries={[entry('legacy')]} />);
    fireEvent.click(screen.getByText('设定选择诊断（模拟预览）'));
    for (const name of ['共享始终设定选择器', '共享关键词选择器', '桌面通用选择器']) {
      expect(within(screen.getByRole('region', { name })).getByText('旧诊断').closest('li'))
        .toHaveTextContent('作用范围或来源状态不符合要求');
    }
  });

  it('compares real selectors, updates query and budget, and isolates another agent', () => {
    const entries = [entry('长设定', { content: '长'.repeat(500), priority: 100 }), entry('短设定'),
      entry('关停设定', { enabled: false }), entry('私有备注', { visibility: 'private' }), entry('另一角色秘密', { agentId: 'b' })];
    render(<LoreDiagnostics agentId="a" entries={entries} />);
    fireEvent.click(screen.getByText('设定选择诊断（模拟预览）'));
    expect(screen.getByText(/不是最后一次模型请求记录/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('诊断查询文本'), { target: { value: '灯塔' } });
    fireEvent.change(screen.getByLabelText('各路径条目字符预算'), { target: { value: '200' } });
    const shared = within(screen.getByRole('region', { name: '共享关键词选择器' }));
    const desktop = within(screen.getByRole('region', { name: '桌面通用选择器' }));
    expect(shared.getByText('长设定').closest('li')).toHaveTextContent('截断选入：预算不足');
    expect(shared.getByText('短设定').closest('li')).toHaveTextContent('完整选入');
    expect(desktop.getByText('长设定').closest('li')).toHaveTextContent('截断选入：预算不足');
    expect(desktop.getByText('短设定').closest('li')).toHaveTextContent('完整选入');
    expect(desktop.getByText('关停设定').closest('li')).toHaveTextContent('未启用');
    expect(desktop.getByText('私有备注').closest('li')).toHaveTextContent('私有备注或草稿');
    expect(screen.queryByText('另一角色秘密')).not.toBeInTheDocument();
    expect(screen.queryByText('长'.repeat(500))).not.toBeInTheDocument();
  });

  it('desktop diagnostics preserve selections and explain mode switches, keyword failures, and boost order', () => {
    const entries = [entry('always', { insertionMode: 'always' }), entry('manual', { insertionMode: 'manual' }),
      entry('hit'), entry('miss', { keywords: ['港口'] }), entry('no-keys', { keywords: [] }),
      entry('boost', { category: 'relationship', priority: 1 })];
    const snapshot = JSON.stringify(Object.fromEntries(entries.map((item) => [item.id, item])));
    const storage = { getItem: (key: string) => key === XINGYE_LORE_ENTRIES_STORAGE_KEY ? snapshot : null, setItem: () => {} };
    const rows: XingyeLoreDecision[] = [];
    const options = { queryText: '灯塔', includeAlways: false, priorityBoostCategories: ['relationship' as const] };
    const baseline = collectXingyeLoreRuntimeContext('a', options, storage);
    const observed = collectXingyeLoreRuntimeContext('a', { ...options, onDecision: (row) => rows.push(row) }, storage);
    expect(observed).toEqual(baseline);
    expect(observed.entries.map((item) => item.id)).toEqual(['boost', 'hit']);
    expect(Object.fromEntries(rows.map((row) => [row.id, row.reason]))).toEqual({ always: 'mode', manual: 'mode', hit: 'selected', miss: 'no-match', 'no-keys': 'no-keywords', boost: 'selected' });
  });
});
