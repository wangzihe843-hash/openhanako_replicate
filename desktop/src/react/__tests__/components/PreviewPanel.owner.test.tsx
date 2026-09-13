// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PreviewPanel } from '../../components/PreviewPanel';
import type { PreviewEditorProps } from '../../components/PreviewEditor';
import { useStore } from '../../stores';
import { installWindowTestT } from '../helpers/i18n-test-strings';
const captured = vi.hoisted(() => ({ props: null as PreviewEditorProps | null }));
vi.mock('../../components/PreviewEditor', async () => {
  const { forwardRef } = await import('react');
  return { PreviewEditor: forwardRef((props: PreviewEditorProps, _ref) => { captured.props = props; return null; }) };
});
vi.mock('../../components/app/OpenPreviewDocumentWatchBridge', () => ({ OpenPreviewDocumentWatchBridge: () => null }));
beforeEach(() => {
  installWindowTestT();
  useStore.setState({ activeServerConnection: null, activeServerConnectionId: null, serverConnections: {}, serverPort: '3210', serverToken: 'owner-A',
    previewOpen: true, activeTabId: 'remote', openTabs: ['remote'], markdownPreviewIds: [], previewItems: [{ id: 'remote', title: 'note.md', type: 'markdown', content: 'A', storageKind: 'remote-content',
      remoteContentRef: { kind: 'workbench-file', mountId: 'docs', subdir: '', name: 'note.md', contentPath: '/api/workbench/content?mountId=docs&name=note.md' } }] });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, version: { mtimeMs: 2, size: 4, sha256: 'ack' } }))));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('REVIEW binds retired PreviewPanel saves to their original connection through the real helper', async () => {
  render(<PreviewPanel />);
  const old = captured.props!;
  act(() => { useStore.setState({ serverPort: '4321', serverToken: 'owner-B' }); });
  const next = captured.props!;
  const version = { mtimeMs: 1, size: 1, sha256: 'original' };
  await old.saveDocument!('old edit', version);
  await next.saveDocument!('new edit', null);
  const calls = vi.mocked(fetch).mock.calls.filter(([url, init]) => String(url).includes('/api/workbench/actions') && init?.method === 'POST');
  expect(calls).toHaveLength(2);
  expect(String(calls[0][0])).toContain(':3210/api/workbench/actions');
  expect(String(calls[1][0])).toContain(':4321/api/workbench/actions');
  expect(new Headers(calls[0][1]?.headers).get('Authorization')).toBe('Bearer owner-A');
  expect(JSON.parse(String(calls[0][1]?.body))).toMatchObject({ content: 'old edit', expectedVersion: version });
  expect(JSON.parse(String(calls[1][1]?.body))).toMatchObject({ content: 'new edit', expectedVersion: null });
  expect(next.documentOwnerKey).not.toBe(old.documentOwnerKey);
});
