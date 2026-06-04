// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsContent } from '../SettingsContent';
import { useSettingsStore } from '../store';

vi.mock('../actions', () => ({
  loadAgents: vi.fn(async () => {}),
  loadAvatars: vi.fn(async () => {}),
  loadSettingsConfig: vi.fn(async () => {}),
  loadPluginSettings: vi.fn(async () => {}),
}));

vi.mock('../api', () => ({
  hanaFetch: vi.fn(async (url: string) => {
    if (url === '/api/config') {
      return new Response(JSON.stringify({ locale: 'zh-CN' }));
    }
    return new Response(JSON.stringify({ experiments: [] }));
  }),
}));

describe('SettingsContent tab heading', () => {
  beforeEach(() => {
    window.t = ((key: string) => key) as typeof window.t;
    window.i18n = {
      locale: 'zh-CN',
      defaultName: 'Hana',
      _data: {},
      _agentOverrides: {},
      load: vi.fn(async () => {}),
      setAgentOverrides: vi.fn(),
      t: ((key: string) => key) as typeof window.t,
    };
    window.platform = {
      getServerPort: vi.fn(async () => 3000),
      getServerToken: vi.fn(async () => null),
      getPlatform: vi.fn(async () => 'darwin'),
      onSwitchTab: vi.fn(),
      onSettingsChanged: vi.fn(),
      onServerRestarted: vi.fn(),
    } as unknown as typeof window.platform;
    useSettingsStore.setState({
      activeTab: 'experiments',
      platformName: 'darwin',
      pluginSettingsTabs: [],
      ready: true,
    } as never);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders experiment copy as a tab-level description', async () => {
    render(React.createElement(SettingsContent, { variant: 'window' }));

    const description = screen.getByText('settings.experiments.description');
    expect(description.tagName).toBe('P');

    await waitFor(() => {
      expect(screen.getByText('settings.experiments.empty')).toBeTruthy();
    });
  });
});
