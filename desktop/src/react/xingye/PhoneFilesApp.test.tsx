/**
 * @vitest-environment jsdom
 */

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../types';

const filesStoreMock = vi.hoisted(() => {
  class DuplicateFileEntryError extends Error {
    existing: unknown;
    detection: unknown;
    /**
     * 与真实 xingye-files-store.ts 的 signature 对齐：
     * `FilesDuplicateResult & { kind: 'exact_dup' | 'similar' }`，需要接 `kind`。
     */
    constructor(detection: { entry: unknown; kind?: string }) {
      super('duplicate');
      this.name = 'DuplicateFileEntryError';
      this.existing = detection.entry;
      this.detection = detection;
    }
  }
  return {
    DuplicateFileEntryError,
    appendFileDraft: vi.fn(),
    appendFileEntry: vi.fn(),
    confirmFileDraft: vi.fn(),
    deleteFileEntry: vi.fn(),
    discardFileDraft: vi.fn(),
    ensureDefaultFileFolders: vi.fn(),
    listFileDrafts: vi.fn(),
    listFileEntries: vi.fn(),
    listFileEntriesByFolder: vi.fn(),
    listFileFolders: vi.fn(),
    resolveFolderIdFromHint: vi.fn(),
    // `null as unknown` 放宽返回类型推断，让后续 mockReturnValue(targetEntry) 不被卡。
    resolveTargetEntry: vi.fn(() => null as unknown),
    updateFileEntry: vi.fn(),
  };
});

vi.mock('./xingye-files-store', () => filesStoreMock);

