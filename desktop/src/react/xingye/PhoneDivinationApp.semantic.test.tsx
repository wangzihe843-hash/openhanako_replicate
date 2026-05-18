/**
 * @vitest-environment jsdom
 */

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { Agent } from '../types';
import { PhoneDivinationApp } from './PhoneDivinationApp';

const { buildCtx, appendDivinationEntryMock, generateReadingMock } = vi.hoisted(() => ({
  buildCtx: vi.fn(),
  appendDivinationEntryMock: vi.fn(),
  generateReadingMock: vi.fn(),
}));

vi.mock('./xingye-divination-resolver-context', () => ({
  buildDivinationResolverContext: (...args: unknown[]) => buildCtx(...args),
}));

vi.mock('./xingye-divination-ai', () => ({
  generateDivinationReadingWithAI: (...args: unknown[]) => generateReadingMock(...args),
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

const AI_READING = {
  title: '蓝线之外',
  agentQuestion: '我想确认补给线还能不能撑过下一轮。',
  content: [
    '【标题】',
    '蓝线之外',
    '【行动签象】',
    '我把哨声压在牙后，没让它冲出来。',
    '【正文】',
    '我看着掌心的影子，慢慢把急意压下去。',
    '【行动签】',
    '先确认风从哪边来。',
  ].join('\n'),
};

describe('PhoneDivinationApp — agent-owned divination semantics (AI route)', () => {
  const agent: Agent = { id: 'ag-sem', name: '林雾', yuan: 'lin', isPrimary: true };

  beforeEach(() => {
    buildCtx.mockReset();
    appendDivinationEntryMock.mockReset();
    generateReadingMock.mockReset();
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
    generateReadingMock.mockResolvedValue(AI_READING);
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

  it('calls AI route and persists agentQuestion + AI content; userProvidedTheme remains optional', async () => {
    render(
      <PhoneDivinationApp ownerAgent={agent} ownerProfile={null} displayName="林雾" onBack={() => {}} />,
    );
    await waitFor(() => {
      expect(generateButton()).not.toBeDisabled();
    });
    fireEvent.click(generateButton());
    await waitFor(() => {
      expect(generateReadingMock).toHaveBeenCalled();
    });
    const aiArgs = generateReadingMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(aiArgs.methodId).toBe('field_oracle');
    expect(aiArgs.methodLabel).toBeTruthy();
    expect(Array.isArray(aiArgs.symbols)).toBe(true);
    expect((aiArgs.agentLike as { displayName?: string }).displayName).toBe('林雾');
    expect(aiArgs.userProvidedTheme).toBeUndefined();

    await waitFor(() => {
      expect(appendDivinationEntryMock).toHaveBeenCalled();
    });
    const payload = appendDivinationEntryMock.mock.calls[0]![1] as { metadata: Record<string, unknown>; content: string };
    expect(payload.metadata.agentQuestion).toBe(AI_READING.agentQuestion);
    expect(payload.metadata.question).toBe(AI_READING.agentQuestion);
    expect(payload.metadata.userProvidedTheme).toBeUndefined();
    expect(payload.metadata.method).toBe('field_oracle');
    expect(payload.content).toBe(AI_READING.content);
    expect(payload.content).toMatch(/【正文】/);
    expect(payload.content).toMatch(/【行动签】/);

    await waitFor(() => {
      expect(screen.getByTestId('phone-divination-sections')).toBeInTheDocument();
    });
    const sections = screen.getByTestId('phone-divination-sections');
    expect(sections.querySelector('[data-divination-section="title"]')).not.toBeNull();
    expect(sections.querySelector('[data-divination-section="sign"]')).not.toBeNull();
    expect(sections.querySelector('[data-divination-section="body"]')).not.toBeNull();
    expect(sections.querySelector('[data-divination-section="action"]')).not.toBeNull();
    expect(sections.textContent).toContain('蓝线之外');
    expect(sections.textContent).toContain('哨声');
    expect(sections.textContent).toContain('掌心的影子');
    expect(sections.textContent).toContain('先确认风从哪边来');
  });

  it('stores userProvidedTheme when filled and forwards it to AI; agentQuestion comes from AI not theme', async () => {
    render(
      <PhoneDivinationApp ownerAgent={agent} ownerProfile={null} displayName="林雾" onBack={() => {}} />,
    );
    await waitFor(() => {
      expect(generateButton()).not.toBeDisabled();
    });
    fireEvent.change(screen.queryAllByTestId('phone-divination-theme-hint')[0]!, {
      target: { value: '仅注脚：天气' },
    });
    await waitFor(
      () => {
        expect(generateButton()).not.toBeDisabled();
      },
      { timeout: 4000 },
    );
    fireEvent.click(generateButton());
    await waitFor(() => {
      expect(generateReadingMock).toHaveBeenCalled();
    });
    const aiArgs = generateReadingMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(aiArgs.userProvidedTheme).toBe('仅注脚：天气');

    await waitFor(() => {
      expect(appendDivinationEntryMock).toHaveBeenCalled();
    });
    const payload = appendDivinationEntryMock.mock.calls[0]![1] as { metadata: Record<string, unknown> };
    expect(payload.metadata.userProvidedTheme).toBe('仅注脚：天气');
    expect(String(payload.metadata.agentQuestion)).not.toBe('仅注脚：天气');
    expect(payload.metadata.agentQuestion).toBe(AI_READING.agentQuestion);
  });

  it('renders fortune / omens / lucky cards when AI returns those fields', async () => {
    generateReadingMock.mockResolvedValueOnce({
      ...AI_READING,
      fortuneScore: { overall: 73, career: 77, love: 82, wealth: 62 },
      omens: { good: '靠近自己确认过的事', bad: '在路口反复折返' },
      luckyDirection: '东南',
      luckyColor: '#7AA2C8',
    });
    appendDivinationEntryMock.mockImplementationOnce(async (agentId, input) => ({
      id: 'new-entry-with-fortune',
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
        fortuneScore: input.metadata?.fortuneScore,
        omens: input.metadata?.omens,
        luckyDirection: input.metadata?.luckyDirection,
        luckyColor: input.metadata?.luckyColor,
      },
      source: 'divination',
      createdAt: '2026-05-14T10:00:00.000Z',
      updatedAt: '2026-05-14T10:00:00.000Z',
    }));

    render(
      <PhoneDivinationApp ownerAgent={agent} ownerProfile={null} displayName="林雾" onBack={() => {}} />,
    );
    await waitFor(() => {
      expect(generateButton()).not.toBeDisabled();
    });
    fireEvent.click(generateButton());

    const fortune = await screen.findByTestId('phone-divination-fortune');
    expect(fortune.textContent).toMatch(/73/);
    expect(fortune.textContent).toMatch(/77/);
    expect(fortune.textContent).toMatch(/82/);
    expect(fortune.textContent).toMatch(/62/);

    const omens = screen.getByTestId('phone-divination-omens');
    expect(omens.textContent).toContain('靠近自己确认过的事');
    expect(omens.textContent).toContain('在路口反复折返');

    const lucky = screen.getByTestId('phone-divination-lucky');
    expect(lucky.textContent).toContain('东南');
    expect(lucky.textContent).toContain('#7AA2C8');

    /** appendDivinationEntry payload 也应携带新字段。 */
    const payload = appendDivinationEntryMock.mock.calls[0]![1] as { metadata: Record<string, unknown> };
    expect(payload.metadata.fortuneScore).toEqual({ overall: 73, career: 77, love: 82, wealth: 62 });
    expect(payload.metadata.omens).toEqual({ good: '靠近自己确认过的事', bad: '在路口反复折返' });
    expect(payload.metadata.luckyDirection).toBe('东南');
    expect(payload.metadata.luckyColor).toBe('#7AA2C8');
  });

  it('does NOT render fortune/omens/lucky cards when entry lacks those fields (back-compat for old entries)', async () => {
    render(
      <PhoneDivinationApp ownerAgent={agent} ownerProfile={null} displayName="林雾" onBack={() => {}} />,
    );
    await waitFor(() => {
      expect(generateButton()).not.toBeDisabled();
    });
    fireEvent.click(generateButton());
    await waitFor(() => {
      expect(screen.getByTestId('phone-divination-sections')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('phone-divination-fortune')).not.toBeInTheDocument();
    expect(screen.queryByTestId('phone-divination-omens')).not.toBeInTheDocument();
    expect(screen.queryByTestId('phone-divination-lucky')).not.toBeInTheDocument();
  });

  it('surfaces AI errors in the UI without crashing', async () => {
    generateReadingMock.mockRejectedValueOnce(new Error('占卜生成失败：utility boom'));
    render(
      <PhoneDivinationApp ownerAgent={agent} ownerProfile={null} displayName="林雾" onBack={() => {}} />,
    );
    await waitFor(() => {
      expect(generateButton()).not.toBeDisabled();
    });
    fireEvent.click(generateButton());
    await waitFor(() => {
      expect(screen.getByText(/占卜生成失败：utility boom/)).toBeInTheDocument();
    });
    expect(appendDivinationEntryMock).not.toHaveBeenCalled();
  });
});
