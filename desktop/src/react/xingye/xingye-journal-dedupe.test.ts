import { describe, expect, it } from 'vitest';
import {
  buildJournalContinuityAnchorBlock,
  detectJournalDuplicate,
  JOURNAL_ANCHOR_SAMPLE_LIMIT,
} from './xingye-journal-dedupe';
import type { XingyeJournalEntry } from './xingye-journal-store';

function entry(
  partial: Partial<XingyeJournalEntry> & { id: string; title: string; body: string },
): XingyeJournalEntry {
  return {
    dayKey: '2026-05-27',
    createdAt: '2026-05-27T00:00:00.000Z',
    ...partial,
  };
}

describe('buildJournalContinuityAnchorBlock', () => {
  it('空列表 → 空串', () => {
    expect(buildJournalContinuityAnchorBlock([])).toBe('');
  });

  it('单条 → 一行样本（无连续提示）', () => {
    const out = buildJournalContinuityAnchorBlock([
      entry({ id: 'a', title: '今天的雨', body: '雨从早上下到傍晚，我泡了茶。' }),
    ]);
    expect(out).toContain('最近写过的日记');
    expect(out).toContain('[2026-05-27]');
    expect(out).toContain('今天的雨');
    expect(out).toContain('雨从早上下到傍晚');
    expect(out).not.toContain('最近几天的主题');
  });

  it('最多抽 8 条', () => {
    const entries: XingyeJournalEntry[] = [];
    for (let i = 0; i < 12; i += 1) {
      entries.push(entry({ id: `e${i}`, title: `标题${i}`, body: `开头${i}`, dayKey: `2026-05-${String(27 - i).padStart(2, '0')}` }));
    }
    const out = buildJournalContinuityAnchorBlock(entries);
    expect(out).toContain('标题0');
    expect(out).toContain(`标题${JOURNAL_ANCHOR_SAMPLE_LIMIT - 1}`);
    expect(out).not.toContain(`标题${JOURNAL_ANCHOR_SAMPLE_LIMIT}`);
  });

  it('连续 2+ 天有日记 → 列出最近几天主题并提示换切口', () => {
    const entries = [
      entry({ id: 'a', title: '今天的雨', body: '雨从早上下到傍晚', dayKey: '2026-05-27' }),
      entry({ id: 'b', title: '昨天的茶', body: '泡了一壶冷泡茶', dayKey: '2026-05-26' }),
      entry({ id: 'c', title: '前天的傍晚', body: '一个人坐在窗边', dayKey: '2026-05-25' }),
    ];
    const out = buildJournalContinuityAnchorBlock(entries);
    expect(out).toContain('最近几天的主题');
    expect(out).toContain('今天的雨');
    expect(out).toContain('昨天的茶');
    expect(out).toContain('今天请换一个切口');
  });
});

