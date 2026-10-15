import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelManager } from '../core/model-manager.ts';
import { ProviderRegistry } from '../core/provider-registry.ts';
import { createProvidersRoute } from '../server/routes/providers.ts';
import { kimiDiscoveryCases, kimiExplicitBudgets } from './fixtures/kimi-context-cases.ts';

const provider = 'kimi-coding';
const id = 'kimi-for-coding';
const official = 'https://api.kimi.com/coding/v1';
const proxy = 'https://proxy.example/coding/v1';
let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hana-k28-discovery-'));
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('', { status: 404 }));
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(home, { recursive: true, force: true }); });

async function fixture(config: Record<string, unknown> = {}) {
  new ProviderRegistry(home).saveProvider(provider, { api_key: 'sk-k28-synthetic-fixture', ...config });
  fs.writeFileSync(path.join(home, 'auth.json'), '{}');
  const manager = new ModelManager({ hanakoHome: home });
  await manager.init();
  await manager.refreshAvailable();
  const engine = {
    hanakoHome: home,
    providerRegistry: manager.providerRegistry,
    getRegistryModelsForProvider: (name) => manager.getRegistryModelsForProvider(name),
    resolveProviderCredentials: (name) => manager.resolveProviderCredentials(name),
    resolveProviderCredentialsFresh: (name) => manager.resolveProviderCredentialsFresh(name),
  };
  const app = new Hono();
  app.route('/api', createProvidersRoute(engine));
  async function discover(base_url?: string, api?: string) {
    const result = await app.request('/api/providers/fetch-models', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: provider, base_url, api }) });
    expect(result.status).toBe(200);
    return result.json();
  }
  return { app, manager, engine, discover };
}

function context(result) { return result.models.find(m => m.id === id)?.context; }

describe('K2.8 discovery fallback context and source boundaries', () => {
  it.each(kimiDiscoveryCases)('projects the target configuration without mutating discovery state: $label', async c => {
    const { manager, engine, discover, app } = await fixture(c.source);
    if (c.forceDefaults) engine.getRegistryModelsForProvider = () => [];
    const savedBefore = structuredClone(manager.providerRegistry.getAllProvidersRaw());
    const availableBefore = structuredClone(manager.availableModels);
    const result = await discover(c.request.base_url, c.request.api);
    expect(result.source).toBe(c.forceDefaults ? 'builtin' : 'registry');
    expect(context(result)).toBe(c.expected);
    expect(context(await (await app.request(`/api/providers/${provider}/discovered-models`)).json())).toBe(c.expected);
    expect(manager.providerRegistry.getAllProvidersRaw()).toEqual(savedBefore);
    expect(manager.availableModels).toEqual(availableBefore);
    manager.providerRegistry.saveProvider(provider, { ...c.request, ...(c.add ? { models: [id] } : {}) });
    await manager.reloadAndSync();
    expect(manager.availableModels.find(m => m.id === id && m.provider === provider)?.contextWindow).toBe(c.expected);
  });

  it('uses the requested raw URL across official/proxy/official without enabling disabled models', async () => {
    const { manager, discover } = await fixture({ models: [] });
    for (const [url, expected] of [[official, 1048576], [proxy, 262144], ['https://api.kimi.ai/coding/v1', 1048576],
      ['https://api.kimi.com/coding?x=1', 262144], ['https://api.kimi.com', 262144]]) {
      expect(context(await discover(url as string, 'openai-completions'))).toBe(expected);
      expect(manager.availableModels.filter(m => m.provider === provider)).toEqual([]);
      expect(manager.providerRegistry.getAllProvidersRaw()[provider].models).toEqual([]);
    }
  });

  it.each(kimiExplicitBudgets)('preserves saved budgets %j in registry and defaults fallback', async budget => {
    const { engine, discover } = await fixture({ models: [{ id, ...budget }] });
    for (const url of [official, proxy]) expect(context(await discover(url))).toBe(budget.context ?? budget.contextWindow);
    engine.getRegistryModelsForProvider = () => [];
    expect(context(await discover(official))).toBe(budget.context ?? budget.contextWindow);
  });

  it.each(['https://api.kimi.ai/coding', 'https://proxy.example/coding'])(
    'preserves legacy Anthropic 1M and conflicting explicit alias precedence at %s', async base_url => {
      const { manager, discover } = await fixture({ base_url, api: 'anthropic-messages', models: [id] });
      expect(context(await discover())).toBe(1048576);
      manager.providerRegistry.saveProvider(provider, { models: [{ id, context: 123456, contextWindow: 234567 }] });
      await manager.reloadAndSync();
      expect(context(await discover())).toBe(234567);
    });

  it('synthesizes only K2.8 context in defaults fallback', async () => {
    const { engine, discover } = await fixture({ models: [] });
    engine.getRegistryModelsForProvider = () => [];
    // Include K3 explicitly to exercise the non-K2.8 default path; the current
    // built-in defaults list only contains kimi-for-coding.
    vi.spyOn(engine.providerRegistry, 'getDefaultModels').mockReturnValue([id, 'k3']);
    const result = await discover();
    expect(result.source).toBe('builtin');
    expect(context(result)).toBe(1048576);
    expect(result.models.find(m => m.id === 'k3').context).toBeNull();
    expect(result.models.find(m => m.id === id).maxOutput).toBeNull();
  });

  it('keeps remote numeric budgets and existing cached numbers unchanged', async () => {
    const { app, discover } = await fixture({ models: [] });
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response(JSON.stringify({ data: [
      { id, context_length: 123456, max_completion_tokens: 12000 },
    ] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const remote = await discover(official);
    expect(remote).not.toHaveProperty('source');
    expect(context(remote)).toBe(123456);
    const cached = await (await app.request(`/api/providers/${provider}/discovered-models`)).json();
    expect(context(cached)).toBe(123456);
    fs.writeFileSync(path.join(home, 'models-cache.json'), JSON.stringify({
      [provider]: { models: [{ id, context: 262144 }], fetchedAt: '2026-01-01T00:00:00Z' },
    }));
    expect(context(await (await app.request(`/api/providers/${provider}/discovered-models`)).json())).toBe(262144);
  });
});
