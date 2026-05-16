// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MobileApp } from '../../mobile/MobileApp';

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
    setTimeout(() => this.onopen?.(), 0);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.onclose?.();
  }
}

describe('MobileApp', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('WebSocket', MockWebSocket);
    MockWebSocket.instances = [];
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows the access-key login when no browser session exists', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ authenticated: false, principal: null }));

    render(<MobileApp />);

    expect(await screen.findByText('手机访问 Hana')).toBeInTheDocument();
    expect(screen.getByLabelText('访问密钥')).toBeInTheDocument();
  });

  it('loads chat sessions and workbench files for an authenticated phone', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/web-auth/session')) {
        return Promise.resolve(jsonResponse({ authenticated: true, principal: { scopes: ['chat', 'files.read'] } }));
      }
      if (url.includes('/api/server/identity')) {
        return Promise.resolve(jsonResponse({
          serverId: 'server_1',
          userId: 'user_1',
          studioId: 'studio_1',
          label: 'Hana Studio',
          connectionKind: 'lan',
          trustState: 'lan',
          credentialKind: 'device_credential',
          capabilities: ['chat', 'resources', 'files'],
        }));
      }
      if (url.includes('/api/mobile/workbench/files')) {
        return Promise.resolve(jsonResponse({
          rootId: 'default',
          subdir: '',
          files: [{ name: 'note.md', isDir: false, size: 12, mtime: '2026-05-16T00:00:00.000Z' }],
        }));
      }
      if (url.includes('/api/sessions/messages')) {
        return Promise.resolve(jsonResponse({ messages: [], blocks: [], todos: [], hasMore: false, sessionFiles: [] }));
      }
      if (url.includes('/api/sessions')) {
        return Promise.resolve(jsonResponse([
          { path: '/hana/sessions/one.jsonl', title: '日常记录', modified: '2026-05-16T00:00:00.000Z', messageCount: 2 },
        ]));
      }
      return Promise.resolve(jsonResponse({}));
    });

    render(<MobileApp />);

    expect(await screen.findByText('日常记录')).toBeInTheDocument();
    fireEvent.click(screen.getByText('工作台'));
    expect(await screen.findByText('note.md')).toBeInTheDocument();
  });
});

function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => data,
    text: async () => typeof data === 'string' ? data : JSON.stringify(data),
    headers: new Headers(),
  } as Response;
}
