/** @vitest-environment jsdom */
import React from 'react';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ModelManager } from '../core/model-manager.ts';
import { ProviderRegistry } from '../core/provider-registry.ts';
import { createProvidersRoute } from '../server/routes/providers.ts';
import { kimiExplicitBudgets, kimiProjectionCases, type KimiModelEntry } from './fixtures/kimi-context-cases.ts';

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

async function saveModelAndWait(onRefresh: ReturnType<typeof vi.fn>, expectedRefreshes: number) {
  const callIndex = mocks.hanaFetch.mock.calls.length;
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'settings.api.save' }));
    expect(mocks.hanaFetch).toHaveBeenCalledTimes(callIndex + 1);
    expect(mocks.hanaFetch.mock.calls[callIndex][1]).toMatchObject({ method: 'PUT' });
    // This request runs the real route and filesystem-backed model sync. Await
    // its completion instead of polling the refresh spy on a separate deadline.
    const response = await mocks.hanaFetch.mock.results[callIndex].value;
    expect(response.ok).toBe(true);
  });
  expect(onRefresh).toHaveBeenCalledTimes(expectedRefreshes);
  // Refresh is called before onClose; flush and check the completed edit before
  // reopening it or unmounting the provider for the next budget.
  expect(screen.queryByRole('button', { name: 'settings.api.save' })).not.toBeInTheDocument();
}

let fixtureHome: string;
beforeEach(() => {
  fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hana-k28-ui-runtime-'));
  vi.clearAllMocks();
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No live calls in UI context tests'));
});
afterEach(() => {
  cleanup();
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  fs.rmSync(fixtureHome, { recursive: true, force: true });
});

it.each(kimiProjectionCases.filter(c => c.base_url && c.api && !c.modelApi))(
  'keeps pending UI, saved UI and real runtime context consistent at $label/$api', async c => {
    const baseUrl = c.base_url;
    const provider = 'kimi-coding';
    const id = 'kimi-for-coding';
    const registry = new ProviderRegistry(fixtureHome);
    registry.saveProvider(provider, { api_key: 'sk-k28-synthetic-fixture',
      api: c.api, base_url: baseUrl, models: [] });
    fs.writeFileSync(path.join(fixtureHome, 'auth.json'), '{}');
    const manager = new ModelManager({ hanakoHome: fixtureHome });
    await manager.init();
    await manager.refreshAvailable();
    for (const budget of [{}, ...kimiExplicitBudgets]) {
      let savedModels: KimiModelEntry[] = [];
      mocks.hanaFetch.mockImplementation(async (url, options) => {
        if (url === '/api/config' && options?.method === 'PUT') {
          const saved = JSON.parse(options.body).providers[provider];
          savedModels = saved.models;
          manager.providerRegistry.saveProvider(provider, saved);
          await manager.reloadAndSync();
          return { json: async () => ({ ok: true }) };
        }
        return { json: async () => ({ models: [{ id, ...budget }] }) };
      });
      const expected = ('context' in budget ? budget.context : undefined)
        ?? ('contextWindow' in budget ? budget.contextWindow : undefined)
        ?? c.expected;
      const summary = { type: 'api-key', auth_type: 'api-key', display_name: 'Kimi',
        base_url: baseUrl, api: c.api, api_key: '', models: [], custom_models: [],
        has_credentials: true, supports_oauth: false, can_delete: false } as const;
      const onRefresh = vi.fn(async () => {});
      const { rerender, unmount } = render(<ProviderModelList providerId={provider}
        summary={{ ...summary, models: [], custom_models: [] }} onRefresh={onRefresh} />);
      fireEvent.click(screen.getByRole('button', { name: 'settings.api.addModel' }));
      const option = await screen.findByRole('button', { name: /kimi-for-coding/ });
      expect(option).toHaveTextContent(String(expected));
      fireEvent.click(option);
      await waitFor(() => expect(onRefresh).toHaveBeenCalled());
      expect(manager.availableModels.find(model => model.provider === provider && model.id === id)
        ?.contextWindow).toBe(expected);
      rerender(<ProviderModelList providerId={provider} summary={{ ...summary, models: savedModels,
        custom_models: [] }} onRefresh={onRefresh} />);
      expect(screen.getAllByText(String(expected)).length).toBeGreaterThan(0);
      unmount();
    }
  });

it.each(kimiProjectionCases.filter(c => c.base_url && c.api))(
  'keeps saved display, editing and runtime on the same budget branch at $label/$api/$modelApi', async c => {
    const provider = 'kimi-coding', id = 'kimi-for-coding';
    const registry = new ProviderRegistry(fixtureHome);
    registry.saveProvider(provider, { api_key: 'sk-k28-synthetic-fixture', base_url: c.base_url, api: c.api, models: [] });
    fs.writeFileSync(path.join(fixtureHome, 'auth.json'), '{}');
    const manager = new ModelManager({ hanakoHome: fixtureHome });
    await manager.init();
    const app = new Hono();
    app.route('/api', createProvidersRoute({ hanakoHome: fixtureHome, providerRegistry: manager.providerRegistry,
      onProviderChanged: () => manager.reloadAndSync() }));
    for (const budget of [{}, ...kimiExplicitBudgets]) {
      const entry = Object.keys(budget).length || c.modelApi ? { id, ...(c.modelApi ? { api: c.modelApi } : {}), ...budget } : id;
      manager.providerRegistry.saveProvider(provider, { models: [entry] });
      await manager.reloadAndSync();
      const original = structuredClone(manager.providerRegistry.getAllProvidersRaw()[provider].models);
      const expected = c.builtin ? budget.contextWindow ?? budget.context ?? c.expected : budget.context ?? budget.contextWindow ?? c.expected;
      const summary: ProviderSummary = { type: 'api-key', auth_type: 'api-key', display_name: 'Kimi',
        base_url: c.base_url, api: c.api, api_key: '', models: original, custom_models: [],
        has_credentials: true, supports_oauth: false, can_delete: false };
      useSettingsStore.setState({ providersSummary: { [provider]: summary }, settingsConfig: {} });
      mocks.hanaFetch.mockImplementation(async (url, options) => options?.method === 'PUT'
        ? app.request(url, options) : { json: async () => ({ models: [{ id, context: 555555 }] }) });
      const onRefresh = vi.fn(async () => {});
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
      await saveModelAndWait(onRefresh, 1);
      const update = mocks.hanaFetch.mock.calls.filter(([, options]) => options?.method === 'PUT').at(-1);
      expect(JSON.parse(update[1].body)).not.toHaveProperty('context');
      const saved = manager.providerRegistry.getAllProvidersRaw()[provider].models[0];
      expect(saved.context).toBe(typeof entry === 'string' ? undefined : entry.context);
      expect(saved.contextWindow).toBe(typeof entry === 'string' ? undefined : entry.contextWindow);
      for (const edited of [1048576, 262144]) {
        fireEvent.click(screen.getByRole('button', { name: 'settings.api.editModel' }));
        fireEvent.change(screen.getAllByRole('spinbutton')[0], { target: { value: '999999' } });
        fireEvent.change(screen.getAllByRole('spinbutton')[0], { target: { value: String(edited) } });
        await saveModelAndWait(onRefresh, edited === 1048576 ? 2 : 3);
        expect(manager.providerRegistry.getAllProvidersRaw()[provider].models[0]).toMatchObject({ context: edited });
        expect(manager.providerRegistry.getAllProvidersRaw()[provider].models[0]).not.toHaveProperty('contextWindow');
        expect(manager.availableModels.find(m => m.id === id && m.provider === provider)?.contextWindow).toBe(edited);
      }
      unmount();
    }
  });
