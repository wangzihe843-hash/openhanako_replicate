/** @vitest-environment jsdom */
import React from 'react';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ModelManager } from '../core/model-manager.ts';
import { ProviderRegistry } from '../core/provider-registry.ts';
import { createProvidersRoute } from '../server/routes/providers.ts';
import { kimiExplicitBudgets, kimiProjectionCases } from './fixtures/kimi-context-cases.ts';

const mocks = vi.hoisted(() => ({ hanaFetch: vi.fn() }));
vi.mock('../desktop/src/react/settings/api', () => ({
  hanaFetch: (...args: unknown[]) => mocks.hanaFetch(...args),
}));
vi.mock('../desktop/src/react/hooks/use-config', () => ({ invalidateConfigCache: vi.fn() }));
vi.mock('../desktop/src/react/settings/helpers', async importOriginal => ({
  ...await importOriginal<typeof import('../desktop/src/react/settings/helpers')>(),
  t: (key: string) => key, formatContext: (n: number) => `${n}`, CONTEXT_PRESETS: [], OUTPUT_PRESETS: [],
}));
import { ProviderModelList } from '../desktop/src/react/settings/tabs/providers/ProviderModelList';
import { lookupModelMeta } from '../desktop/src/react/settings/helpers';
import { useSettingsStore, type ProviderSummary } from '../desktop/src/react/settings/store';

import * as trace from './helpers/kimi-context-windows-trace';

// Collection must not install hooks. The native guard still runs before any fixture.
beforeAll(() => trace.install(ModelManager.prototype, ProviderRegistry.prototype, useSettingsStore));
afterAll(() => trace.finish());
let fixtureHome: string;
beforeEach(() => {
  fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hana-k28-ui-runtime-'));
  vi.clearAllMocks();
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No live calls in UI context tests'));
  trace.beforeTest(fixtureHome);
});
afterEach(() => {
  trace.lifecycle('cleanup.begin');
  cleanup();
  trace.lifecycle('cleanup.end');
  trace.lifecycle('fetch-guard.begin');
  expect(globalThis.fetch).not.toHaveBeenCalled();
  trace.lifecycle('fetch-guard.pass');
  vi.restoreAllMocks();
  trace.lifecycle('restoreMocks.end');
  trace.lifecycle('fixture.remove.begin');
  fs.rmSync(fixtureHome, { recursive: true, force: true });
  trace.lifecycle('fixture.remove.end');
  trace.health();
});

const target = kimiProjectionCases.find(c => c.label === 'ai' && c.api === 'anthropic-messages' && c.modelApi === 'openai-completions')!;
const previous = kimiProjectionCases.find(c => c.label === 'ai' && c.api === 'anthropic-messages' && !c.modelApi)!;
const following = kimiProjectionCases.find(c => c.label === 'ai' && c.api === 'anthropic-messages' && c.modelApi === 'anthropic-messages')!;
const cohort = process.env.KIMI_DIAG_COHORT;
const cases = cohort === 'B' ? [target] : cohort === 'C' ? [target, target, target]
  : cohort === 'D' ? [previous, target, following, previous, target, following] : [];
