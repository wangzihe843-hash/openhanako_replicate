/** @vitest-environment jsdom */
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../stores';
import { WorkspaceFileChangeBridge } from '../../components/app/WorkspaceFileChangeBridge';
import { OpenPreviewDocumentWatchBridge } from '../../components/app/OpenPreviewDocumentWatchBridge';
import { setResourceEventConnection } from '../../services/resource-events';

const refresh = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../utils/preview-document-refresh', async (original) => ({
  ...await original<typeof import('../../utils/preview-document-refresh')>(),
  refreshPreviewDocumentTarget: refresh,
}));
const preview = () => ({
  id: 'remote', title: 'note.md', type: 'markdown' as const, content: '', storageKind: 'remote-content' as const,
  remoteContentRef: { kind: 'workbench-file' as const, mountId: 'docs', subdir: '', name: 'note.md', contentPath: '/api/workbench/content?mountId=docs&name=note.md' },
});

describe('resource watch bridges connection lifecycle', () => {
  beforeEach(() => {
    refresh.mockClear();
    useStore.setState({ activeServerConnection: null, activeServerConnectionId: null, serverConnections: {},
      serverPort: '19111', serverToken: 'synthetic-A', deskBasePath: '/same/root', deskWorkspaceMountId: null,
      deskWorkspaceNativeRoot: null, deskExpandedPaths: [], studioWorkspaces: [], previewItems: [preview()], openTabs: ['remote'],
    });
    let id = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(
      url.endsWith('/subscribe') ? { subscriptionId: `subscription-${++id}` } : {},
    ))));
  });
  afterEach(async () => {
    cleanup();
    useStore.setState({ serverPort: null, serverToken: null });
    setResourceEventConnection(null);
    await new Promise(resolve => setTimeout(resolve, 0));
    vi.unstubAllGlobals();
  });
  const calls = () => vi.mocked(fetch).mock.calls;
  const subscriptions = (port: string) => calls().filter(([url, opts]) => String(url) === `http://127.0.0.1:${port}/api/resource-io/subscribe` && opts?.method === 'POST');

  it.each(['workspace', 'preview'])('cleans old %s subscriptions and re-retains the same current resource on another connection', async (kind) => {
    render(kind === 'workspace' ? <WorkspaceFileChangeBridge /> : <OpenPreviewDocumentWatchBridge />);
    await waitFor(() => expect(subscriptions('19111')).toHaveLength(1));
    // Actual resolved local identity changes although the resource key is identical.
    act(() => useStore.setState({ serverPort: '19222', serverToken: 'synthetic-B' }));
    await waitFor(() => expect(subscriptions('19222')).toHaveLength(1));
    const deletion = calls().findIndex(([url, opts]) => String(url).startsWith('http://127.0.0.1:19111/api/resource-io/subscriptions/') && opts?.method === 'DELETE');
    const replacement = calls().findIndex(([url, opts]) => String(url) === 'http://127.0.0.1:19222/api/resource-io/subscribe' && opts?.method === 'POST');
    expect(deletion).toBeGreaterThanOrEqual(0);
    expect(deletion).toBeLessThan(replacement);
    expect(new Headers(subscriptions('19222')[0][1]?.headers).get('Authorization')).toBe('Bearer synthetic-B');
    expect(calls().some(([url, opts]) => String(url).startsWith('http://127.0.0.1:19222/api/resource-io/subscriptions/') && opts?.method === 'DELETE')).toBe(false);
  });

  it('does not resubscribe or refresh a preview removed during connection reset', async () => {
    render(<OpenPreviewDocumentWatchBridge />);
    await waitFor(() => expect(subscriptions('19111')).toHaveLength(1));
    refresh.mockClear();
    act(() => useStore.setState({ serverPort: '19222', serverToken: 'synthetic-B', previewItems: [], openTabs: [] }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(subscriptions('19222')).toHaveLength(0);
    expect(refresh).not.toHaveBeenCalled();
    act(() => useStore.setState({ previewItems: [preview()], openTabs: ['remote'] }));
    await waitFor(() => expect(subscriptions('19222')).toHaveLength(1));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('waits for a current workspace after connection reset empties the old root', async () => {
    render(<WorkspaceFileChangeBridge />);
    await waitFor(() => expect(subscriptions('19111')).toHaveLength(1));
    act(() => useStore.setState({ serverPort: '19222', serverToken: 'synthetic-B', deskBasePath: '', deskWorkspaceMountId: null, deskExpandedPaths: [] }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(subscriptions('19222')).toHaveLength(0);
    act(() => useStore.setState({ deskBasePath: '/same/root' }));
    await waitFor(() => expect(subscriptions('19222')).toHaveLength(1));
  });
});
