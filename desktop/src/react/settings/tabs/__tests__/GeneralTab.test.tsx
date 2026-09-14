/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const getAutoLaunchStatus = vi.fn();
const setAutoLaunchEnabled = vi.fn();
const setKeepAwakeEnabled = vi.fn();
const quickChatReloadShortcut = vi.fn();
const settingsChanged = vi.fn();
const autoSaveConfig = vi.fn();
const loadSettingsConfig = vi.fn();
const updateSettingsSnapshot = vi.fn();
const hanaFetch = vi.fn();

vi.mock('../../api', () => ({
  hanaFetch: (...args: unknown[]) => hanaFetch(...args),
}));

vi.mock('../../helpers', () => ({
  t: (key: string) => key,
  autoSaveConfig: (...args: unknown[]) => autoSaveConfig(...args),
}));

vi.mock('../../actions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../actions')>();
  return {
    ...actual,
    loadSettingsConfig: (...args: unknown[]) => loadSettingsConfig(...args),
    updateSettingsSnapshot: (...args: Parameters<typeof actual.updateSettingsSnapshot>) => {
      updateSettingsSnapshot(...args);
      return actual.updateSettingsSnapshot(...args);
    },
  };
});

vi.mock('@/ui', () => ({
  Toggle: ({
    on,
    onChange,
    label,
    ariaLabel,
    disabled,
  }: {
    on: boolean | undefined;
    onChange: (next: boolean) => void;
    label?: string;
    ariaLabel?: string;
    disabled?: boolean;
  }) => (
    <button
      type="button"
      aria-label={ariaLabel || label}
      aria-busy={on === undefined ? 'true' : undefined}
      aria-checked={on === undefined ? 'mixed' : on ? 'true' : 'false'}
      data-testid={`${ariaLabel || label}-${on === undefined ? 'loading' : on ? 'on' : 'off'}`}
      disabled={disabled || on === undefined}
      onClick={() => {
        if (on !== undefined) onChange(!on);
      }}
    >
      toggle
    </button>
  ),
  SelectWidget: ({
    options,
    value,
    onChange,
    disabled,
  }: {
    options: { value: string; label: string }[];
    value: string;
    onChange: (value: string) => void;
    disabled?: boolean;
  }) => (
    <select
      aria-label="turn-completion-notification"
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.currentTarget.value)}
    >
      {options.map(option => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  ),
}));

import { GeneralTab } from '../GeneralTab';
import { useSettingsStore, type SettingsSnapshot } from '../../store';

function jsonResponse(data: unknown) {
  return {
    json: vi.fn(async () => data),
  };
}

function installHana(overrides: Record<string, unknown> = {}) {
  vi.stubGlobal('window', Object.assign(window, {
    hana: {
      getAutoLaunchStatus,
      setAutoLaunchEnabled,
      setKeepAwakeEnabled,
      quickChatReloadShortcut,
      settingsChanged,
      ...overrides,
    },
  }));
}

beforeEach(() => {
  getAutoLaunchStatus.mockResolvedValue({
    supported: true,
    openAtLogin: false,
    openedAtLogin: false,
    status: null,
  });
  hanaFetch.mockResolvedValue(jsonResponse({
    notifications: { chatCompletion: 'never' },
  }));
  quickChatReloadShortcut.mockResolvedValue({ ok: true, shortcut: 'Alt+Space' });
  useSettingsStore.setState({
    serverPort: 32123,
    serverToken: null,
    serverConnections: {},
    activeServerConnectionId: null,
    activeServerConnection: null,
    settingsAgentId: 'agent-a',
    currentAgentId: 'agent-a',
    settingsConfig: { keep_awake: false },
    settingsSnapshot: {
      key: null,
      status: 'idle',
      data: null,
      error: null,
      requestId: 0,
      updatedAt: null,
    },
    toastMessage: '',
    toastType: '',
    toastVisible: false,
  });
});

afterEach(() => {
  cleanup();
  getAutoLaunchStatus.mockReset();
  setAutoLaunchEnabled.mockReset();
  setKeepAwakeEnabled.mockReset();
  quickChatReloadShortcut.mockReset();
  settingsChanged.mockReset();
  autoSaveConfig.mockReset();
  loadSettingsConfig.mockReset();
  updateSettingsSnapshot.mockReset();
  hanaFetch.mockReset();
  useSettingsStore.setState({
    settingsConfig: null,
    settingsSnapshot: {
      key: null,
      status: 'idle',
      data: null,
      error: null,
      requestId: 0,
      updatedAt: null,
    },
  });
  vi.unstubAllGlobals();
});

