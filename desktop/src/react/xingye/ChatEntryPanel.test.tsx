// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatEntryPanel } from './ChatEntryPanel';
import { hanaFetch } from '../hooks/use-hana-fetch';
import { createXingyeMemoryCandidate } from './xingye-memory-candidate-store';
import type { Agent } from '../types';

vi.mock('../hooks/use-hana-fetch', () => ({ hanaFetch: vi.fn() }));
vi.mock('../stores', () => ({ useStore: (selector: (value: unknown) => unknown) => selector({ sessions: [
  { agentId: 'agent-a', sessionId: 'session-a', title: 'A' },
  { agentId: 'agent-a', sessionId: 'session-a2', title: 'A2' },
  { agentId: 'agent-b', sessionId: 'session-b', title: 'B' },
] }) }));
vi.mock('./xingye-profile-store', () => ({
  useXingyeRoleProfile: () => null,
  getXingyeRoleProfileDisplay: (agent: { name: string }) => ({ displayName: agent.name }),
}));
vi.mock('./XingyeAgentAvatar', () => ({ XingyeAgentAvatar: () => null }));
vi.mock('./MemoryCandidatePanel', () => ({ MemoryCandidatePanel: () => null }));
vi.mock('./xingye-memory-candidate-store', () => ({
  createXingyeMemoryCandidate: vi.fn(),
  sceneSummaryContent: () => 'summary',
}));

const agentA = { id: 'agent-a', name: 'A' } as Agent;
const agentB = { id: 'agent-b', name: 'B' } as Agent;
const props = {
  currentAgent: null,
  currentAgentId: null,
  enteringAgentId: null,
  enterChatError: null,
  onEnterChat: vi.fn(),
  onExit: vi.fn(),
};

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('M5 scene draft selection lifecycle', () => {
  it.each(['agent', 'session'] as const)('discards a model result after the selected %s changes', async (change) => {
    let finishModel!: (response: Response) => void;
    vi.mocked(hanaFetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/generate')) return new Promise<Response>((resolve) => { finishModel = resolve; });
      if (url.includes('/sources')) {
        const entryId = url.includes('agent-b') ? 'b1' : 'a1';
        return Response.json({ rows: [{ entryId, role: 'user', preview: '我们在月台见面。', hash: 'hash', timestamp: null, ordinal: 0 }], nextBefore: null });
      }
      throw new Error(`unexpected request: ${url}`);
    });
    const view = render(<ChatEntryPanel {...props} selectedAgent={agentA} />);
    const modelButton = await screen.findByRole('button', { name: '发送所选消息给模型并生成摘要' });
    await waitFor(() => expect((modelButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(modelButton);
    await waitFor(() => expect(finishModel).toBeTypeOf('function'));
    if (change === 'agent') view.rerender(<ChatEntryPanel {...props} selectedAgent={agentB} />);
    else fireEvent.change(screen.getByLabelText('场景会话'), { target: { value: 'session-a2' } });
    await act(async () => {
      finishModel(Response.json({
        ok: true, branchHeadId: 'a1', sourceRefs: [{ entryId: 'a1', role: 'user', hash: 'hash' }],
        sections: [{ kind: 'location', text: '我们在月台见面。', inference: false, evidence: [{ entryId: 'a1', quote: '我们在月台见面。' }] }],
      }));
    });
    expect(createXingyeMemoryCandidate).not.toHaveBeenCalled();
    expect(screen.queryByText(/模型摘要草稿已生成/)).toBeNull();
  });
});
