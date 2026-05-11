/**
 * @vitest-environment jsdom
 */

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackgroundPicker } from './BackgroundPicker';

vi.mock('./image-utils', () => ({
  MAX_CHAT_BACKGROUND_WIDTH: 1600,
  processChatBackgroundFile: vi.fn(),
}));

const { processChatBackgroundFile } = await import('./image-utils');

describe('BackgroundPicker', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows the concrete processing error and logs the original error', async () => {
    const error = new Error('图片解码失败');
    vi.mocked(processChatBackgroundFile).mockRejectedValueOnce(error);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(<BackgroundPicker value={undefined} onChange={vi.fn()} />);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'broken.png', { type: 'image/png' })] },
    });

    await waitFor(() => expect(screen.getByText('图片解码失败')).toBeInTheDocument());
    expect(consoleError).toHaveBeenCalledWith('[Xingye] Failed to process chat background', error);
  });

  it('shows save failure details from RoleDetailPanel onChange', async () => {
    vi.mocked(processChatBackgroundFile).mockResolvedValueOnce({
      dataUrl: 'data:image/png;base64,ok',
      width: 100,
      height: 80,
    });

    render(
      <BackgroundPicker
        value={undefined}
        onChange={vi.fn(async () => {
          throw new Error('保存失败：localStorage quota exceeded');
        })}
      />,
    );

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'ok.png', { type: 'image/png' })] },
    });

    await waitFor(() => expect(screen.getByText('保存失败：localStorage quota exceeded')).toBeInTheDocument());
  });
});