describe('GeneralTab', () => {
  it('renders startup and background controls in one section', async () => {
    installHana();

    render(<GeneralTab />);

    expect(await screen.findByText('settings.general.startup.title')).toBeTruthy();
    const launchRow = await screen.findByText('settings.general.launchAtLogin');
    const keepAwakeRow = screen.getByText('settings.general.keepAwake');
    const quickChatSection = screen.getByText('settings.general.quickChat.title');
    const notificationSection = screen.getByText('settings.general.notifications.title');

    expect(launchRow.compareDocumentPosition(keepAwakeRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(keepAwakeRow.compareDocumentPosition(quickChatSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(quickChatSection.compareDocumentPosition(notificationSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId('settings.general.launchAtLogin-off')).toBeTruthy();
    expect(screen.getByTestId('settings.general.keepAwake-off')).toBeTruthy();
  });

  it('keeps the keep-awake switch in loading state until settings config is ready', async () => {
    installHana();
    useSettingsStore.setState({ settingsConfig: null });

    render(<GeneralTab />);

    const keepAwakeSwitch = await screen.findByTestId('settings.general.keepAwake-loading');
    expect(keepAwakeSwitch.getAttribute('aria-checked')).toBe('mixed');
    expect((keepAwakeSwitch as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(keepAwakeSwitch);
    expect(autoSaveConfig).not.toHaveBeenCalled();
    expect(setKeepAwakeEnabled).not.toHaveBeenCalled();
  });

  it('updates the launch-at-login row from the main-process result', async () => {
    installHana();
    setAutoLaunchEnabled.mockResolvedValue({
      supported: true,
      openAtLogin: true,
      openedAtLogin: false,
      status: null,
    });

    render(<GeneralTab />);

    fireEvent.click(await screen.findByTestId('settings.general.launchAtLogin-off'));

    await waitFor(() => expect(setAutoLaunchEnabled).toHaveBeenCalledWith(true));
    await screen.findByTestId('settings.general.launchAtLogin-on');
  });

  it('persists keep-awake preference before applying it in the main process', async () => {
    installHana();
    autoSaveConfig.mockResolvedValue(undefined);
    loadSettingsConfig.mockResolvedValue(undefined);
    setKeepAwakeEnabled.mockResolvedValue({
      enabled: true,
      active: true,
      blockerId: 42,
      type: 'prevent-app-suspension',
    });

    render(<GeneralTab />);

    fireEvent.click(await screen.findByTestId('settings.general.keepAwake-off'));

    await waitFor(() => expect(autoSaveConfig).toHaveBeenCalledWith({ keep_awake: true }, { silent: true }));
    await waitFor(() => expect(setKeepAwakeEnabled).toHaveBeenCalledWith(true));
    expect(autoSaveConfig.mock.invocationCallOrder[0]).toBeLessThan(setKeepAwakeEnabled.mock.invocationCallOrder[0]);
  });

  it('renders three completion categories and saves the chat preference through the notification route', async () => {
    installHana();
    hanaFetch
      .mockResolvedValueOnce(jsonResponse({ quickChat: { shortcut: 'Alt+Space' } }))
      .mockResolvedValueOnce(jsonResponse({ notifications: { chatCompletion: 'never' } }))
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        notifications: {
          chatCompletion: 'when_session_unfocused',
          scheduledTaskCompletion: 'never',
          patrolCompletion: 'never',
        },
      }));

    render(<GeneralTab />);

    expect(await screen.findByText('settings.general.notifications.chatCompletion')).toBeTruthy();
    expect(screen.getByText('settings.general.notifications.scheduledTaskCompletion')).toBeTruthy();
    expect(screen.getByText('settings.general.notifications.patrolCompletion')).toBeTruthy();
    const row = screen.getByTestId('chat-completion-notification-row');
    const select = within(row).getByRole('combobox');
    await waitFor(() => expect((select as HTMLSelectElement).disabled).toBe(false));
    expect(within(row).getByText('settings.general.notifications.whenSessionUnfocused')).toBeTruthy();
    fireEvent.change(select, { target: { value: 'when_session_unfocused' } });

    await waitFor(() => expect(hanaFetch).toHaveBeenLastCalledWith('/api/preferences/notifications', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notifications: { chatCompletion: 'when_session_unfocused' } }),
    }));
    await waitFor(() => expect((select as HTMLSelectElement).value).toBe('when_session_unfocused'));
  });

  it('records and registers the quick chat shortcut', async () => {
    installHana();
    hanaFetch
      .mockResolvedValueOnce(jsonResponse({ quickChat: { shortcut: 'Alt+Space', reuseTimeoutMinutes: 5 } }))
      .mockResolvedValueOnce(jsonResponse({ notifications: { chatCompletion: 'never' } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, quickChat: { shortcut: 'CommandOrControl+Shift+K', reuseTimeoutMinutes: 5 } }));
    quickChatReloadShortcut.mockResolvedValue({ ok: true, shortcut: 'CommandOrControl+Shift+K' });

    render(<GeneralTab />);

    const shortcutButton = await screen.findByLabelText('settings.general.quickChat.shortcut');
    await waitFor(() => expect((shortcutButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(shortcutButton);
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true, shiftKey: true });

    await waitFor(() => expect(hanaFetch).toHaveBeenLastCalledWith('/api/preferences/quick-chat', {
      connection: expect.objectContaining({ baseUrl: 'http://127.0.0.1:32123' }),
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quickChat: { shortcut: 'CommandOrControl+Shift+K', reuseTimeoutMinutes: 5 } }),
    }));
    expect(quickChatReloadShortcut).toHaveBeenCalledOnce();
    await waitFor(() => expect(settingsChanged).toHaveBeenCalledWith('quick-chat-shortcut-changed', {
      quickChat: { shortcut: 'CommandOrControl+Shift+K', reuseTimeoutMinutes: 5 },
    }));
  });

  it('saves the quick chat reuse timeout without re-registering the shortcut', async () => {
    installHana();
    hanaFetch
      .mockResolvedValueOnce(jsonResponse({ quickChat: { shortcut: 'Alt+Space', reuseTimeoutMinutes: 10 } }))
      .mockResolvedValueOnce(jsonResponse({ notifications: { chatCompletion: 'never' } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, quickChat: { shortcut: 'Alt+Space', reuseTimeoutMinutes: 5 } }));

    render(<GeneralTab />);

    const input = await screen.findByLabelText('settings.general.quickChat.reuseTimeout');
    fireEvent.change(input, { target: { value: '5' } });

    await waitFor(() => expect(hanaFetch).toHaveBeenLastCalledWith('/api/preferences/quick-chat', {
      connection: expect.objectContaining({ baseUrl: 'http://127.0.0.1:32123' }),
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quickChat: { shortcut: 'Alt+Space', reuseTimeoutMinutes: 5 } }),
    }));
    expect(quickChatReloadShortcut).not.toHaveBeenCalled();
  });

  it('records macOS Option+Space as Alt+Space instead of an invisible character', async () => {
    installHana();
    hanaFetch
      .mockResolvedValueOnce(jsonResponse({ quickChat: { shortcut: 'CommandOrControl+Shift+K', reuseTimeoutMinutes: 10 } }))
      .mockResolvedValueOnce(jsonResponse({ notifications: { chatCompletion: 'never' } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, quickChat: { shortcut: 'Alt+Space', reuseTimeoutMinutes: 10 } }));
    quickChatReloadShortcut.mockResolvedValue({ ok: true, shortcut: 'Alt+Space' });

    render(<GeneralTab />);

    fireEvent.click(await screen.findByLabelText('settings.general.quickChat.shortcut'));
    fireEvent.keyDown(window, { key: '\u00A0', code: 'Space', altKey: true });

    await waitFor(() => expect(hanaFetch).toHaveBeenLastCalledWith('/api/preferences/quick-chat', {
      connection: expect.objectContaining({ baseUrl: 'http://127.0.0.1:32123' }),
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quickChat: { shortcut: 'Alt+Space', reuseTimeoutMinutes: 10 } }),
    }));
    expect(quickChatReloadShortcut).toHaveBeenCalledOnce();
  });
});