if (!cases.length) throw new Error('Invalid diagnostic cohort');
cases.map((c, index) => ({ ...c, test_index: index, case_key: c === previous ? 'P' : c === following ? 'S' : 'T' })).forEach(c =>
  it(`diagnostic ${c.test_index} ${c.case_key}`, async () => trace.runCase(c, async () => {
    const provider = 'kimi-coding', id = 'kimi-for-coding';
    const registry = new ProviderRegistry(fixtureHome);
    registry.saveProvider(provider, { api_key: 'sk-k28-synthetic-fixture', base_url: c.base_url, api: c.api, models: [] });
    fs.writeFileSync(path.join(fixtureHome, 'auth.json'), '{}');
    const manager = new ModelManager({ hanakoHome: fixtureHome });
    trace.attachManager(manager, fixtureHome);
    await manager.init();
    const app = new Hono();
    app.route('/api', createProvidersRoute({ hanakoHome: fixtureHome, providerRegistry: manager.providerRegistry,
      onProviderChanged: () => manager.reloadAndSync() }));
    for (const [budgetIndex, budget] of [{}, ...kimiExplicitBudgets].entries()) {
      await trace.budget(budgetIndex, async () => {
      const entry = Object.keys(budget).length || c.modelApi ? { id, ...(c.modelApi ? { api: c.modelApi } : {}), ...budget } : id;
      manager.providerRegistry.saveProvider(provider, { models: [entry] });
      await manager.reloadAndSync();
      const original = structuredClone(manager.providerRegistry.getAllProvidersRaw()[provider].models);
      const expected = c.builtin ? budget.contextWindow ?? budget.context ?? c.expected : budget.context ?? budget.contextWindow ?? c.expected;
      const summary: ProviderSummary = { type: 'api-key', auth_type: 'api-key', display_name: 'Kimi',
        base_url: c.base_url, api: c.api, api_key: '', models: original, custom_models: [],
        has_credentials: true, supports_oauth: false, can_delete: false };
      useSettingsStore.setState({ providersSummary: { [provider]: summary }, settingsConfig: {} });
      trace.stateSnapshot(manager, useSettingsStore, useSettingsStore.getState().providersSummary[provider] === summary);
      mocks.hanaFetch.mockImplementation(async (url, options) => options?.method === 'PUT'
        ? trace.put(app, url, options) : { json: async () => ({ models: [{ id, context: 555555 }] }) });
      const onRefresh = vi.fn(async () => { trace.onRefresh(); });
      const { unmount } = render(<ProviderModelList providerId={provider} summary={summary} onRefresh={onRefresh} />);
      expect(lookupModelMeta(id, provider).context).toBe(expected);
      expect(screen.getByText(String(expected))).toBeInTheDocument();
      expect(manager.availableModels.find(m => m.id === id && m.provider === provider)?.contextWindow).toBe(expected);
      fireEvent.click(screen.getByRole('button', { name: 'settings.api.addModel' }));
      expect(await screen.findByRole('button', { name: /kimi-for-coding/ })).toHaveTextContent(String(expected));
      fireEvent.click(screen.getByRole('button', { name: 'settings.api.addModel' }));
      fireEvent.click(screen.getByRole('button', { name: 'settings.api.editModel' }));
      expect(screen.getAllByRole('spinbutton')[0]).toHaveValue(expected);
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Renamed Kimi' } });
      await trace.save('rename', () => fireEvent.click(screen.getByRole('button', { name: 'settings.api.save' })),
        poll => waitFor(poll), () => expect(onRefresh).toHaveBeenCalledTimes(1),
        () => onRefresh.mock.calls.length, () => !!screen.queryByRole('textbox'));
      const update = mocks.hanaFetch.mock.calls.filter(([, options]) => options?.method === 'PUT').at(-1);
      expect(JSON.parse(update[1].body)).not.toHaveProperty('context');
      const saved = manager.providerRegistry.getAllProvidersRaw()[provider].models[0];
      expect(saved.context).toBe(typeof entry === 'string' ? undefined : entry.context);
      expect(saved.contextWindow).toBe(typeof entry === 'string' ? undefined : entry.contextWindow);
      for (const edited of [1048576, 262144]) {
        fireEvent.click(screen.getByRole('button', { name: 'settings.api.editModel' }));
        fireEvent.change(screen.getAllByRole('spinbutton')[0], { target: { value: '999999' } });
        fireEvent.change(screen.getAllByRole('spinbutton')[0], { target: { value: String(edited) } });
        await trace.save(`context-${edited}`, () => fireEvent.click(screen.getByRole('button', { name: 'settings.api.save' })),
          poll => waitFor(poll), () => expect(onRefresh).toHaveBeenCalledTimes(edited === 1048576 ? 2 : 3),
          () => onRefresh.mock.calls.length, () => !!screen.queryByRole('textbox'));
        expect(manager.providerRegistry.getAllProvidersRaw()[provider].models[0]).toMatchObject({ context: edited });
        expect(manager.providerRegistry.getAllProvidersRaw()[provider].models[0]).not.toHaveProperty('contextWindow');
        expect(manager.availableModels.find(m => m.id === id && m.provider === provider)?.contextWindow).toBe(edited);
      }
      unmount();
      });
    }
  })));
