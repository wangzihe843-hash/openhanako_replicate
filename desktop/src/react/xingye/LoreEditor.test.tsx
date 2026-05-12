/**
 * @vitest-environment jsdom
 */

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoreEditor } from './LoreEditor';
import { createLoreEntry } from './xingye-lore-store';
import {
  XINGYE_MEMORY_CANDIDATES_STORAGE_KEY,
  listXingyeMemoryCandidates,
  type XingyeMemoryCandidate,
} from './xingye-memory-candidate-store';

vi.mock('../hooks/use-hana-fetch', () => ({
  hanaUrl: (path: string) => path,
  hanaFetch: vi.fn(),
}));

const { hanaFetch } = await import('../hooks/use-hana-fetch');

const agentId = 'agent-lore-editor-1';

function seedLoreEntry(overrides: Partial<Parameters<typeof createLoreEntry>[1]> = {}) {
  return createLoreEntry(agentId, {
    title: '失落王国',
    content: '完整背景说明，包含若干段落。',
    category: 'worldview',
    keywords: ['王国'],
    priority: 80,
    insertionMode: 'manual',
    visibility: 'canonical',
    ...overrides,
  });
}

describe('LoreEditor — save lore as memory candidate', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.mocked(hanaFetch).mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders a "保存为候选重要记忆" button for each lore entry', () => {
    const a = seedLoreEntry({ title: '条目 A' });
    const b = seedLoreEntry({ title: '条目 B', content: '另一段设定。' });

    render(<LoreEditor agentId={agentId} />);

    expect(screen.getByTestId(`lore-entry-save-candidate-${a.id}`)).toHaveTextContent('保存为候选重要记忆');
    expect(screen.getByTestId(`lore-entry-save-candidate-${b.id}`)).toHaveTextContent('保存为候选重要记忆');
    expect(screen.getAllByRole('button', { name: '保存为候选重要记忆' })).toHaveLength(2);
  });

  it('creates a pinned-target candidate from the lore entry and never confirms or writes pinned', async () => {
    const entry = seedLoreEntry({ title: '誓约之灯', content: '灯塔的誓约规则与象征。' });

    render(<LoreEditor agentId={agentId} />);

    fireEvent.click(screen.getByTestId(`lore-entry-save-candidate-${entry.id}`));

    let candidates: XingyeMemoryCandidate[] = [];
    await waitFor(() => {
      candidates = listXingyeMemoryCandidates(agentId);
      expect(candidates).toHaveLength(1);
    });

    const [candidate] = candidates;
    expect(candidate.sourceDomain).toBe('lore');
    expect(candidate.sourceId).toBe(entry.id);
    expect(candidate.target).toBe('pinned');
    expect(candidate.status).toBe('pending');
    expect(candidate.content).toBe(`【设定】${entry.title}\n${entry.content}`);
    expect(candidate.reason).toBe('用户从设定库保存为候选重要记忆');
    expect(candidate.importance).toBe(2);

    expect(hanaFetch).not.toHaveBeenCalled();
  });

  it('shows lightweight flash after creating a candidate', async () => {
    const entry = seedLoreEntry({ title: '只显示提示' });

    render(<LoreEditor agentId={agentId} />);

    fireEvent.click(screen.getByTestId(`lore-entry-save-candidate-${entry.id}`));

    await waitFor(() => {
      expect(screen.getByTestId('lore-editor-flash')).toHaveTextContent(
        '已加入候选重要记忆，请到记忆候选中确认写入',
      );
    });
  });

  it('does not auto-create candidates for always-insertion lore entries on render', () => {
    seedLoreEntry({ title: '常驻设定', insertionMode: 'always' });
    seedLoreEntry({ title: '另一条常驻', insertionMode: 'always' });

    render(<LoreEditor agentId={agentId} />);

    expect(listXingyeMemoryCandidates(agentId)).toHaveLength(0);
    expect(window.localStorage.getItem(XINGYE_MEMORY_CANDIDATES_STORAGE_KEY)).toBeNull();
  });

  it('does not write pinned or call any /api when saving as candidate', async () => {
    const entry = seedLoreEntry({ title: '不应触发网络' });

    render(<LoreEditor agentId={agentId} />);

    fireEvent.click(screen.getByTestId(`lore-entry-save-candidate-${entry.id}`));

    await waitFor(() => {
      expect(listXingyeMemoryCandidates(agentId)).toHaveLength(1);
    });

    expect(listXingyeMemoryCandidates(agentId)[0].status).toBe('pending');
    expect(listXingyeMemoryCandidates(agentId)[0].writtenAt).toBeUndefined();
    expect(hanaFetch).not.toHaveBeenCalled();
  });
});
