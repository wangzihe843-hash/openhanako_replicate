// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionNodeActions } from '../../components/chat/SessionNodeActions';
import { MessageFooterActions } from '../../components/chat/MessageFooterActions';
import { useStore } from '../../stores';

const mocks = vi.hoisted(() => ({
  retry: vi.fn(async () => true), fork: vi.fn(async () => null), activate: vi.fn(),
  generate: vi.fn(), list: vi.fn(async (): Promise<unknown[]> => []), update: vi.fn(async () => true),
}));
vi.mock('../../stores/message-turn-actions', () => ({
  retrySessionTurn: mocks.retry, forkSessionTurn: mocks.fork, activateForkedSession: mocks.activate,
  generateDialogueVariant: mocks.generate, listDialogueVariants: mocks.list, updateDialogueVariant: mocks.update,
}));
const candidate = { candidateId: 'candidate-one', requestId: 'request-one', sourceEntryId: 'assistant-one', turnInputEntryId: 'user-one', status: 'ready', text: 'The original task result, expressed differently.' };
function Harness({ sessionPath = '/session.jsonl', entryId = 'assistant-one' }: { sessionPath?: string; entryId?: string } = {}) {
  const { actions } = useSessionNodeActions({ sessionPath, target: { role: 'assistant', entryId } });
  return <MessageFooterActions actions={actions} />;
}
afterEach(cleanup);
beforeEach(() => {
  vi.resetAllMocks();
  mocks.retry.mockResolvedValue(true); mocks.fork.mockResolvedValue(null); mocks.update.mockResolvedValue(true);
  mocks.list.mockResolvedValue([]); mocks.generate.mockResolvedValue(candidate);
  Object.assign(window, { t: (key: string) => key });
  useStore.setState({ sessions: [{ path: '/session.jsonl', sessionId: 'sess_one' }], streamingSessions: [] } as never);
});
describe('distinct turn actions', () => {
  it('previews an expression without retrying the task and adopts only on a separate click', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByTitle('Expression variant'));
    await screen.findByText(candidate.text);
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(mocks.retry).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Adopt expression' }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith('/session.jsonl', 'adopt', { candidateId: candidate.candidateId }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
  it('reopens a persisted candidate without generating another or automatically adopting it', async () => {
    mocks.list.mockResolvedValue([candidate]);
    render(<Harness />);
    fireEvent.click(screen.getByTitle('Expression variant'));
    await screen.findByText(candidate.text);
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith('/session.jsonl', 'discard', { candidateId: candidate.candidateId }));
  });
  it('guards repeated generation clicks and sends cancellation by request ID', async () => {
    let finish: (value: unknown) => void;
    mocks.generate.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    render(<Harness />);
    fireEvent.click(screen.getByTitle('Expression variant'));
    fireEvent.click(screen.getByTitle('Expression variant'));
    await screen.findByText('Generating expression…');
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    const requestId = mocks.generate.mock.calls[0][2];
    expect(mocks.update).toHaveBeenCalledWith('/session.jsonl', 'cancel', { requestId });
    await act(async () => { finish!(null); });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('uses the task retry mode and disables it in pure-story sessions', async () => {
    const view = render(<Harness />);
    fireEvent.click(screen.getByTitle('Retry task'));
    expect(mocks.retry).toHaveBeenCalledWith('/session.jsonl', { role: 'assistant', entryId: 'assistant-one' }, { mode: 'task_retry' });
    await act(async () => {});
    view.unmount();
    useStore.setState({ sessions: [{ path: '/session.jsonl', memoryScope: { realm: 'story' } }] } as never);
    render(<Harness />);
    expect(screen.getByTitle('Retry task')).toBeDisabled();
    fireEvent.click(screen.getByTitle('Narrative branch'));
    expect(mocks.fork).toHaveBeenCalledWith('/session.jsonl', { role: 'assistant', entryId: 'assistant-one' }, 'narrative_branch');
    await act(async () => {});
  });
  it('ignores a delayed candidate list after navigating and does not start its old generation', async () => {
    let finishList: (value: unknown[]) => void;
    mocks.list.mockReturnValueOnce(new Promise(resolve => { finishList = resolve; }));
    const view = render(<Harness />);
    fireEvent.click(screen.getByTitle('Expression variant'));
    view.rerender(<Harness sessionPath="/other.jsonl" entryId="assistant-two" />);
    await act(async () => { finishList!([candidate]); });
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByTitle('Expression variant')).toBeEnabled();
  });

  it.each(['session', 'target'])('cancels old generation and ignores its late result after %s navigation', async navigation => {
    let finishOld: (value: unknown) => void;
    let finishNew: (value: unknown) => void;
    mocks.generate.mockReturnValueOnce(new Promise(resolve => { finishOld = resolve; }))
      .mockReturnValueOnce(new Promise(resolve => { finishNew = resolve; }));
    const view = render(<Harness />);
    fireEvent.click(screen.getByTitle('Expression variant'));
    await screen.findByText('Generating expression…');
    const oldRequestId = mocks.generate.mock.calls[0][2];
    const nextPath = navigation === 'session' ? '/other.jsonl' : '/session.jsonl';
    view.rerender(<Harness sessionPath={nextPath} entryId="assistant-two" />);
    expect(mocks.update).toHaveBeenCalledWith('/session.jsonl', 'cancel', { requestId: oldRequestId });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Expression variant'));
    await screen.findByText('Generating expression…');
    await act(async () => { finishOld!(candidate); });
    expect(screen.queryByText(candidate.text)).not.toBeInTheDocument();
    expect(screen.getByText('Generating expression…')).toBeInTheDocument();
    expect(screen.getByTitle('Expression variant')).toBeDisabled();
    const nextCandidate = { ...candidate, candidateId: 'candidate-two', sourceEntryId: 'assistant-two', text: 'Current response alternative.' };
    await act(async () => { finishNew!(nextCandidate); });
    expect(screen.getByText(nextCandidate.text)).toBeInTheDocument();
  });

  it.each(['adopt', 'discard'] as const)('ignores old %s completion while a new target preview is open', async action => {
    let finishUpdate: (value: boolean) => void;
    mocks.list.mockResolvedValueOnce([candidate]);
    mocks.update.mockReturnValueOnce(new Promise(resolve => { finishUpdate = resolve; }));
    const view = render(<Harness />);
    fireEvent.click(screen.getByTitle('Expression variant'));
    await screen.findByText(candidate.text);
    fireEvent.click(screen.getByRole('button', { name: action === 'adopt' ? 'Adopt expression' : 'Discard' }));
    expect(mocks.update).toHaveBeenCalledWith('/session.jsonl', action, { candidateId: candidate.candidateId });
    view.rerender(<Harness sessionPath="/other.jsonl" entryId="assistant-two" />);
    const nextCandidate = { ...candidate, candidateId: 'candidate-two', sourceEntryId: 'assistant-two', text: 'Current response alternative.' };
    mocks.list.mockResolvedValueOnce([nextCandidate]);
    fireEvent.click(screen.getByTitle('Expression variant'));
    await screen.findByText(nextCandidate.text);
    await act(async () => { finishUpdate!(true); });
    expect(screen.getByText(nextCandidate.text)).toBeInTheDocument();
  });

  it('does not reopen a cancelled preview after late generation and cancellation responses', async () => {
    let finishGeneration: (value: unknown) => void;
    let finishCancellation: (value: boolean) => void;
    mocks.generate.mockReturnValueOnce(new Promise(resolve => { finishGeneration = resolve; }));
    mocks.update.mockReturnValueOnce(new Promise(resolve => { finishCancellation = resolve; }));
    const view = render(<Harness />);
    fireEvent.click(screen.getByTitle('Expression variant'));
    await screen.findByText('Generating expression…');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    view.rerender(<Harness sessionPath="/other.jsonl" entryId="assistant-two" />);
    await act(async () => { finishGeneration!(candidate); finishCancellation!(true); });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByTitle('Expression variant')).toBeEnabled();
  });

});
