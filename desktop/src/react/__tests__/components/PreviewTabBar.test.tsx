/**
 * @vitest-environment jsdom
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TabBar } from '../../components/preview/TabBar';
import { useStore, type StoreState } from '../../stores';

describe('Preview TabBar', () => {
  beforeEach(() => {
    window.t = ((key: string) => key) as typeof window.t;
    useStore.setState({
      previewItems: [{
        id: 'note',
        type: 'markdown',
        title: 'note.md',
        content: '# Note',
        filePath: '/tmp/note.md',
      }],
      openTabs: ['note'],
      activeTabId: 'note',
    } as Partial<StoreState>);
  });

  afterEach(() => {
    cleanup();
    useStore.setState({
      previewItems: [],
      openTabs: [],
      activeTabId: null,
    } as Partial<StoreState>);
  });

  it('does not expose the removed open-in-new-window action from tab right click', () => {
    render(<TabBar />);

    fireEvent.contextMenu(screen.getByText('note.md'), { clientX: 24, clientY: 24 });

    expect(screen.queryByText('preview.openInNewWindow')).not.toBeInTheDocument();
    expect(screen.queryByText('preview.openInNewWindowUnsupported')).not.toBeInTheDocument();
  });
});
