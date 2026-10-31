/** @vitest-environment jsdom */

import React, { StrictMode, type ComponentProps } from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../types';

vi.mock('./XingyeAgentAvatar', () => ({
  XingyeAgentAvatar: ({ alt }: { alt: string }) => <div>{alt}</div>,
}));

import {
  MomentComposer,
  type MomentComposerAiDraft,
  type MomentComposerAiDraftRequest,
  type MomentComposerSubmitInput,
} from './MomentComposer';

type Props = ComponentProps<typeof MomentComposer>;
type Outcome = 'success' | 'error';
const A: Agent = { id: 'owner-a', name: 'Role A', yuan: 'hanako', isPrimary: false, hasAvatar: false };
const B: Agent = { ...A, id: 'owner-b', name: 'Role B' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function aiDraft(owner: string): MomentComposerAiDraft {
  return {
    content: `${owner} generated text`,
    seedLikes: [{ actorType: 'virtual_contact', actorId: `${owner}:private`, actorName: `${owner} contact` }],
    seedComments: [{ actorType: 'virtual_contact', actorId: `${owner}:private`, actorName: `${owner} contact`, body: `${owner} reply` }],
  };
}

function propsFor(agent: Agent | null, overrides: Partial<Props> = {}): Props {
  return {
    agent,
    display: null,
    identityMode: 'agent',
    onIdentityModeChange: vi.fn(),
    userName: '我',
    onSubmit: vi.fn<(input: MomentComposerSubmitInput) => Promise<void>>().mockResolvedValue(undefined),
    ...overrides,
  };
}

const input = () => screen.getByRole('textbox');
const generate = () => screen.getByRole('button', { name: /^AI 生成/ });
const publish = () => screen.getByRole('button', { name: /^发表$/ });
const type = (value: string) => fireEvent.change(input(), { target: { value } });

async function settleAi(pending: ReturnType<typeof deferred<MomentComposerAiDraft>>, outcome: Outcome, owner: string) {
  await act(async () => {
    if (outcome === 'success') pending.resolve(aiDraft(owner));
    else pending.reject(new Error(`${owner} old AI error`));
  });
}

async function settleSubmit(pending: ReturnType<typeof deferred<void>>, outcome: Outcome) {
  await act(async () => {
    if (outcome === 'success') pending.resolve(undefined);
    else pending.reject(new Error('old submit error'));
  });
}

afterEach(cleanup);

describe('MomentComposer owner lifetime', () => {
  it.each<Outcome>(['success', 'error'])('late A AI %s cannot change B input, seeds or its new busy request', async outcome => {
    const oldAi = deferred<MomentComposerAiDraft>();
    const newAi = deferred<MomentComposerAiDraft>();
    const oldGenerate = vi.fn<(opts?: MomentComposerAiDraftRequest) => Promise<MomentComposerAiDraft>>(() => oldAi.promise);
    const newGenerate = vi.fn<(opts?: MomentComposerAiDraftRequest) => Promise<MomentComposerAiDraft>>(() => newAi.promise);
    const submit = vi.fn<(value: MomentComposerSubmitInput) => Promise<void>>().mockResolvedValue(undefined);
    const ui = render(<MomentComposer {...propsFor(A, { onGenerateAiDraft: oldGenerate })} />);
    fireEvent.click(generate());
    expect(oldGenerate).toHaveBeenCalledTimes(1);
    ui.rerender(<MomentComposer {...propsFor(B, { onGenerateAiDraft: newGenerate, onSubmit: submit })} />);
    expect(input()).toBeEnabled();
    expect(input()).toHaveValue('');
    type('B manually entered text');
    fireEvent.click(generate());
    expect(newGenerate).toHaveBeenCalledWith({ existingContent: 'B manually entered text' });
    await settleAi(oldAi, outcome, 'A');
    expect(input()).toHaveValue('B manually entered text');
    expect(input()).toBeDisabled();
    expect(screen.getByRole('button', { name: '生成中…' })).toBeDisabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await settleAi(newAi, 'success', 'B');
    expect(input()).toHaveValue('B manually entered text');
    fireEvent.click(publish());
    expect(submit).toHaveBeenCalledWith({ content: 'B manually entered text', seedLikes: aiDraft('B').seedLikes, seedComments: aiDraft('B').seedComments });
    await act(async () => undefined);
  });

  it('an A AI result arriving after B generation cannot replace B text or private-contact seeds', async () => {
    const oldAi = deferred<MomentComposerAiDraft>();
    const submit = vi.fn<(value: MomentComposerSubmitInput) => Promise<void>>().mockResolvedValue(undefined);
    const ui = render(<MomentComposer {...propsFor(A, { onGenerateAiDraft: () => oldAi.promise })} />);
    fireEvent.click(generate());
    ui.rerender(<MomentComposer {...propsFor(B, { onGenerateAiDraft: async () => aiDraft('B'), onSubmit: submit })} />);
    await act(async () => fireEvent.click(generate()));
    expect(input()).toHaveValue('B generated text');
    await settleAi(oldAi, 'success', 'A');
    expect(input()).toHaveValue('B generated text');
    fireEvent.click(publish());
    expect(submit).toHaveBeenCalledWith({ content: 'B generated text', seedLikes: aiDraft('B').seedLikes, seedComments: aiDraft('B').seedComments });
    await act(async () => undefined);
  });

  it('A → B → A expires the first A request while the second A request remains busy', async () => {
    const first = deferred<MomentComposerAiDraft>();
    const latest = deferred<MomentComposerAiDraft>();
    const ui = render(<MomentComposer {...propsFor(A, { onGenerateAiDraft: () => first.promise })} />);
    fireEvent.click(generate());
    ui.rerender(<MomentComposer {...propsFor(B)} />);
    ui.rerender(<MomentComposer {...propsFor(A, { onGenerateAiDraft: () => latest.promise })} />);
    type('new A input');
    fireEvent.click(generate());
    await settleAi(first, 'success', 'first-A');
    expect(input()).toHaveValue('new A input');
    expect(input()).toBeDisabled();
    await settleAi(latest, 'success', 'latest-A');
    expect(input()).toBeEnabled();
    expect(input()).toHaveValue('new A input');
  });

  it.each<Outcome>(['success', 'error'])('external agent → user → agent identity changes expire old AI %s', async outcome => {
    const oldAi = deferred<MomentComposerAiDraft>();
    const submit = vi.fn<(value: MomentComposerSubmitInput) => Promise<void>>().mockResolvedValue(undefined);
    const ui = render(<MomentComposer {...propsFor(A, { onGenerateAiDraft: () => oldAi.promise })} />);
    fireEvent.click(generate());
    ui.rerender(<MomentComposer {...propsFor(A, { identityMode: 'user' })} />);
    expect(input()).toBeEnabled();
    type('new manual identity text');
    ui.rerender(<MomentComposer {...propsFor(A, { onGenerateAiDraft: async () => aiDraft('new-A'), onSubmit: submit })} />);
    await settleAi(oldAi, outcome, 'old-A');
    expect(input()).toHaveValue('new manual identity text');
    expect(input()).toBeEnabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.click(publish());
    expect(submit).toHaveBeenCalledWith({ content: 'new manual identity text', seedLikes: undefined, seedComments: undefined });
    await act(async () => undefined);
  });

  it.each<Outcome>(['success', 'error'])('agent removal rejects late AI %s and a later owner can edit normally', async outcome => {
    const oldAi = deferred<MomentComposerAiDraft>();
    const ui = render(<MomentComposer {...propsFor(A, { onGenerateAiDraft: () => oldAi.promise })} />);
    fireEvent.click(generate());
    ui.rerender(<MomentComposer {...propsFor(null, { onGenerateAiDraft: () => oldAi.promise })} />);
    expect(input()).toHaveValue('');
    expect(input()).toBeDisabled();
    await settleAi(oldAi, outcome, 'A');
    expect(input()).toHaveValue('');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    ui.rerender(<MomentComposer {...propsFor(B)} />);
    expect(input()).toBeEnabled();
    type('B manual after removal');
    expect(input()).toHaveValue('B manual after removal');
  });

  it('same-owner roster object replacement preserves pending AI and current manual content', async () => {
    const ai = deferred<MomentComposerAiDraft>();
    const onGenerateAiDraft = () => ai.promise;
    const ui = render(<MomentComposer {...propsFor(A, { onGenerateAiDraft })} />);
    type('A retained manual text');
    fireEvent.click(generate());
    ui.rerender(<MomentComposer {...propsFor({ ...A, name: 'A renamed' }, { onGenerateAiDraft })} />);
    expect(input()).toHaveValue('A retained manual text');
    expect(input()).toBeDisabled();
    await settleAi(ai, 'success', 'A');
    expect(input()).toBeEnabled();
    expect(input()).toHaveValue('A retained manual text');
  });

  it.each<Outcome>(['success', 'error'])('old A submit %s cannot clear B newly entered input or show an old error', async outcome => {
    const oldSubmit = deferred<void>();
    const submitA = vi.fn<(value: MomentComposerSubmitInput) => Promise<void>>(() => oldSubmit.promise);
    const ui = render(<MomentComposer {...propsFor(A, { onSubmit: submitA })} />);
    type('A submitted text');
    fireEvent.click(publish());
    expect(submitA).toHaveBeenCalledWith({ content: 'A submitted text', seedLikes: undefined, seedComments: undefined });
    ui.rerender(<MomentComposer {...propsFor(B)} />);
    expect(input()).toBeEnabled();
    type('B unsent input');
    await settleSubmit(oldSubmit, outcome);
    expect(input()).toHaveValue('B unsent input');
    expect(input()).toBeEnabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each<Outcome>(['success', 'error'])('old A submit %s cannot clear busy while a B submit is still pending', async outcome => {
    const oldSubmit = deferred<void>();
    const newSubmit = deferred<void>();
    const submitB = vi.fn<(value: MomentComposerSubmitInput) => Promise<void>>(() => newSubmit.promise);
    const ui = render(<MomentComposer {...propsFor(A, { onSubmit: () => oldSubmit.promise })} />);
    type('A text');
    fireEvent.click(publish());
    ui.rerender(<MomentComposer {...propsFor(B, { onSubmit: submitB })} />);
    type('B submitted text');
    fireEvent.click(publish());
    expect(submitB).toHaveBeenCalledTimes(1);
    await settleSubmit(oldSubmit, outcome);
    expect(input()).toHaveValue('B submitted text');
    expect(input()).toBeDisabled();
    expect(screen.getByRole('button', { name: '发表中…' })).toBeDisabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await settleSubmit(newSubmit, 'success');
    expect(input()).toHaveValue('');
    expect(input()).toBeEnabled();
  });

  it.each<Outcome>(['success', 'error'])('unmounted AI %s cannot affect a new mounted composer', async outcome => {
    const oldAi = deferred<MomentComposerAiDraft>();
    const nextAi = deferred<MomentComposerAiDraft>();
    const old = render(<MomentComposer {...propsFor(A, { onGenerateAiDraft: () => oldAi.promise })} />);
    fireEvent.click(generate());
    old.unmount();
    render(<MomentComposer {...propsFor(B, { onGenerateAiDraft: () => nextAi.promise })} />);
    fireEvent.click(generate());
    await settleAi(oldAi, outcome, 'A');
    expect(input()).toHaveValue('');
    expect(input()).toBeDisabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await settleAi(nextAi, 'success', 'B');
    expect(input()).toHaveValue('B generated text');
  });

  it.each<Outcome>(['success', 'error'])('unmounted submit %s cannot affect a new mounted composer', async outcome => {
    const oldSubmit = deferred<void>();
    const old = render(<MomentComposer {...propsFor(A, { onSubmit: () => oldSubmit.promise })} />);
    type('A submitted text');
    fireEvent.click(publish());
    old.unmount();
    render(<MomentComposer {...propsFor(B)} />);
    type('B new instance input');
    await settleSubmit(oldSubmit, outcome);
    expect(input()).toHaveValue('B new instance input');
    expect(input()).toBeEnabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('StrictMode effect replay permits current generation and invalidates a later owner switch', async () => {
    const ai = deferred<MomentComposerAiDraft>();
    const submit = vi.fn<(value: MomentComposerSubmitInput) => Promise<void>>().mockResolvedValue(undefined);
    const propsA = propsFor(A, { onGenerateAiDraft: () => ai.promise, onSubmit: submit });
    const ui = render(<StrictMode><MomentComposer {...propsA} /></StrictMode>);
    fireEvent.click(generate());
    await settleAi(ai, 'success', 'A');
    expect(input()).toHaveValue('A generated text');
    await act(async () => fireEvent.click(publish()));
    expect(submit).toHaveBeenCalledWith({ content: 'A generated text', seedLikes: aiDraft('A').seedLikes, seedComments: aiDraft('A').seedComments });
    const stale = deferred<MomentComposerAiDraft>();
    ui.rerender(<StrictMode><MomentComposer {...propsFor(A, { onGenerateAiDraft: () => stale.promise })} /></StrictMode>);
    fireEvent.click(generate());
    ui.rerender(<StrictMode><MomentComposer {...propsFor(B)} /></StrictMode>);
    type('B strict input');
    await settleAi(stale, 'success', 'A-old');
    expect(input()).toHaveValue('B strict input');
    expect(input()).toBeEnabled();
  });
});
