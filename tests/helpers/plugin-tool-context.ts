import { vi } from 'vitest';
import type { HanaToolContext } from '@hana/plugin-runtime';

// Metadata-only tool tests should not silently acquire a working I/O surface.
// Callers explicitly override a typed service when their scenario needs it.
function unexpected(service: string) {
  return () => { throw new Error(`Unexpected fixture service call: ${service}`); };
}

export function createPluginToolContext(overrides: Partial<HanaToolContext> = {}): HanaToolContext {
  return {
    serverId: 'fixture-server', userId: 'fixture-user', studioId: 'fixture-studio',
    pluginId: 'fixture-plugin', pluginDir: '/fixture/plugin', dataDir: '/fixture/data',
    bus: { emit: unexpected('bus.emit'), request: unexpected('bus.request'), subscribe: unexpected('bus.subscribe') },
    network: { fetch: unexpected('network.fetch') },
    resources: {
      stat: unexpected('resources.stat'), read: unexpected('resources.read'), list: unexpected('resources.list'),
      search: unexpected('resources.search'), materialize: unexpected('resources.materialize'),
      write: unexpected('resources.write'), writeExpectedVersion: unexpected('resources.writeExpectedVersion'),
      edit: unexpected('resources.edit'), mkdir: unexpected('resources.mkdir'), delete: unexpected('resources.delete'),
      copy: unexpected('resources.copy'), rename: unexpected('resources.rename'), move: unexpected('resources.move'),
      trash: unexpected('resources.trash'), watch: unexpected('resources.watch'), subscribe: unexpected('resources.subscribe'),
    },
    config: { get: unexpected('config.get'), set: unexpected('config.set') },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides,
  };
}
