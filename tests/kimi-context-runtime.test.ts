import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { syncModels } from '../core/model-sync.ts';
import { ModelManager } from '../core/model-manager.ts';
import { ProviderRegistry } from '../core/provider-registry.ts';
import { getModelRuntime } from '../lib/pi-sdk/model-runtime.ts';
import { normalizeProviderPayload } from '../core/provider-compat.ts';
import { kimiExplicitBudgets, kimiProjectionCases, nonOfficialKimiEndpoints, officialKimiEndpoints, type KimiModelEntry } from './fixtures/kimi-context-cases.ts';

const id = 'kimi-for-coding';
const provider = 'kimi-coding';
const official = 'https://api.kimi.com/coding/v1';
let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hana-k28-context-'));
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No live provider calls in context tests'));
});
afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

function project(base_url: string | undefined, models: KimiModelEntry[] = [id], api = 'openai-completions') {
  const modelsJsonPath = path.join(home, 'projection.json');
  const configs = { [provider]: { base_url, api, api_key: 'sk-k28-synthetic-fixture', models } };
  const before = structuredClone(configs);
  syncModels(configs, { modelsJsonPath });
  expect(configs).toEqual(before);
  return JSON.parse(fs.readFileSync(modelsJsonPath, 'utf8')).providers[provider];
}

async function load(config: Record<string, unknown>) {
  new ProviderRegistry(home).saveProvider(provider, { api_key: 'sk-k28-synthetic-fixture', ...config });
  fs.writeFileSync(path.join(home, 'auth.json'), '{}');
  const manager = new ModelManager({ hanakoHome: home });
  await manager.init();
  await manager.refreshAvailable();
  expect(manager.modelRegistry.getError()).toBeUndefined();
  return manager;
}

function selected(manager, modelId = id) {
  const model = manager.availableModels.find(m => m.provider === provider && m.id === modelId);
  expect(model).toBeDefined();
  return model;
}

