// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../stores';
import type { Agent } from '../../types';
import type { PetWindowState } from '../../companion/pet-types';
import { CompanionStatusCard } from './CompanionStatusCard';
import { companionTranslation } from '../../__tests__/helpers/companion-translations';

const petState: PetWindowState = {
  supported: true, visible: true, paused: true, clickThrough: false, alwaysOnTop: false, context: null,
};

beforeEach(() => {
  useStore.setState({ locale: 'zh' });
  vi.stubGlobal('t', (key: string, vars?: Record<string, string | number>) =>
    companionTranslation(useStore.getState().locale, key, vars));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('CompanionStatusCard pet state', () => {
  it('switches the shared status and pet controls to the active UI language', async () => {
    vi.stubGlobal('platform', { petState: async () => petState, onPetState: () => () => {} });
    const agent: Agent = { id: 'agent-a', name: '阿花', yuan: 'hanako', isPrimary: false, hasAvatar: false };
    useStore.setState({ agents: [agent], currentAgentId: agent.id, currentSessionPath: '/session-a', currentSessionId: null, connected: false });
    render(<CompanionStatusCard />);
    expect(await screen.findByRole('button', { name: '继续' })).toBeInTheDocument();
    act(() => useStore.setState({ locale: 'en' }));
    expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pixel room' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Status unavailable');
  });

  it('does not let a late initial snapshot replace a live pet state event', async () => {
    let finishSnapshot!: (state: PetWindowState) => void;
    let onPetState!: (state: PetWindowState) => void;
    vi.stubGlobal('platform', {
      petState: () => new Promise<PetWindowState>(resolve => { finishSnapshot = resolve; }),
      onPetState: (callback: (state: PetWindowState) => void) => {
        onPetState = callback;
        return () => {};
      },
    });
    const agent: Agent = { id: 'agent-a', name: '阿花', yuan: 'hanako', isPrimary: false, hasAvatar: false };
    useStore.setState({
      agents: [agent], currentAgentId: agent.id, currentSessionPath: '/session-a',
      currentSessionId: null, connected: false,
    });
    render(<CompanionStatusCard />);
    await act(async () => { onPetState(petState); });
    expect(screen.getByRole('button', { name: '继续' })).toBeInTheDocument();
    await act(async () => { finishSnapshot({ ...petState, supported: false, paused: false }); });
    expect(screen.getByRole('button', { name: '继续' })).toBeInTheDocument();
  });

  it('does not let a late control response replace a newer live pet state', async () => {
    let finishOptions!: (state: PetWindowState) => void;
    let onPetState!: (state: PetWindowState) => void;
    vi.stubGlobal('platform', {
      petState: async () => ({ ...petState, paused: false }),
      petSetOptions: () => new Promise<PetWindowState>(resolve => { finishOptions = resolve; }),
      onPetState: (callback: (state: PetWindowState) => void) => {
        onPetState = callback;
        return () => {};
      },
    });
    const agent: Agent = { id: 'agent-a', name: '阿花', yuan: 'hanako', isPrimary: false, hasAvatar: false };
    useStore.setState({
      agents: [agent], currentAgentId: agent.id, currentSessionPath: '/session-a',
      currentSessionId: null, connected: false,
    });
    render(<CompanionStatusCard />);
    const pause = await screen.findByRole('button', { name: '暂停' });
    fireEvent.click(pause);
    await act(async () => { onPetState(petState); });
    await act(async () => { finishOptions({ ...petState, paused: false }); });
    expect(screen.getByRole('button', { name: '继续' })).toBeInTheDocument();
  });
});
