// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExperimentsTab } from '../ExperimentsTab';
import { useSettingsStore } from '../../store';

const hanaFetchMock = vi.fn(async (url: string) => {
  if (url === '/api/preferences/computer-use') {
    return new Response(JSON.stringify({
      selectedProviderId: 'macos:cua',
      settings: { enabled: false, app_approvals: [] },
      status: {
        providers: [{ providerId: 'macos:cua', status: { available: false, permissions: [] } }],
        activeLease: null,
      },
    }));
  }
  return new Response(JSON.stringify({ experiments: [] }));
});

vi.mock('../../api', () => ({
  hanaFetch: (...args: [string]) => hanaFetchMock(...args),
}));

describe('ExperimentsTab', () => {
  beforeEach(() => {
    window.t = ((key: string) => key) as typeof window.t;
    useSettingsStore.setState({ platformName: 'darwin', showToast: vi.fn() } as never);
  });

  afterEach(() => {
    cleanup();
    hanaFetchMock.mockClear();
    vi.clearAllMocks();
  });

  it('uses cache memory as the section title and keeps the cache intro above the card body', async () => {
    const { container } = render(React.createElement(ExperimentsTab));

    expect(screen.getByText('settings.experiments.memoryTitle')).toBeTruthy();
    expect(screen.getByText('settings.experiments.cacheSnapshot.description')).toBeTruthy();
    expect(screen.getByText('settings.computerUse.title')).toBeTruthy();
    expect(screen.queryByText('settings.experiments.description')).toBeNull();

    await waitFor(() => {
      expect(screen.getByText('settings.experiments.empty')).toBeTruthy();
    });

    const body = Array.from(container.querySelectorAll('[class*="sectionBody"]'))
      .find((sectionBody) => sectionBody.textContent?.includes('settings.experiments.empty'));
    expect(body?.textContent).toContain('settings.experiments.empty');
    expect(body?.textContent).not.toContain('settings.experiments.cacheSnapshot.description');
  });

  it('hides Computer Use on Linux preview', () => {
    useSettingsStore.setState({ platformName: 'linux', showToast: vi.fn() } as never);

    render(React.createElement(ExperimentsTab));

    expect(screen.queryByText('settings.computerUse.title')).toBeNull();
  });
});