describe('K2.8 configured context through syncModels and real Pi registry', () => {
  it.each(kimiProjectionCases)('locks real Pi projection and explicit alias order at $label/$api/$modelApi', async c => {
    const manager = await load({ base_url: c.base_url, api: c.api, models: [id] });
    const entries: KimiModelEntry[] = [id, { id }, { id, name: 'My Kimi' }, ...kimiExplicitBudgets.map(b => ({ id, ...b }))];
    for (const model of entries) {
      const entry = c.modelApi ? { ...(typeof model === 'object' ? model : { id }), api: c.modelApi } : model;
      manager.providerRegistry.saveProvider(provider, { models: [entry] });
      await manager.reloadAndSync();
      const budget: { context?: number; contextWindow?: number } = typeof model === 'object' ? model : {};
      const expected = c.builtin ? budget.contextWindow ?? budget.context ?? c.expected : budget.context ?? budget.contextWindow ?? c.expected;
      expect(selected(manager).contextWindow).toBe(expected);
      expect(manager.providerRegistry.getAllProvidersRaw()[provider].models).toEqual([entry]);
      if (c.label === 'com' && c.modelApi === 'anthropic-messages') {
        // Pi 1.3's official catalog and the effective .com transport use OpenAI.
        expect(manager.getRegistryModelsForProvider(provider).find(m => m.id === id)?.api).toBe('openai-completions');
        expect(selected(manager).api).toBe('openai-completions');
      }
    }
  });

  it.each(officialKimiEndpoints)('projects bare/id/name forms at %s', baseUrl => {
    for (const entry of [id, { id }, { id, name: 'My K2.8' }]) {
      expect(project(baseUrl, [entry]).models[0]).toMatchObject({ id, contextWindow: 1048576, maxTokens: 32768 });
    }
  });

  it.each(nonOfficialKimiEndpoints.filter(Boolean))('never promotes before transport normalization at %s', baseUrl => {
    expect(project(baseUrl).models[0].contextWindow).toBe(262144);
  });

  it('keeps low-level missing URL skipped while Registry supplies an actual default endpoint', async () => {
    expect(project(undefined)).toBeUndefined();
    expect(project('')).toBeUndefined();
    const manager = await load({ models: [id] });
    expect(selected(manager)).toMatchObject({ contextWindow: 1048576, maxTokens: 32768, baseUrl: official });
    expect(manager.providerRegistry.getAllProvidersRaw()[provider]).not.toHaveProperty('base_url');
  });

  it.each(kimiExplicitBudgets)('preserves explicit regular budgets %j without migrating the user object', async budget => {
    const entry = { id, ...budget };
    const manager = await load({ base_url: official, models: [entry] });
    expect(selected(manager).contextWindow).toBe(budget.context ?? budget.contextWindow);
    expect(manager.providerRegistry.getAllProvidersRaw()[provider].models).toEqual([entry]);
  });

  it.each(['https://api.kimi.ai/coding', 'https://proxy.example/coding'])(
    'freezes the legacy Anthropic builtin and override alias order at %s', async baseUrl => {
      const manager = await load({ base_url: baseUrl, api: 'anthropic-messages', models: [id, 'k3'] });
      expect(selected(manager)).toMatchObject({ contextWindow: 1048576, maxTokens: 32768, api: 'anthropic-messages' });
      expect(selected(manager, 'k3')).toMatchObject({ contextWindow: 1048576, maxTokens: 131072 });
      manager.providerRegistry.saveProvider(provider, { models: [{ id, context: 123456, contextWindow: 234567 }] });
      await manager.reloadAndSync();
      expect(selected(manager).contextWindow).toBe(234567);
    });

  it('keeps K3 safe defaults, explicit 1M, fixed variants, unknown IDs and model ordering', async () => {
    const models = ['k3', id, 'k3-256k', 'kimi-for-coding-highspeed', 'future-kimi-model'];
    const manager = await load({ models });
    const order = manager.providerRegistry.getChatModelIds(provider);
    expect(order).toEqual(models);
    expect(selected(manager, 'k3')).toMatchObject({ contextWindow: 262144, maxTokens: 16384 });
    expect(selected(manager, 'k3-256k').contextWindow).toBe(262144);
    for (const modelId of ['kimi-for-coding-highspeed', 'future-kimi-model']) {
      expect(selected(manager, modelId).contextWindow).toBe(128000);
    }
    manager.providerRegistry.saveProvider(provider, { models: [{ id: 'k3', context: 1048576 }] });
    await manager.reloadAndSync();
    expect(selected(manager, 'k3').contextWindow).toBe(1048576);
  });

  it('keeps models absent/default, empty/disabled and explicit/allowlist distinct through reload', async () => {
    const manager = await load({});
    expect(manager.providerRegistry.getChatModelSelection(provider).selectionMode).toBe('default');
    expect(selected(manager).contextWindow).toBe(1048576);
    manager.providerRegistry.saveProvider(provider, { models: [] });
    await manager.reloadAndSync();
    expect(manager.availableModels.filter(m => m.provider === provider)).toEqual([]);
    expect(manager.providerRegistry.getChatDiscoverableModelEntries(provider).length).toBeGreaterThan(0);
    manager.providerRegistry.saveProvider(provider, { models: ['k3', id] });
    await manager.reloadAndSync();
    expect(manager.providerRegistry.getChatModelIds(provider)).toEqual(['k3', id]);
    expect(manager.availableModels.filter(m => m.provider === provider).map(m => m.id).sort()).toEqual([id, 'k3'].sort());
  });

  it('serializes identical URL/API/model/output/thinking/headers for implicit 1M and explicit 256K', async () => {
    const manager = await load({ base_url: official, models: [id], headers: { 'x-context-fixture': 'unchanged' } });
    async function capture(model) {
      const requests = [];
      const stream = getModelRuntime(manager.modelRegistry).streamSimple(model, {
        messages: [{ role: 'user', content: 'synthetic request', timestamp: 1 }],
      }, {
        reasoning: 'high', maxRetries: 0,
        onPayload(payload) { return normalizeProviderPayload(payload, model, { mode: 'chat', reasoningLevel: 'high' }); },
        async fetch(input, init) {
          const request = new Request(input, init);
          requests.push({ url: request.url, body: JSON.parse(await request.text()), headers: Object.fromEntries(request.headers) });
          return new Response(JSON.stringify({ error: { message: 'Synthetic dispatch captured' } }),
            { status: 400, headers: { 'content-type': 'application/json' } });
        },
      });
      await stream.result();
      expect(requests).toHaveLength(1);
      return requests[0];
    }
    const implicit = selected(manager);
    expect(implicit.api).toBe('openai-completions');
    const first = await capture(implicit);
    manager.providerRegistry.saveProvider(provider, { models: [{ id, context: 262144 }] });
    await manager.reloadAndSync();
    expect(selected(manager).contextWindow).toBe(262144);
    expect(await capture(selected(manager))).toEqual(first);
    expect(first.url).toBe(`${official}/chat/completions`);
    expect(first.body).toMatchObject({ model: id, reasoning_effort: 'high', thinking: { type: 'enabled' } });
    expect(first.body.max_tokens ?? first.body.max_completion_tokens).toBe(32768);
    expect(first.body).not.toHaveProperty('context_window');
    expect(first.headers['user-agent']).toBeTruthy();
    expect(first.headers['x-context-fixture']).toBe('unchanged');
  });
  it('keeps Moonshot local output 131072, ordinary cap 65536, and explicit output overrides', async () => {
    const manager = await load({ models: [] });
    manager.providerRegistry.saveProvider('moonshot', { api_key: 'sk-k28-synthetic-fixture', models: ['kimi-k3'] });
    await manager.reloadAndSync();
    const model = manager.availableModels.find(m => m.provider === 'moonshot' && m.id === 'kimi-k3');
    expect(model).toMatchObject({ contextWindow: 1048576, maxTokens: 131072 });
    for (const explicit of [undefined, 4096, 100000]) {
      let raw, normalized;
      const stream = getModelRuntime(manager.modelRegistry).streamSimple(model, {
        messages: [{ role: 'user', content: 'Synthetic output check', timestamp: 1 }],
      }, {
        reasoning: 'high', ...(explicit === undefined ? {} : { maxTokens: explicit }),
        onPayload(payload) {
          raw = structuredClone(payload);
          normalized = normalizeProviderPayload(payload, model, { mode: 'chat', reasoningLevel: 'high',
            ...(explicit === undefined ? {} : { outputBudgetSource: 'user' }) });
          throw new Error('Captured before network');
        },
      });
      await stream.result();
      expect(raw.max_tokens ?? raw.max_completion_tokens).toBe(explicit ?? 131072);
      expect(normalized.max_tokens ?? normalized.max_completion_tokens).toBe(explicit ?? 65536);
    }
  });

});
