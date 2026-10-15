/** @vitest-environment jsdom */
import React from 'react';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ModelManager } from '../core/model-manager.ts';
import { ProviderRegistry } from '../core/provider-registry.ts';
import { createProvidersRoute } from '../server/routes/providers.ts';
import { createConfigRoute } from '../server/routes/config.ts';
import { HanaEngine } from '../core/engine.ts';
import { SessionCoordinator } from '../core/session-coordinator.ts';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, shouldCompact } from '../lib/pi-sdk/index.ts';
import { installDynamicCompactionReserve } from '../core/session-compaction-runtime.ts';

const mocks = vi.hoisted(() => ({ hanaFetch: vi.fn() }));
vi.mock('../desktop/src/react/settings/api', () => ({
  hanaFetch: (...args: unknown[]) => mocks.hanaFetch(...args),
}));
vi.mock('../desktop/src/react/hooks/use-config', () => ({ invalidateConfigCache: vi.fn() }));
vi.mock('../desktop/src/react/settings/helpers', async original => ({
  ...await original<typeof import('../desktop/src/react/settings/helpers')>(),
  t: (key: string) => key,
}));
import { ProviderModelList } from '../desktop/src/react/settings/tabs/providers/ProviderModelList';
import { ApiKeyCredentials } from '../desktop/src/react/settings/tabs/providers/ApiKeyCredentials';
import { API_FORMAT_OPTIONS, formatContext } from '../desktop/src/react/settings/helpers';
import { useSettingsStore, type ProviderSummary } from '../desktop/src/react/settings/store';

const C = 262144, W = 524288, E = 786432;
const cases = [
  { label: 'Zen Sonnet', provider: 'opencode', id: 'claude-sonnet-4-6', api: 'anthropic-messages', url: 'https://opencode.ai/zen', builtin: false },
  { label: 'Go ordinary GLM', provider: 'opencode-go', id: 'glm-5.3', api: 'openai-completions', url: 'https://opencode.ai/zen/go/v1', builtin: false },
  { label: 'Go builtin MiniMax', provider: 'opencode-go', id: 'minimax-m3', api: 'anthropic-messages', url: 'https://opencode.ai/zen/go', builtin: true },
  { label: 'Go builtin GLM', provider: 'opencode-go', id: 'glm-5.3', api: 'anthropic-messages', url: 'https://opencode.ai/zen/go/v1', builtin: true },
];
const shapes = ['context', 'contextWindow', 'conflict', 'bare'] as const;
type Shape = typeof shapes[number];
type Entry = string | { id: string; context?: number; contextWindow?: number; name?: string };
function entryFor(id: string, shape: Shape): Entry {
  return shape === 'bare' ? id : { id, ...(shape === 'context' ? { context: C }
    : shape === 'contextWindow' ? { contextWindow: W } : { context: C, contextWindow: W }) };
}
function budgetFields(entry: Entry) {
  return typeof entry === 'string' ? {} : Object.fromEntries(Object.entries(entry)
    .filter(([key]) => key === 'context' || key === 'contextWindow'));
}

