/**
 * @vitest-environment jsdom
 */

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../stores';
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

vi.mock('../hooks/use-config', () => ({
  useConfig: () => ({ config: { user: { name: 'OpenHanakoUser' } }, refresh: vi.fn() }),
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
    (window as unknown as { __XINGYE_PERSISTENCE_DEV_LOCAL__?: boolean }).__XINGYE_PERSISTENCE_DEV_LOCAL__ = true;
    window.localStorage.clear();
    vi.mocked(hanaFetch).mockReset();
  });

  afterEach(() => {
    delete (window as unknown as { __XINGYE_PERSISTENCE_DEV_LOCAL__?: boolean }).__XINGYE_PERSISTENCE_DEV_LOCAL__;
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
    expect(candidate.reason).toBe('这是我心里早认定的事，想一直记着。');
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

describe('LoreEditor — relationship template', () => {
  beforeEach(() => {
    (window as unknown as { __XINGYE_PERSISTENCE_DEV_LOCAL__?: boolean }).__XINGYE_PERSISTENCE_DEV_LOCAL__ = true;
    window.localStorage.clear();
    vi.mocked(hanaFetch).mockReset();
    useStore.setState({ userName: 'User', agents: [] });
  });

  afterEach(() => {
    delete (window as unknown as { __XINGYE_PERSISTENCE_DEV_LOCAL__?: boolean }).__XINGYE_PERSISTENCE_DEV_LOCAL__;
    cleanup();
  });

  function getDraftContentTextarea() {
    const boxes = screen.getAllByRole('textbox');
    return boxes[1] as HTMLTextAreaElement;
  }

  it('does not auto-fill template when selecting relationship; inserts template and defaults only after clicking insert', () => {
    render(<LoreEditor agentId={agentId} agentName="  星侧角色  " />);

    fireEvent.change(screen.getByRole('combobox', { name: '分类' }), { target: { value: 'relationship' } });

    expect(getDraftContentTextarea().value).toBe('');

    fireEvent.click(screen.getByTestId('lore-relationship-insert-template'));

    const body = getDraftContentTextarea();
    expect(body.value).toContain('星侧角色');
    expect(body.value).toContain('OpenHanakoUser');
    expect(body.value).toContain('【适用范围】');

    const insertionSelect = screen.getByRole('combobox', { name: '插入模式' });
    expect(insertionSelect).toHaveValue('always');

    expect(screen.getByRole('combobox', { name: '可见性' })).toHaveValue('canonical');
    expect(screen.getByRole('textbox', { name: '标题' })).toHaveValue('用户身份与关系（星侧角色）');
  });

  it('does not replace existing body when switching to relationship with non-empty content', () => {
    render(<LoreEditor agentId={agentId} agentName="A1" />);

    fireEvent.change(getDraftContentTextarea(), { target: { value: '已有正文' } });
    fireEvent.change(screen.getByRole('combobox', { name: '分类' }), { target: { value: 'relationship' } });

    expect(getDraftContentTextarea().value).toBe('已有正文');
    expect(screen.getByTestId('lore-relationship-insert-template')).toBeInTheDocument();
  });

  it('discards unsaved relationship draft when selecting another lore entry from the list', () => {
    const saved = seedLoreEntry({
      title: '已有条目',
      content: '真实正文-来自存储',
      category: 'worldview',
    });

    render(<LoreEditor agentId={agentId} agentName="AgentX" />);

    fireEvent.change(screen.getByRole('combobox', { name: '分类' }), { target: { value: 'relationship' } });
    fireEvent.click(screen.getByTestId('lore-relationship-insert-template'));
    expect(getDraftContentTextarea().value).toContain('【适用范围】');

    fireEvent.click(screen.getByTestId(`lore-entry-card-${saved.id}`));

    expect(getDraftContentTextarea().value).toBe('真实正文-来自存储');
    expect(screen.getByRole('textbox', { name: '标题' })).toHaveValue('已有条目');
    expect(screen.getByRole('combobox', { name: '分类' })).toHaveValue('worldview');
    expect(screen.queryByTestId('lore-relationship-insert-template')).not.toBeInTheDocument();
  });

  it('appends template after confirm when body already has text', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<LoreEditor agentId={agentId} agentName="A1" />);

    fireEvent.change(getDraftContentTextarea(), { target: { value: '第一段' } });
    fireEvent.change(screen.getByRole('combobox', { name: '分类' }), { target: { value: 'relationship' } });

    fireEvent.click(screen.getByTestId('lore-relationship-insert-template'));

    const body = getDraftContentTextarea().value;
    expect(body.startsWith('第一段')).toBe(true);
    expect(body).toContain('【适用范围】');
    expect(confirmSpy).toHaveBeenCalled();

    confirmSpy.mockRestore();
  });

  it('inserts the peer-agent relationship template + defaults via its own button (no peer picked)', () => {
    render(<LoreEditor agentId={agentId} agentName="星侧角色" />);

    fireEvent.change(screen.getByRole('combobox', { name: '分类' }), { target: { value: 'relationship' } });
    expect(getDraftContentTextarea().value).toBe('');

    // 没有其他 agent 时，下拉不出现
    expect(screen.queryByTestId('lore-peer-agent-picker')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('lore-peer-agent-insert-template'));

    const body = getDraftContentTextarea();
    expect(body.value).toContain('星侧角色');
    expect(body.value).toContain('OpenHanakoUser');
    expect(body.value).toContain('【实体区分（重要）】');
    expect(body.value).toContain('AI agent');

    expect(screen.getByRole('combobox', { name: '插入模式' })).toHaveValue('keyword');
    expect(screen.getByRole('combobox', { name: '可见性' })).toHaveValue('canonical');
    expect(screen.getByRole('textbox', { name: '标题' })).toHaveValue('其他 agent 关系（星侧角色）');
  });

  it('bakes the selected peer name + id into the template and title', () => {
    useStore.setState({
      userName: 'User',
      agents: [
        { id: agentId, name: '星侧角色', yuan: 'hanako', isPrimary: true },
        { id: 'ming', name: '明', yuan: 'ming', isPrimary: false },
      ],
    });

    render(<LoreEditor agentId={agentId} agentName="星侧角色" />);

    fireEvent.change(screen.getByRole('combobox', { name: '分类' }), { target: { value: 'relationship' } });

    // 下拉出现（排除了自己，只剩 ming），选中具体 peer
    const picker = screen.getByRole('combobox', { name: '其他 agent' });
    fireEvent.change(picker, { target: { value: 'ming' } });

    fireEvent.click(screen.getByTestId('lore-peer-agent-insert-template'));

    const body = getDraftContentTextarea().value;
    expect(body).toContain('「明」');
    expect(body).toContain('id：ming');
    expect(body).toContain('对方 id：ming');
    expect(screen.getByRole('textbox', { name: '标题' })).toHaveValue('与 明 的关系（星侧角色）');
    // 默认 keyword 注入 + 关键词自动填为 名字 + id
    expect(screen.getByRole('combobox', { name: '插入模式' })).toHaveValue('keyword');
    expect(screen.getByRole('textbox', { name: '关键词' })).toHaveValue('明, ming');
  });
});
