import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Agent } from '../types';
import styles from './XingyeShell.module.css';
import {
  appendAppEntry,
  deleteAppEntry,
  listAppEntries,
  type AppEntry,
} from './xingye-app-entry-store';
import {
  deleteBookForAgent,
  importBooksForAgent,
  listBooksForAgent,
  type BookSearchResult,
  type XingyeBookCatalogEntry,
} from './xingye-reading-book-catalog';

export interface PhoneReadingNotesAppProps {
  ownerAgent: Agent | null;
  displayName: string;
  onBack: () => void;
}

type NoteType = 'want_to_read' | 'pre_read' | 'question' | 'reading_note';

type ReadingNoteMetadata = {
  bookId: string;
  noteType: NoteType;
  quote?: {
    text: string;
    source: 'manual' | 'user_provided';
  };
};

type ReadingNoteEntry = AppEntry & {
  appId: 'reading_notes';
  metadata: ReadingNoteMetadata;
};

type BookDraft = {
  title: string;
  authorsText: string;
  subjectsText: string;
  description: string;
};

type NoteDraft = {
  title: string;
  body: string;
  noteType: NoteType;
  quoteText: string;
};

const READING_NOTES_APP_ID = 'reading_notes';

const NOTE_TYPE_LABELS: Record<NoteType, string> = {
  want_to_read: '想读',
  pre_read: '预读',
  question: '问题',
  reading_note: '笔记',
};

function emptyBookDraft(): BookDraft {
  return {
    title: '',
    authorsText: '',
    subjectsText: '',
    description: '',
  };
}

function emptyNoteDraft(): NoteDraft {
  return {
    title: '',
    body: '',
    noteType: 'pre_read',
    quoteText: '',
  };
}

function splitList(text: string): string[] {
  return text
    .split(/[,，、;/；\n]+/g)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 12);
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function excerpt(text: string, max = 64): string {
  const one = text.replace(/\s+/g, ' ').trim();
  if (!one) return '没有正文。';
  if (one.length <= max) return one;
  return `${one.slice(0, Math.max(1, max - 1))}…`;
}

function normalizeNoteType(value: unknown): NoteType {
  return (
    value === 'want_to_read' ||
    value === 'pre_read' ||
    value === 'question' ||
    value === 'reading_note'
  ) ? value : 'reading_note';
}

function normalizeReadingNote(entry: AppEntry): ReadingNoteEntry | null {
  const bookId = typeof entry.metadata?.bookId === 'string' ? entry.metadata.bookId.trim() : '';
  if (!bookId) return null;
  const rawQuote = entry.metadata?.quote;
  let quote: ReadingNoteMetadata['quote'];
  if (rawQuote && typeof rawQuote === 'object' && !Array.isArray(rawQuote)) {
    const record = rawQuote as Record<string, unknown>;
    const source = record.source === 'manual' || record.source === 'user_provided' ? record.source : null;
    const text = typeof record.text === 'string' ? record.text.trim() : '';
    if (source && text) quote = { source, text };
  }
  const metadata: ReadingNoteMetadata = {
    bookId,
    noteType: normalizeNoteType(entry.metadata?.noteType),
  };
  if (quote) metadata.quote = quote;
  return {
    ...entry,
    appId: 'reading_notes',
    metadata,
  };
}

function buildManualBook(agentId: string, draft: BookDraft): BookSearchResult {
  const title = draft.title.trim();
  const authors = splitList(draft.authorsText);
  const subjects = splitList(draft.subjectsText);
  const description = draft.description.trim();
  return {
    key: `manual:${agentId}:${title}`,
    title,
    authors,
    subjects,
    description: description || undefined,
  };
}

function noteInputForBook(bookId: string, draft: NoteDraft) {
  const metadata: ReadingNoteMetadata = {
    bookId,
    noteType: draft.noteType,
  };
  const quoteText = draft.quoteText.trim();
  if (quoteText) {
    metadata.quote = { text: quoteText, source: 'manual' };
  }
  return {
    title: draft.title.trim(),
    content: draft.body.trim(),
    source: 'manual',
    metadata: metadata as Record<string, unknown>,
  };
}

