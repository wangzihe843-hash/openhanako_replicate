import { afterEach, describe, expect, it } from 'vitest';
import { useStore } from '../stores';
import { collectRecentContextForAgent } from './xingye-recent-context';

afterEach(() => {
  useStore.setState({
    sessions: [],
    sessionLocatorsById: {},
    currentSessionId: null,
    currentSessionPath: null,
    chatSessions: {},
  });
});

describe('collectRecentContextForAgent', () => {
  it('reads cached OpenHanako chat messages keyed by sessionId', () => {
    const sessionPath = 'agents/hana/sessions/main.jsonl';
    useStore.setState({
      sessions: [
        {
          path: sessionPath,
          sessionId: 'sess_hana_recent',
          title: null,
          firstMessage: '',
          modified: '2026-06-24T00:00:00.000Z',
          messageCount: 1,
          agentId: 'hana',
          agentName: 'Hana',
          cwd: null,
        },
      ],
      sessionLocatorsById: {
        sess_hana_recent: { path: sessionPath },
      },
      chatSessions: {
        sess_hana_recent: {
          items: [
            {
              type: 'message',
              data: {
                id: 'm1',
                role: 'user',
                text: 'hello from sessionId cache',
                timestamp: Date.parse('2026-06-24T00:00:01.000Z'),
              },
            },
          ],
          hasMore: false,
          loadingMore: false,
        },
      },
    });

    const context = collectRecentContextForAgent({ agentId: 'hana' });

    expect(context.hasOpenHanakoMessages).toBe(true);
    expect(context.messages).toHaveLength(1);
    expect(context.summaryText).toContain('hello from sessionId cache');
  });
});