let home: string;
const sessions: Array<{ dispose(): void }> = [];
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hana-opencode-context-'));
  vi.clearAllMocks();
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No live model calls in context tests'));
});
afterEach(() => {
  cleanup();
  for (const session of sessions.splice(0)) session.dispose();
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

async function fixture(c: typeof cases[number], models?: Entry[]) {
  new ProviderRegistry(home).saveProvider(c.provider, {
    api_key: 'synthetic-opencode-context-fixture', base_url: c.url, api: c.api,
    ...(models === undefined ? {} : { models }),
  });
  fs.writeFileSync(path.join(home, 'auth.json'), '{}');
  const manager = new ModelManager({ hanakoHome: home });
  await manager.init();
  await manager.refreshAvailable();
  expect(manager.modelRegistry.getError()).toBeUndefined();
  const engine = { hanakoHome: home, providerRegistry: manager.providerRegistry,
    get availableModels() { return manager.availableModels; },
    onProviderChanged: () => manager.reloadAndSync(), updateConfig: async () => {}, emitEvent: () => {} };
  const app = new Hono();
  app.route('/api', createProvidersRoute(engine));
  app.route('/api', createConfigRoute(engine));
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  mocks.hanaFetch.mockImplementation(async (url: string, options?: RequestInit) => {
    if (options?.method === 'PUT') requests.push({ url, body: JSON.parse(String(options.body)) });
    const response = await app.request(url, options);
    expect(response.status).toBe(200);
    return response;
  });
  async function summary(): Promise<ProviderSummary> {
    const before = JSON.stringify(manager.providerRegistry.getAllProvidersRaw());
    const response = await app.request('/api/providers/summary');
    expect(response.status).toBe(200);
    const result = (await response.json()).providers[c.provider];
    expect(JSON.stringify(manager.providerRegistry.getAllProvidersRaw())).toBe(before);
    expect(result.models).toEqual(manager.providerRegistry.getChatModelEntries(c.provider));
    useSettingsStore.setState({ providersSummary: { [c.provider]: result }, settingsConfig: {}, showToast: () => {} });
    return result;
  }
  const selected = () => manager.availableModels.find(m => m.provider === c.provider && m.id === c.id);
  const saved = () => manager.providerRegistry.getAllProvidersRaw()[c.provider].models[0] as Entry;
  const onRefresh = vi.fn(async () => {});
  async function show() {
    return render(<ProviderModelList providerId={c.provider} summary={await summary()} onRefresh={onRefresh} />);
  }
  return { manager, app, engine, requests, summary, selected, saved, show, onRefresh };
}

function openEditor(expected: number) {
  expect(Array.from(document.querySelectorAll('[class*="pv-model-ctx"]')).map(e => e.textContent))
    .toContain(formatContext(expected));
  fireEvent.click(screen.getByRole('button', { name: 'settings.api.editModel' }));
  expect((screen.getAllByRole('spinbutton')[0] as HTMLInputElement).value).toBe(String(expected));
}
function editContext(value: number) {
  fireEvent.change(screen.getAllByRole('spinbutton')[0], { target: { value: String(value) } });
}
function save() { fireEvent.click(screen.getByRole('button', { name: 'settings.api.save' })); }
async function switchApi(c: typeof cases[number], f: Awaited<ReturnType<typeof fixture>>, nextApi: string) {
  const summary = await f.summary();
  const view = render(<ApiKeyCredentials providerId={c.provider} summary={summary} onRefresh={f.onRefresh} />);
  fireEvent.click(screen.getByRole('button', { name: API_FORMAT_OPTIONS.find(o => o.value === summary.api)!.label }));
  fireEvent.click(screen.getByRole('option', { name: API_FORMAT_OPTIONS.find(o => o.value === nextApi)!.label }));
  await waitFor(() => expect(f.onRefresh).toHaveBeenCalled());
  view.unmount();
}

const matrix = cases.flatMap(c => shapes.flatMap(shape => ['edit', 'noop', 'rename', 'api-only'].map(action => ({ c, shape, action }))));
it.each(matrix)('$c.label / $shape / $action preserves user intent through real UI, routes and Pi', async ({ c, shape, action }) => {
  const input = entryFor(c.id, shape);
  const f = await fixture(c, [input]);
  const before = shape === 'bare' ? 1000000 : shape === 'context' ? C : shape === 'contextWindow' || c.builtin ? W : C;
  expect(f.selected().contextWindow).toBe(before);
  const initial = await f.summary();
  expect(initial.model_context_windows?.[c.id]).toBe(before);
  let view = await f.show();
  openEditor(before);
  if (action === 'api-only') {
    fireEvent.click(screen.getByRole('button', { name: 'settings.api.cancel' }));
    view.unmount();
    await switchApi(c, f, c.api === 'anthropic-messages' ? 'openai-completions' : 'anthropic-messages');
    expect(f.saved()).toEqual(input);
  } else {
    if (action === 'edit') editContext(E);
    if (action === 'rename') fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Renamed model' } });
    save();
    await waitFor(() => expect(f.onRefresh).toHaveBeenCalledTimes(1));
    const body = f.requests[0].body;
    if (action === 'edit') {
      expect(body.context).toBe(E);
      expect(f.selected().contextWindow).toBe(E);
      if (c.provider === 'opencode-go') expect(f.saved()).not.toHaveProperty('contextWindow');
    } else {
      expect(body).not.toHaveProperty('context');
      expect(body).not.toHaveProperty('contextWindow');
      expect(budgetFields(f.saved())).toEqual(budgetFields(input));
      expect(f.selected().contextWindow).toBe(before);
    }
    view.unmount();
  }
  view = await f.show();
  openEditor(f.selected().contextWindow);
  const cold = new ModelManager({ hanakoHome: home });
  await cold.init();
  await cold.refreshAvailable();
  expect(cold.availableModels.find(m => m.provider === c.provider && m.id === c.id)?.contextWindow)
    .toBe(f.selected().contextWindow);
  view.unmount();
});

it.each(['noop', 'rename', 'edit-to-reference'])('keeps a manually added bare Sonnet at 1M until explicitly edited: %s', async action => {
  const c = cases[0];
  const f = await fixture(c, []);
  let view = await f.show();
  fireEvent.click(screen.getByRole('button', { name: 'settings.api.addModel' }));
  const input = screen.getByPlaceholderText('settings.oauth.customModelPlaceholder');
  fireEvent.change(input, { target: { value: c.id } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(f.onRefresh).toHaveBeenCalledTimes(1));
  expect(f.saved()).toBe(c.id);
  expect(f.selected().contextWindow).toBe(1000000);
  view.unmount();
  view = await f.show();
  openEditor(1000000);
  if (action === 'rename') fireEvent.change(screen.getByRole('textbox'), { target: { value: 'My Sonnet' } });
  if (action === 'edit-to-reference') editContext(200000);
  save();
  await waitFor(() => expect(f.onRefresh).toHaveBeenCalledTimes(2));
  expect(budgetFields(f.saved())).toEqual(action === 'edit-to-reference' ? { context: 200000 } : {});
  expect(f.selected().contextWindow).toBe(action === 'edit-to-reference' ? 200000 : 1000000);
  view.unmount();
});

it.each(['contextWindow', 'conflict'] as const)('does not revive an old alias after ordinary edit then builtin switch: %s', async shape => {
  const c = cases[1];
  const f = await fixture(c, [entryFor(c.id, shape)]);
  const view = await f.show();
  openEditor(shape === 'conflict' ? C : W);
  editContext(E);
  save();
  await waitFor(() => expect(f.onRefresh).toHaveBeenCalledTimes(1));
  view.unmount();
  expect(f.saved()).not.toHaveProperty('contextWindow');
  f.onRefresh.mockClear();
  await switchApi(c, f, 'anthropic-messages');
  expect(f.selected().contextWindow).toBe(E);
  expect(JSON.parse(fs.readFileSync(f.manager.modelsJsonPath, 'utf8')).providers[c.provider]
    .modelOverrides[c.id].contextWindow).toBe(E);
});

it.each(cases)('$label keeps direct W normalization and dual-field C write precedence', async c => {
  const original = { id: c.id, context: C, contextWindow: W };
  const f = await fixture(c, [original]);
  for (const [body, expected] of [[{ contextWindow: E }, E], [{ context: C, contextWindow: E }, C]] as const) {
    f.manager.providerRegistry.saveProvider(c.provider, { models: [original] });
    await f.manager.reloadAndSync();
    const response = await f.app.request(`/api/providers/${c.provider}/models/${c.id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    expect(f.saved()).toMatchObject({ context: expected });
    expect(f.selected().contextWindow).toBe(expected);
  }
});

it.each(cases.flatMap(c => [undefined, [], [c.id]].map(models => ({ c, models }))))(
  '$c.label preserves omitted/empty/allowlist models: $models', async ({ c, models }) => {
    const f = await fixture(c, models);
    const rawBefore = JSON.stringify(f.manager.providerRegistry.getAllProvidersRaw()[c.provider]);
    const summary = await f.summary();
    expect(Object.keys(summary.model_context_windows || {}).sort()).toEqual(f.manager.availableModels
      .filter(m => m.provider === c.provider).map(m => m.id).sort());
    expect(JSON.stringify(f.manager.providerRegistry.getAllProvidersRaw()[c.provider])).toBe(rawBefore);
    if (models?.length === 0) expect(summary.model_context_windows).toEqual({});
    if (models === undefined) expect(f.manager.providerRegistry.getAllProvidersRaw()[c.provider]).not.toHaveProperty('models');
  },
);

async function restoreSession(manager: ModelManager, file: string) {
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
    retry: { enabled: false }, cacheWarming: 'off' });
  const resourceLoader = new DefaultResourceLoader({ cwd: home, agentDir: home, settingsManager,
    systemPrompt: 'Synthetic OpenCode context test', noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd: home, agentDir: home, modelRegistry: manager.modelRegistry,
    sessionManager: SessionManager.open(file, home), settingsManager, resourceLoader, tools: [] });
  sessions.push(session);
  installDynamicCompactionReserve(session);
  return session;
}

function expectSessionBudget(session: Awaited<ReturnType<typeof restoreSession>>, window: number, threshold: number) {
  expect(session.model.contextWindow).toBe(window);
  expect(session.getContextUsage()).toMatchObject({ tokens: 600000, contextWindow: window });
  const settings = session.settingsManager.getCompactionSettings();
  expect(window - settings.reserveTokens).toBe(threshold);
  for (const delta of [-1, 0, 1]) expect(shouldCompact(threshold + delta, window, settings)).toBe(delta > 0);
  expect(shouldCompact(600000, window, settings)).toBe(600000 > threshold);
}

const sessionCases = [
  ...cases.slice(2).flatMap(c => (['contextWindow', 'conflict'] as const)
    .map(shape => ({ c, shape, action: 'edit', value: E, threshold: 707788 }))),
  ...['noop', 'rename', 'edit'].map(action => ({ c: cases[0], shape: 'bare' as const, action,
    value: action === 'edit' ? 200000 : 1000000, threshold: action === 'edit' ? 180000 : 900000 })),
];
it.each(sessionCases)('$c.label / $shape / $action carries the actual UI request into hot and cold 600K JSONL sessions', async ({ c, shape, action, value, threshold }) => {
  const f = await fixture(c, [entryFor(c.id, shape)]);
  const timestamp = '2026-10-01T00:00:00.000Z';
  const file = path.join(home, 'history.jsonl');
  const history = [
    { type: 'session', version: 3, id: 'opencode-context-history', timestamp, cwd: home },
    { type: 'model_change', id: 'model001', parentId: null, timestamp, provider: c.provider, modelId: c.id },
    { type: 'message', id: 'user0001', parentId: 'model001', timestamp,
      message: { role: 'user', content: [{ type: 'text', text: 'Retain my history' }], timestamp: 1 } },
    { type: 'message', id: 'assist01', parentId: 'user0001', timestamp,
      message: { role: 'assistant', content: [{ type: 'text', text: 'Prior answer' }], api: c.api,
        provider: c.provider, model: c.id, stopReason: 'stop', timestamp: 2,
        usage: { input: 599000, output: 1000, cacheRead: 0, cacheWrite: 0, totalTokens: 600000,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } },
  ].map(entry => JSON.stringify(entry)).join('\n') + '\n';
  fs.writeFileSync(file, history);
  const session = await restoreSession(f.manager, file);
  // SDK bootstrap may append a thinking-level entry; budget edits must preserve
  // this restored file as well as every original history entry.
  const persisted = fs.readFileSync(file, 'utf8');
  expect(persisted.startsWith(history.trimEnd())).toBe(true);
  const before = shape === 'bare' ? 1000000 : W;
  expectSessionBudget(session, before, shape === 'bare' ? 900000 : 471859);
  const coordinator = new SessionCoordinator({ agentsDir: path.join(home, 'agents'),
    getModels: () => f.manager, emitEvent: () => {}, memoryPressure: { enabled: false } });
  coordinator.sessions.set(file, { session, sessionPath: file, agentId: 'synthetic-owner', sessionId: 'opencode-context-history' });
  const hotEngine = { _models: f.manager, _sessionCoord: coordinator,
    _configCoord: { normalizeUtilityApiPreferences: () => {} } };
  f.engine.onProviderChanged = () => HanaEngine.prototype.onProviderChanged.call(hotEngine);
  const view = await f.show();
  openEditor(before);
  if (action === 'edit') editContext(value);
  if (action === 'rename') fireEvent.change(screen.getByRole('textbox'), { target: { value: 'My Sonnet' } });
  save();
  await waitFor(() => expect(f.onRefresh).toHaveBeenCalledTimes(1));
  expectSessionBudget(session, value, threshold);
  expect(fs.readFileSync(file, 'utf8')).toBe(persisted);
  const coldManager = new ModelManager({ hanakoHome: home });
  await coldManager.init();
  await coldManager.refreshAvailable();
  expectSessionBudget(await restoreSession(coldManager, file), value, threshold);
  expect(fs.readFileSync(file, 'utf8')).toBe(persisted);
  view.unmount();
});