const previousQuickChat = { shortcut: 'Alt+Space', reuseTimeoutMinutes: 5 };
const nextQuickChat = { shortcut: 'CommandOrControl+Shift+K', reuseTimeoutMinutes: 5 };

function seedSnapshot(quickChat = previousQuickChat, agentId = 'agent-a') {
  const snapshot: SettingsSnapshot = {
    agentId, config: {}, identity: '', agents: '', publicAgents: '', userProfile: '', experience: '',
    pinned: { pins: [] }, globalModels: {},
    preferences: {
      quickChat, browser: {}, notifications: { chatCompletion: 'never' },
      bridge: { permissionMode: 'auto', readOnly: false, receiptEnabled: true, richStreamingEnabled: true },
      speechRecognition: {}, experiments: [],
    },
    plugins: { allowFullAccess: false, devToolsEnabled: false, userDir: '' },
  };
  useSettingsStore.setState({
    settingsAgentId: agentId,
    settingsSnapshot: { key: `local:snapshot:${agentId}`, status: 'ready', data: snapshot, error: null, requestId: 1, updatedAt: 1 },
  });
}

function response(quickChat = previousQuickChat) {
  return new Response(JSON.stringify({ quickChat }), { status: 200 });
}

function recordShortcut() {
  fireEvent.click(screen.getByLabelText('settings.general.quickChat.shortcut'));
  fireEvent.keyDown(window, { key: 'k', code: 'KeyK', ctrlKey: true, shiftKey: true });
}

