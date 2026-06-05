/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('../../../hooks/use-auto-update-state', () => ({
  useAutoUpdateState: () => ({ status: 'idle' }),
}));

vi.mock('../../widgets/Toggle', () => ({
  Toggle: ({
    on,
    onChange,
    label,
    ariaLabel,
  }: {
    on: boolean;
    onChange: (next: boolean) => void;
    label?: string;
    ariaLabel?: string;
  }) => (
    <button
      type="button"
      aria-label={ariaLabel || label}
      data-testid={`${ariaLabel || label}-${on ? 'on' : 'off'}`}
      onClick={() => onChange(!on)}
    >
      toggle
    </button>
  ),
}));

vi.mock('../../helpers', () => ({
  t: (key: string) => key,
  autoSaveConfig: vi.fn(),
}));

vi.mock('../../actions', () => ({
  loadSettingsConfig: vi.fn(),
}));

import { AboutTab } from '../AboutTab';
import { useSettingsStore } from '../../store';

afterEach(() => {
  cleanup();
  useSettingsStore.setState({ settingsConfig: null });
  vi.unstubAllGlobals();
});

function installHana() {
  vi.stubGlobal('window', Object.assign(window, {
    hana: {
      getAppVersion: vi.fn().mockResolvedValue('0.160.2'),
      autoUpdateCheck: vi.fn(),
      autoUpdateInstall: vi.fn(),
      autoUpdateSetChannel: vi.fn(),
      openExternal: vi.fn(),
    },
  }));
}

describe('AboutTab', () => {
  it('keeps startup and background controls out of the about page', () => {
    installHana();
    useSettingsStore.setState({ settingsConfig: { auto_check_updates: true, update_channel: 'stable' } });

    render(<AboutTab />);

    expect(screen.getByText('settings.about.autoCheckUpdates')).toBeTruthy();
    expect(screen.getByText('settings.about.betaUpdates')).toBeTruthy();
    expect(screen.queryByText('settings.general.launchAtLogin')).toBeNull();
    expect(screen.queryByText('settings.general.keepAwake')).toBeNull();
  });
});