export function PhoneReadingNotesApp({ ownerAgent, displayName, onBack }: PhoneReadingNotesAppProps) {
  const ownerAgentId = ownerAgent?.id ?? '';
  const [books, setBooks] = useState<XingyeBookCatalogEntry[]>([]);
  const [notes, setNotes] = useState<ReadingNoteEntry[]>([]);
  const [selectedBookId, setSelectedBookId] = useState<string | null>(null);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [bookDraft, setBookDraft] = useState<BookDraft>(() => emptyBookDraft());
  const [noteDraft, setNoteDraft] = useState<NoteDraft>(() => emptyNoteDraft());
  const [mode, setMode] = useState<'list' | 'book_form' | 'note_form'>('list');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!ownerAgentId) {
      setBooks([]);
      setNotes([]);
      return;
    }
    setLoading(true);
    setMessage(null);
    try {
      const [bookRows, noteRows] = await Promise.all([
        listBooksForAgent(ownerAgentId),
        listAppEntries(ownerAgentId, READING_NOTES_APP_ID),
      ]);
      setBooks(bookRows.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)));
      setNotes(noteRows
        .map(normalizeReadingNote)
        .filter((note): note is ReadingNoteEntry => Boolean(note))
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)));
    } catch (err) {
      setMessage(`加载失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }, [ownerAgentId]);

  useEffect(() => {
    setSelectedBookId(null);
    setSelectedNoteId(null);
    setMode('list');
    setMessage(null);
    void reload();
  }, [ownerAgentId, reload]);

  const selectedBook = useMemo(
    () => books.find((book) => book.id === selectedBookId) ?? null,
    [books, selectedBookId],
  );
  const selectedNote = useMemo(
    () => notes.find((note) => note.id === selectedNoteId) ?? null,
    [notes, selectedNoteId],
  );
  const selectedBookNotes = useMemo(
    () => (selectedBook ? notes.filter((note) => note.metadata.bookId === selectedBook.id) : []),
    [notes, selectedBook],
  );

  const updateBookDraft = (patch: Partial<BookDraft>) => setBookDraft((prev) => ({ ...prev, ...patch }));
  const updateNoteDraft = (patch: Partial<NoteDraft>) => setNoteDraft((prev) => ({ ...prev, ...patch }));

  const openBookForm = () => {
    setBookDraft(emptyBookDraft());
    setMode('book_form');
    setMessage(null);
  };

  const openNoteForm = () => {
    setNoteDraft(emptyNoteDraft());
    setSelectedNoteId(null);
    setMode('note_form');
    setMessage(null);
  };

  const saveBook = async () => {
    if (!ownerAgentId) return;
    if (!bookDraft.title.trim()) {
      setMessage('请先填写书名。');
      return;
    }
    const book = buildManualBook(ownerAgentId, bookDraft);
    try {
      const imported = await importBooksForAgent(ownerAgentId, [book], {
        reason: 'manual',
        interests: book.subjects ?? [],
      });
      setBooks((prev) => [...imported, ...prev.filter((item) => !imported.some((row) => row.id === item.id))]);
      setSelectedBookId(imported[0]?.id ?? null);
      setMode('list');
      setMessage(null);
    } catch (err) {
      setMessage(`保存书目失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const saveNote = async () => {
    if (!ownerAgentId || !selectedBook) return;
    if (!noteDraft.title.trim()) {
      setMessage('请先填写笔记标题。');
      return;
    }
    try {
      const row = normalizeReadingNote(await appendAppEntry(
        ownerAgentId,
        READING_NOTES_APP_ID,
        noteInputForBook(selectedBook.id, noteDraft),
      ));
      if (row) setNotes((prev) => [row, ...prev.filter((note) => note.id !== row.id)]);
      setMode('list');
      setMessage(null);
    } catch (err) {
      setMessage(`保存笔记失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const deleteSelectedNote = async () => {
    if (!ownerAgentId || !selectedNote) return;
    if (!window.confirm('确定删除这条阅读笔记？')) return;
    const deleted = await deleteAppEntry(ownerAgentId, READING_NOTES_APP_ID, selectedNote.id);
    if (deleted) {
      setNotes((prev) => prev.filter((note) => note.id !== selectedNote.id));
      setSelectedNoteId(null);
    } else {
      await reload();
    }
  };

  const deleteSelectedBook = async () => {
    if (!ownerAgentId || !selectedBook) return;
    if (selectedBookNotes.length > 0) {
      setMessage('已有阅读笔记，先删除笔记后再删除书目。');
      return;
    }
    if (!window.confirm('确定删除这本本地书目？')) return;
    const deleted = await deleteBookForAgent(ownerAgentId, selectedBook.id);
    if (deleted) {
      setBooks((prev) => prev.filter((book) => book.id !== selectedBook.id));
      setSelectedBookId(null);
      setMessage(null);
    } else {
      await reload();
    }
  };

  if (!ownerAgentId) {
    return (
      <div className={styles.phoneShell} aria-label="阅读笔记">
        <div className={styles.phoneStatusBar}>
          <button type="button" className={styles.phoneBackButton} onClick={onBack}>返回首页</button>
          <span>阅读笔记</span>
        </div>
        <div className={styles.phoneBody}>
          <section className={styles.phoneAppCard}>
            <h3 className={styles.phoneAppTitle}>阅读笔记不可用</h3>
            <p className={styles.phoneAppHint}>请选择有效角色后再打开阅读笔记。</p>
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.phoneShell} aria-label="阅读笔记">
      <div className={styles.phoneStatusBar}>
        {selectedNote ? (
          <button type="button" className={styles.phoneBackButton} onClick={() => setSelectedNoteId(null)}>返回书目</button>
        ) : selectedBook || mode !== 'list' ? (
          <button
            type="button"
            className={styles.phoneBackButton}
            onClick={() => {
              if (mode !== 'list') setMode('list');
              else setSelectedBookId(null);
              setMessage(null);
            }}
          >
            {mode !== 'list' ? '取消' : '返回列表'}
          </button>
        ) : (
          <button type="button" className={styles.phoneBackButton} onClick={onBack}>返回首页</button>
        )}
        <span>阅读笔记</span>
      </div>

      <div className={styles.phoneBody}>
        {message ? <p className={styles.phoneAppHint} role="alert">{message}</p> : null}
        {loading && books.length === 0 ? <p className={styles.phoneAppHint}>加载中…</p> : null}

        {mode === 'book_form' ? (
          <section className={styles.phoneReadingEditor} aria-label="新增书目">
            <h2 className={styles.phoneReadingTitle}>新增书目</h2>
            <p className={styles.phoneReadingSafeNote}>只保存手动输入的本地书目 metadata，不连接外部书库。</p>
            <label className={styles.phoneFormField}>
              <span>书名</span>
              <input value={bookDraft.title} onChange={(e) => updateBookDraft({ title: e.target.value })} />
            </label>
            <label className={styles.phoneFormField}>
              <span>作者</span>
              <input value={bookDraft.authorsText} onChange={(e) => updateBookDraft({ authorsText: e.target.value })} />
            </label>
            <label className={styles.phoneFormField}>
              <span>主题</span>
              <input value={bookDraft.subjectsText} onChange={(e) => updateBookDraft({ subjectsText: e.target.value })} />
            </label>
            <label className={styles.phoneFormField}>
              <span>备注</span>
              <textarea rows={4} value={bookDraft.description} onChange={(e) => updateBookDraft({ description: e.target.value })} />
            </label>
            <button type="button" className={styles.phoneJournalPrimaryButton} onClick={saveBook}>保存书目</button>
          </section>
        ) : mode === 'note_form' && selectedBook ? (
          <section className={styles.phoneReadingEditor} aria-label="新增笔记">
            <h2 className={styles.phoneReadingTitle}>新增笔记</h2>
            <p className={styles.phoneReadingSafeNote}>只写想读、预读或问题；摘录必须由用户手动输入。</p>
            <label className={styles.phoneFormField}>
              <span>标题</span>
              <input value={noteDraft.title} onChange={(e) => updateNoteDraft({ title: e.target.value })} />
            </label>
            <label className={styles.phoneFormField}>
              <span>类型</span>
              <select
                className={styles.phoneInlineSelect}
                value={noteDraft.noteType}
                onChange={(e) => updateNoteDraft({ noteType: e.target.value as NoteType })}
              >
                {Object.entries(NOTE_TYPE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>
            <label className={styles.phoneFormField}>
              <span>正文</span>
              <textarea rows={5} value={noteDraft.body} onChange={(e) => updateNoteDraft({ body: e.target.value })} />
            </label>
            <label className={styles.phoneFormField}>
              <span>手动摘录</span>
              <textarea rows={3} value={noteDraft.quoteText} onChange={(e) => updateNoteDraft({ quoteText: e.target.value })} />
            </label>
            <button type="button" className={styles.phoneJournalPrimaryButton} onClick={saveNote}>保存笔记</button>
          </section>
        ) : selectedNote ? (
          <section className={styles.phoneReadingDetail} data-testid="phone-reading-note-detail">
            <span className={styles.phoneReadingChip}>{NOTE_TYPE_LABELS[selectedNote.metadata.noteType]}</span>
            <h2 className={styles.phoneReadingTitle}>{selectedNote.title}</h2>
            <p className={styles.phoneReadingMeta}>{formatDateTime(selectedNote.createdAt)}</p>
            <p className={styles.phoneReadingBody}>{selectedNote.content || '没有正文。'}</p>
            {selectedNote.metadata.quote ? (
              <blockquote className={styles.phoneReadingQuote}>{selectedNote.metadata.quote.text}</blockquote>
            ) : null}
            <button type="button" className={styles.phoneShortcutButton} onClick={deleteSelectedNote}>删除笔记</button>
          </section>
        ) : selectedBook ? (
          <section className={styles.phoneReadingDetail}>
            <h2 className={styles.phoneReadingTitle}>{selectedBook.title}</h2>
            {selectedBook.authors.length ? <p className={styles.phoneReadingMeta}>{selectedBook.authors.join(' / ')}</p> : null}
            {selectedBook.description ? <p className={styles.phoneReadingBody}>{selectedBook.description}</p> : null}
            {selectedBook.subjects?.length ? (
              <div className={styles.phoneTagRow}>
                {selectedBook.subjects.map((subject) => <span key={subject}>{subject}</span>)}
              </div>
            ) : null}
            <div className={styles.phoneReadingActions}>
              <button type="button" className={styles.phoneJournalPrimaryButton} onClick={openNoteForm}>新增笔记</button>
              <button type="button" className={styles.phoneShortcutButton} onClick={deleteSelectedBook}>删除书目</button>
            </div>
            {selectedBookNotes.length === 0 ? (
              <p className={styles.phoneJournalEmpty}>还没有这本书的阅读笔记。</p>
            ) : (
              <div className={styles.phoneReadingList}>
                {selectedBookNotes.map((note) => (
                  <button key={note.id} type="button" className={styles.phoneReadingCard} onClick={() => setSelectedNoteId(note.id)}>
                    <span className={styles.phoneReadingChip}>{NOTE_TYPE_LABELS[note.metadata.noteType]}</span>
                    <strong>{note.title}</strong>
                    <span>{excerpt(note.content)}</span>
                  </button>
                ))}
              </div>
            )}
          </section>
        ) : (
          <section className={styles.phoneReadingLayout}>
            <header className={styles.phoneReadingHeader}>
              <p className={styles.phoneReadingKicker}>READING NOTES</p>
              <h2 className={styles.phoneReadingTitle}>{displayName || ownerAgent?.name || 'TA'} 的阅读笔记</h2>
              <p className={styles.phoneReadingSafeNote}>本页只使用当前 agent 的本地书目和手动笔记。</p>
            </header>
            {books.length === 0 && !loading ? (
              <p className={styles.phoneJournalEmpty} data-testid="phone-reading-empty">还没有阅读书目。</p>
            ) : (
              <div className={styles.phoneReadingList}>
                {books.map((book) => (
                  <button key={book.id} type="button" className={styles.phoneReadingCard} onClick={() => setSelectedBookId(book.id)}>
                    <strong>{book.title}</strong>
                    <span>{book.authors.length ? book.authors.join(' / ') : '未填写作者'}</span>
                    {book.subjects?.length ? <small>{book.subjects.join(' · ')}</small> : null}
                  </button>
                ))}
              </div>
            )}
            <button type="button" className={styles.phoneJournalPrimaryButton} onClick={openBookForm}>新增书目</button>
          </section>
        )}
      </div>
    </div>
  );
}
