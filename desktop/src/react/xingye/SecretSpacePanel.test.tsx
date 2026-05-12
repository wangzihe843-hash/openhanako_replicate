/**
 * @vitest-environment jsdom
 */

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../types';
import { SecretSpacePanel } from './SecretSpacePanel';

vi.mock('../hooks/use-hana-fetch', () => ({
  hanaUrl: (path: string) => path,
  hanaFetch: vi.fn(),
}));

vi.mock('./xingye-secret-space-store', () => ({
  listSecretSpaceRecords: vi.fn(async () => []),
}));

const { hanaFetch } = await import('../hooks/use-hana-fetch');

describe('SecretSpacePanel memory candidate manual entry', () => {
  const agent: Agent = {
    id: 'agent-secret-1',
    name: 'Test',
    yuan: 'test',
    isPrimary: true,
    hasAvatar: false,
  };

  beforeEach(() => {
    window.localStorage.clear();
    vi.mocked(hanaFetch).mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it('creates candidate from manual form and shows in list without calling hanaFetch', async () => {
    render(<SecretSpacePanel agent={agent} />);

    fireEvent.change(screen.getByPlaceholderText('输入一条你希望记住的要点…'), {
      target: { value: 'manual note from secret space' },
    });
    fireEvent.click(screen.getByRole('button', { name: '创建候选记忆' }));

    await waitFor(() => {
      expect(screen.getByDisplayValue('manual note from secret space')).toBeInTheDocument();
    });
    expect(hanaFetch).not.toHaveBeenCalled();
  });
});
