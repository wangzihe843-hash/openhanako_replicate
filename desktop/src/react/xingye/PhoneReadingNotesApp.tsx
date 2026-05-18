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
  confirmReadingNoteDraft,
  discardReadingNoteDraft,
  listReadingNoteDrafts,
  type ReadingNoteDraftType,
  type XingyePendingReadingNoteDraft,
} from './xingye-reading-notes-drafts';
import {
  deleteBookForAgent,
  importBooksForAgent,
  listBooksForAgent,
  type BookSearchResult,
  type XingyeBookCatalogEntry,
} from './xingye-reading-book-catalog';
import { searchOpenLibraryBooksViaProxy } from './xingye-open-library-adapter';
import {
  inferReadingTopicsWithAI,
  type XingyeReadingTopicSuggestion,
} from './xingye-reading-topics-ai';
import {
  fetchWikiquoteSuggestions,
  type WikiquoteSourceCitation,
  type WikiquoteSuggestion,
} from './xingye-wikiquote-adapter';
import {
  inferReadingAnnotationWithAI,
  type XingyeReadingAnnotation,
} from './xingye-reading-annotation-ai';
import type { XingyeRoleProfile } from './xingye-profile-store';

export interface PhoneReadingNotesAppProps {
  ownerAgent: Agent | null;
  ownerProfile?: XingyeRoleProfile | null;
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
    sourceCitation?: WikiquoteSourceCitation;
  };
  /** Hash 用于跨笔记去重——同一本书内同一段原文只允许批注一次。 */
  passageHash?: string;
  /** 'ai' 表示该笔记由模型基于用户选定的原文生成；缺省视为 manual。 */
  annotationSource?: 'ai' | 'manual';
  /** AI 给出的情绪标签，仅 annotationSource='ai' 时有意义。 */
  mood?: string;
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

type DiscoveryStatus = 'idle' | 'topic_loading' | 'search_loading' | 'error';

type DiscoveryResult = BookSearchResult & {
  importedId?: string;
};

type AppMode = 'list' | 'book_form' | 'note_form' | 'discover' | 'annotation';

type AnnotationStatus = 'idle' | 'suggestion_loading' | 'generating' | 'preview' | 'error';

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
    if (source && text) {
      quote = { source, text };
      const citation = record.sourceCitation as Record<string, unknown> | undefined;
      if (citation && citation.provider === 'wikiquote'
        && (citation.lang === 'en' || citation.lang === 'zh')
        && typeof citation.pageTitle === 'string' && typeof citation.pageUrl === 'string') {
        quote.sourceCitation = {
          provider: 'wikiquote',
          lang: citation.lang,
          pageTitle: citation.pageTitle,
          pageUrl: citation.pageUrl,
        };
      }
    }
  }
  const metadata: ReadingNoteMetadata = {
    bookId,
    noteType: normalizeNoteType(entry.metadata?.noteType),
  };
  if (quote) metadata.quote = quote;
  if (typeof entry.metadata?.passageHash === 'string' && entry.metadata.passageHash.trim()) {
    metadata.passageHash = entry.metadata.passageHash.trim();
  }
  if (entry.metadata?.annotationSource === 'ai' || entry.metadata?.annotationSource === 'manual') {
    metadata.annotationSource = entry.metadata.annotationSource;
  }
  if (typeof entry.metadata?.mood === 'string' && entry.metadata.mood.trim()) {
    metadata.mood = entry.metadata.mood.trim();
  }
  return {
    ...entry,
    appId: 'reading_notes',
    metadata,
  };
}

function normalizePassageForHash(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKC')
    // 先把标点（含中英文标点 + 符号）换成空格，避免相邻空格-标点-空格挤压时丢字
    .replace(/[\p{P}\p{S}]/gu, ' ')
    // 再把所有空白（含全角空格、不间断空格）压成一个空格
    .replace(/[\s　]+/g, ' ')
    .trim();
}

