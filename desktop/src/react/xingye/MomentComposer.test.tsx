/**
 * @vitest-environment jsdom
 */

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../types';

vi.mock('./XingyeAgentAvatar', () => ({
  XingyeAgentAvatar: ({ alt }: { alt: string }) => <div>{alt}</div>,
}));

import { MomentComposer, type MomentComposerAiDraft, type MomentComposerAiDraftRequest } from './MomentComposer';

/** Helper: typed `onGenerateAiDraft` mock so TS knows the args tuple has one element. */
function makeAiMock(impl: (req?: MomentComposerAiDraftRequest) => Promise<MomentComposerAiDraft>) {
  return vi.fn<(req?: MomentComposerAiDraftRequest) => Promise<MomentComposerAiDraft>>(impl);
}

const agent: Agent = {
  id: 'linwu',
  name: '林雾',
  yuan: 'hanako',
  isPrimary: false,
  hasAvatar: false,
};

const display = {
  displayName: '林雾',
  shortBio: 'bio',
  relationshipLabel: 'friend',
  speakingStyle: 'calm',
  chatBackgroundDataUrl: undefined,
  allowAutoMoments: false,
  allowProactiveDM: false,
} as const;

afterEach(() => {
  cleanup();
});

describe('MomentComposer · AI generate behavior', () => {
  it('first click (no content): receives no existingContent and applies returned content', async () => {
    const onSubmit = vi.fn();
    const onGenerateAiDraft = makeAiMock(async () => ({
      content: '海风把灯影吹得有点歪。',
      seedLikes: [],
      seedComments: [],
    }));

    render(
      <MomentComposer
        agent={agent}
        display={display as never}
        identityMode="agent"
        onIdentityModeChange={vi.fn()}
        userName="我"
        onSubmit={onSubmit}
        onGenerateAiDraft={onGenerateAiDraft}
      />,
    );

    /** Button label reflects "no content" mode. */
    const btn = await screen.findByRole('button', { name: 'AI 生成' });
    fireEvent.click(btn);

    await waitFor(() => {
      expect(onGenerateAiDraft).toHaveBeenCalledTimes(1);
    });
    /** First call must pass undefined (or no existingContent), NOT an empty string. */
    const arg = onGenerateAiDraft.mock.calls[0][0];
    expect(arg).toBeUndefined();

    /** Content gets populated from AI draft. */
    const textarea = screen.getByPlaceholderText('写下这一刻的想法...') as HTMLTextAreaElement;
    await waitFor(() => {
      expect(textarea.value).toBe('海风把灯影吹得有点歪。');
    });
  });

  it('second click (with existing content): passes existingContent and KEEPS user content unchanged', async () => {
    const onSubmit = vi.fn();
    /** Model misbehaves and returns a different content; defense in depth should ignore it. */
    const onGenerateAiDraft = makeAiMock(async () => ({
      content: '模型擅自改写的正文（应被忽略）',
      seedLikes: [
        { actorType: 'agent' as const, actorId: 'hanako', actorName: 'Hanako' },
        { actorType: 'virtual_contact' as const, actorId: 'linwu:vc-1', actorName: '夜班搭子' },
      ],
      seedComments: [
        {
          actorType: 'virtual_contact' as const,
          actorId: 'linwu:vc-1',
          actorName: '夜班搭子',
          body: '又熬夜？',
        },
      ],
    }));

    render(
      <MomentComposer
        agent={agent}
        display={display as never}
        identityMode="agent"
        onIdentityModeChange={vi.fn()}
        userName="我"
        onSubmit={onSubmit}
        onGenerateAiDraft={onGenerateAiDraft}
      />,
    );

    const textarea = screen.getByPlaceholderText('写下这一刻的想法...') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '用户自己写的灯塔正文。' } });

    /** Button label switches when content is present. */
    const btn = await screen.findByRole('button', { name: 'AI 生成互动' });
    fireEvent.click(btn);

    await waitFor(() => {
      expect(onGenerateAiDraft).toHaveBeenCalledTimes(1);
    });
    expect(onGenerateAiDraft.mock.calls[0][0]).toEqual({
      existingContent: '用户自己写的灯塔正文。',
    });

    /** Content state must NOT be overwritten by what the AI returned. */
    await waitFor(() => {
      /** First, wait for some side effect from the call to settle. */
      expect(onGenerateAiDraft).toHaveBeenCalled();
    });
    expect(textarea.value).toBe('用户自己写的灯塔正文。');
  });

  it('whitespace-only content goes through the full-generate path (not interactions-only)', async () => {
    const onGenerateAiDraft = makeAiMock(async () => ({ content: 'fresh', seedLikes: [], seedComments: [] }));
    render(
      <MomentComposer
        agent={agent}
        display={display as never}
        identityMode="agent"
        onIdentityModeChange={vi.fn()}
        userName="我"
        onSubmit={vi.fn()}
        onGenerateAiDraft={onGenerateAiDraft}
      />,
    );
    const textarea = screen.getByPlaceholderText('写下这一刻的想法...') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '   ' } });
    /** Trimmed content is empty → button label stays in fresh-generate mode. */
    const btn = await screen.findByRole('button', { name: 'AI 生成' });
    fireEvent.click(btn);
    await waitFor(() => expect(onGenerateAiDraft).toHaveBeenCalledTimes(1));
    expect(onGenerateAiDraft.mock.calls[0][0]).toBeUndefined();
  });
});

describe('MomentComposer · identity mode', () => {
  it('user mode: hides the AI generate button and submits with no seeds', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <MomentComposer
        agent={agent}
        display={display as never}
        identityMode="user"
        onIdentityModeChange={vi.fn()}
        userName="阿离"
        onSubmit={onSubmit}
        onGenerateAiDraft={makeAiMock(async () => ({ content: 'x' }))}
      />,
    );
    /** No AI generate button in user mode — user writes their own moment. */
    expect(screen.queryByRole('button', { name: /AI 生成/ })).not.toBeInTheDocument();

    const textarea = screen.getByPlaceholderText('写下这一刻的想法，分享到朋友圈…') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '今天天气真好' } });
    fireEvent.click(screen.getByRole('button', { name: '发表' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({
      content: '今天天气真好',
      seedLikes: undefined,
      seedComments: undefined,
    });
  });

  it('clicking the "以角色发表" chip invokes onIdentityModeChange', () => {
    const onIdentityModeChange = vi.fn();
    render(
      <MomentComposer
        agent={agent}
        display={display as never}
        identityMode="user"
        onIdentityModeChange={onIdentityModeChange}
        userName="阿离"
        onSubmit={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('radio', { name: '以角色发表' }));
    expect(onIdentityModeChange).toHaveBeenCalledWith('agent');
  });
});
