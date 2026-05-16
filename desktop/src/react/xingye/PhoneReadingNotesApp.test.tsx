/**
 * @vitest-environment jsdom
 */

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../types';
import type {
  AgentBookTagContext,
  BookSearchResult,
} from './xingye-reading-book-catalog';

const catalogMock = vi.hoisted(() => ({
  deleteBookForAgent: vi.fn(),
  importBooksForAgent: vi.fn(),
  listBooksForAgent: vi.fn(),
}));

const appEntryStoreMock = vi.hoisted(() => ({
  appendAppEntry: vi.fn(),
  deleteAppEntry: vi.fn(),
  listAppEntries: vi.fn(),
}));

const openLibraryMock = vi.hoisted(() => ({
  searchOpenLibraryBooks: vi.fn(),
  searchOpenLibraryBooksViaProxy: vi.fn(),
}));

const readingTopicsAiMock = vi.hoisted(() => ({
  inferReadingTopicsWithAI: vi.fn(),
}));

const wikiquoteMock = vi.hoisted(() => ({
  fetchWikiquoteSuggestions: vi.fn(),
}));

const annotationAiMock = vi.hoisted(() => ({
  inferReadingAnnotationWithAI: vi.fn(),
}));

vi.mock('./xingye-reading-book-catalog', () => catalogMock);
vi.mock('./xingye-app-entry-store', () => appEntryStoreMock);
vi.mock('./xingye-open-library-adapter', () => openLibraryMock);
vi.mock('./xingye-reading-topics-ai', () => readingTopicsAiMock);
vi.mock('./xingye-wikiquote-adapter', () => wikiquoteMock);
vi.mock('./xingye-reading-annotation-ai', () => annotationAiMock);

import { PhoneReadingNotesApp } from './PhoneReadingNotesApp';
import type { XingyeRoleProfile } from './xingye-profile-store';

const linwu: Agent = {
  id: 'test01',
  name: '林雾',
  yuan: 'hanako',
  isPrimary: false,
  hasAvatar: false,
};

const linwuProfile: XingyeRoleProfile = {
  agentId: 'test01',
  displayName: '林雾',
  shortBio: '战地医生，喜欢冬天。',
  personalitySummary: '克制，关注创伤恢复。',
  updatedAt: '2026-05-16T00:00:00.000Z',
};

function renderReadingNotes(agent: Agent | null = linwu, profile: XingyeRoleProfile | null = null) {
  return render(
    <PhoneReadingNotesApp
      ownerAgent={agent}
      ownerProfile={profile}
      displayName={agent?.name ?? 'TA'}
      onBack={vi.fn()}
    />,
  );
}

