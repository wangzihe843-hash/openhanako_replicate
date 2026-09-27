// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PetApp } from './PetApp';
import type { PetBridge, PetContext, PetWindowState } from './pet-types';
import { companionPacks, companionTranslation } from '../__tests__/helpers/companion-translations';

const oldContext: PetContext = {
  agentId: 'old', agentName: '旧角色', sessionPath: '/old', sessionId: null,
  connected: false, streaming: false, awaitingApproval: false, inlineError: false,
};
const nextContext: PetContext = { ...oldContext, agentId: 'next', agentName: '新角色', sessionPath: '/next' };
const oldState: PetWindowState = {
  supported: true, visible: true, paused: false, clickThrough: false, alwaysOnTop: false, context: oldContext,
};

beforeEach(() => {
  const i18n = {
    locale: 'zh',
    load: vi.fn(async (locale: string) => {
      i18n.locale = locale === 'zh-TW' ? 'zh-TW' : locale.startsWith('zh') ? 'zh'
        : locale.startsWith('ja') ? 'ja' : locale.startsWith('ko') ? 'ko' : 'en';
    }),
  };
  vi.stubGlobal('i18n', i18n);
  vi.stubGlobal('t', (key: string, vars?: Record<string, string | number>) => companionTranslation(i18n.locale, key, vars));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('PetApp initial state', () => {
  it('loads the configured language and refreshes it when the window becomes visible', async () => {
    let configuredLocale = 'en';
    const fetchConfig = vi.fn(async () => new Response(JSON.stringify({ locale: configuredLocale }), { status: 200 }));
    vi.stubGlobal('fetch', fetchConfig);
    const bridge: PetBridge = {
      getState: vi.fn(async () => oldState),
      getConnection: vi.fn(async () => ({ port: 4000, token: 'test-token' })),
      hide: vi.fn(async () => null), setOptions: vi.fn(async () => null), openMain: vi.fn(async () => {}),
      onState: vi.fn(() => () => {}), onContext: vi.fn(() => () => {}), onResume: vi.fn(() => () => {}),
    };
    vi.stubGlobal('hanaPet', bridge);
    render(<PetApp />);
    expect(await screen.findByRole('button', { name: 'Pause' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Status unavailable');
    expect(fetchConfig).toHaveBeenCalledWith('http://127.0.0.1:4000/api/config', expect.objectContaining({
      headers: { Authorization: 'Bearer test-token' },
    }));
    configuredLocale = 'ja';
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(await screen.findByRole('button', { name: '一時停止' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('状態を取得できません');
    expect(fetchConfig).toHaveBeenCalledTimes(2);
  });

  it('ignores an old locale response after unmount and does not overlap refreshes', async () => {
    let finishConfig!: (response: Response) => void;
    const fetchConfig = vi.fn(() => new Promise<Response>(resolve => { finishConfig = resolve; }));
    vi.stubGlobal('fetch', fetchConfig);
    const bridge: PetBridge = {
      getState: vi.fn(async () => oldState),
      getConnection: vi.fn(async () => ({ port: 4000, token: 'test-token' })),
      hide: vi.fn(async () => null), setOptions: vi.fn(async () => null), openMain: vi.fn(async () => {}),
      onState: vi.fn(() => () => {}), onContext: vi.fn(() => () => {}), onResume: vi.fn(() => () => {}),
    };
    vi.stubGlobal('hanaPet', bridge);
    render(<PetApp />);
    await waitFor(() => expect(fetchConfig).toHaveBeenCalledTimes(1));
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(fetchConfig).toHaveBeenCalledTimes(1);
    cleanup();
    await act(async () => { finishConfig(new Response(JSON.stringify({ locale: 'en' }), { status: 200 })); });
    expect(window.i18n.load).not.toHaveBeenCalled();
  });

  it('has the same companion keys in every shipped language pack', () => {
    const keys = (value: unknown, prefix = ''): string[] => value && typeof value === 'object' && !Array.isArray(value)
      ? Object.entries(value).flatMap(([name, child]) => keys(child, prefix ? `${prefix}.${name}` : name))
      : [prefix];
    const expected = keys(companionPacks.zh.companion).sort();
    for (const locale of ['zh-TW', 'en', 'ja', 'ko']) {
      expect(keys(companionPacks[locale].companion).sort()).toEqual(expected);
      for (const key of expected) expect(companionTranslation(locale, `companion.${key}`)).not.toBe(`companion.${key}`);
    }
  });

  it('keeps a live session event when an older initial snapshot arrives late', async () => {
    let finishSnapshot!: (state: PetWindowState) => void;
    let onContext!: (context: PetContext | null) => void;
    const bridge: PetBridge = {
      getState: vi.fn(() => new Promise<PetWindowState | null>(resolve => { finishSnapshot = resolve; })),
      getConnection: vi.fn(async () => null), hide: vi.fn(async () => null),
      setOptions: vi.fn(async () => null), openMain: vi.fn(async () => {}),
      onState: vi.fn(() => () => {}),
      onContext: vi.fn(callback => { onContext = callback; return () => {}; }),
      onResume: vi.fn(() => () => {}),
    };
    vi.stubGlobal('hanaPet', bridge);
    render(<PetApp />);
    await act(async () => { onContext(nextContext); });
    expect(screen.getByText('新角色')).toBeInTheDocument();
    await act(async () => { finishSnapshot(oldState); });
    expect(screen.getByText('新角色')).toBeInTheDocument();
    expect(screen.queryByText('旧角色')).not.toBeInTheDocument();
  });

  it('keeps a live window state when an older initial snapshot arrives late', async () => {
    let finishSnapshot!: (state: PetWindowState) => void;
    let onState!: (state: PetWindowState) => void;
    const bridge: PetBridge = {
      getState: vi.fn(() => new Promise<PetWindowState | null>(resolve => { finishSnapshot = resolve; })),
      getConnection: vi.fn(async () => null), hide: vi.fn(async () => null),
      setOptions: vi.fn(async () => null), openMain: vi.fn(async () => {}),
      onState: vi.fn(callback => { onState = callback; return () => {}; }),
      onContext: vi.fn(() => () => {}), onResume: vi.fn(() => () => {}),
    };
    vi.stubGlobal('hanaPet', bridge);
    render(<PetApp />);
    await act(async () => { onState({ ...oldState, paused: true, context: nextContext }); });
    await act(async () => { finishSnapshot(oldState); });
    expect(screen.getByText('新角色')).toBeInTheDocument();
    expect(screen.getByText('动作已暂停')).toBeInTheDocument();
  });

  it('keeps a newer live state when an older option response arrives late', async () => {
    let finishOptions!: (state: PetWindowState) => void;
    let onState!: (state: PetWindowState) => void;
    const bridge: PetBridge = {
      getState: vi.fn(async () => oldState),
      getConnection: vi.fn(async () => null), hide: vi.fn(async () => null),
      setOptions: vi.fn(() => new Promise<PetWindowState | null>(resolve => { finishOptions = resolve; })),
      openMain: vi.fn(async () => {}),
      onState: vi.fn(callback => { onState = callback; return () => {}; }),
      onContext: vi.fn(() => () => {}), onResume: vi.fn(() => () => {}),
    };
    vi.stubGlobal('hanaPet', bridge);
    render(<PetApp />);
    await screen.findByText('旧角色');
    fireEvent.click(screen.getByRole('button', { name: '暂停' }));
    await act(async () => { onState({ ...oldState, paused: true }); });
    await act(async () => { finishOptions(oldState); });
    expect(screen.getByText('动作已暂停')).toBeInTheDocument();
  });
});
