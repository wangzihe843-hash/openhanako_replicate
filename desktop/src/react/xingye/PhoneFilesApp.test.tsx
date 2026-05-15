/**
 * @vitest-environment jsdom
 */

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../types';

const filesStoreMock = vi.hoisted(() => ({
  appendFileEntry: vi.fn(),
  deleteFileEntry: vi.fn(),
  ensureDefaultFileFolders: vi.fn(),
  listFileEntries: vi.fn(),
  listFileEntriesByFolder: vi.fn(),
  listFileFolders: vi.fn(),
  updateFileEntry: vi.fn(),
}));

vi.mock('./xingye-files-store', () => filesStoreMock);

import { PhoneFilesApp } from './PhoneFilesApp';

const agent: Agent = {
  id: 'linwu',
  name: '林雾',
  yuan: 'hanako',
  isPrimary: false,
  hasAvatar: false,
};

function renderFilesApp() {
  return render(
    <PhoneFilesApp ownerAgent={agent} displayName="林雾" onBack={vi.fn()} />,
  );
}

describe('PhoneFilesApp', () => {
  beforeEach(() => {
    filesStoreMock.appendFileEntry.mockReset();
    filesStoreMock.deleteFileEntry.mockReset();
    filesStoreMock.ensureDefaultFileFolders.mockReset();
    filesStoreMock.listFileEntries.mockReset();
    filesStoreMock.listFileEntriesByFolder.mockReset();
    filesStoreMock.listFileFolders.mockReset();
    filesStoreMock.updateFileEntry.mockReset();
    filesStoreMock.listFileFolders.mockResolvedValue([]);
    filesStoreMock.listFileEntries.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
  });

  it('shows the empty state and initializes default folders on click', async () => {
    filesStoreMock.ensureDefaultFileFolders.mockResolvedValueOnce([
      {
        id: 'f-1', agentId: 'linwu', name: '世界观整理', description: '关于 TA 所处世界的设定与规则。',
        order: 0, createdAt: '2026-05-15T10:00:00.000Z', updatedAt: '2026-05-15T10:00:00.000Z',
      },
      {
        id: 'f-2', agentId: 'linwu', name: '人际关系', description: 'TA 接触过的人、关系与分寸感。',
        order: 1, createdAt: '2026-05-15T10:00:00.000Z', updatedAt: '2026-05-15T10:00:00.000Z',
      },
    ]);

    renderFilesApp();

    expect(await screen.findByTestId('phone-files-empty')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('phone-files-init-button'));

    await waitFor(() => {
      expect(filesStoreMock.ensureDefaultFileFolders).toHaveBeenCalledWith('linwu');
    });
    expect(await screen.findByText('世界观整理')).toBeInTheDocument();
    expect(screen.getByText('人际关系')).toBeInTheDocument();
  });

  it('opens a folder, creates a file entry, and shows it in the list', async () => {
    filesStoreMock.listFileFolders.mockResolvedValue([
      {
        id: 'f-1', agentId: 'linwu', name: '世界观整理', description: '设定。',
        order: 0, createdAt: '2026-05-15T10:00:00.000Z', updatedAt: '2026-05-15T10:00:00.000Z',
      },
    ]);
    filesStoreMock.appendFileEntry.mockImplementation(async (_agentId: string, draft: { folderId: string; title: string; body: string; tags?: string[] }) => ({
      id: 'e-new',
      key: 'e-new',
      agentId: 'linwu',
      folderId: draft.folderId,
      title: draft.title,
      body: draft.body,
      tags: draft.tags,
      createdAt: '2026-05-15T11:00:00.000Z',
      updatedAt: '2026-05-15T11:00:00.000Z',
    }));

    renderFilesApp();

    fireEvent.click(await screen.findByTestId('phone-files-folder-f-1'));
    expect(await screen.findByTestId('phone-files-folder-empty')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('phone-files-new-in-folder'));
    fireEvent.change(screen.getByTestId('phone-files-title-input'), { target: { value: '世界设定 · 简介' } });
    fireEvent.change(screen.getByTestId('phone-files-body-input'), { target: { value: '这是一个安静的城市。' } });
    fireEvent.change(screen.getByTestId('phone-files-tags-input'), { target: { value: '设定, 城市' } });
    fireEvent.click(screen.getByTestId('phone-files-save-button'));

    await waitFor(() => {
      expect(filesStoreMock.appendFileEntry).toHaveBeenCalledWith('linwu', {
        folderId: 'f-1',
        title: '世界设定 · 简介',
        body: '这是一个安静的城市。',
        tags: ['设定', '城市'],
        source: undefined,
      });
    });

    expect(await screen.findByText('世界设定 · 简介')).toBeInTheDocument();
  });

  it('opens an entry detail and deletes it', async () => {
    filesStoreMock.listFileFolders.mockResolvedValue([
      {
        id: 'f-1', agentId: 'linwu', name: '人际关系', description: 'TA 接触过的人。',
        order: 0, createdAt: '2026-05-15T10:00:00.000Z', updatedAt: '2026-05-15T10:00:00.000Z',
      },
    ]);
    filesStoreMock.listFileEntries.mockResolvedValue([
      {
        id: 'e-1', key: 'e-1', agentId: 'linwu', folderId: 'f-1',
        title: '关于阿芷', body: '阿芷是 TA 的同学，性格温和。',
        createdAt: '2026-05-15T10:00:00.000Z', updatedAt: '2026-05-15T10:00:00.000Z',
      },
    ]);
    filesStoreMock.deleteFileEntry.mockResolvedValueOnce(true);
    vi.spyOn(window, 'confirm').mockReturnValueOnce(true);

    renderFilesApp();

    fireEvent.click(await screen.findByTestId('phone-files-folder-f-1'));
    fireEvent.click(await screen.findByTestId('phone-files-entry-e-1'));
    expect(screen.getByText('阿芷是 TA 的同学，性格温和。')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('phone-files-delete-button'));

    await waitFor(() => {
      expect(filesStoreMock.deleteFileEntry).toHaveBeenCalledWith('linwu', 'e-1');
    });
  });

  it('edits an existing entry and persists via updateFileEntry', async () => {
    filesStoreMock.listFileFolders.mockResolvedValue([
      {
        id: 'f-1', agentId: 'linwu', name: '人际关系', description: '',
        order: 0, createdAt: '2026-05-15T10:00:00.000Z', updatedAt: '2026-05-15T10:00:00.000Z',
      },
    ]);
    filesStoreMock.listFileEntries.mockResolvedValue([
      {
        id: 'e-1', key: 'e-1', agentId: 'linwu', folderId: 'f-1',
        title: '原标题', body: '原正文',
        createdAt: '2026-05-15T10:00:00.000Z', updatedAt: '2026-05-15T10:00:00.000Z',
      },
    ]);
    filesStoreMock.updateFileEntry.mockImplementation(async (_aid: string, _eid: string, patch: { title?: string; body?: string }) => ({
      id: 'e-1', key: 'e-1', agentId: 'linwu', folderId: 'f-1',
      title: patch.title ?? '原标题', body: patch.body ?? '原正文',
      createdAt: '2026-05-15T10:00:00.000Z', updatedAt: '2026-05-15T11:00:00.000Z',
    }));

    renderFilesApp();

    fireEvent.click(await screen.findByTestId('phone-files-folder-f-1'));
    fireEvent.click(await screen.findByTestId('phone-files-entry-e-1'));
    fireEvent.click(screen.getByTestId('phone-files-edit-button'));
    fireEvent.change(screen.getByTestId('phone-files-title-input'), { target: { value: '新标题' } });
    fireEvent.change(screen.getByTestId('phone-files-body-input'), { target: { value: '新正文' } });
    fireEvent.click(screen.getByTestId('phone-files-save-button'));

    await waitFor(() => {
      expect(filesStoreMock.updateFileEntry).toHaveBeenCalledWith(
        'linwu',
        'e-1',
        expect.objectContaining({ folderId: 'f-1', title: '新标题', body: '新正文' }),
      );
    });
    expect(await screen.findByText('新标题')).toBeInTheDocument();
  });

  it('shows the unavailable state when no agent is selected', () => {
    render(<PhoneFilesApp ownerAgent={null} displayName="" onBack={vi.fn()} />);
    expect(screen.getByText('文件管理不可用')).toBeInTheDocument();
  });
});
