import type { MouseEventHandler } from 'react';
import { ChannelTabBar } from '../channels/ChannelTabBar';
import { WidgetButtons } from '../plugin/WidgetButtons';
import { WindowControls } from '../WindowControls';

interface AppTitlebarProps {
  sidebarOpen: boolean;
  jianOpen: boolean;
  onToggleSidebar: () => void;
  onToggleJian: () => void;
  previewOpen?: boolean;
  onTogglePreview?: () => void;
  showPreviewToggle?: boolean;
  showChannelTabs?: boolean;
  showWidgetButtons?: boolean;
  onLeftMouseEnter?: MouseEventHandler<HTMLButtonElement>;
  onRightMouseEnter?: MouseEventHandler<HTMLButtonElement>;
  onToggleMouseLeave?: MouseEventHandler<HTMLButtonElement>;
}

export function AppTitlebar({
  sidebarOpen,
  jianOpen,
  onToggleSidebar,
  onToggleJian,
  previewOpen = false,
  onTogglePreview,
  showPreviewToggle = false,
  showChannelTabs = true,
  showWidgetButtons = true,
  onLeftMouseEnter,
  onRightMouseEnter,
  onToggleMouseLeave,
}: AppTitlebarProps) {
  const t = window.t ?? ((p: string) => p);

  return (
    <div className="titlebar">
      <button
        className={`tb-toggle tb-toggle-left${sidebarOpen ? ' active' : ''}`}
        id="tbToggleLeft"
        title={t('sidebar.toggle')}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onToggleSidebar}
        onMouseEnter={onLeftMouseEnter}
        onMouseLeave={onToggleMouseLeave}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
          <line x1="9" y1="3" x2="9" y2="21"></line>
        </svg>
      </button>
      {showChannelTabs && <ChannelTabBar />}
      <div className="tb-right-group">
        {showWidgetButtons && <WidgetButtons />}
        {showPreviewToggle && onTogglePreview && (
          <button
            className={`tb-toggle tb-toggle-preview${previewOpen ? ' active' : ''}`}
            id="tbTogglePreview"
            title={t('preview.toggle')}
            onMouseDown={(e) => e.preventDefault()}
            onClick={onTogglePreview}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M7 3.5h7l3 3v14H7z"></path>
              <path d="M14 3.5v3h3"></path>
              <path d="M9.5 11h5"></path>
              <path d="M9.5 14.5h5"></path>
            </svg>
          </button>
        )}
        <button
          className={`tb-toggle tb-toggle-right${jianOpen ? ' active' : ''}`}
          id="tbToggleRight"
          title={t('sidebar.jian')}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onToggleJian}
          onMouseEnter={onRightMouseEnter}
          onMouseLeave={onToggleMouseLeave}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
            <line x1="15" y1="3" x2="15" y2="21"></line>
          </svg>
        </button>
      </div>
      <WindowControls />
    </div>
  );
}
