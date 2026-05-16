/**
 * DeskSection — 笺侧栏的工作空间内容区（编排层）
 *
 * 替代旧 desk.js 的 renderDeskFiles / initJianEditor / updateDeskEmptyOverlay 逻辑。
 * 由 App.tsx 在 .jian-chat-content 容器内直接渲染。
 *
 * 子组件拆分至 ./desk/ 目录。
 */

import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../stores';
import { loadDeskTreeFiles } from '../stores/desk-actions';
import { ContextMenu } from '../ui';
import { DESK_SORT_KEY, type SortMode, type CtxMenuState, type FileTypeFilter } from './desk/desk-types';
import { DeskFilterButton, DeskOpenIconButton, DeskSearchBox, DeskSortButton } from './desk/DeskToolbar';
import { DeskTree } from './desk/DeskTree';
import { DeskDropZone } from './desk/DeskDropZone';
import { DeskEmptyOverlay } from './desk/DeskEmptyOverlay';
import { DeskCwdSkillsButton, DeskCwdSkillsPanel } from './desk/DeskCwdSkills';
import s from './desk/Desk.module.css';
// @ts-expect-error — shared JS module
import { workspaceDisplayName } from '../../../../shared/workspace-history.js';

const DESK_FILTER_KEY = 'hana-desk-type-filters';
const VALID_TYPE_FILTERS = new Set<FileTypeFilter>(['image', 'text', 'video']);

function getInitialTypeFilters(): FileTypeFilter[] {
  try {
    const raw = localStorage.getItem(DESK_FILTER_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is FileTypeFilter => VALID_TYPE_FILTERS.has(item));
  } catch {
    return [];
  }
}

export function DeskSection({
  framed = true,
  showHeader = true,
  rightWorkspaceLayout = false,
}: {
  framed?: boolean;
  showHeader?: boolean;
  rightWorkspaceLayout?: boolean;
}) {
  const deskBasePath = useStore(st => st.deskBasePath);
  const deskExpandedPaths = useStore(st => st.deskExpandedPaths);
  const deskDirtyTreePaths = useStore(st => st.deskDirtyTreePaths);
  const clearDeskTreeDirty = useStore(st => st.clearDeskTreeDirty);
  const selectedFolder = useStore(st => st.selectedFolder);
  const homeFolder = useStore(st => st.homeFolder);

  const [sortMode, setSortMode] = useState<SortMode>(
    () => (localStorage.getItem(DESK_SORT_KEY) as SortMode) || 'mtime-desc',
  );
  const [typeFilters, setTypeFilters] = useState<FileTypeFilter[]>(getInitialTypeFilters);

  useEffect(() => {
    if (!deskBasePath || deskDirtyTreePaths.length === 0) return;
    const visibleTreeKeys = new Set(['', ...deskExpandedPaths]);
    const reloadSubdirs = deskDirtyTreePaths.filter(subdir => visibleTreeKeys.has(subdir));
    if (reloadSubdirs.length === 0) return;
    clearDeskTreeDirty(reloadSubdirs);
    for (const subdir of reloadSubdirs) {
      void loadDeskTreeFiles(subdir, { force: true });
    }
  }, [clearDeskTreeDirty, deskBasePath, deskDirtyTreePaths, deskExpandedPaths]);

  // ── 共享 context menu 状态 ──
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);

  const handleShowMenu = useCallback((state: CtxMenuState) => {
    setCtxMenu(state);
  }, []);

  const handleCloseMenu = useCallback(() => {
    setCtxMenu(null);
  }, []);

  const handleTypeFiltersChange = useCallback((filters: FileTypeFilter[]) => {
    localStorage.setItem(DESK_FILTER_KEY, JSON.stringify(filters));
    setTypeFilters(filters);
  }, []);

  const t = window.t ?? ((p: string) => p);
  const rootName = workspaceDisplayName(deskBasePath || selectedFolder || homeFolder, t('desk.title'));
  const workspaceTitle = t('desk.workspaceTitle');
  const title = `${workspaceTitle} · ${rootName}`;

  return (
    <>
      <DeskDropZone onShowMenu={handleShowMenu} framed={framed} rightWorkspaceLayout={rightWorkspaceLayout}>
        {showHeader && (
          <div className={s.header}>
            <div className={`jian-section-title ${s.sectionTitle}`} title={deskBasePath || selectedFolder || homeFolder || undefined}>
              {title}
            </div>
            <DeskCwdSkillsButton />
          </div>
        )}
        {showHeader && <DeskCwdSkillsPanel />}
        <DeskSearchBox />
        <div className={s.toolbar}>
          <div className={s.toolbarActions}>
            <DeskOpenIconButton />
            <DeskFilterButton filters={typeFilters} onFiltersChange={handleTypeFiltersChange} onShowMenu={handleShowMenu} />
            <DeskSortButton sortMode={sortMode} onSort={setSortMode} onShowMenu={handleShowMenu} />
          </div>
        </div>
        <DeskTree sortMode={sortMode} typeFilters={typeFilters} onShowMenu={handleShowMenu} />
        <DeskEmptyOverlay />
      </DeskDropZone>
      {ctxMenu && (
        <ContextMenu
          items={ctxMenu.items}
          position={ctxMenu.position}
          onClose={handleCloseMenu}
        />
      )}
    </>
  );
}
