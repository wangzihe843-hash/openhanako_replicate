/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { useSettingsStore } from '../desktop/src/react/settings/store';
import { TaskRegistry } from '../lib/task-registry';
import { registerTaskRegistryBusHandlers } from '../server/task-bus-handlers';

const hanaFetch = vi.fn();

vi.mock('../desktop/src/react/settings/api', () => ({
  hanaFetch: (...args: unknown[]) => hanaFetch(...args),
}));

function jsonResponse(body: unknown): Response {
  return { json: async () => body } as Response;
}

// Keep the actual Node registry integration in the test project, outside the
// strict renderer compilation boundary.
describe('Plugin task diagnostics', () => {
  beforeEach(() => {
    hanaFetch.mockResolvedValue(jsonResponse([]));
    window.t = ((key: string) => key) as typeof window.t;
    window.platform = {
      selectFile: vi.fn(),
      selectDirectory: vi.fn(),
      showInFinder: vi.fn(),
    } as unknown as typeof window.platform;
    useSettingsStore.setState({
      pluginAllowFullAccess: undefined,
      pluginDevToolsEnabled: undefined,
      pluginUserDir: '',
      toastMessage: '',
      toastType: '',
      toastVisible: false,
    } as never);
  });

  afterEach(() => {
    cleanup();
    hanaFetch.mockReset();
    vi.unstubAllGlobals();
    useSettingsStore.setState({
      pluginAllowFullAccess: undefined,
      pluginDevToolsEnabled: undefined,
      pluginUserDir: '',
    } as never);
  });

  it('shows real registry lifecycle states without deriving success from result text', async () => {
    const registry = new TaskRegistry();
    const handlers = new Map<string, (payload: Record<string, unknown>) => unknown>();
    registerTaskRegistryBusHandlers({ handle: (name: string, handler: (payload: Record<string, unknown>) => unknown) => handlers.set(name, handler) }, registry);
    const request = (name: string, payload: Record<string, unknown>) => handlers.get(name)!(payload);
    request('task:register-handler', { type: 'workflow', abort: vi.fn() });
    for (const status of ['blocked', 'failed', 'canceled', 'aborted', 'completed', 'paused', 'recovering', 'pending', 'running']) {
      request('task:register', { taskId: status, type: 'workflow', meta: { summary: `Workflow ${status}` } });
      if (status === 'completed') request('task:complete', { taskId: status, result: 'success words' });
      else if (status === 'failed') request('task:fail', { taskId: status, reason: 'Validation failed after file write' });
      else if (status === 'canceled') request('task:cancel', { taskId: status, reason: 'User canceled' });
      else if (status === 'aborted') request('task:abort', { taskId: status });
      else request('task:update', { taskId: status, status, ...(status === 'blocked' ? { progress: { current: 1, total: 4, message: 'Waiting for credentials' } } : {}) });
    }
    hanaFetch.mockImplementation(async (path: string) => jsonResponse(path === '/api/plugins/diagnostics'
      ? { plugins: [], eventBus: [], tasks: registry.listAll(), schedules: [] } : []));
    const { PluginsTab } = await import('../desktop/src/react/settings/tabs/PluginsTab');
    render(<PluginsTab />);
    fireEvent.click(screen.getByTitle('settings.plugins.showDiagnostics'));
    const region = await screen.findByRole('region', { name: 'settings.plugins.taskTitle' });
    for (const status of ['Blocked', 'Failed', 'Canceled', 'Aborted', 'Completed', 'Paused', 'Recovering', 'Pending', 'Running']) {
      expect(within(region).getByText(`settings.plugins.task${status}`)).toBeInTheDocument();
    }
    expect(within(region).getByText('Waiting for credentials')).toBeInTheDocument();
    expect(within(region).getByText('Validation failed after file write')).toBeInTheDocument();
    expect(within(region).getByText('settings.plugins.taskCompletionNote')).toBeInTheDocument();
    expect(within(region).getByText('settings.plugins.taskScope')).toBeInTheDocument();
    expect(within(region).queryByText('success words')).not.toBeInTheDocument();
    registry.remove('blocked');
    fireEvent.click(screen.getByTitle('settings.plugins.showDiagnostics'));
    await waitFor(() => expect(within(region).queryByText('Workflow blocked')).not.toBeInTheDocument());
  });

  it('keeps the last snapshot visibly stale when refresh fails and recovers on a successful retry', async () => {
    let response: unknown = { plugins: [], tasks: [{ taskId: 'blocked-task', type: 'workflow', status: 'blocked' }] };
    hanaFetch.mockImplementation(async (path: string) => path === '/api/plugins/diagnostics'
      ? response instanceof Error ? Promise.reject(response) : jsonResponse(response) : jsonResponse([]));
    const { PluginsTab } = await import('../desktop/src/react/settings/tabs/PluginsTab');
    render(<PluginsTab />);
    fireEvent.click(screen.getByTitle('settings.plugins.showDiagnostics'));
    await screen.findByText('settings.plugins.taskBlocked');
    expect(screen.getByText('settings.plugins.taskNoReason')).toBeInTheDocument();
    response = new Error('Disconnected');
    fireEvent.click(screen.getByTitle('settings.plugins.showDiagnostics'));
    expect(await screen.findByRole('alert')).toHaveTextContent('settings.plugins.taskRefreshFailed');
    expect(screen.getByText('settings.plugins.taskBlocked')).toBeInTheDocument();
    response = { plugins: [] }; // A malformed response must not clear evidence.
    fireEvent.click(screen.getByTitle('settings.plugins.showDiagnostics'));
    await waitFor(() => expect(screen.getByTitle('settings.plugins.showDiagnostics')).not.toBeDisabled());
    expect(screen.getByText('settings.plugins.taskBlocked')).toBeInTheDocument();
    response = { plugins: [], tasks: [] };
    fireEvent.click(screen.getByTitle('settings.plugins.showDiagnostics'));
    expect(await screen.findByText('settings.plugins.taskEmpty')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('uses task IDs for arbitrary plugin metadata instead of rendering objects', async () => {
    const registry = new TaskRegistry();
    registry.registerHandler('plugin', { abort: vi.fn() });
    registry.register('object-summary', { type: 'plugin', meta: { summary: { label: 'nested' } } });
    registry.register('array-summary', { type: 'plugin', meta: { summary: 'old title' } });
    registry.update('array-summary', { meta: { summary: [{ label: 'updated' }] } });
    registry.register('blank-summary', { type: 'plugin', meta: { summary: '   ' } });
    registry.register('normal-summary', { type: 'plugin', meta: { summary: 'Readable title' } });
    hanaFetch.mockImplementation(async (path: string) => jsonResponse(path === '/api/plugins/diagnostics'
      ? { plugins: [], tasks: registry.listAll() } : []));
    const { PluginsTab } = await import('../desktop/src/react/settings/tabs/PluginsTab');
    render(<PluginsTab />);
    fireEvent.click(screen.getByTitle('settings.plugins.showDiagnostics'));
    const region = await screen.findByRole('region', { name: 'settings.plugins.taskTitle' });
    for (const title of ['object-summary', 'array-summary', 'blank-summary', 'Readable title']) {
      expect(within(region).getByText(title, { selector: 'strong' })).toBeInTheDocument();
    }
    expect(within(region).getAllByText('settings.plugins.taskRunning')).toHaveLength(4);
  });

  it('does not label unknown or absent lifecycle values completed', async () => {
    hanaFetch.mockImplementation(async (path: string) => jsonResponse(path === '/api/plugins/diagnostics'
      ? { plugins: [], tasks: [{ taskId: 'future', type: 'plugin', status: 'future-state' }, { taskId: 'legacy', type: 'plugin' }] } : []));
    const { PluginsTab } = await import('../desktop/src/react/settings/tabs/PluginsTab');
    render(<PluginsTab />);
    fireEvent.click(screen.getByTitle('settings.plugins.showDiagnostics'));
    expect(await screen.findAllByText('settings.plugins.taskUnknown')).toHaveLength(2);
    expect(screen.queryByText('settings.plugins.taskCompleted')).not.toBeInTheDocument();
  });

});
