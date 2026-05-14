/**
 * @vitest-environment jsdom
 */

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { Agent } from '../types';
import { PhoneDivinationApp } from './PhoneDivinationApp';

const { buildCtx, appendDivinationEntryMock } = vi.hoisted(() => ({
  buildCtx: vi.fn(),
  appendDivinationEntryMock: vi.fn(),
}));

vi.mock('./xingye-divination-resolver-context', () => ({
  buildDivinationResolverContext: (...args: unknown[]) => buildCtx(...args),
}));

vi.mock('./xingye-app-entry-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./xingye-app-entry-store')>();
  return {
    ...actual,
    appendDivinationEntry: appendDivinationEntryMock,
    loadDivinationEntries: vi.fn(async () => []),
    deleteDivinationEntry: vi.fn(),
  };
});

function generateButton(): HTMLElement {
  const all = screen.queryAllByTestId('phone-divination-generate');
  if (!all.length) throw new Error('missing phone-divination-generate');
  return all[0]!;
}

describe('PhoneDivinationApp — agent-owned divination semantics', () => {
  const agent: Agent = { id: 'ag-sem', name: '林雾', yuan: 'lin', isPrimary: true };

  beforeEach(() => {
    buildCtx.mockReset();
    appendDivinationEntryMock.mockReset();
    buildCtx.mockResolvedValue({
      agentLike: {
        name: '林雾',
        displayName: '林雾',
        shortBio: '边境医生',
        backgroundSummary: '战乱中救治伤患，资源不足。',
        extraCorpus: '感染控制、止血、撤离。',
      },
      contextText: 'x',
      contextLength: 400,
      contextSources: ['xingye.profile.json', 'xingye.lore.entries.json:战地'],
      loreSkippedDisabledCount: 0,
      enabledLoreTitlesInCorpus: ['战地'],
      profileOnlyNoEnabledLore: false,
    });
    appendDivinationEntryMock.mockImplementation(async (agentId, input) => ({
      id: 'new-entry',
      agentId,
      appId: 'divination',
      title: input.title,
      content: input.content,
      metadata: {
        method: input.metadata?.method ?? '',
        methodLabel: input.metadata?.methodLabel ?? '',
        question: input.metadata?.question ?? '',
        agentQuestion: input.metadata?.agentQuestion ?? '',
        symbols: input.metadata?.symbols ?? [],
        autoSelected: Boolean(input.metadata?.autoSelected),
        resolverReason: input.metadata?.resolverReason ?? '',
        userProvidedTheme: input.metadata?.userProvidedTheme,
        contextSummary: input.metadata?.contextSummary,
      },
      source: 'divination',
      createdAt: '2026-05-14T10:00:00.000Z',
      updatedAt: '2026-05-14T10:00:00.000Z',
    }));
  });

  afterEach(() => {
    cleanup();
  });

  it('does not show user-question-oriented placeholder copy', async () => {
    render(
      <PhoneDivinationApp ownerAgent={agent} ownerProfile={null} displayName="林雾" onBack={() => {}} />,
    );
    await waitFor(() => {
      expect(screen.queryByText(/正在读取角色 profile/)).not.toBeInTheDocument();
    });
    expect(screen.queryByPlaceholderText(/写下想问的事/)).not.toBeInTheDocument();
    expect(screen.queryAllByPlaceholderText(/可选：给 TA 一个关注方向/)[0]).toBeInTheDocument();
    expect(generateButton()).toBeInTheDocument();
  });

  it('allows generate with empty theme; append receives agentQuestion and optional userProvidedTheme', async () => {
    render(
      <PhoneDivinationApp ownerAgent={agent} ownerProfile={null} displayName="林雾" onBack={() => {}} />,
    );
    await waitFor(() => {
      expect(generateButton()).not.toBeDisabled();
    });
    fireEvent.click(generateButton());
    await waitFor(() => {
      expect(appendDivinationEntryMock).toHaveBeenCalled();
    });
    const call = appendDivinationEntryMock.mock.calls[0]!;
    const payload = call[1] as { metadata: Record<string, unknown>; content: string };
    expect(payload.metadata.agentQuestion).toBeTruthy();
    expect(typeof payload.metadata.agentQuestion).toBe('string');
    expect(payload.metadata.userProvidedTheme).toBeUndefined();
    expect(payload.metadata.method).toBe('field_oracle');
    expect(payload.content).toMatch(/我/);
    expect(payload.content).not.toMatch(/xingye\.profile\.json|xingye\.lore\.entries\.json|上下文摘要/);
    expect(payload.content).not.toMatch(/你是当前角色本人|用户没有替你提问/);
    expect(payload.content).not.toMatch(/\b(prompt|context|system|developer|instruction|source|debug)\b/i);
    expect(payload.content).not.toMatch(/用户|如果用户|林雾会|她会|TA 会|该角色|这个角色|角色设定|根据人设|根据背景|从设定来看|建议用户/);
    expect(payload.content).toMatch(/【正文】/);
    expect(payload.content).toMatch(/【行动签】/);
    await waitFor(() => {
      expect(screen.getByText(/我把这次/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/上下文摘要/)).not.toBeInTheDocument();
    expect(screen.queryByText(/xingye\.profile\.json/)).not.toBeInTheDocument();
  });

  it('stores userProvidedTheme when optional field filled; agentQuestion is not the theme text', async () => {
    render(
      <PhoneDivinationApp ownerAgent={agent} ownerProfile={null} displayName="林雾" onBack={() => {}} />,
    );
    await waitFor(() => {
      expect(generateButton()).not.toBeDisabled();
    });
    fireEvent.change(screen.queryAllByTestId('phone-divination-theme-hint')[0]!, { target: { value: '仅注脚：天气' } });
    await waitFor(
      () => {
        expect(generateButton()).not.toBeDisabled();
      },
      { timeout: 4000 },
    );
    fireEvent.click(generateButton());
    await waitFor(() => {
      expect(appendDivinationEntryMock).toHaveBeenCalled();
    });
    const payload = appendDivinationEntryMock.mock.calls[0]![1] as { metadata: Record<string, unknown> };
    expect(payload.metadata.userProvidedTheme).toBe('仅注脚：天气');
    expect(String(payload.metadata.agentQuestion)).not.toBe('仅注脚：天气');
  });
});
