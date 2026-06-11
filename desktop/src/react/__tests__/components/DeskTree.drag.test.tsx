/**
 * @vitest-environment jsdom
 *
 * #1622：手动 Browse 选目录创建的 local_fs mount 工作台，拖拽文件到聊天区
 * 必须携带真实绝对路径（mount 披露 native root 时），而不是 workbench:<mountId>
 * 占位引用；同时要发起原生拖拽，让拖拽真正可用。
 */

import React from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../stores';
import { DeskTree } from '../../components/desk/DeskTree';
import {
  clearAppFileDragPayload,
  getActiveAppFileDragPayload,
} from '../../utils/app-file-drag';

const mocks = vi.hoisted(() => ({
  loadDeskTreeFiles: vi.fn(async () => {}),
}));

vi.mock('../../stores/desk-actions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/desk-actions')>();
  return {
    ...actual,
    loadDeskTreeFiles: mocks.loadDeskTreeFiles,
  };
});

function makeDataTransfer() {
  return {
    effectAllowed: '',
    dropEffect: '',
    setData: vi.fn(),
    getData: vi.fn(() => ''),
    files: [],
    items: [],
  } as unknown as DataTransfer;
}

function renderTree() {
  return render(
    <DeskTree
      sortMode="name-asc"
      onShowMenu={vi.fn()}
      inlineEdit={null}
      onInlineEditChange={vi.fn()}
      onStartCreate={vi.fn(async () => {})}
    />,
  );
}

describe('DeskTree drag payloads for workspace roots', () => {
  let startDrag: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    clearAppFileDragPayload();
    startDrag = vi.fn();
    window.t = ((key: string) => key) as typeof window.t;
    window.platform = { startDrag } as unknown as typeof window.platform;
    document.documentElement.removeAttribute('data-platform');
    useStore.setState({
      deskFiles: [{ name: 'report.md', isDir: false }],
      deskTreeFilesByPath: { '': [{ name: 'report.md', isDir: false }] },
      deskExpandedPaths: [],
      deskSelectedPath: '',
    } as never);
  });

  afterEach(() => {
    clearAppFileDragPayload();
    cleanup();
  });

  it('drags plain folder workspace files with native paths', () => {
    useStore.setState({
      deskBasePath: '/Users/me/project',
      deskWorkspaceMountId: null,
      deskWorkspaceNativeRoot: null,
    } as never);

    const { container } = renderTree();
    const item = container.querySelector('[data-desk-path="report.md"]');
    expect(item).not.toBeNull();
    fireEvent.dragStart(item as Element, { dataTransfer: makeDataTransfer() });

    expect(getActiveAppFileDragPayload()?.files).toEqual([
      expect.objectContaining({ path: '/Users/me/project/report.md' }),
    ]);
    expect(startDrag).toHaveBeenCalledWith('/Users/me/project/report.md');
  });

  it('drags native-root mount workspace files with real absolute paths and starts a native drag', () => {
    useStore.setState({
      deskBasePath: 'studio:mount_docs',
      deskWorkspaceMountId: 'mount_docs',
      deskWorkspaceLabel: 'Docs',
      deskWorkspaceNativeRoot: '/Users/me/docs',
    } as never);

    const { container } = renderTree();
    const item = container.querySelector('[data-desk-path="report.md"]');
    expect(item).not.toBeNull();
    fireEvent.dragStart(item as Element, { dataTransfer: makeDataTransfer() });

    expect(getActiveAppFileDragPayload()?.files).toEqual([
      expect.objectContaining({ path: '/Users/me/docs/report.md' }),
    ]);
    expect(startDrag).toHaveBeenCalledWith('/Users/me/docs/report.md');
  });

  it('keeps workbench references for mounts without a disclosed native root', () => {
    useStore.setState({
      deskBasePath: 'studio:mount_remote',
      deskWorkspaceMountId: 'mount_remote',
      deskWorkspaceLabel: 'Remote',
      deskWorkspaceNativeRoot: null,
    } as never);

    const { container } = renderTree();
    const item = container.querySelector('[data-desk-path="report.md"]');
    expect(item).not.toBeNull();
    fireEvent.dragStart(item as Element, { dataTransfer: makeDataTransfer() });

    expect(getActiveAppFileDragPayload()?.files).toEqual([
      expect.objectContaining({ path: 'workbench:mount_remote:report.md' }),
    ]);
    expect(startDrag).not.toHaveBeenCalled();
  });
});
