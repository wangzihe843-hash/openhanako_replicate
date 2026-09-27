import { FROM_DRAFT_ID_PREFIX } from './xingye-draft-confirm-lock';
import type { XingyeJournalEntry } from './xingye-journal-store';

/** Only a confirmed heartbeat proposal has an entry ID minted by confirmJournalDraft. */
export function isConfirmedJournalExportEntry(entry: XingyeJournalEntry): boolean {
  return entry.id.startsWith(FROM_DRAFT_ID_PREFIX);
}

export interface XingyeJournalExport {
  schemaVersion: 1;
  contentType: 'xingye-journal-entry';
  sourceType: 'journal';
  confirmation: 'user-confirmed-heartbeat-draft';
  agent: { id: string; displayName: string };
  entry: {
    id: string;
    title: string;
    body: string;
    createdAt: string;
    dayKey: string | null;
    dateSmudged: boolean;
    mood: string | null;
  };
}

export function createConfirmedJournalExport(
  entry: XingyeJournalEntry,
  agent: { id: string; displayName: string },
): XingyeJournalExport {
  if (!isConfirmedJournalExportEntry(entry)) {
    throw new Error('只有已确认的日记可以导出。');
  }
  if (!agent.id.trim()) throw new Error('导出日记缺少角色标识。');
  return {
    schemaVersion: 1,
    contentType: 'xingye-journal-entry',
    sourceType: 'journal',
    confirmation: 'user-confirmed-heartbeat-draft',
    agent: { id: agent.id, displayName: agent.displayName },
    entry: {
      id: entry.id,
      title: entry.title,
      body: entry.body,
      createdAt: entry.createdAt,
      dayKey: entry.dateSmudged ? null : entry.dayKey,
      dateSmudged: entry.dateSmudged === true,
      mood: entry.mood ?? null,
    },
  };
}

export function serializeJournalExportJson(document: XingyeJournalExport): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] ?? character);
}

export function renderJournalExportHtml(document: XingyeJournalExport): string {
  const { agent, entry } = document;
  const date = entry.dateSmudged ? '日记日期不详' : entry.dayKey || '日记日期不详';
  const mood = entry.mood ? `<p class="mood">心情：${escapeHtml(entry.mood)}</p>` : '';
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <title>${escapeHtml(entry.title)} · 日记</title>
  <style>
    :root { color-scheme: light; font-family: "Noto Sans CJK SC", "Microsoft YaHei", sans-serif; }
    body { max-width: 46rem; margin: 2rem auto; padding: 0 1.5rem 3rem; color: #352b27; background: #fffdf8; line-height: 1.8; }
    header { border-bottom: 1px solid #d9c8b7; padding-bottom: 1rem; }
    h1 { line-height: 1.35; overflow-wrap: anywhere; }
    .meta, .mood { color: #6d5b51; overflow-wrap: anywhere; }
    article { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 1.05rem; margin-top: 2rem; }
    footer { border-top: 1px solid #d9c8b7; margin-top: 3rem; padding-top: 1rem; color: #746960; font-size: .85rem; }
    @media print { body { margin: 0 auto; background: white; } }
  </style>
</head>
<body>
  <header>
    <h1>${escapeHtml(entry.title)}</h1>
    <p class="meta">${escapeHtml(agent.displayName)} · ${escapeHtml(date)} · 内容创建于 ${escapeHtml(entry.createdAt)}</p>
    ${mood}
  </header>
  <article>${escapeHtml(entry.body)}</article>
  <footer>星野日记 · 用户已确认的内容 · 来源类型：${escapeHtml(document.sourceType)} · 格式版本：${document.schemaVersion}</footer>
</body>
</html>
`;
}

function safeFilename(document: XingyeJournalExport, extension: 'json' | 'html'): string {
  const title = document.entry.title.replace(/[<>:"/\\|?*]/g, '_').replace(/\p{Cc}/gu, '_').replace(/[.\s]+$/g, '').slice(0, 48) || '无标题';
  const id = document.entry.id.replace(/[^A-Za-z0-9_-]/g, '_').slice(-32);
  return `日记-${title}-${id}.${extension}`;
}

/** Uses the renderer's existing local Blob download path; no server export call. */
export function downloadJournalExport(document: XingyeJournalExport, format: 'json' | 'html'): string {
  const content = format === 'json' ? serializeJournalExportJson(document) : renderJournalExportHtml(document);
  const blob = new Blob([content], { type: format === 'json' ? 'application/json;charset=utf-8' : 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const filename = safeFilename(document, format);
  try {
    const anchor = globalThis.document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
  return filename;
}