function hashPassage(text: string): string {
  const norm = normalizePassageForHash(text);
  if (!norm) return '';
  // 32-bit FNV-1a，仅用于本地去重 key
  let h = 0x811c9dc5;
  for (let i = 0; i < norm.length; i++) {
    h ^= norm.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return `p${h.toString(16)}_${norm.length}`;
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

export function PhoneReadingNotesApp({ ownerAgent, ownerProfile, displayName, onBack }: PhoneReadingNotesAppProps) {
  const ownerAgentId = ownerAgent?.id ?? '';
  const [books, setBooks] = useState<XingyeBookCatalogEntry[]>([]);
  const [notes, setNotes] = useState<ReadingNoteEntry[]>([]);
  const [selectedBookId, setSelectedBookId] = useState<string | null>(null);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [bookDraft, setBookDraft] = useState<BookDraft>(() => emptyBookDraft());
  const [noteDraft, setNoteDraft] = useState<NoteDraft>(() => emptyNoteDraft());
  const [mode, setMode] = useState<AppMode>('list');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [discoveryTopics, setDiscoveryTopics] = useState<XingyeReadingTopicSuggestion[]>([]);
  const [discoveryTopic, setDiscoveryTopic] = useState<XingyeReadingTopicSuggestion | null>(null);
  const [discoveryResults, setDiscoveryResults] = useState<DiscoveryResult[]>([]);
  const [discoveryStatus, setDiscoveryStatus] = useState<DiscoveryStatus>('idle');
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [discoveryImporting, setDiscoveryImporting] = useState<string | null>(null);
  const [annotationStatus, setAnnotationStatus] = useState<AnnotationStatus>('idle');
  const [annotationPassage, setAnnotationPassage] = useState<string>('');
  const [annotationCitation, setAnnotationCitation] = useState<WikiquoteSourceCitation | null>(null);
  const [annotationSuggestions, setAnnotationSuggestions] = useState<WikiquoteSuggestion[]>([]);
  const [annotationDraft, setAnnotationDraft] = useState<XingyeReadingAnnotation | null>(null);
  const [annotationError, setAnnotationError] = useState<string | null>(null);
  const [annotationSuggestionError, setAnnotationSuggestionError] = useState<string | null>(null);
  const [annotationSaving, setAnnotationSaving] = useState(false);
  /** 待确认草稿（心跳巡检产出，用户在 list home 顶部确认/丢弃）。 */
  const [pendingDrafts, setPendingDrafts] = useState<XingyePendingReadingNoteDraft[]>([]);
  const [draftEdits, setDraftEdits] = useState<
    Record<string, { title: string; body: string; noteType: ReadingNoteDraftType }>
  >({});
  const [draftBusyId, setDraftBusyId] = useState<string | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!ownerAgentId) {
      setBooks([]);
      setNotes([]);
      setPendingDrafts([]);
      setDraftEdits({});
      return;
    }
    setLoading(true);
    setMessage(null);
    try {
      const [bookRows, noteRows, draftRows] = await Promise.all([
        listBooksForAgent(ownerAgentId),
        listAppEntries(ownerAgentId, READING_NOTES_APP_ID),
        listReadingNoteDrafts(ownerAgentId),
      ]);
      setBooks(bookRows.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)));
      setNotes(noteRows
        .map(normalizeReadingNote)
        .filter((note): note is ReadingNoteEntry => Boolean(note))
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)));
      setPendingDrafts(draftRows);
    } catch (err) {
      setMessage(`加载失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }, [ownerAgentId]);

  const draftWorkingValue = useCallback(
    (d: XingyePendingReadingNoteDraft) => {
      const edit = draftEdits[d.id];
      if (edit) return edit;
      return { title: d.title, body: d.body, noteType: d.noteType };
    },
    [draftEdits],
  );

  const handleDraftFieldChange = (
    draftId: string,
    patch: Partial<{ title: string; body: string; noteType: ReadingNoteDraftType }>,
  ) => {
    setDraftEdits((prev) => {
      const d = pendingDrafts.find((entry) => entry.id === draftId);
      if (!d) return prev;
      const base = prev[draftId] ?? { title: d.title, body: d.body, noteType: d.noteType };
      return { ...prev, [draftId]: { ...base, ...patch } };
    });
  };

  /**
   * 在本地书架里按名字解析 bookHint → bookId。匹配规则与 files.folderHint 同款：
   *   1. 精确同名
   *   2. startsWith 互相匹配
   *   3. 都不行 → 不带 bookId（entry 落到「未归类批注」）
   */
  const resolveBookIdFromHint = useCallback(
    (hint: string | undefined): string | null => {
      const trimmed = (hint ?? '').trim();
      if (!trimmed) return null;
      const exact = books.find((b) => b.title === trimmed);
      if (exact) return exact.id;
      const prefix = books.find((b) => b.title.startsWith(trimmed) || trimmed.startsWith(b.title));
      return prefix ? prefix.id : null;
    },
    [books],
  );

  const handleConfirmDraft = async (d: XingyePendingReadingNoteDraft) => {
    if (!ownerAgentId) return;
    setDraftBusyId(d.id);
    setDraftError(null);
    try {
      const working = draftWorkingValue(d);
      const bookId = resolveBookIdFromHint(d.bookHint);
      const entry = await confirmReadingNoteDraft(ownerAgentId, d.id, {
        title: working.title,
        body: working.body,
        noteType: working.noteType,
        bookId: bookId,
      });
      const normalized = normalizeReadingNote(entry);
      if (normalized) {
        setNotes((prev) =>
          [normalized, ...prev.filter((p) => p.id !== normalized.id)].sort(
            (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
          ),
        );
      }
      setPendingDrafts((prev) => prev.filter((p) => p.id !== d.id));
      setDraftEdits((prev) => {
        if (!(d.id in prev)) return prev;
        const { [d.id]: _omitted, ...rest } = prev;
        return rest;
      });
    } catch (err) {
      setDraftError(err instanceof Error ? err.message : String(err));
    } finally {
      setDraftBusyId(null);
    }
  };

  const handleDiscardDraft = async (d: XingyePendingReadingNoteDraft) => {
    if (!ownerAgentId) return;
    if (!window.confirm('确定丢弃这条待确认读书批注草稿？此操作不可恢复，但角色可在下次巡检里重新提议。')) return;
    setDraftBusyId(d.id);
    setDraftError(null);
    try {
      const ok = await discardReadingNoteDraft(ownerAgentId, d.id);
      if (ok) {
        setPendingDrafts((prev) => prev.filter((p) => p.id !== d.id));
        setDraftEdits((prev) => {
          if (!(d.id in prev)) return prev;
          const { [d.id]: _omitted, ...rest } = prev;
          return rest;
        });
      } else {
        await reload();
      }
    } catch (err) {
      setDraftError(err instanceof Error ? err.message : String(err));
    } finally {
      setDraftBusyId(null);
    }
  };

  useEffect(() => {
    setSelectedBookId(null);
    setSelectedNoteId(null);
    setMode('list');
    setMessage(null);
    setDiscoveryTopics([]);
    setDiscoveryTopic(null);
    setDiscoveryResults([]);
    setDiscoveryStatus('idle');
    setDiscoveryError(null);
    setDiscoveryImporting(null);
    setAnnotationStatus('idle');
    setAnnotationPassage('');
    setAnnotationCitation(null);
    setAnnotationSuggestions([]);
    setAnnotationDraft(null);
    setAnnotationError(null);
    setAnnotationSuggestionError(null);
    setAnnotationSaving(false);
    void reload();
    // ownerProfile/agent-name changes don't need to reset discovery; only the agent identity does.
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

  const openDiscover = async () => {
    if (!ownerAgent) return;
    setMode('discover');
    setMessage(null);
    setDiscoveryTopics([]);
    setDiscoveryTopic(null);
    setDiscoveryResults([]);
    setDiscoveryError(null);
    setDiscoveryStatus('topic_loading');
    try {
      const topics = await inferReadingTopicsWithAI({
        agent: ownerAgent,
        ownerProfile: ownerProfile ?? null,
      });
      setDiscoveryTopics(topics);
      setDiscoveryStatus('idle');
    } catch (err) {
      setDiscoveryError(`类别推断失败：${err instanceof Error ? err.message : String(err)}`);
      setDiscoveryStatus('error');
    }
  };

  const runDiscoverySearch = async (topic: XingyeReadingTopicSuggestion) => {
    const subject = topic.subject.trim();
    if (!ownerAgentId || !subject) return;
    setDiscoveryTopic(topic);
    setDiscoveryStatus('search_loading');
    setDiscoveryError(null);
    setDiscoveryResults([]);
    try {
      const found = await searchOpenLibraryBooksViaProxy({ subject, limit: 12 });
      setDiscoveryResults(found.map((book) => ({ ...book })));
      setDiscoveryStatus('idle');
    } catch (err) {
      setDiscoveryError(err instanceof Error ? err.message : String(err));
      setDiscoveryStatus('error');
    }
  };

  const importDiscoveredBook = async (candidate: DiscoveryResult) => {
    if (!ownerAgentId || discoveryImporting) return;
    const topic = discoveryTopic;
    const subject = topic?.subject ?? '';
    const reasonParts: string[] = [];
    if (topic?.label) reasonParts.push(topic.label);
    if (subject) reasonParts.push(subject);
    const reason = reasonParts.length
      ? `topic search: ${reasonParts.join(' / ')}${topic?.reason ? ` — ${topic.reason}` : ''}`
      : 'topic search';
    setDiscoveryImporting(candidate.key || candidate.title);
    try {
      const imported = await importBooksForAgent(ownerAgentId, [{
        key: candidate.key,
        title: candidate.title,
        authors: candidate.authors,
        subjects: candidate.subjects,
        firstPublishYear: candidate.firstPublishYear,
        languages: candidate.languages,
        coverId: candidate.coverId,
        isbn: candidate.isbn,
        openLibraryUrl: candidate.openLibraryUrl,
      }], {
        reason,
        interests: subject ? [subject] : [],
      });
      setBooks((prev) => [
        ...imported,
        ...prev.filter((item) => !imported.some((row) => row.id === item.id)),
      ]);
      const importedId = imported[0]?.id;
      setDiscoveryResults((prev) => prev.map((row) => (
        row.key === candidate.key && row.title === candidate.title
          ? { ...row, importedId }
          : row
      )));
    } catch (err) {
      setDiscoveryError(`加入书目失败：${err instanceof Error ? err.message : String(err)}`);
      setDiscoveryStatus('error');
    } finally {
      setDiscoveryImporting(null);
    }
  };

  const openNoteForm = () => {
    setNoteDraft(emptyNoteDraft());
    setSelectedNoteId(null);
    setMode('note_form');
    setMessage(null);
  };

  const openAnnotationForm = async () => {
    if (!ownerAgent || !selectedBook) return;
    setMode('annotation');
    setMessage(null);
    setAnnotationStatus('idle');
    setAnnotationPassage('');
    setAnnotationCitation(null);
    setAnnotationSuggestions([]);
    setAnnotationDraft(null);
    setAnnotationError(null);
    setAnnotationSuggestionError(null);

    setAnnotationStatus('suggestion_loading');
    try {
      const suggestions = await fetchWikiquoteSuggestions({
        title: selectedBook.title,
        authors: selectedBook.authors,
        lang: /[一-鿿]/.test(selectedBook.title) ? 'zh' : 'en',
      });
      setAnnotationSuggestions(suggestions);
    } catch (err) {
      setAnnotationSuggestionError(err instanceof Error ? err.message : String(err));
    } finally {
      setAnnotationStatus((s) => (s === 'suggestion_loading' ? 'idle' : s));
    }
  };

  const pickAnnotationSuggestion = (suggestion: WikiquoteSuggestion) => {
    setAnnotationPassage(suggestion.text);
    setAnnotationCitation(suggestion.sourceCitation);
    setAnnotationError(null);
    setAnnotationDraft(null);
    if (annotationStatus === 'preview' || annotationStatus === 'error') {
      setAnnotationStatus('idle');
    }
  };

  const passageAlreadyAnnotated = (passage: string): ReadingNoteEntry | null => {
    if (!selectedBook) return null;
    const hash = hashPassage(passage);
    if (!hash) return null;
    for (const note of selectedBookNotes) {
      const existing = note.metadata.passageHash;
      if (existing && existing === hash) return note;
      // 兜底：旧笔记没存 hash，用 quote.text 再算一次
      if (!existing && note.metadata.quote?.text && hashPassage(note.metadata.quote.text) === hash) {
        return note;
      }
    }
    return null;
  };

  const generateAnnotation = async () => {
    if (!ownerAgent || !selectedBook) return;
    const passage = annotationPassage.trim();
    if (passage.length < 4) {
      setAnnotationError('原文太短，至少 4 个字。');
      setAnnotationStatus('error');
      return;
    }
    const dup = passageAlreadyAnnotated(passage);
    if (dup) {
      setAnnotationError(`这段原文已经批注过：《${dup.title || '未命名笔记'}》`);
      setAnnotationStatus('error');
      return;
    }
    setAnnotationStatus('generating');
    setAnnotationError(null);
    try {
      const draft = await inferReadingAnnotationWithAI({
        agent: ownerAgent,
        ownerProfile: ownerProfile ?? null,
        book: {
          title: selectedBook.title,
          authors: selectedBook.authors,
          subjects: selectedBook.subjects,
          description: selectedBook.description,
        },
        passage,
        passageCitation: annotationCitation ?? undefined,
      });
      setAnnotationDraft(draft);
      setAnnotationStatus('preview');
    } catch (err) {
      setAnnotationError(`批注生成失败：${err instanceof Error ? err.message : String(err)}`);
      setAnnotationStatus('error');
    }
  };

  const updateAnnotationDraft = (patch: Partial<XingyeReadingAnnotation>) => {
    setAnnotationDraft((prev) => (prev ? { ...prev, ...patch } : prev));
  };

  const saveAnnotation = async () => {
    if (!ownerAgentId || !selectedBook || !annotationDraft) return;
    const passage = annotationPassage.trim();
    if (!passage) {
      setAnnotationError('原文不能为空。');
      setAnnotationStatus('error');
      return;
    }
    const dup = passageAlreadyAnnotated(passage);
    if (dup) {
      setAnnotationError(`这段原文已经批注过：《${dup.title || '未命名笔记'}》`);
      setAnnotationStatus('error');
      return;
    }
    const hash = hashPassage(passage);
    const quote: Record<string, unknown> = {
      text: passage,
      source: 'user_provided',
    };
    if (annotationCitation) quote.sourceCitation = annotationCitation;
    const metadata: Record<string, unknown> = {
      bookId: selectedBook.id,
      noteType: 'reading_note',
      quote,
      passageHash: hash,
      annotationSource: 'ai',
    };
    if (annotationDraft.mood) metadata.mood = annotationDraft.mood;
    setAnnotationSaving(true);
    try {
      const row = normalizeReadingNote(await appendAppEntry(
        ownerAgentId,
        READING_NOTES_APP_ID,
        {
          title: annotationDraft.title.trim() || '未命名批注',
          content: annotationDraft.annotation.trim(),
          source: 'ai_annotation',
          metadata,
        },
      ));
      if (row) setNotes((prev) => [row, ...prev.filter((note) => note.id !== row.id)]);
      setMode('list');
      setAnnotationStatus('idle');
      setAnnotationPassage('');
      setAnnotationCitation(null);
      setAnnotationDraft(null);
      setAnnotationError(null);
    } catch (err) {
      setAnnotationError(`保存失败：${err instanceof Error ? err.message : String(err)}`);
      setAnnotationStatus('error');
    } finally {
      setAnnotationSaving(false);
    }
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

        {mode === 'discover' ? (
          <section className={styles.phoneReadingEditor} aria-label="帮 TA 找书">
            <h2 className={styles.phoneReadingTitle}>帮 TA 找书</h2>
            <p className={styles.phoneReadingSafeNote}>
              由模型基于 TA 的画像、最近聊天与常驻设定推断可能感兴趣的英文书籍类别，再调 Open Library subject API 拉候选书目。只显示元信息，不抓书摘、不生成引用。
            </p>
            {discoveryStatus === 'topic_loading' ? (
              <p className={styles.phoneAppHint}>正在让模型推断 TA 的阅读偏好…</p>
            ) : null}
            {discoveryTopics.length === 0 && discoveryStatus !== 'topic_loading' && discoveryStatus !== 'error' ? (
              <p className={styles.phoneJournalEmpty} data-testid="phone-reading-discover-empty">
                还没有可用的阅读类别。先在角色面板补充身份、性格或 lore，再回来试。
              </p>
            ) : null}
            {discoveryTopics.length > 0 ? (
              <div className={styles.phoneTagRow} data-testid="phone-reading-discover-topics">
                {discoveryTopics.map((topic) => (
                  <button
                    key={topic.subject}
                    type="button"
                    className={styles.phoneReadingChip}
                    aria-pressed={discoveryTopic?.subject === topic.subject}
                    title={topic.reason ? `${topic.subject} — ${topic.reason}` : topic.subject}
                    onClick={() => void runDiscoverySearch(topic)}
                  >
                    {topic.label}
                  </button>
                ))}
              </div>
            ) : null}
            {discoveryTopic?.reason ? (
              <p className={styles.phoneReadingSafeNote}>选中类别原因：{discoveryTopic.reason}（Open Library subject: <code>{discoveryTopic.subject}</code>）</p>
            ) : null}
            {discoveryStatus === 'search_loading' && discoveryTopic ? (
              <p className={styles.phoneAppHint}>
                正在查询「{discoveryTopic.label}」的候选书目…
              </p>
            ) : null}
            {discoveryStatus === 'error' && discoveryError ? (
              <p className={styles.phoneAppHint} role="alert">
                {discoveryError}
              </p>
            ) : null}
            {discoveryStatus === 'idle' && discoveryTopic && discoveryResults.length === 0 ? (
              <p className={styles.phoneJournalEmpty}>没找到「{discoveryTopic.label}」相关书目，换个类别试试。</p>
            ) : null}
            {discoveryResults.length > 0 ? (
              <div className={styles.phoneReadingList} data-testid="phone-reading-discover-results">
                {discoveryResults.map((candidate) => {
                  const candidateKey = candidate.key || `${candidate.title}::${candidate.authors.join('|')}`;
                  const importing = discoveryImporting === (candidate.key || candidate.title);
                  return (
                    <div key={candidateKey} className={styles.phoneReadingCard}>
                      <strong>{candidate.title}</strong>
                      <span>{candidate.authors.length ? candidate.authors.join(' / ') : '未列作者'}</span>
                      {candidate.subjects?.length ? <small>{candidate.subjects.slice(0, 4).join(' · ')}</small> : null}
                      {candidate.openLibraryUrl ? (
                        <small>{candidate.openLibraryUrl}</small>
                      ) : null}
                      <button
                        type="button"
                        className={styles.phoneJournalPrimaryButton}
                        disabled={Boolean(candidate.importedId) || importing}
                        onClick={() => void importDiscoveredBook(candidate)}
                      >
                        {candidate.importedId ? '已加入书目' : importing ? '加入中…' : '加入书目'}
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </section>
        ) : mode === 'annotation' && selectedBook ? (
          <section className={styles.phoneReadingEditor} aria-label="让 TA 批注">
            <h2 className={styles.phoneReadingTitle}>让 TA 批注：{selectedBook.title}</h2>
            <p className={styles.phoneReadingSafeNote}>
              先放原文（手动粘贴或选 Wikiquote 建议），再让模型基于 TA 的身份/最近聊天/lore/巡检记录给中文批注。原文严禁由模型创造；同一段原文只能批注一次。
            </p>

            <label className={styles.phoneFormField}>
              <span>原文（用户提供）</span>
              <textarea
                rows={5}
                value={annotationPassage}
                onChange={(e) => {
                  setAnnotationPassage(e.target.value);
                  if (annotationCitation) setAnnotationCitation(null);
                  if (annotationStatus === 'preview' || annotationStatus === 'error') setAnnotationStatus('idle');
                  if (annotationError) setAnnotationError(null);
                  if (annotationDraft) setAnnotationDraft(null);
                }}
                placeholder="把你想批注的那段原文粘进来。"
              />
            </label>
            {annotationCitation ? (
              <p className={styles.phoneReadingQuoteCitation}>
                来自 {annotationCitation.provider}（{annotationCitation.pageTitle}）· {annotationCitation.pageUrl}
              </p>
            ) : null}

            {annotationStatus === 'suggestion_loading' ? (
              <p className={styles.phoneAppHint}>正在向 Wikiquote 找一些候选原文…</p>
            ) : null}
            {annotationSuggestionError ? (
              <p className={styles.phoneAppHint}>Wikiquote 建议不可用：{annotationSuggestionError}</p>
            ) : null}
            {annotationSuggestions.length > 0 ? (
              <div data-testid="phone-reading-annotation-suggestions">
                <p className={styles.phoneReadingSafeNote}>从 Wikiquote 找到几句候选，点一条会自动填到上面：</p>
                <div className={styles.phoneReadingList}>
                  {annotationSuggestions.map((suggestion, idx) => (
                    <button
                      key={`${suggestion.sourceCitation.pageUrl}#${idx}`}
                      type="button"
                      className={styles.phoneReadingCard}
                      onClick={() => pickAnnotationSuggestion(suggestion)}
                    >
                      <span>{suggestion.text}</span>
                      <small>{suggestion.sourceCitation.pageTitle}</small>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {annotationStatus === 'generating' ? (
              <p className={styles.phoneAppHint}>TA 正在批注这一段…</p>
            ) : null}
            {annotationStatus === 'error' && annotationError ? (
              <p className={styles.phoneAppHint} role="alert">{annotationError}</p>
            ) : null}

            {annotationDraft && annotationStatus === 'preview' ? (
              <div className={styles.phoneReadingAnnotationCard} data-testid="phone-reading-annotation-preview">
                <label className={styles.phoneFormField}>
                  <span>笔记标题</span>
                  <input
                    value={annotationDraft.title}
                    onChange={(e) => updateAnnotationDraft({ title: e.target.value })}
                  />
                </label>
                <blockquote className={styles.phoneReadingQuote}>{annotationPassage.trim()}</blockquote>
                <label className={styles.phoneFormField}>
                  <span>TA 的批注（中文，可改）</span>
                  <textarea
                    className={styles.phoneReadingHandwriting}
                    rows={5}
                    value={annotationDraft.annotation}
                    onChange={(e) => updateAnnotationDraft({ annotation: e.target.value })}
                  />
                </label>
                {annotationDraft.mood ? (
                  <p className={styles.phoneReadingAnnotationMood}>情绪标签：{annotationDraft.mood}</p>
                ) : null}
              </div>
            ) : null}

            <div className={styles.phoneReadingActions}>
              {annotationStatus === 'preview' && annotationDraft ? (
                <>
                  <button
                    type="button"
                    className={styles.phoneJournalPrimaryButton}
                    disabled={annotationSaving}
                    onClick={() => void saveAnnotation()}
                  >
                    {annotationSaving ? '保存中…' : '保存批注'}
                  </button>
                  <button
                    type="button"
                    className={styles.phoneShortcutButton}
                    disabled={annotationSaving}
                    onClick={() => void generateAnnotation()}
                  >
                    再来一版
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className={styles.phoneJournalPrimaryButton}
                  disabled={annotationStatus === 'generating' || annotationStatus === 'suggestion_loading' || !annotationPassage.trim()}
                  onClick={() => void generateAnnotation()}
                >
                  {annotationStatus === 'generating' ? '生成中…' : '让 TA 批注'}
                </button>
              )}
            </div>
          </section>
        ) : mode === 'book_form' ? (
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
            <span className={styles.phoneReadingChip}>
              {NOTE_TYPE_LABELS[selectedNote.metadata.noteType]}
              {selectedNote.metadata.annotationSource === 'ai' ? ' · TA 批注' : ''}
            </span>
            <h2 className={styles.phoneReadingTitle}>{selectedNote.title}</h2>
            <p className={styles.phoneReadingMeta}>
              {formatDateTime(selectedNote.createdAt)}
              {selectedNote.metadata.mood ? ` · 情绪：${selectedNote.metadata.mood}` : ''}
            </p>
            {selectedNote.metadata.quote ? (
              <>
                <blockquote className={styles.phoneReadingQuote}>{selectedNote.metadata.quote.text}</blockquote>
                {selectedNote.metadata.quote.sourceCitation ? (
                  <p className={styles.phoneReadingQuoteCitation}>
                    来自 {selectedNote.metadata.quote.sourceCitation.provider}（{selectedNote.metadata.quote.sourceCitation.pageTitle}）·{' '}
                    {selectedNote.metadata.quote.sourceCitation.pageUrl}
                  </p>
                ) : null}
              </>
            ) : null}
            <p
              className={selectedNote.metadata.annotationSource === 'ai'
                ? `${styles.phoneReadingBody} ${styles.phoneReadingHandwriting}`
                : styles.phoneReadingBody}
            >
              {selectedNote.content || '没有正文。'}
            </p>
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
              <button type="button" className={styles.phoneJournalPrimaryButton} onClick={openNoteForm}>手写笔记</button>
              <button type="button" className={styles.phoneJournalPrimaryButton} onClick={() => void openAnnotationForm()}>让 TA 批注</button>
              <button type="button" className={styles.phoneShortcutButton} onClick={deleteSelectedBook}>删除书目</button>
            </div>
            {selectedBookNotes.length === 0 ? (
              <p className={styles.phoneJournalEmpty}>还没有这本书的阅读笔记。</p>
            ) : (
              <div className={styles.phoneReadingList}>
                {selectedBookNotes.map((note) => (
                  <button key={note.id} type="button" className={styles.phoneReadingCard} onClick={() => setSelectedNoteId(note.id)}>
                    <span className={styles.phoneReadingChip}>
                      {NOTE_TYPE_LABELS[note.metadata.noteType]}
                      {note.metadata.annotationSource === 'ai' ? ' · TA 批注' : ''}
                    </span>
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

            {pendingDrafts.length > 0 ? (
              <section
                aria-label="待确认读书批注草稿"
                data-testid="phone-reading-pending-drafts"
                style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
              >
                <p className={styles.phoneReadingSafeNote}>
                  待确认草稿 · 来自心跳巡检。TA 在巡检里想留下的批注，还没出现在「已生成」列表里。
                  点「确认生成」才会真正写入；离开页面再回来不会丢草稿。
                </p>
                {draftError ? (
                  <p className={styles.phoneAppHint} role="alert">{draftError}</p>
                ) : null}
                {pendingDrafts.map((d) => {
                  const working = draftWorkingValue(d);
                  const busy = draftBusyId === d.id;
                  return (
                    <div
                      key={d.id}
                      className={styles.phoneReadingCard}
                      style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 6 }}
                      data-testid={`phone-reading-draft-${d.id}`}
                    >
                      <input
                        type="text"
                        value={working.title}
                        onChange={(e) => handleDraftFieldChange(d.id, { title: e.target.value })}
                        placeholder="批注标题"
                        aria-label="待确认批注标题"
                        data-testid={`phone-reading-draft-title-${d.id}`}
                        disabled={busy}
                        style={{ font: 'inherit', background: 'transparent', border: '1px dashed rgba(0,0,0,0.2)', padding: '4px 6px' }}
                      />
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                        <span className={styles.phoneReadingChip}>{NOTE_TYPE_LABELS[working.noteType]}</span>
                        <select
                          value={working.noteType}
                          onChange={(e) => handleDraftFieldChange(d.id, { noteType: e.target.value as ReadingNoteDraftType })}
                          disabled={busy}
                          aria-label="待确认批注类型"
                          data-testid={`phone-reading-draft-type-${d.id}`}
                          style={{ font: 'inherit', background: 'transparent', border: '1px dashed rgba(0,0,0,0.2)', padding: '4px 6px' }}
                        >
                          <option value="reading_note">批注</option>
                          <option value="question">提问</option>
                        </select>
                        {d.bookHint ? (
                          <span className={styles.phoneAppHint} style={{ margin: 0 }}>
                            建议归《{d.bookHint}》
                            {resolveBookIdFromHint(d.bookHint) ? '（已匹配本地书）' : '（书架未匹配，会落到「未归类」）'}
                          </span>
                        ) : null}
                      </div>
                      {d.quoteText ? (
                        <blockquote className={styles.phoneReadingQuote} style={{ margin: 0 }}>{d.quoteText}</blockquote>
                      ) : null}
                      <textarea
                        value={working.body}
                        onChange={(e) => handleDraftFieldChange(d.id, { body: e.target.value })}
                        rows={4}
                        placeholder="批注正文"
                        aria-label="待确认批注正文"
                        data-testid={`phone-reading-draft-body-${d.id}`}
                        disabled={busy}
                        style={{ width: '100%', font: 'inherit', background: 'transparent', border: '1px dashed rgba(0,0,0,0.2)', padding: '6px' }}
                      />
                      {d.reason ? (
                        <p className={styles.phoneAppHint} style={{ margin: 0 }}>理由：{d.reason}</p>
                      ) : null}
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <button
                          type="button"
                          className={styles.phoneJournalPrimaryButton}
                          onClick={() => void handleConfirmDraft(d)}
                          disabled={busy}
                          data-testid={`phone-reading-draft-confirm-${d.id}`}
                        >
                          {busy ? '处理中…' : '确认生成'}
                        </button>
                        <button
                          type="button"
                          className={styles.phoneShortcutButton}
                          onClick={() => void handleDiscardDraft(d)}
                          disabled={busy}
                          data-testid={`phone-reading-draft-discard-${d.id}`}
                        >
                          丢弃
                        </button>
                      </div>
                    </div>
                  );
                })}
              </section>
            ) : null}

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
            <div className={styles.phoneReadingActions}>
              <button type="button" className={styles.phoneJournalPrimaryButton} onClick={openBookForm}>新增书目</button>
              <button type="button" className={styles.phoneShortcutButton} onClick={openDiscover}>帮 TA 找书</button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