function expectConfirmed(quickChat: typeof previousQuickChat) {
  expect(useSettingsStore.getState().settingsSnapshot.data?.preferences.quickChat).toEqual(quickChat);
  const button = screen.getByLabelText('settings.general.quickChat.shortcut') as HTMLButtonElement;
  expect(button.textContent).toBe(quickChat.shortcut === 'Alt+Space' ? 'AltSpace' : 'CtrlShiftK');
  expect(button.disabled).toBe(false);
  expect((screen.getByLabelText('settings.general.quickChat.reuseTimeout') as HTMLInputElement).value).toBe(String(quickChat.reuseTimeoutMinutes));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('GeneralTab quick-chat failure recovery with real HTTP validation and snapshot updates', () => {
  const transport = vi.fn<typeof fetch>();
  let serverPreferences = { ...previousQuickChat };

  beforeEach(async () => {
    installHana();
    seedSnapshot();
    serverPreferences = { ...previousQuickChat };
    transport.mockReset();
    transport.mockImplementation(async (_url, options) => {
      if (options?.method === 'PUT') serverPreferences = JSON.parse(String(options.body)).quickChat;
      return response(serverPreferences);
    });
    vi.stubGlobal('fetch', transport);
    const actual = await vi.importActual<typeof import('../../api')>('../../api');
    hanaFetch.mockImplementation(actual.hanaFetch);
  });

  it('publishes the confirmed save to the mounted component and shared snapshot, including re-entry', async () => {
    const page = render(<GeneralTab />);
    recordShortcut();
    await waitFor(() => expectConfirmed(nextQuickChat));
    expect(serverPreferences).toEqual(nextQuickChat);
    expect(settingsChanged).toHaveBeenCalledOnce();
    page.unmount();
    render(<GeneralTab />);
    await waitFor(() => expectConfirmed(nextQuickChat));
    expect(transport).toHaveBeenCalledOnce();
  });

  it('reads back a rejected first save without issuing a compensating PUT', async () => {
    transport.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'first save rejected' }), { status: 500 }));
    render(<GeneralTab />);
    recordShortcut();
    await waitFor(() => expect(useSettingsStore.getState().toastMessage).toContain('first save rejected'));
    expectConfirmed(previousQuickChat);
    expect(serverPreferences).toEqual(previousQuickChat);
    expect(transport.mock.calls.map(([, options]) => options?.method)).toEqual(['PUT', 'GET']);
    expect(quickChatReloadShortcut).toHaveBeenCalledOnce();
  });

  it('reconciles an accepted first save whose response was lost without replaying the write', async () => {
    transport.mockImplementationOnce(async (_url, options) => {
      serverPreferences = JSON.parse(String(options?.body)).quickChat;
      throw new TypeError('save response lost');
    });
    render(<GeneralTab />);
    recordShortcut();
    await waitFor(() => expect(useSettingsStore.getState().toastMessage).toContain('save response lost'));
    expectConfirmed(nextQuickChat);
    expect(serverPreferences).toEqual(nextQuickChat);
    expect(transport.mock.calls.map(([, options]) => options?.method)).toEqual(['PUT', 'GET']);
    expect(quickChatReloadShortcut).toHaveBeenCalledOnce();
    expect(settingsChanged).not.toHaveBeenCalled();
  });

  it('publishes a confirmed rollback to the real snapshot and preserves it when re-entering', async () => {
    quickChatReloadShortcut.mockResolvedValueOnce({ ok: false, error: 'shortcut occupied' });
    const page = render(<GeneralTab />);
    recordShortcut();
    await waitFor(() => expect(useSettingsStore.getState().toastMessage).toContain('shortcut occupied'));
    expectConfirmed(previousQuickChat);
    expect(serverPreferences).toEqual(previousQuickChat);
    expect(quickChatReloadShortcut).toHaveBeenCalledTimes(2);
    expect(settingsChanged).not.toHaveBeenCalled();
    page.unmount();
    render(<GeneralTab />);
    await waitFor(() => expectConfirmed(previousQuickChat));
  });

  it.each(['network', 'HTTP 500'])('reports a rollback %s failure and reads back the actual saved preference', async failure => {
    quickChatReloadShortcut.mockResolvedValueOnce({ ok: false, error: 'shortcut occupied' });
    transport.mockImplementationOnce(async (_url, options) => {
      serverPreferences = JSON.parse(String(options?.body)).quickChat;
      return response(serverPreferences);
    });
    if (failure === 'network') transport.mockRejectedValueOnce(new TypeError('rollback disconnected'));
    else transport.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'rollback HTTP 500' }), { status: 500 }));
    render(<GeneralTab />);
    recordShortcut();
    await waitFor(() => expect(useSettingsStore.getState().toastMessage).toContain('settings.security.restoreFailed'));
    expect(useSettingsStore.getState().toastMessage).toContain('shortcut occupied');
    expect(useSettingsStore.getState().toastMessage).toContain(failure === 'network' ? 'rollback disconnected' : 'rollback HTTP 500');
    expectConfirmed(nextQuickChat);
    expect(serverPreferences).toEqual(nextQuickChat);
    expect(transport.mock.calls.map(([, options]) => options?.method)).toEqual(['PUT', 'PUT', 'GET']);
    expect(quickChatReloadShortcut).toHaveBeenCalledTimes(2);
  });

  it('reports a second host registration failure while keeping the confirmed rollback', async () => {
    quickChatReloadShortcut
      .mockResolvedValueOnce({ ok: false, error: 'new shortcut occupied' })
      .mockResolvedValueOnce({ ok: false, error: 'old shortcut unavailable' });
    render(<GeneralTab />);
    recordShortcut();
    await waitFor(() => expect(useSettingsStore.getState().toastMessage).toContain('old shortcut unavailable'));
    expect(useSettingsStore.getState().toastMessage).toContain('new shortcut occupied');
    expectConfirmed(previousQuickChat);
    expect(serverPreferences).toEqual(previousQuickChat);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(settingsChanged).not.toHaveBeenCalled();
  });

  it('marks unknown state unavailable and lets the user retry a failed reconciliation without rewriting', async () => {
    quickChatReloadShortcut.mockResolvedValueOnce({ ok: false, error: 'shortcut occupied' });
    transport
      .mockImplementationOnce(async (_url, options) => {
        serverPreferences = JSON.parse(String(options?.body)).quickChat;
        return response(serverPreferences);
      })
      .mockRejectedValueOnce(new TypeError('rollback disconnected'))
      .mockRejectedValueOnce(new TypeError('read disconnected'));
    render(<GeneralTab />);
    recordShortcut();
    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toContain('read disconnected');
    expect(useSettingsStore.getState().settingsSnapshot.data).toBeNull();
    expect((screen.getByLabelText('settings.general.quickChat.shortcut') as HTMLButtonElement).disabled).toBe(true);
    expect(transport.mock.calls.filter(([url]) => String(url).endsWith('/quick-chat'))).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'action.retry' }));
    await waitFor(() => expect((screen.getByLabelText('settings.general.quickChat.shortcut') as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByLabelText('settings.general.quickChat.shortcut').textContent).toBe('CtrlShiftK');
    expect(transport.mock.calls.filter(([url]) => String(url).endsWith('/quick-chat')).map(([, options]) => options?.method || 'GET')).toEqual(['PUT', 'PUT', 'GET', 'GET']);
    expect(serverPreferences).toEqual(nextQuickChat);
    expect(quickChatReloadShortcut).toHaveBeenCalledTimes(2);
  });

  it.each(['owner', 'connection'])('ignores a pending save response after the %s changes', async change => {
    const pending = deferred<Response>();
    transport.mockReturnValueOnce(pending.promise);
    render(<GeneralTab />);
    recordShortcut();
    await act(async () => {
      if (change === 'connection') useSettingsStore.setState({ serverPort: 32124 });
      seedSnapshot(previousQuickChat, change === 'owner' ? 'agent-b' : 'agent-a');
    });
    await act(async () => pending.resolve(response(nextQuickChat)));
    expectConfirmed(previousQuickChat);
    expect(quickChatReloadShortcut).not.toHaveBeenCalled();
    expect(settingsChanged).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledOnce();
    expect(useSettingsStore.getState().toastMessage).toBe('');
  });

  it.each(['owner', 'connection'])('does not compensate on a new %s when an old host registration fails late', async change => {
    const pending = deferred<{ ok: boolean; error: string }>();
    quickChatReloadShortcut.mockReturnValueOnce(pending.promise);
    render(<GeneralTab />);
    recordShortcut();
    await waitFor(() => expect(quickChatReloadShortcut).toHaveBeenCalledOnce());
    await act(async () => {
      if (change === 'connection') useSettingsStore.setState({ serverPort: 32124 });
      seedSnapshot(previousQuickChat, change === 'owner' ? 'agent-b' : 'agent-a');
    });
    await act(async () => pending.resolve({ ok: false, error: 'stale registration failed' }));
    expectConfirmed(previousQuickChat);
    expect(transport).toHaveBeenCalledOnce();
    expect(settingsChanged).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().toastMessage).toBe('');
  });

  it('reads a rollback that was accepted before its response was lost without replaying it', async () => {
    quickChatReloadShortcut.mockResolvedValueOnce({ ok: false, error: 'shortcut occupied' });
    transport
      .mockImplementationOnce(async (_url, options) => {
        serverPreferences = JSON.parse(String(options?.body)).quickChat;
        return response(serverPreferences);
      })
      .mockImplementationOnce(async (_url, options) => {
        serverPreferences = JSON.parse(String(options?.body)).quickChat;
        throw new TypeError('rollback response lost');
      });
    render(<GeneralTab />);
    recordShortcut();
    await waitFor(() => expect(useSettingsStore.getState().toastMessage).toContain('rollback response lost'));
    expectConfirmed(previousQuickChat);
    expect(serverPreferences).toEqual(previousQuickChat);
    expect(transport.mock.calls.map(([, options]) => options?.method)).toEqual(['PUT', 'PUT', 'GET']);
    expect(quickChatReloadShortcut).toHaveBeenCalledTimes(2);
  });

  it('does not publish or register a save response after unmount', async () => {
    const pending = deferred<Response>();
    transport.mockReturnValueOnce(pending.promise);
    const page = render(<GeneralTab />);
    recordShortcut();
    page.unmount();
    await act(async () => pending.resolve(response(nextQuickChat)));
    expect(useSettingsStore.getState().settingsSnapshot.data?.preferences.quickChat).toEqual(previousQuickChat);
    expect(quickChatReloadShortcut).not.toHaveBeenCalled();
    expect(settingsChanged).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledOnce();
  });

  it('ignores an old reconciliation GET after switching connection', async () => {
    const pending = deferred<Response>();
    transport.mockRejectedValueOnce(new TypeError('save disconnected')).mockReturnValueOnce(pending.promise);
    render(<GeneralTab />);
    recordShortcut();
    await waitFor(() => expect(transport).toHaveBeenCalledTimes(2));
    await act(async () => {
      useSettingsStore.setState({ serverPort: 32124 });
      seedSnapshot(previousQuickChat);
    });
    await act(async () => pending.resolve(response(nextQuickChat)));
    expectConfirmed(previousQuickChat);
    expect(transport.mock.calls.map(([url]) => String(url))).toEqual([
      'http://127.0.0.1:32123/api/preferences/quick-chat',
      'http://127.0.0.1:32123/api/preferences/quick-chat',
    ]);
    expect(useSettingsStore.getState().toastMessage).toBe('');
  });


  it('keeps read-back preferences confirmed when host recovery also fails', async () => {
    transport.mockImplementationOnce(async (_url, options) => {
      serverPreferences = JSON.parse(String(options?.body)).quickChat;
      throw new TypeError('save response lost');
    });
    quickChatReloadShortcut.mockResolvedValueOnce({ ok: false, error: 'recovered shortcut unavailable' });
    render(<GeneralTab />);
    recordShortcut();
    await waitFor(() => expect(useSettingsStore.getState().toastMessage).toContain('recovered shortcut unavailable'));
    expect(useSettingsStore.getState().toastMessage).toContain('save response lost');
    expectConfirmed(nextQuickChat);
    expect(serverPreferences).toEqual(nextQuickChat);
    expect(transport.mock.calls.map(([, options]) => options?.method)).toEqual(['PUT', 'GET']);
  });

});
