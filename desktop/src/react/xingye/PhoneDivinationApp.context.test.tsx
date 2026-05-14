/**
 * @vitest-environment jsdom
 */

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Agent } from '../types';
import { PhoneDivinationApp } from './PhoneDivinationApp';

const buildCtx = vi.fn();

vi.mock('./xingye-divination-resolver-context', () => ({
  buildDivinationResolverContext: (...args: unknown[]) => buildCtx(...args),
}));

vi.mock('./xingye-app-entry-store', () => ({
  loadDivinationEntries: vi.fn(async () => []),
  appendDivinationEntry: vi.fn(),
  deleteDivinationEntry: vi.fn(),
}));

describe('PhoneDivinationApp — divination context wiring', () => {
  const agent: Agent = { id: 'ag-ctx', name: 'Test', yuan: 't', isPrimary: true };

  beforeEach(() => {
    buildCtx.mockReset();
    buildCtx.mockResolvedValue({
      agentLike: {
        name: 'Test',
        backgroundSummary: '边境战乱、感染控制、止血、药物配给、资源不足。',
      },
      contextText: '',
      contextLength: 120,
      contextSources: ['xingye.profile.json'],
      loreSkippedDisabledCount: 0,
      enabledLoreTitlesInCorpus: [],
      profileOnlyNoEnabledLore: true,
    });
  });

  it('calls buildDivinationResolverContext(agentId) and shows recommendation after load', async () => {
    render(
      <PhoneDivinationApp
        ownerAgent={agent}
        ownerProfile={null}
        displayName="Test"
        onBack={() => {}}
      />,
    );

    await waitFor(() => {
      expect(buildCtx).toHaveBeenCalledWith('ag-ctx', agent, null, { divinationQuestion: '' });
    });

    await waitFor(() => {
      expect(screen.queryByText(/正在读取角色 profile/)).not.toBeInTheDocument();
    });

    expect(screen.getByText(/推荐：/)).toBeInTheDocument();
  });
});
