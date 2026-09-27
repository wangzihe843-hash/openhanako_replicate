import { describe, expect, it } from 'vitest';
import type { XingyeJournalExport } from './xingye-journal-export';
import { journalBodyFromImagePages, layoutJournalImagePages } from './xingye-journal-image';

const document: XingyeJournalExport = {
  schemaVersion: 1,
  contentType: 'xingye-journal-entry',
  sourceType: 'journal',
  confirmation: 'user-confirmed-heartbeat-draft',
  agent: { id: 'linwu', displayName: '林雾' },
  entry: {
    id: 'from-draft-1', title: '长夜里的灯', body: '', createdAt: '2026-09-27T10:00:00.000Z',
    dayKey: '2026-09-27', dateSmudged: false, mood: null,
  },
};

describe('journal PNG page layout', () => {
  it('keeps every source character across page breaks, including Chinese, blank lines and visible image links', () => {
    const body = ('星野记得这一天。🙂\n\n![未加载的图片](https://invalid.example/image.png)\n').repeat(200);
    const pages = layoutJournalImagePages({ ...document, entry: { ...document.entry, body } }, text => Array.from(text).length * 25);
    expect(pages.length).toBeGreaterThan(1);
    expect(journalBodyFromImagePages(pages)).toBe(body);
    expect(pages.every(page => page.lines.every(line => line.y < 1290))).toBe(true);
    expect(pages.flatMap(page => page.lines).some(line => line.text.includes('未加载的图片'))).toBe(true);
  });

  it('wraps an overlong title without losing it and labels unknown dates truthfully', () => {
    const title = '长标题'.repeat(100);
    const pages = layoutJournalImagePages({ ...document, entry: { ...document.entry, title, dateSmudged: true, dayKey: null } }, text => Array.from(text).length * 30);
    expect(pages.flatMap(page => page.lines).filter(line => line.kind === 'title').map(line => line.text).join('')).toBe(title);
    expect(pages.flatMap(page => page.lines).some(line => line.text.includes('日记日期不详'))).toBe(true);
  });

  it('treats a large embedded image as one frame while preserving the exact source', () => {
    const body = `开始\n![照片](data:image/png;base64,${'A'.repeat(20_000)})\n结束`;
    const pages = layoutJournalImagePages({ ...document, entry: { ...document.entry, body } }, text => Array.from(text).length * 25);
    expect(pages).toHaveLength(1);
    expect(pages[0].lines.filter(line => line.kind === 'image')).toHaveLength(1);
    expect(journalBodyFromImagePages(pages)).toBe(body);
  });
});