describe('detectJournalDuplicate', () => {
  it('candidate 标题 + body 全空 → unique', () => {
    const existing = [entry({ id: 'e1', title: '今天的雨', body: '雨从早上下到傍晚' })];
    expect(detectJournalDuplicate({ title: '   ', body: '' }, existing).kind).toBe('unique');
  });

  it('existing 为空 → unique', () => {
    expect(detectJournalDuplicate({ title: '随便写', body: '随便写的开头' }, []).kind).toBe('unique');
  });

  it('完全相同的标题 → exact_dup(via=title)', () => {
    const existing = [entry({ id: 'e1', title: '今天的雨', body: '雨从早上下到傍晚' })];
    const result = detectJournalDuplicate({ title: '今天的雨', body: '完全不同的开头' }, existing);
    expect(result.kind).toBe('exact_dup');
    if (result.kind === 'exact_dup') {
      expect(result.via).toBe('title');
      expect(result.entry.id).toBe('e1');
    }
  });

  it('标题 trim 后相同 → exact_dup(via=title)', () => {
    const existing = [entry({ id: 'e1', title: '今天的雨', body: 'X' })];
    const result = detectJournalDuplicate({ title: '  今天的雨  ', body: '另一段' }, existing);
    expect(result.kind).toBe('exact_dup');
  });

  it('标题改 1 字（编辑距离 1）→ similar(via=title, method=edit)', () => {
    const existing = [entry({ id: 'e1', title: '今天的雨水', body: '完全不同的开头不能算' })];
    const result = detectJournalDuplicate(
      { title: '昨天的雨水', body: '某一段毫不相关的内容' },
      existing,
    );
    expect(result.kind).toBe('similar');
    if (result.kind === 'similar') {
      expect(result.via).toBe('title');
      expect(result.method).toBe('edit');
    }
  });

  it('标题 bigram ≥ 0.75（高度重叠的换序）→ similar(via=title)', () => {
    const existing = [entry({ id: 'e1', title: '关于诊所那条街的笔记', body: '不能与开头相同' })];
    const result = detectJournalDuplicate(
      { title: '关于诊所那条街的备注', body: '另一段完全不同的话' },
      existing,
    );
    expect(result.kind).toBe('similar');
    if (result.kind === 'similar') expect(result.via).toBe('title');
  });

  it('标题不同但开头 30 字相同 → exact_dup(via=opening)', () => {
    const existing = [
      entry({ id: 'e1', title: '第一篇', body: '今天又下了一整天的雨，我泡了一壶冷茶。' }),
    ];
    const result = detectJournalDuplicate(
      { title: '完全不一样的标题', body: '今天又下了一整天的雨，我泡了一壶冷茶。还看了一会书。' },
      existing,
    );
    expect(result.kind).toBe('exact_dup');
    if (result.kind === 'exact_dup') expect(result.via).toBe('opening');
  });

  it('开头层编辑距离 ≤ 2 → similar(via=opening, method=edit)', () => {
    const existing = [
      entry({ id: 'e1', title: '完全不同 A', body: '今天又下了一整天的雨水我泡冷茶' }),
    ];
    const result = detectJournalDuplicate(
      { title: '完全不同 B', body: '今天又下了一整天的雨水我没泡茶' },
      existing,
    );
    expect(result.kind).toBe('similar');
    if (result.kind === 'similar') {
      expect(result.via).toBe('opening');
      expect(result.method).toBe('edit');
    }
  });

  it('主题完全不同 → unique', () => {
    const existing = [
      entry({ id: 'e1', title: '今天的雨', body: '雨从早上下到傍晚，我泡了茶。' }),
      entry({ id: 'e2', title: '昨晚的梦', body: '梦见自己又回到老家的小巷子里。' }),
    ];
    const result = detectJournalDuplicate(
      { title: '考试成绩出来了', body: '终于查到了这次的考试结果，比预想的好一点。' },
      existing,
    );
    expect(result.kind).toBe('unique');
  });

  it('全角包裹符号（《》）等同于无包裹 → exact_dup', () => {
    const existing = [entry({ id: 'e1', title: '《今天的雨》', body: 'X' })];
    const result = detectJournalDuplicate({ title: '今天的雨', body: 'Y' }, existing);
    expect(result.kind).toBe('exact_dup');
  });

  it('标题层优先于开头层：两层都命中 → via=title', () => {
    const existing = [entry({ id: 'e1', title: '今天的雨', body: '雨从早上下到傍晚' })];
    const result = detectJournalDuplicate(
      { title: '今天的雨', body: '雨从早上下到傍晚' },
      existing,
    );
    expect(result.kind).toBe('exact_dup');
    if (result.kind === 'exact_dup') expect(result.via).toBe('title');
  });

  it('maxRecent 限制比较范围：超出窗口外的不算重复', () => {
    const existing: XingyeJournalEntry[] = [];
    for (let i = 0; i < 35; i += 1) {
      existing.push(entry({ id: `e${i}`, title: `主题${i}`, body: `开头${i}` }));
    }
    // 第 34 条与 candidate 同标题，但默认 maxRecent=30，应当 unique
    existing.push(entry({ id: 'old', title: '今天的雨', body: 'X' }));
    expect(detectJournalDuplicate({ title: '今天的雨', body: 'Y' }, existing, { maxRecent: 30 }).kind).toBe('unique');
    expect(detectJournalDuplicate({ title: '今天的雨', body: 'Y' }, existing, { maxRecent: 100 }).kind).toBe('exact_dup');
  });
});
