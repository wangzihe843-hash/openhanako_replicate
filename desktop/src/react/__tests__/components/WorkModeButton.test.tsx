// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React, { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkModeButton } from '../../components/input/WorkModeButton';
import { ChatPage } from '../../components/app/ChatPage';

const state = vi.hoisted(() => ({ currentSessionPath: 'session-a' as string | null, welcomeVisible: false, pendingNewSession: false }));
const hanaFetch = vi.hoisted(() => vi.fn());
const pageOnChange = vi.hoisted(() => vi.fn());
vi.mock('../../hooks/use-hana-fetch', () => ({ hanaFetch }));
vi.mock('../../hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('../../stores', () => ({
  useStore: Object.assign((selector: (snapshot: typeof state) => unknown) => selector(state), {
    getState: () => state,
  }),
}));
// Keep ChatPage's real session key and the real control; unrelated UI is inert.
vi.mock('../../components/InputArea', () => ({
  InputArea: () => <WorkModeButton enabled={false} onChange={pageOnChange} />,
}));
vi.mock('../../components/WelcomeScreen', () => ({ WelcomeScreen: () => null }));
vi.mock('../../components/chat/ChatArea', () => ({ ChatArea: () => null }));
vi.mock('../../components/RegionalErrorBoundary', () => ({
  RegionalErrorBoundary: ({ children }: { children: React.ReactNode }) => children,
}));

function deferredResponse() {
  let resolve!: (response: Response) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<Response>((yes, no) => { resolve = yes; reject = no; });
  return {
    promise,
    resolve: (body: { ok?: boolean; enabled?: boolean }) => resolve({ json: async () => body } as Response),
    reject,
  };
}

function Harness({ onChange }: { onChange: (value: boolean) => void }) {
  const [enabled, setEnabled] = useState(false);
  return <WorkModeButton enabled={enabled} onChange={(value) => { onChange(value); setEnabled(value); }} />;
}

describe('WorkModeButton request ownership', () => {
  beforeEach(() => {
    state.currentSessionPath = 'session-a';
    state.pendingNewSession = false;
    hanaFetch.mockReset();
    pageOnChange.mockReset();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('updates the current session optimistically and applies its server response', async () => {
    const request = deferredResponse();
    hanaFetch.mockReturnValue(request.promise);
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onChange.mock.calls).toEqual([[true]]);
    expect(JSON.parse(hanaFetch.mock.calls[0][1].body)).toEqual({ sessionPath: 'session-a', enabled: true });

    await act(async () => { request.resolve({ ok: true, enabled: false }); });
    expect(onChange.mock.calls).toEqual([[true], [false]]);
    expect(screen.getByRole('button').getAttribute('aria-pressed')).toBe('false');
  });

  it.each(['response', 'rejection'] as const)('does not apply a late %s to another session', async (outcome) => {
    const request = deferredResponse();
    hanaFetch.mockReturnValue(request.promise);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const onChange = vi.fn();
    const view = render(<WorkModeButton enabled={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button'));
    state.currentSessionPath = 'session-b';
    view.rerender(<WorkModeButton enabled={false} onChange={onChange} />);
    onChange.mockClear();

    await act(async () => {
      if (outcome === 'response') request.resolve({ ok: true, enabled: true });
      else request.reject(new Error('late request failure'));
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each(['response', 'rejection'] as const)('ignores a superseded %s from an earlier toggle', async (outcome) => {
    const first = deferredResponse();
    const second = deferredResponse();
    hanaFetch.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByRole('button'));
    expect(onChange.mock.calls).toEqual([[true], [false]]);
    await act(async () => { second.resolve({ ok: true, enabled: false }); });
    onChange.mockClear();

    await act(async () => {
      if (outcome === 'response') first.resolve({ ok: true, enabled: true });
      else first.reject(new Error('superseded failure'));
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('button').getAttribute('aria-pressed')).toBe('false');
  });

  it.each(['response', 'rejection'] as const)('does not update after unmount on %s', async (outcome) => {
    const request = deferredResponse();
    hanaFetch.mockReturnValue(request.promise);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const onChange = vi.fn();
    const view = render(<WorkModeButton enabled={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button'));
    view.unmount();
    onChange.mockClear();

    await act(async () => {
      if (outcome === 'response') request.resolve({ ok: true, enabled: true });
      else request.reject(new Error('request finished after unmount'));
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each(['error envelope', 'rejection'] as const)('rolls back the latest current-session request on %s', async (outcome) => {
    const request = deferredResponse();
    hanaFetch.mockReturnValue(request.promise);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByRole('button'));

    await act(async () => {
      if (outcome === 'error envelope') request.resolve({ ok: false });
      else request.reject(new Error('current request failed'));
    });
    expect(onChange.mock.calls).toEqual([[true], [false]]);
    expect(screen.getByRole('button').getAttribute('aria-pressed')).toBe('false');
  });

  it.each(['response', 'rejection'] as const)('ignores the original A request after ChatPage switches A to B to A (%s)', async (outcome) => {
    const request = deferredResponse();
    hanaFetch.mockReturnValue(request.promise);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const view = render(<ChatPage />);
    fireEvent.click(screen.getByRole('button'));
    expect(pageOnChange.mock.calls).toEqual([[true]]);
    state.currentSessionPath = 'session-b';
    view.rerender(<ChatPage />);
    state.currentSessionPath = 'session-a';
    view.rerender(<ChatPage />);
    pageOnChange.mockClear();

    await act(async () => {
      if (outcome === 'response') request.resolve({ ok: true, enabled: true });
      else request.reject(new Error('original A request failed'));
    });
    expect(pageOnChange).not.toHaveBeenCalled();
    expect(screen.getByRole('button').getAttribute('aria-pressed')).toBe('false');
  });

  it('preselects and cancels work mode locally before a session exists', () => {
    state.currentSessionPath = null;
    state.pendingNewSession = true;
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('button').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('button').getAttribute('aria-pressed')).toBe('false');
    expect(onChange.mock.calls).toEqual([[true], [false]]);
    expect(hanaFetch).not.toHaveBeenCalled();
    expect(state.currentSessionPath).toBeNull();
  });

  it('does not submit a session-less toggle', () => {
    state.currentSessionPath = null;
    const onChange = vi.fn();
    render(<WorkModeButton enabled={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button'));
    expect(hanaFetch).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });
});
