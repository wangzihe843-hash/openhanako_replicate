/**
 * @vitest-environment jsdom
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COVER_GALLERY_PRESETS } from '../../../../../shared/cover-gallery-presets.js';
import { COVER_GALLERY_ITEMS } from '../../components/preview/cover-gallery-assets';
import { FloatingActions } from '../../components/preview/FloatingActions';
import { useStore, type StoreState } from '../../stores';
import type { PlatformApi } from '../../types';

const mocks = vi.hoisted(() => ({
  hanaFetch: vi.fn(),
}));

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: mocks.hanaFetch,
}));

describe('FloatingActions cover gallery', () => {
  beforeEach(() => {
    window.t = ((key: string) => key) as typeof window.t;
    window.platform = {
      readFile: vi.fn(async () => null),
      readFileSnapshot: vi.fn(async () => ({
        content: '---\ncover:\n  image: 文本附件/demo-cover.jpg\n---\n# Demo\n',
        version: 'v-cover',
      })),
    } as unknown as PlatformApi;
    mocks.hanaFetch.mockReset();
    mocks.hanaFetch.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/desk/beautify/status')) {
        return new Response(JSON.stringify({ available: true, enabled: true, agentId: 'agent-1' }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, cover: { image: '文本附件/demo-cover.jpg' } }), { status: 200 });
    });
    useStore.setState({
      currentAgentId: 'agent-1',
      previewItems: [{
        id: 'note',
        type: 'markdown',
        title: 'note.md',
        content: '# Demo\n',
        filePath: '/tmp/note.md',
      }],
    } as Partial<StoreState>);
  });

  afterEach(() => {
    cleanup();
    useStore.setState({
      currentAgentId: null,
      previewItems: [],
    } as Partial<StoreState>);
  });

  it('keeps every shared preset mapped to a renderer asset', () => {
    expect(COVER_GALLERY_ITEMS).toHaveLength(COVER_GALLERY_PRESETS.length);
    expect(COVER_GALLERY_ITEMS.every(item => item.src && item.id)).toBe(true);
  });

  it('does not expose the removed pink daisy fireworks preset', () => {
    expect(COVER_GALLERY_PRESETS.some(item => item.id === 'pink-daisy-fireworks')).toBe(false);
    expect(COVER_GALLERY_ITEMS.some(item => item.title === '粉菊烟火')).toBe(false);
  });

  it('removes a gallery preset when its thumbnail fails to load', async () => {
    render(<FloatingActions content="# Demo\n" filePath="/tmp/note.md" contentType="markdown" />);

    await waitFor(() => expect(screen.getByLabelText('制作 cover')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('制作 cover'));
    fireEvent.click(screen.getByText('小花美术馆'));

    const firstItem = COVER_GALLERY_ITEMS[0];
    const itemButton = screen.getByRole('button', { name: firstItem.title });
    const image = itemButton.querySelector('img');
    expect(image).toBeTruthy();

    fireEvent.error(image as HTMLImageElement);

    expect(screen.queryByRole('button', { name: firstItem.title })).not.toBeInTheDocument();
  });

  it('opens the built-in gallery card and applies the selected preset', async () => {
    render(<FloatingActions content="# Demo\n" filePath="/tmp/note.md" contentType="markdown" />);

    await waitFor(() => expect(screen.getByLabelText('制作 cover')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('制作 cover'));
    fireEvent.click(screen.getByText('小花美术馆'));

    expect(screen.getByRole('dialog', { name: '小花美术馆' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: COVER_GALLERY_PRESETS[0].title }));

    await waitFor(() => {
      expect(mocks.hanaFetch).toHaveBeenCalledWith(
        '/api/desk/beautify/cover/preset/apply',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            filePath: '/tmp/note.md',
            presetId: COVER_GALLERY_PRESETS[0].id,
            agentId: 'agent-1',
          }),
        }),
      );
    });

    await waitFor(() => {
      const item = useStore.getState().previewItems[0];
      expect(item.content).toContain('cover:');
      expect(item.fileVersion).toBe('v-cover');
    });
  });
});
