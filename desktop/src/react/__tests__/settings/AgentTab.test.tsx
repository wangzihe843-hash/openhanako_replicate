/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from '../../settings/store';

vi.mock('../../settings/api', () => ({
  hanaFetch: vi.fn(async () => ({
    json: async () => ({ models: [] }),
  })),
}));

vi.mock('../../settings/helpers', () => ({
  t: (key: string) => key,
  autoSaveConfig: vi.fn(async () => true),
}));

vi.mock('../../settings/actions', () => ({
  browseAgent: vi.fn(),
  switchToAgent: vi.fn(),
  loadSettingsConfig: vi.fn(async () => {}),
  loadAgents: vi.fn(async () => {}),
}));

vi.mock('@/ui', () => ({
  SelectWidget: ({ value }: { value?: string }) => (
    <div data-testid="model-select">{value || ''}</div>
  ),
}));

vi.mock('../../settings/tabs/agent/AgentCardStack', () => ({
  AgentCardStack: ({ selectedId }: { selectedId: string | null }) => (
    <div data-testid="selected-agent">{selectedId || ''}</div>
  ),
}));

vi.mock('../../settings/tabs/agent/YuanSelector', () => ({
  YuanSelector: () => <div data-testid="yuan-selector" />,
}));

vi.mock('../../settings/tabs/agent/AgentMemory', () => ({
  MemorySection: ({ isViewingOther }: { isViewingOther: boolean }) => (
    <div data-testid="is-viewing-other">{String(isViewingOther)}</div>
  ),
}));

vi.mock('../../settings/tabs/agent/AgentToolsSection', () => ({
  AgentToolsSection: () => <div data-testid="agent-tools" />,
}));

vi.mock('../../settings/tabs/agent/AgentExperience', () => ({
  parseExperience: () => [],
  ExperienceBlock: () => null,
  putExperience: vi.fn(),
}));

describe('AgentTab settings agent selection', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      agents: [
        { id: 'hana', name: 'Hana', yuan: 'hanako', isPrimary: true },
        { id: 'deepseek', name: 'DeepSeek', yuan: 'deepseek', isPrimary: false },
      ],
      currentAgentId: 'hana',
      settingsAgentId: null,
      settingsConfig: {
        agent: { name: 'Hana', yuan: 'hanako' },
        memory: { enabled: true },
      },
      currentPins: [],
      globalModelsConfig: {
        models: { utility: { id: 'u' }, utility_large: { id: 'ul' } },
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('rerenders when browsing a different settings agent', async () => {
    const { AgentTab } = await import('../../settings/tabs/AgentTab');
    render(<AgentTab />);

    expect(screen.getByTestId('selected-agent')).toHaveTextContent('hana');
    expect(screen.getByTestId('is-viewing-other')).toHaveTextContent('false');

    act(() => {
      useSettingsStore.setState({ settingsAgentId: 'deepseek' });
    });

    expect(screen.getByTestId('selected-agent')).toHaveTextContent('deepseek');
    expect(screen.getByTestId('is-viewing-other')).toHaveTextContent('true');
  });
});