import { PhoneFilesApp } from './PhoneFilesApp';
import { useStore } from '../stores';

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
    filesStoreMock.appendFileDraft.mockReset();
    filesStoreMock.appendFileEntry.mockReset();
    filesStoreMock.confirmFileDraft.mockReset();
    filesStoreMock.deleteFileEntry.mockReset();
    filesStoreMock.discardFileDraft.mockReset();
    filesStoreMock.ensureDefaultFileFolders.mockReset();
    filesStoreMock.listFileDrafts.mockReset();
    filesStoreMock.listFileEntries.mockReset();
    filesStoreMock.listFileEntriesByFolder.mockReset();
    filesStoreMock.listFileFolders.mockReset();
    filesStoreMock.resolveFolderIdFromHint.mockReset();
    filesStoreMock.updateFileEntry.mockReset();
    filesStoreMock.listFileFolders.mockResolvedValue([]);
    filesStoreMock.listFileEntries.mockResolvedValue([]);
    filesStoreMock.listFileDrafts.mockResolvedValue([]);
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
      expect(filesStoreMock.appendFileEntry).toHaveBeenCalledWith(
        'linwu',
        {
          folderId: 'f-1',
          title: '世界设定 · 简介',
          body: '这是一个安静的城市。',
          tags: ['设定', '城市'],
          source: undefined,
        },
        expect.objectContaining({ skipDedupe: false }),
      );
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

  it('share-to-chat from entry detail stages the quote with sourceKind=files and full body', async () => {
    filesStoreMock.listFileFolders.mockResolvedValue([
      {
        id: 'f-1', agentId: 'linwu', name: '人际关系', description: '',
        order: 0, createdAt: '2026-05-15T10:00:00.000Z', updatedAt: '2026-05-15T10:00:00.000Z',
      },
    ]);
    filesStoreMock.listFileEntries.mockResolvedValue([
      {
        id: 'e-1', key: 'e-1', agentId: 'linwu', folderId: 'f-1',
        title: '关于阿芷', body: '阿芷是 TA 的同学，性格温和。',
        tags: ['人物'], source: 'xingye-heartbeat',
        createdAt: '2026-05-15T10:00:00.000Z', updatedAt: '2026-05-15T10:00:00.000Z',
      },
    ]);

    // 清空全局 stagedChatQuote，避免被其它测试污染
    useStore.setState({ stagedChatQuote: null });

    renderFilesApp();

    fireEvent.click(await screen.findByTestId('phone-files-folder-f-1'));
    fireEvent.click(await screen.findByTestId('phone-files-entry-e-1'));
    fireEvent.click(screen.getByTestId('phone-files-share-to-chat-e-1'));

    const staged = useStore.getState().stagedChatQuote;
    expect(staged).not.toBeNull();
    expect(staged?.sourceKind).toBe('files');
    expect(staged?.sourceTitle).toBe('资料柜 · 关于阿芷');
    expect(staged?.text).toContain('资料柜 › 人际关系');
    expect(staged?.text).toContain('《关于阿芷》');
    expect(staged?.text).toContain('阿芷是 TA 的同学，性格温和。');
    expect(staged?.text).toContain('#人物');
    expect(staged?.charCount).toBe(staged?.text.length);

    // 反馈行可见
    expect(screen.getByTestId('phone-files-share-to-chat-notice-e-1')).toBeInTheDocument();

    // 清理
    useStore.setState({ stagedChatQuote: null });
  });

  it('shows duplicate modal when appendFileEntry throws DuplicateFileEntryError', async () => {
    filesStoreMock.listFileFolders.mockResolvedValue([
      {
        id: 'f-1', agentId: 'linwu', name: '人际关系', description: '',
        order: 0, createdAt: '2026-05-15T10:00:00.000Z', updatedAt: '2026-05-15T10:00:00.000Z',
      },
    ]);
    const existingEntry = {
      id: 'e-existing', key: 'e-existing', agentId: 'linwu', folderId: 'f-1',
      title: '师父的话', body: '老段落',
      createdAt: '2026-05-15T10:00:00.000Z', updatedAt: '2026-05-15T10:00:00.000Z',
    };
    filesStoreMock.listFileEntries.mockResolvedValue([existingEntry]);
    filesStoreMock.appendFileEntry.mockImplementationOnce(async () => {
      throw new filesStoreMock.DuplicateFileEntryError({ kind: 'exact_dup', entry: existingEntry });
    });

    renderFilesApp();

    fireEvent.click(await screen.findByTestId('phone-files-folder-f-1'));
    fireEvent.click(screen.getByTestId('phone-files-new-in-folder'));
    fireEvent.change(screen.getByTestId('phone-files-title-input'), { target: { value: '师父的话' } });
    fireEvent.change(screen.getByTestId('phone-files-body-input'), { target: { value: '我又听到一句' } });
    fireEvent.click(screen.getByTestId('phone-files-save-button'));

    // Modal 出现
    const modal = await screen.findByTestId('phone-files-duplicate-modal');
    expect(within(modal).getByText('资料柜里已有相似条目')).toBeInTheDocument();
    expect(within(modal).getByText(/师父的话/)).toBeInTheDocument();

    // 点「仍然新建一条」 → 第二次 appendFileEntry 走 skipDedupe=true
    filesStoreMock.appendFileEntry.mockImplementationOnce(async (_aid: string, draft: { folderId: string; title: string; body: string }) => ({
      id: 'e-new', key: 'e-new', agentId: 'linwu',
      folderId: draft.folderId, title: draft.title, body: draft.body,
      createdAt: '2026-05-15T11:00:00.000Z', updatedAt: '2026-05-15T11:00:00.000Z',
    }));
    fireEvent.click(screen.getByTestId('phone-files-duplicate-force-create'));

    await waitFor(() => {
      expect(filesStoreMock.appendFileEntry).toHaveBeenLastCalledWith(
        'linwu',
        expect.objectContaining({ folderId: 'f-1', title: '师父的话' }),
        expect.objectContaining({ skipDedupe: true }),
      );
    });
  });

  it('duplicate modal "open target for edit" switches compose to edit mode', async () => {
    filesStoreMock.listFileFolders.mockResolvedValue([
      {
        id: 'f-1', agentId: 'linwu', name: '人际关系', description: '',
        order: 0, createdAt: '2026-05-15T10:00:00.000Z', updatedAt: '2026-05-15T10:00:00.000Z',
      },
    ]);
    const existingEntry = {
      id: 'e-existing', key: 'e-existing', agentId: 'linwu', folderId: 'f-1',
      title: '师父的话', body: '老段落',
      createdAt: '2026-05-15T10:00:00.000Z', updatedAt: '2026-05-15T10:00:00.000Z',
    };
    filesStoreMock.listFileEntries.mockResolvedValue([existingEntry]);
    filesStoreMock.appendFileEntry.mockImplementationOnce(async () => {
      throw new filesStoreMock.DuplicateFileEntryError({ kind: 'exact_dup', entry: existingEntry });
    });

    renderFilesApp();

    fireEvent.click(await screen.findByTestId('phone-files-folder-f-1'));
    fireEvent.click(screen.getByTestId('phone-files-new-in-folder'));
    fireEvent.change(screen.getByTestId('phone-files-title-input'), { target: { value: '师父的话' } });
    fireEvent.click(screen.getByTestId('phone-files-save-button'));

    await screen.findByTestId('phone-files-duplicate-modal');
    fireEvent.click(screen.getByTestId('phone-files-duplicate-open-target'));

    // modal 消失，compose 切换到 edit 模式（标题被填回 existingEntry.title）
    await waitFor(() => {
      expect(screen.queryByTestId('phone-files-duplicate-modal')).not.toBeInTheDocument();
    });
    const titleInput = screen.getByTestId('phone-files-title-input') as HTMLInputElement;
    expect(titleInput.value).toBe('师父的话');
    // compose modal 标题变为「编辑文件」
    expect(screen.getByText('编辑文件')).toBeInTheDocument();
  });

  it('renders update draft card and confirms with patch.bodyAppend', async () => {
    filesStoreMock.listFileFolders.mockResolvedValue([
      {
        id: 'f-1', agentId: 'linwu', name: '人际关系', description: '',
        order: 0, createdAt: '2026-05-15T10:00:00.000Z', updatedAt: '2026-05-15T10:00:00.000Z',
      },
    ]);
    const targetEntry = {
      id: 'e-target', key: 'e-target', agentId: 'linwu', folderId: 'f-1',
      title: '师父的话', body: '老段落',
      createdAt: '2026-05-15T10:00:00.000Z', updatedAt: '2026-05-15T10:00:00.000Z',
    };
    filesStoreMock.listFileEntries.mockResolvedValue([targetEntry]);
    filesStoreMock.listFileDrafts.mockResolvedValue([
      {
        id: 'd-upd', action: 'update', targetEntryId: 'e-target',
        patch: { bodyAppend: '新段落 v0' },
        title: '', body: '',
        createdAt: '2026-05-17T12:00:00.000Z',
        source: 'xingye-heartbeat-tool',
      },
    ]);
    filesStoreMock.resolveTargetEntry.mockReturnValue(targetEntry);
    filesStoreMock.confirmFileDraft.mockImplementation(async (_aid: string, _did: string, edits: { patch?: { bodyAppend?: string } }) => ({
      ...targetEntry,
      body: `${targetEntry.body}\n\n${edits.patch?.bodyAppend ?? ''}`,
      updatedAt: '2026-05-17T12:01:00.000Z',
    }));

    renderFilesApp();

    const card = await screen.findByTestId('phone-files-pending-draft-d-upd');
    expect(card).toHaveAttribute('data-action', 'update');
    // Update 卡片显示 target.title
    expect(within(card).getByText(/师父的话/)).toBeInTheDocument();
    // Update 卡片不显示 add 路径的 title input
    expect(within(card).queryByTestId('phone-files-pending-draft-title-d-upd')).not.toBeInTheDocument();

    // 用户改了 bodyAppend
    const bodyAppendInput = screen.getByTestId('phone-files-pending-draft-bodyappend-d-upd');
    fireEvent.change(bodyAppendInput, { target: { value: '新段落 v1（已编辑）' } });

    fireEvent.click(screen.getByTestId('phone-files-pending-draft-confirm-d-upd'));

    await waitFor(() => {
      expect(filesStoreMock.confirmFileDraft).toHaveBeenCalledWith(
        'linwu',
        'd-upd',
        { patch: expect.objectContaining({ bodyAppend: '新段落 v1（已编辑）' }) },
      );
    });
  });

  it('update draft card shows "目标条目已不存在" when target was deleted', async () => {
    filesStoreMock.listFileFolders.mockResolvedValue([
      {
        id: 'f-1', agentId: 'linwu', name: '人际关系', description: '',
        order: 0, createdAt: '2026-05-15T10:00:00.000Z', updatedAt: '2026-05-15T10:00:00.000Z',
      },
    ]);
    filesStoreMock.listFileEntries.mockResolvedValue([]);
    filesStoreMock.listFileDrafts.mockResolvedValue([
      {
        id: 'd-missing', action: 'update', targetEntryId: 'e-gone',
        patch: { bodyAppend: 'x' },
        title: '', body: '',
        createdAt: '2026-05-17T12:00:00.000Z',
        source: 'xingye-heartbeat-tool',
      },
    ]);
    filesStoreMock.resolveTargetEntry.mockReturnValue(null);

    renderFilesApp();

    await screen.findByTestId('phone-files-pending-draft-d-missing');
    expect(screen.getByText(/目标条目已不存在/)).toBeInTheDocument();
    expect(screen.getByTestId('phone-files-pending-draft-confirm-d-missing')).toBeDisabled();
    // 但仍允许 discard
    expect(screen.getByTestId('phone-files-pending-draft-discard-d-missing')).toBeEnabled();
  });
});
