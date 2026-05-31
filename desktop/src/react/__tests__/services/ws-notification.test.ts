// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// handleServerMessage pulls in the full renderer dependency graph; stub the
// heavy collaborators so this file can focus on the notification → showNotification hop.
vi.mock('../../hooks/use-stream-buffer', () => ({
  streamBufferManager: { handle: vi.fn(), beginTurn: vi.fn(), finishTurn: vi.fn() },
}));
vi.mock('../../stores/session-actions', () => ({ loadSessions: vi.fn() }));
vi.mock('../../stores/desk-actions', () => ({ loadDeskFiles: vi.fn() }));
vi.mock('../../stores/channel-actions', () => ({ loadChannels: vi.fn(), openChannel: vi.fn() }));
vi.mock('../../stores/preview-actions', () => ({ handleLegacyArtifactBlock: vi.fn() }));
vi.mock('../../services/app-event-actions', () => ({ handleAppEvent: vi.fn() }));
vi.mock('../../services/stream-resume', () => ({
  replayStreamResume: vi.fn(),
  isStreamResumeRebuilding: () => null,
  isStreamScopedMessage: () => false,
  updateSessionStreamMeta: vi.fn(),
}));
vi.mock('../../services/stream-key-dispatcher', () => ({ dispatchStreamKey: vi.fn() }));

import { handleServerMessage } from '../../services/ws-message-handler';

describe('ws-message-handler desktop notification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete (window as unknown as { hana?: unknown }).hana;
  });

  it('把触发 agent 的 agentId 透传给 showNotification（多 agent 定时任务可分辨身份）', () => {
    const showNotification = vi.fn();
    (window as unknown as { hana: { showNotification: typeof showNotification } }).hana = { showNotification };

    handleServerMessage({
      type: 'notification',
      title: '提醒',
      body: '该喝水了',
      agentId: 'a2',
    });

    expect(showNotification).toHaveBeenCalledWith('提醒', '该喝水了', 'a2');
  });

  it('agentId 缺失时透传 null，不从全局焦点兜底', () => {
    const showNotification = vi.fn();
    (window as unknown as { hana: { showNotification: typeof showNotification } }).hana = { showNotification };

    handleServerMessage({
      type: 'notification',
      title: '提醒',
      body: '正文',
      agentId: null,
    });

    expect(showNotification).toHaveBeenCalledWith('提醒', '正文', null);
  });
});
