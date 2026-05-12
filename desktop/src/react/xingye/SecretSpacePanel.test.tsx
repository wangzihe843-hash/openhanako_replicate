/**
 * @vitest-environment jsdom
 */

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Agent } from '../types';
import { SecretSpacePanel } from './SecretSpacePanel';

describe('SecretSpacePanel secret space navigation', () => {
  const agent: Agent = {
    id: 'agent-secret-1',
    name: 'Test',
    yuan: 'test',
    isPrimary: true,
    hasAvatar: false,
  };

  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('shows six category entries on the home screen', () => {
    render(<SecretSpacePanel agent={agent} />);

    expect(screen.getByTestId('secret-space-home')).toBeInTheDocument();
    expect(screen.getByTestId('secret-space-entry-state')).toBeInTheDocument();
    expect(screen.getByTestId('secret-space-entry-draft_reply')).toBeInTheDocument();
    expect(screen.getByTestId('secret-space-entry-dream')).toBeInTheDocument();
    expect(screen.getByTestId('secret-space-entry-saved_item')).toBeInTheDocument();
    expect(screen.getByTestId('secret-space-entry-unsent_moment')).toBeInTheDocument();
    expect(screen.getByTestId('secret-space-entry-memory_fragment')).toBeInTheDocument();
  });

  it('opens the dream category view and returns home from back', () => {
    render(<SecretSpacePanel agent={agent} />);

    fireEvent.click(screen.getByTestId('secret-space-entry-dream'));

    expect(screen.getByTestId('secret-space-category-dream')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'TA 的梦境' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '返回' }));

    expect(screen.getByTestId('secret-space-home')).toBeInTheDocument();
    expect(screen.queryByTestId('secret-space-category-dream')).not.toBeInTheDocument();
  });

  it('shows empty state copy when there are no records', () => {
    render(<SecretSpacePanel agent={agent} />);

    fireEvent.click(screen.getByTestId('secret-space-entry-draft_reply'));

    expect(screen.getByTestId('secret-space-empty')).toHaveTextContent('暂无记录');
  });

  it('shows RelationshipStatePanel content after opening the TA 的状态 category', () => {
    render(<SecretSpacePanel agent={agent} />);

    expect(screen.getByTestId('secret-space-entry-state')).toHaveAccessibleName(/TA 的状态/);

    fireEvent.click(screen.getByTestId('secret-space-entry-state'));

    expect(screen.getByTestId('secret-space-state-section')).toBeInTheDocument();
    expect(screen.getByTestId('secret-space-relationship-panel')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'TA 当前状态' })).toBeInTheDocument();
  });
});

describe('SecretSpacePanel memory candidate manual entry', () => {
  const agent: Agent = {
    id: 'agent-secret-2',
    name: 'Test',
    yuan: 'test',
    isPrimary: true,
    hasAvatar: false,
  };

  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('creates candidate from manual form without using fetch mocks', async () => {
    render(<SecretSpacePanel agent={agent} />);

    fireEvent.click(screen.getByTestId('secret-space-entry-memory_fragment'));

    const manualForm = screen.getByTestId('secret-space-manual-candidate');
    const contentInput = within(manualForm).getByPlaceholderText('输入一条你希望记住的要点…');

    fireEvent.change(contentInput, {
      target: { value: 'manual note from secret space' },
    });
    fireEvent.click(within(manualForm).getByRole('button', { name: '创建候选记忆' }));

    await waitFor(() => {
      expect(contentInput).toHaveValue('');
    });
  });
});
