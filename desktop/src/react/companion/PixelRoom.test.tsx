// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../stores';
import { PixelRoom } from './PixelRoom';
import { companionTranslation } from '../__tests__/helpers/companion-translations';

const scopeKey = 'agent\u0000room-session';
const sessionPath = '/room-session';

describe('pixel room user interaction', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(`hana:pixel-room:v1:${scopeKey}`, JSON.stringify({ col: 7, row: 4 }));
    useStore.setState({ currentSessionPath: sessionPath, currentSessionId: null, drafts: {}, draftDocs: {}, locale: 'zh' } as never);
    vi.stubGlobal('t', (key: string, vars?: Record<string, string | number>) =>
      companionTranslation(useStore.getState().locale, key, vars));
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('keeps furniture movement local and only prepares an editable draft after an explicit click', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    render(<PixelRoom agentName="小花" sessionPath={sessionPath} scopeKey={scopeKey} companionState="idle" />);
    expect(screen.getByText(/在沙发旁休息/)).toBeInTheDocument();
    expect(useStore.getState().drafts).toEqual({});
    fireEvent.click(screen.getByRole('button', { name: '前往沙发' }));
    expect(useStore.getState().drafts).toEqual({});
    fireEvent.click(screen.getByRole('button', { name: '把交流意图填入输入框' }));
    expect(useStore.getState().drafts[sessionPath]).toBe('陪我聊聊吧。');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('preserves a user draft when a furniture prompt is requested', () => {
    useStore.setState({ drafts: { [sessionPath]: '我的原稿' } } as never);
    render(<PixelRoom agentName="小花" sessionPath={sessionPath} scopeKey={scopeKey} companionState="idle" />);
    fireEvent.click(screen.getByRole('button', { name: '把交流意图填入输入框' }));
    expect(useStore.getState().drafts[sessionPath]).toBe('我的原稿');
    expect(screen.getByText(/输入框已有草稿/)).toBeInTheDocument();
  });

  it('updates room labels and editable draft language when the UI locale changes', () => {
    render(<PixelRoom agentName="Flower" sessionPath={sessionPath} scopeKey={scopeKey} companionState="idle" />);
    expect(screen.getByText(/在沙发旁休息/)).toBeInTheDocument();
    act(() => useStore.setState({ locale: 'en' }));
    expect(screen.getByText(/Resting by the sofa/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Go to sofa' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add this idea to the input' }));
    expect(useStore.getState().drafts[sessionPath]).toBe("Let's chat for a while.");
  });
});
