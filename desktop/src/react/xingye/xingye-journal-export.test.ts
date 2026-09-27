/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import type { XingyeJournalEntry } from './xingye-journal-store';
import {
  createConfirmedJournalExport,
  isConfirmedJournalExportEntry,
  renderJournalExportHtml,
  serializeJournalExportJson,
} from './xingye-journal-export';

const confirmed: XingyeJournalEntry = {
  id: 'from-draft-heartbeat-42',
  dayKey: '2026-09-27',
  title: '长夜里的灯',
  body: '第一行。\n第二行，汉字仍然清楚。',
  createdAt: '2026-09-27T10:00:00.000Z',
  mood: '安心',
};

describe('confirmed journal export', () => {
  it('limits export to confirmed draft entries and preserves the exact long Chinese body', () => {
    expect(isConfirmedJournalExportEntry(confirmed)).toBe(true);
    expect(isConfirmedJournalExportEntry({ ...confirmed, id: 'journal-init-42' })).toBe(false);
    expect(() => createConfirmedJournalExport({ ...confirmed, id: 'journal-init-42' }, { id: 'linwu', displayName: '林雾' })).toThrow();

    const body = '星野和灯塔。\n'.repeat(1500);
    const document = createConfirmedJournalExport({ ...confirmed, body }, { id: 'linwu', displayName: '林雾' });
    expect(JSON.parse(serializeJournalExportJson(document)).entry.body).toBe(body);
    const html = renderJournalExportHtml(document);
    expect(html).toContain(body);
    expect(html).toContain('charset="utf-8"');
    expect(html).toContain('white-space: pre-wrap');
  });

  it('escapes untrusted text in standalone HTML and carries a truthful date', () => {
    const document = createConfirmedJournalExport({
      ...confirmed,
      title: '<img src=x onerror=alert(1)>',
      body: '<script>alert("x")</script> & more',
      dateSmudged: true,
      dayKey: '0001-01-01',
    }, { id: 'linwu', displayName: '<林雾>' });
    expect(document.entry.dayKey).toBeNull();
    const html = renderJournalExportHtml(document);
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; more');
    expect(html).toContain('&lt;林雾&gt;');
    expect(html).toContain('日记日期不详');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('0001-01-01');
  });
});