describe('PhoneReadingNotesApp', () => {
  beforeEach(() => {
    catalogMock.deleteBookForAgent.mockReset();
    catalogMock.importBooksForAgent.mockReset();
    catalogMock.listBooksForAgent.mockReset();
    appEntryStoreMock.appendAppEntry.mockReset();
    appEntryStoreMock.deleteAppEntry.mockReset();
    appEntryStoreMock.listAppEntries.mockReset();

    catalogMock.listBooksForAgent.mockResolvedValue([]);
    appEntryStoreMock.listAppEntries.mockResolvedValue([]);
    catalogMock.importBooksForAgent.mockImplementation(async (
      agentId: string,
      books: BookSearchResult[],
      tagContext: AgentBookTagContext,
    ) => books.map((book, index) => ({
      ...book,
      id: `book-${index + 1}`,
      dedupeKey: book.key,
      agentTags: [{ agentId, reason: tagContext.reason, interests: tagContext.interests, createdAt: '2026-05-16T01:00:00.000Z' }],
      createdAt: '2026-05-16T01:00:00.000Z',
      updatedAt: '2026-05-16T01:00:00.000Z',
    })));
    appEntryStoreMock.appendAppEntry.mockImplementation(async (agentId, appId, input) => ({
      id: 'note-created',
      agentId,
      appId,
      title: input.title,
      content: input.content,
      metadata: input.metadata,
      source: input.source,
      createdAt: '2026-05-16T02:00:00.000Z',
      updatedAt: '2026-05-16T02:00:00.000Z',
    }));
    appEntryStoreMock.deleteAppEntry.mockResolvedValue(true);
    catalogMock.deleteBookForAgent.mockResolvedValue(true);

    openLibraryMock.searchOpenLibraryBooks.mockReset();
    openLibraryMock.searchOpenLibraryBooksViaProxy.mockReset();
    readingTopicsAiMock.inferReadingTopicsWithAI.mockReset();
    readingTopicsAiMock.inferReadingTopicsWithAI.mockResolvedValue([]);
    wikiquoteMock.fetchWikiquoteSuggestions.mockReset();
    wikiquoteMock.fetchWikiquoteSuggestions.mockResolvedValue([]);
    annotationAiMock.inferReadingAnnotationWithAI.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('loads only the current agent books and creates a manual local book', async () => {
    renderReadingNotes();

    await waitFor(() => {
      expect(catalogMock.listBooksForAgent).toHaveBeenCalledWith('test01');
    });
    expect(appEntryStoreMock.listAppEntries).toHaveBeenCalledWith('test01', 'reading_notes');
    expect(screen.getByTestId('phone-reading-empty')).toHaveTextContent('还没有阅读书目');

    fireEvent.click(screen.getByRole('button', { name: '新增书目' }));
    fireEvent.change(screen.getByLabelText('书名'), { target: { value: '雪线急救手册' } });
    fireEvent.change(screen.getByLabelText('作者'), { target: { value: '林地出版社' } });
    fireEvent.change(screen.getByLabelText('主题'), { target: { value: '医疗, 雪地' } });
    fireEvent.change(screen.getByLabelText('备注'), { target: { value: '给林雾手动加入。' } });
    fireEvent.click(screen.getByRole('button', { name: '保存书目' }));

    await waitFor(() => {
      expect(catalogMock.importBooksForAgent).toHaveBeenCalledWith('test01', [{
        key: 'manual:test01:雪线急救手册',
        title: '雪线急救手册',
        authors: ['林地出版社'],
        subjects: ['医疗', '雪地'],
        description: '给林雾手动加入。',
      }], {
        reason: 'manual',
        interests: ['医疗', '雪地'],
      });
    });
  });

  it('opens a book, creates a manual note, and stores quote only as manual metadata', async () => {
    catalogMock.listBooksForAgent.mockResolvedValueOnce([{
      id: 'book-1',
      key: 'manual:test01:book',
      dedupeKey: 'manual:test01:book',
      title: '雪线急救手册',
      authors: ['林地出版社'],
      subjects: ['医疗'],
      description: '只含书目 metadata。',
      agentTags: [{ agentId: 'test01', reason: 'manual', interests: ['医疗'], createdAt: '2026-05-16T01:00:00.000Z' }],
      createdAt: '2026-05-16T01:00:00.000Z',
      updatedAt: '2026-05-16T01:00:00.000Z',
    }]);
    appEntryStoreMock.listAppEntries.mockResolvedValueOnce([]);

    renderReadingNotes();
    fireEvent.click(await screen.findByRole('button', { name: /雪线急救手册/ }));
    expect(screen.getByText('只含书目 metadata。')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '手写笔记' }));
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '预读问题' } });
    fireEvent.change(screen.getByLabelText('类型'), { target: { value: 'question' } });
    fireEvent.change(screen.getByLabelText('正文'), { target: { value: '我想先确认雪地失温处理顺序。' } });
    fireEvent.change(screen.getByLabelText('手动摘录'), { target: { value: '用户自己录入的一句话。' } });
    fireEvent.click(screen.getByRole('button', { name: '保存笔记' }));

    await waitFor(() => {
      expect(appEntryStoreMock.appendAppEntry).toHaveBeenCalledWith('test01', 'reading_notes', {
        title: '预读问题',
        content: '我想先确认雪地失温处理顺序。',
        source: 'manual',
        metadata: {
          bookId: 'book-1',
          noteType: 'question',
          quote: {
            text: '用户自己录入的一句话。',
            source: 'manual',
          },
        },
      });
    });
  });

  it('shows notes for the selected book and deletes one note without touching the other', async () => {
    catalogMock.listBooksForAgent.mockResolvedValueOnce([{
      id: 'book-1',
      key: 'manual:test01:book',
      dedupeKey: 'manual:test01:book',
      title: '雪线急救手册',
      authors: ['林地出版社'],
      subjects: ['医疗'],
      agentTags: [{ agentId: 'test01', reason: 'manual', interests: ['医疗'], createdAt: '2026-05-16T01:00:00.000Z' }],
      createdAt: '2026-05-16T01:00:00.000Z',
      updatedAt: '2026-05-16T01:00:00.000Z',
    }]);
    appEntryStoreMock.listAppEntries.mockResolvedValueOnce([
      {
        id: 'note-1',
        agentId: 'test01',
        appId: 'reading_notes',
        title: '想读',
        content: '先看目录。',
        metadata: { bookId: 'book-1', noteType: 'want_to_read' },
        source: 'manual',
        createdAt: '2026-05-16T02:00:00.000Z',
        updatedAt: '2026-05-16T02:00:00.000Z',
      },
      {
        id: 'note-2',
        agentId: 'test01',
        appId: 'reading_notes',
        title: '问题',
        content: '哪些章节和急救有关？',
        metadata: { bookId: 'book-1', noteType: 'question' },
        source: 'manual',
        createdAt: '2026-05-16T03:00:00.000Z',
        updatedAt: '2026-05-16T03:00:00.000Z',
      },
    ]);
    vi.spyOn(window, 'confirm').mockReturnValueOnce(true);

    renderReadingNotes();
    fireEvent.click(await screen.findByRole('button', { name: /雪线急救手册/ }));
    fireEvent.click(screen.getByRole('button', { name: /想读/ }));

    expect(screen.getByText('先看目录。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '删除笔记' }));

    await waitFor(() => {
      expect(appEntryStoreMock.deleteAppEntry).toHaveBeenCalledWith('test01', 'reading_notes', 'note-1');
    });
    expect(screen.queryByText('想读')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /问题/ })).toBeInTheDocument();
  });

  it('blocks deleting a local book when it already has notes', async () => {
    catalogMock.listBooksForAgent.mockResolvedValueOnce([{
      id: 'book-1',
      key: 'manual:test01:book',
      dedupeKey: 'manual:test01:book',
      title: '雪线急救手册',
      authors: [],
      subjects: [],
      agentTags: [{ agentId: 'test01', reason: 'manual', interests: [], createdAt: '2026-05-16T01:00:00.000Z' }],
      createdAt: '2026-05-16T01:00:00.000Z',
      updatedAt: '2026-05-16T01:00:00.000Z',
    }]);
    appEntryStoreMock.listAppEntries.mockResolvedValueOnce([{
      id: 'note-1',
      agentId: 'test01',
      appId: 'reading_notes',
      title: '想读',
      content: '先看目录。',
      metadata: { bookId: 'book-1', noteType: 'want_to_read' },
      source: 'manual',
      createdAt: '2026-05-16T02:00:00.000Z',
      updatedAt: '2026-05-16T02:00:00.000Z',
    }]);

    renderReadingNotes();
    fireEvent.click(await screen.findByRole('button', { name: /雪线急救手册/ }));
    fireEvent.click(screen.getByRole('button', { name: '删除书目' }));

    expect(screen.getByRole('alert')).toHaveTextContent('已有阅读笔记，先删除笔记后再删除书目');
    expect(catalogMock.deleteBookForAgent).not.toHaveBeenCalled();
  });

  it('does not show another agent books or notes when rendered for Hanako', async () => {
    const hanako = { ...linwu, id: 'hanako', name: 'Hanako' };
    catalogMock.listBooksForAgent.mockResolvedValueOnce([]);
    appEntryStoreMock.listAppEntries.mockResolvedValueOnce([]);

    renderReadingNotes(hanako);

    await waitFor(() => {
      expect(catalogMock.listBooksForAgent).toHaveBeenCalledWith('hanako');
    });
    expect(catalogMock.listBooksForAgent).not.toHaveBeenCalledWith('test01');
    expect(appEntryStoreMock.listAppEntries).toHaveBeenCalledWith('hanako', 'reading_notes');
    expect(screen.queryByText('雪线急救手册')).not.toBeInTheDocument();
  });

  it('renders only manual or user_provided quote sources in note details', async () => {
    catalogMock.listBooksForAgent.mockResolvedValueOnce([{
      id: 'book-1',
      key: 'manual:test01:book',
      dedupeKey: 'manual:test01:book',
      title: '雪线急救手册',
      authors: [],
      subjects: [],
      agentTags: [{ agentId: 'test01', reason: 'manual', interests: [], createdAt: '2026-05-16T01:00:00.000Z' }],
      createdAt: '2026-05-16T01:00:00.000Z',
      updatedAt: '2026-05-16T01:00:00.000Z',
    }]);
    appEntryStoreMock.listAppEntries.mockResolvedValueOnce([
      {
        id: 'note-1',
        agentId: 'test01',
        appId: 'reading_notes',
        title: '手动摘录',
        content: '用户自己记录。',
        metadata: { bookId: 'book-1', noteType: 'pre_read', quote: { text: '可显示', source: 'user_provided' } },
        source: 'manual',
        createdAt: '2026-05-16T02:00:00.000Z',
        updatedAt: '2026-05-16T02:00:00.000Z',
      },
      {
        id: 'note-2',
        agentId: 'test01',
        appId: 'reading_notes',
        title: '非法摘录',
        content: '不应显示伪摘录。',
        metadata: { bookId: 'book-1', noteType: 'pre_read', quote: { text: '不可显示', source: 'generated' } },
        source: 'manual',
        createdAt: '2026-05-16T03:00:00.000Z',
        updatedAt: '2026-05-16T03:00:00.000Z',
      },
    ]);

    renderReadingNotes();
    fireEvent.click(await screen.findByRole('button', { name: /雪线急救手册/ }));
    fireEvent.click(screen.getByRole('button', { name: /手动摘录/ }));
    expect(screen.getByText('可显示')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '返回书目' }));
    fireEvent.click(screen.getByRole('button', { name: /非法摘录/ }));
    const detail = screen.getByTestId('phone-reading-note-detail');
    expect(within(detail).queryByText('不可显示')).not.toBeInTheDocument();
  });

  it('opens 帮 TA 找书 and asks the AI for English subject categories with Chinese labels', async () => {
    readingTopicsAiMock.inferReadingTopicsWithAI.mockResolvedValue([
      { subject: 'war memoir', label: '战争回忆', reason: '幼年经历战乱' },
      { subject: 'medical ethics', label: '医疗伦理', reason: '长期救治伤患' },
      { subject: 'philosophy of mind', label: '心智哲学' },
    ]);

    renderReadingNotes(linwu, linwuProfile);
    await screen.findByTestId('phone-reading-empty');
    fireEvent.click(screen.getByRole('button', { name: /帮 TA 找书/ }));

    await waitFor(() => {
      expect(readingTopicsAiMock.inferReadingTopicsWithAI).toHaveBeenCalledWith(
        expect.objectContaining({ agent: linwu, ownerProfile: linwuProfile }),
      );
    });
    const topicGroup = await screen.findByTestId('phone-reading-discover-topics');
    expect(within(topicGroup).getByRole('button', { name: '战争回忆' })).toBeInTheDocument();
    expect(within(topicGroup).getByRole('button', { name: '医疗伦理' })).toBeInTheDocument();
    expect(within(topicGroup).getByRole('button', { name: '心智哲学' })).toBeInTheDocument();
  });

  it('shows the empty-topic hint when the model returns no usable categories', async () => {
    readingTopicsAiMock.inferReadingTopicsWithAI.mockResolvedValue([]);

    renderReadingNotes(linwu, linwuProfile);
    await screen.findByTestId('phone-reading-empty');
    fireEvent.click(screen.getByRole('button', { name: /帮 TA 找书/ }));

    expect(await screen.findByTestId('phone-reading-discover-empty')).toHaveTextContent('还没有可用的阅读类别');
    expect(openLibraryMock.searchOpenLibraryBooksViaProxy).not.toHaveBeenCalled();
  });

  it('shows the AI failure message and does not call Open Library when topic inference fails', async () => {
    readingTopicsAiMock.inferReadingTopicsWithAI.mockRejectedValue(new Error('模型暂不可用'));

    renderReadingNotes(linwu, linwuProfile);
    await screen.findByTestId('phone-reading-empty');
    fireEvent.click(screen.getByRole('button', { name: /帮 TA 找书/ }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('类别推断失败：模型暂不可用');
    expect(openLibraryMock.searchOpenLibraryBooksViaProxy).not.toHaveBeenCalled();
  });

  it('searches Open Library with the English subject on chip click and imports the picked book', async () => {
    readingTopicsAiMock.inferReadingTopicsWithAI.mockResolvedValue([
      { subject: 'war memoir', label: '战争回忆', reason: '幼年经历战乱' },
    ]);
    openLibraryMock.searchOpenLibraryBooksViaProxy.mockResolvedValue([{
      key: '/works/OL5W',
      title: '战场医生回忆录',
      authors: ['某作者'],
      subjects: ['military medicine'],
      openLibraryUrl: 'https://openlibrary.org/works/OL5W',
    }]);

    renderReadingNotes(linwu, linwuProfile);
    await screen.findByTestId('phone-reading-empty');
    fireEvent.click(screen.getByRole('button', { name: /帮 TA 找书/ }));
    fireEvent.click(await screen.findByRole('button', { name: '战争回忆' }));

    await waitFor(() => {
      expect(openLibraryMock.searchOpenLibraryBooksViaProxy).toHaveBeenCalledWith({ subject: 'war memoir', limit: 12 });
    });
    const results = await screen.findByTestId('phone-reading-discover-results');
    expect(within(results).getByText('战场医生回忆录')).toBeInTheDocument();
    expect(within(results).getByText('https://openlibrary.org/works/OL5W')).toBeInTheDocument();

    fireEvent.click(within(results).getByRole('button', { name: '加入书目' }));

    await waitFor(() => {
      expect(catalogMock.importBooksForAgent).toHaveBeenCalledWith('test01', [{
        key: '/works/OL5W',
        title: '战场医生回忆录',
        authors: ['某作者'],
        subjects: ['military medicine'],
        firstPublishYear: undefined,
        languages: undefined,
        coverId: undefined,
        isbn: undefined,
        openLibraryUrl: 'https://openlibrary.org/works/OL5W',
      }], {
        reason: 'topic search: 战争回忆 / war memoir — 幼年经历战乱',
        interests: ['war memoir'],
      });
    });
    expect(within(results).getByRole('button', { name: '已加入书目' })).toBeDisabled();
  });

  it('shows the adapter error message when the Open Library lookup fails after a topic is picked', async () => {
    readingTopicsAiMock.inferReadingTopicsWithAI.mockResolvedValue([
      { subject: 'survival fiction', label: '生存小说' },
    ]);
    openLibraryMock.searchOpenLibraryBooksViaProxy.mockRejectedValue(new Error('Open Library 查询失败：getaddrinfo ENOTFOUND'));

    renderReadingNotes(linwu, linwuProfile);
    await screen.findByTestId('phone-reading-empty');
    fireEvent.click(screen.getByRole('button', { name: /帮 TA 找书/ }));
    fireEvent.click(await screen.findByRole('button', { name: '生存小说' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Open Library 查询失败：getaddrinfo ENOTFOUND');
    expect(catalogMock.importBooksForAgent).not.toHaveBeenCalled();
  });

  it('does not call Open Library or the topic-inference AI on app mount (no auto-network)', async () => {
    renderReadingNotes(linwu, linwuProfile);
    await screen.findByTestId('phone-reading-empty');
    expect(openLibraryMock.searchOpenLibraryBooksViaProxy).not.toHaveBeenCalled();
    expect(readingTopicsAiMock.inferReadingTopicsWithAI).not.toHaveBeenCalled();
  });

  describe('AI annotation flow', () => {
    const sampleBook = {
      id: 'book-1',
      key: 'manual:test01:book',
      dedupeKey: 'manual:test01:book',
      title: 'Man\'s Search for Meaning',
      authors: ['Viktor E. Frankl'],
      subjects: ['psychotherapy'],
      agentTags: [{ agentId: 'test01', reason: 'manual', interests: [], createdAt: '2026-05-16T01:00:00.000Z' }],
      createdAt: '2026-05-16T01:00:00.000Z',
      updatedAt: '2026-05-16T01:00:00.000Z',
    };

    it('opens 让 TA 批注, fetches Wikiquote suggestions, generates annotation, previews and saves with user_provided quote source', async () => {
      catalogMock.listBooksForAgent.mockResolvedValueOnce([sampleBook]);
      appEntryStoreMock.listAppEntries.mockResolvedValueOnce([]);
      wikiquoteMock.fetchWikiquoteSuggestions.mockResolvedValue([
        {
          text: 'Between stimulus and response there is a space.',
          sourceCitation: { provider: 'wikiquote', lang: 'en', pageTitle: 'Viktor Frankl', pageUrl: 'https://en.wikiquote.org/wiki/Viktor_Frankl' },
        },
      ]);
      annotationAiMock.inferReadingAnnotationWithAI.mockResolvedValue({
        title: '面对沉默的余地',
        annotation: '我懂这种顿挫，但雪地里我们没有那个余地。',
        mood: '克制',
      });

      renderReadingNotes(linwu, linwuProfile);
      fireEvent.click(await screen.findByRole('button', { name: /Search for Meaning/ }));
      fireEvent.click(screen.getByRole('button', { name: /让 TA 批注/ }));

      await waitFor(() => {
        expect(wikiquoteMock.fetchWikiquoteSuggestions).toHaveBeenCalledWith(expect.objectContaining({
          title: 'Man\'s Search for Meaning',
          authors: ['Viktor E. Frankl'],
        }));
      });
      const suggestions = await screen.findByTestId('phone-reading-annotation-suggestions');
      fireEvent.click(within(suggestions).getByRole('button', { name: /Between stimulus and response/ }));
      fireEvent.click(screen.getByRole('button', { name: /^让 TA 批注$/ }));

      await waitFor(() => {
        expect(annotationAiMock.inferReadingAnnotationWithAI).toHaveBeenCalledWith(expect.objectContaining({
          agent: linwu,
          ownerProfile: linwuProfile,
          book: expect.objectContaining({ title: 'Man\'s Search for Meaning' }),
          passage: 'Between stimulus and response there is a space.',
          passageCitation: expect.objectContaining({ provider: 'wikiquote' }),
        }));
      });
      const preview = await screen.findByTestId('phone-reading-annotation-preview');
      expect(within(preview).getByDisplayValue('面对沉默的余地')).toBeInTheDocument();
      expect(within(preview).getByDisplayValue('我懂这种顿挫，但雪地里我们没有那个余地。')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: '保存批注' }));
      await waitFor(() => {
        expect(appEntryStoreMock.appendAppEntry).toHaveBeenCalledWith('test01', 'reading_notes', expect.objectContaining({
          title: '面对沉默的余地',
          content: '我懂这种顿挫，但雪地里我们没有那个余地。',
          source: 'ai_annotation',
          metadata: expect.objectContaining({
            bookId: 'book-1',
            noteType: 'reading_note',
            annotationSource: 'ai',
            mood: '克制',
            quote: expect.objectContaining({
              text: 'Between stimulus and response there is a space.',
              source: 'user_provided',
              sourceCitation: expect.objectContaining({ provider: 'wikiquote' }),
            }),
          }),
        }));
      });
      // 落盘后 passageHash 字段必须有，且就是 'p...' 格式
      const metadataArg = (appEntryStoreMock.appendAppEntry.mock.calls[0][2] as { metadata: Record<string, unknown> }).metadata;
      expect(typeof metadataArg.passageHash).toBe('string');
      expect(metadataArg.passageHash).toMatch(/^p[0-9a-f]+_\d+$/);
    });

    it('blocks generating annotation when the same passage is already annotated for that book', async () => {
      catalogMock.listBooksForAgent.mockResolvedValueOnce([sampleBook]);
      appEntryStoreMock.listAppEntries.mockResolvedValueOnce([{
        id: 'note-existing',
        agentId: 'test01',
        appId: 'reading_notes',
        title: '已有批注',
        content: '当年我也想过这个空间是什么。',
        source: 'ai_annotation',
        metadata: {
          bookId: 'book-1',
          noteType: 'reading_note',
          annotationSource: 'ai',
          quote: {
            text: 'Between stimulus and response there is a space.',
            source: 'user_provided',
          },
        },
        createdAt: '2026-05-15T01:00:00.000Z',
        updatedAt: '2026-05-15T01:00:00.000Z',
      }]);
      wikiquoteMock.fetchWikiquoteSuggestions.mockResolvedValue([]);

      renderReadingNotes(linwu, linwuProfile);
      fireEvent.click(await screen.findByRole('button', { name: /Search for Meaning/ }));
      fireEvent.click(screen.getByRole('button', { name: /让 TA 批注/ }));
      // wait for wikiquote fetch to settle
      await waitFor(() => expect(wikiquoteMock.fetchWikiquoteSuggestions).toHaveBeenCalled());

      const textarea = screen.getByPlaceholderText('把你想批注的那段原文粘进来。');
      // 注意：标点和大小写不同也应被识别为重复（normalizePassageForHash 的契约）
      fireEvent.change(textarea, { target: { value: '  BETWEEN stimulus, and response — there is a space.  ' } });
      fireEvent.click(screen.getByRole('button', { name: /^让 TA 批注$/ }));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('这段原文已经批注过：《已有批注》');
      expect(annotationAiMock.inferReadingAnnotationWithAI).not.toHaveBeenCalled();
      expect(appEntryStoreMock.appendAppEntry).not.toHaveBeenCalled();
    });

    it('does not call Wikiquote or the annotation AI on app mount (no auto-network)', async () => {
      renderReadingNotes(linwu, linwuProfile);
      await screen.findByTestId('phone-reading-empty');
      expect(wikiquoteMock.fetchWikiquoteSuggestions).not.toHaveBeenCalled();
      expect(annotationAiMock.inferReadingAnnotationWithAI).not.toHaveBeenCalled();
    });
  });
});
