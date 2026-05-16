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

vi.mock('./xingye-reading-book-catalog', () => catalogMock);
vi.mock('./xingye-app-entry-store', () => appEntryStoreMock);

import { PhoneReadingNotesApp } from './PhoneReadingNotesApp';

const linwu: Agent = {
  id: 'test01',
  name: '林雾',
  yuan: 'hanako',
  isPrimary: false,
  hasAvatar: false,
};

function renderReadingNotes(agent: Agent | null = linwu) {
  return render(
    <PhoneReadingNotesApp
      ownerAgent={agent}
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

    fireEvent.click(screen.getByRole('button', { name: '新增笔记' }));
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
});
