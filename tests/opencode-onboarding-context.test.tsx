/** @vitest-environment jsdom */
/// <reference types="../desktop/src/react/onboarding/onboarding-env.d.ts" />
import React from 'react';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ModelManager } from '../core/model-manager.ts';
import { createAgentsRoute } from '../server/routes/agents.ts';
import { createProvidersRoute } from '../server/routes/providers.ts';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, shouldCompact } from '../lib/pi-sdk/index.ts';
import { installDynamicCompactionReserve } from '../core/session-compaction-runtime.ts';
import { ModelStep } from '../desktop/src/react/onboarding/steps/ModelStep';
import { ProviderStep } from '../desktop/src/react/onboarding/steps/ProviderStep';
import type { AddedModelEntry, DiscoveredModel, OnboardingVerificationPlan } from '../desktop/src/react/onboarding/onboarding-actions';

const zen = { provider: 'opencode', id: 'claude-sonnet-4-6', api: 'anthropic-messages', url: 'https://opencode.ai/zen', implicit: 1000000 };
type Provider = typeof zen;
type ProviderPatch = { api?: string; models?: AddedModelEntry[] };
let home: string;
const sessions: Array<{ dispose(): void }> = [];
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hana-opencode-onboarding-'));
  vi.stubGlobal('t', (key: string) => key);
  vi.stubGlobal('i18n', { locale: 'en' });
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No live calls in onboarding budget tests'));
});
afterEach(() => {
  cleanup();
  for (const session of sessions.splice(0)) session.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  fs.rmSync(home, { recursive: true, force: true });
});

async function fixture(c: Provider, discovered?: DiscoveredModel[], seedProvider = true, remoteContext?: number) {
  const agentId = 'budget-fixture';
  const agentsDir = path.join(home, 'agents');
  fs.mkdirSync(path.join(agentsDir, agentId), { recursive: true });
  fs.writeFileSync(path.join(agentsDir, agentId, 'config.yaml'), '{}\n');
  fs.writeFileSync(path.join(home, 'auth.json'), '{}');
  const manager = new ModelManager({ hanakoHome: home });
  await manager.init();
  if (seedProvider) {
    manager.providerRegistry.saveProvider(c.provider, {
      api_key: 'synthetic-onboarding-budget', base_url: c.url, api: c.api, models: [],
    });
    await manager.reloadAndSync();
  }
  const engine = { hanakoHome: home, agentsDir, productDir: home, currentAgentId: agentId,
    providerRegistry: manager.providerRegistry, onProviderChanged: () => manager.reloadAndSync(),
    updateConfig: async () => {}, emitEvent: () => {}, invalidateAgentListCache: () => {},
    getRegistryModelsForProvider: (name: string) => manager.getRegistryModelsForProvider(name) };
  const app = new Hono();
  app.route('/api', createAgentsRoute(engine));
  app.route('/api', createProvidersRoute(engine));
  const requests: Array<{ url: string; body: { providers?: Record<string, ProviderPatch> } }> = [];
  const discovery: DiscoveredModel[][] = [];
  const api = vi.fn(async (url: string, options?: RequestInit) => {
    // Connectivity and preferences are unrelated to context persistence. The
    // agent config (including provider credentials/models) always uses real routes.
    if (url === '/api/providers/test' || url === '/api/preferences/models') return Response.json({ ok: true });
    if (url === '/api/providers/fetch-models') {
      if (discovered) { discovery.push(discovered); return Response.json({ models: discovered }); }
      // Exercise server normalization or registry fallback with offline responses.
      vi.mocked(globalThis.fetch).mockResolvedValueOnce(remoteContext === undefined
        ? new Response('{}', { status: 404 })
        : Response.json({ data: [{ id: c.id, max_input_tokens: remoteContext }] }));
    }
    if (options?.method === 'PUT') requests.push({ url, body: JSON.parse(String(options.body)) });
    const response = await app.request(url, options);
    expect(response.status, await response.clone().text()).toBe(200);
    if (url === '/api/providers/fetch-models') discovery.push((await response.clone().json()).models);
    return response;
  });
  const verificationPlan: OnboardingVerificationPlan = { agentConfig: {}, preferenceModels: {}, requiredAgentSecretPaths: [] };
  const props = { preview: false, hanaFetch: api, agentId, verificationPlan,
    providerName: c.provider, providerUrl: c.url, providerApi: c.api,
    apiKey: 'synthetic-onboarding-budget', goToStep: vi.fn(), showError: vi.fn() };
  const saved = () => manager.providerRegistry.getAllProvidersRaw()[c.provider].models[0] as AddedModelEntry;
  const selected = () => manager.availableModels.find(m => m.provider === c.provider && m.id === c.id);
  return { app, manager, props, requests, discovery, saved, selected };
}

async function addModel(id: string, manual: boolean) {
  fireEvent.click(screen.getByRole('button', { name: 'onboarding.model.addModel' }));
  if (manual) {
    fireEvent.change(screen.getByPlaceholderText('onboarding.model.manualModelPlaceholder'), { target: { value: id } });
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.model.addManualModel' }));
  } else fireEvent.click(await screen.findByRole('button', { name: id }));
}
function openEditor() {
  fireEvent.click(screen.getByTitle('onboarding.model.editModel'));
  return screen.getByLabelText('onboarding.model.contextLength') as HTMLInputElement;
}
function setContext(value: number | string) {
  fireEvent.change(screen.getByLabelText('onboarding.model.contextLength'), { target: { value: String(value) } });
}
function saveEditor() { fireEvent.click(screen.getByRole('button', { name: 'onboarding.model.saveEdit' })); }
async function finish(f: Awaited<ReturnType<typeof fixture>>, c: Provider, context?: number) {
  for (const trigger of document.querySelectorAll('.ob-select-widget button[aria-haspopup="listbox"]')) {
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('option'));
  }
  fireEvent.click(screen.getByRole('button', { name: 'onboarding.model.next' }));
  await waitFor(() => expect(f.props.goToStep).toHaveBeenCalledWith(4));
  expect(f.props.showError).not.toHaveBeenCalled();
  const request = f.requests.find(r => r.body.providers?.[c.provider]?.models);
  expect(request?.url).toBe(`/api/agents/${f.props.agentId}/config`);
  expect(request.body.providers[c.provider].models).toEqual([f.saved()]);
  const entry = f.saved();
  expect(typeof entry === 'string' ? undefined : entry.context).toBe(context);
  expect(entry).not.toHaveProperty('contextWindow');
  expect(f.selected()?.contextWindow).toBe(context ?? c.implicit);
  expect(f.manager.modelRegistry.getError()).toBeUndefined();
  return entry;
}

async function verifyColdSession(c: Provider, context: number) {
  const manager = new ModelManager({ hanakoHome: home });
  await manager.init();
  await manager.refreshAvailable();
  const timestamp = '2026-10-01T00:00:00.000Z';
  const file = path.join(home, 'history.jsonl');
  const history = [
    { type: 'session', version: 3, id: 'onboarding-budget-history', timestamp, cwd: home },
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
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
    retry: { enabled: false }, cacheWarming: 'off' });
  const resourceLoader = new DefaultResourceLoader({ cwd: home, agentDir: home, settingsManager,
    systemPrompt: 'Synthetic onboarding budget test', noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd: home, agentDir: home, modelRegistry: manager.modelRegistry,
    sessionManager: SessionManager.open(file, home), settingsManager, resourceLoader, tools: [] });
  sessions.push(session);
  installDynamicCompactionReserve(session);
  expect(session.model.contextWindow).toBe(context);
  expect(session.getContextUsage()).toMatchObject({ tokens: 600000, contextWindow: context });
  const settings = session.settingsManager.getCompactionSettings();
  const threshold = context - Math.ceil(context * 0.1);
  expect(context - settings.reserveTokens).toBe(threshold);
  for (const delta of [-1, 0, 1]) expect(shouldCompact(threshold + delta, context, settings)).toBe(delta > 0);
  expect(shouldCompact(600000, context, settings)).toBe(600000 > threshold);
  // First restore may append a thinking-level entry, but every original history
  // entry and its usage remain byte-for-byte intact.
  expect(fs.readFileSync(file, 'utf8').startsWith(history.trimEnd())).toBe(true);
}

it('saves an explicit reference budget from the actual Custom provider onboarding entry into cold Pi', async () => {
  const f = await fixture(zen, undefined, false);
  const onProviderReady = vi.fn();
  const providerView = render(<ProviderStep {...f.props} onProviderReady={onProviderReady} />);
  fireEvent.click(screen.getByRole('button', { name: 'onboarding.provider.selectPlaceholder' }));
  fireEvent.click(screen.getByRole('button', { name: 'onboarding.provider.custom' }));
  fireEvent.change(screen.getByPlaceholderText('onboarding.provider.customNamePlaceholder'), { target: { value: zen.provider } });
  fireEvent.change(screen.getByPlaceholderText('onboarding.provider.customUrlPlaceholder'), { target: { value: zen.url } });
  fireEvent.click(screen.getByRole('button', { name: 'OpenAI Compatible' }));
  fireEvent.click(screen.getByRole('option', { name: 'Anthropic Messages' }));
  fireEvent.change(screen.getByPlaceholderText('onboarding.provider.keyPlaceholder'), { target: { value: f.props.apiKey } });
  fireEvent.click(screen.getByRole('button', { name: 'onboarding.provider.test' }));
  await waitFor(() => expect((screen.getByRole('button', { name: 'onboarding.provider.next' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'onboarding.provider.next' }));
  await waitFor(() => expect(onProviderReady).toHaveBeenCalledWith(zen.provider, zen.url, zen.api, f.props.apiKey));
  providerView.unmount();
  render(<ModelStep {...f.props} />);
  await waitFor(() => expect(f.discovery).toHaveLength(1));
  expect(f.discovery[0].find(m => m.id === zen.id)?.context).toBe(1000000);
  await addModel(zen.id, true);
  expect(openEditor().value).toBe('200000');
  setContext(888888);
  setContext(200000);
  saveEditor();
  expect(await finish(f, zen, 200000)).toEqual({ id: zen.id, context: 200000 });
  await verifyColdSession(zen, 200000);
  expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  expect(vi.mocked(globalThis.fetch).mock.calls[0][0]).toBe('https://opencode.ai/zen/v1/models?limit=1000');
});

const shapes = [
  { label: 'manual bare', manual: true, metadata: { context: 1000000 }, context: undefined },
  { label: 'discovered bare', manual: false, metadata: {}, context: undefined },
  { label: 'discovered 200K', manual: false, metadata: { context: 200000 }, context: 200000 },
  { label: 'discovered 1M', manual: false, metadata: { context: 1000000 }, context: 1000000 },
  { label: 'discovered alias', manual: false, metadata: { contextWindow: 200000 }, context: 200000 },
  { label: 'discovered conflict', manual: false, metadata: { context: 200000, contextWindow: 1000000 }, context: 200000 },
];
const actions = ['untouched', 'noop', 'rename', 'edit-reference', 'edit-million', 'api-only'] as const;
const matrix = shapes.flatMap(shape => actions.map(action => ({ shape, action })));
it.each(matrix)('Zen $shape.label / $action preserves intent through request, save and cold 600K JSONL', async ({ shape, action }) => {
  const f = await fixture(zen, [{ id: zen.id, ...shape.metadata }]);
  const view = render(<ModelStep {...f.props} />);
  await waitFor(() => expect(f.discovery).toHaveLength(1));
  await addModel(zen.id, shape.manual);
  let context = shape.context;
  if (action === 'api-only') {
    // ModelStep receives API changes from the preceding ProviderStep; persist
    // that same API-only patch through the real per-agent route first.
    await f.props.hanaFetch(`/api/agents/${f.props.agentId}/config`, { method: 'PUT',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ providers: { opencode: { api: 'openai-completions' } } }) });
    view.rerender(<ModelStep {...f.props} providerApi="openai-completions" />);
    expect(f.discovery).toHaveLength(1);
  } else if (action !== 'untouched') {
    expect(openEditor().value).toBe(String(shape.context ?? 200000));
    if (action === 'rename') fireEvent.change(screen.getByLabelText('onboarding.model.displayName'), { target: { value: 'My Sonnet' } });
    if (action.startsWith('edit-')) {
      context = action === 'edit-reference' ? 200000 : 1000000;
      setContext(888888);
      setContext(context);
    }
    saveEditor();
    expect(openEditor().value).toBe(String(context ?? 200000));
    saveEditor(); // a subsequent noop must retain explicit intent too
  }
  const entry = await finish(f, zen, context);
  if (context === undefined && action !== 'rename') expect(entry).toBe(zen.id);
  await verifyColdSession(zen, context ?? zen.implicit);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it.each([[200000, 1000000], [1000000, 200000]])('retains sequential explicit edits %s -> %s across editor reopen', async (first, second) => {
  const f = await fixture(zen, [{ id: zen.id }]);
  render(<ModelStep {...f.props} />);
  await waitFor(() => expect(f.discovery).toHaveLength(1));
  await addModel(zen.id, true);
  for (const value of [first, second]) { openEditor(); setContext(888888); setContext(value); saveEditor(); }
  expect(await finish(f, zen, second)).toEqual({ id: zen.id, context: second });
  await verifyColdSession(zen, second);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it.each([200000, 1000000].flatMap(context => ['noop', 'rename', 'edit-reference', 'edit-million'].map(action => ({ context, action }))))(
  'retains actual server discovery context $context / $action through the onboarding save', async ({ context, action }) => {
    const f = await fixture(zen, undefined, true, context);
    render(<ModelStep {...f.props} />);
    await waitFor(() => expect(f.discovery).toHaveLength(1));
    expect(f.discovery[0].find(m => m.id === zen.id)?.context).toBe(context);
    await addModel(zen.id, false);
    expect(openEditor().value).toBe(String(context));
    if (action === 'rename') fireEvent.change(screen.getByLabelText('onboarding.model.displayName'), { target: { value: 'Discovered Sonnet' } });
    const expected = action === 'edit-reference' ? 200000 : action === 'edit-million' ? 1000000 : context;
    if (action.startsWith('edit-')) { setContext(888888); setContext(expected); }
    saveEditor();
    await finish(f, zen, expected);
    await verifyColdSession(zen, expected);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(globalThis.fetch).mock.calls[0][0]).toBe('https://opencode.ai/zen/v1/models?limit=1000');
  },
);

it.each(['0', '-1', '1.5', 'invalid', 'Infinity'])('rejects invalid context %s without saving or losing the draft', async value => {
  const f = await fixture(zen, [{ id: zen.id, context: 200000 }]);
  render(<ModelStep {...f.props} />);
  await addModel(zen.id, false);
  openEditor(); setContext(value); saveEditor();
  expect(f.props.showError).toHaveBeenCalledWith('onboarding.model.invalidNumber');
  expect(f.requests).toEqual([]);
  fireEvent.click(screen.getByRole('button', { name: 'onboarding.model.cancelEdit' }));
  f.props.showError.mockClear();
  expect(await finish(f, zen, 200000)).toEqual({ id: zen.id, context: 200000 });
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it.each(['cancel', 'clear'])('keeps existing cancel/clear semantics for explicit Zen budgets: %s', async action => {
  const f = await fixture(zen, [{ id: zen.id, context: 200000 }]);
  render(<ModelStep {...f.props} />);
  await addModel(zen.id, false);
  openEditor(); setContext(action === 'clear' ? '' : 888888);
  if (action === 'cancel') fireEvent.click(screen.getByRole('button', { name: 'onboarding.model.cancelEdit' }));
  else saveEditor();
  await finish(f, zen, action === 'clear' ? undefined : 200000);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

const controls = [
  { ...zen, provider: 'anthropic', url: 'https://api.anthropic.com', implicit: 200000, reference: 200000 },
  { provider: 'openai', id: 'gpt-5.4', api: 'openai-completions', url: 'https://api.openai.com/v1', implicit: 272000, reference: 272000 },
  { provider: 'opencode-go', id: 'glm-5.3', api: 'anthropic-messages', url: 'https://opencode.ai/zen/go/v1', implicit: 1000000, reference: 1000000 },
  { provider: 'kimi-coding', id: 'kimi-for-coding', api: 'anthropic-messages', url: 'https://proxy.example/coding/v1', implicit: 1048576, reference: 1048576 },
];
it.each(controls.flatMap(c => ['noop', 'rename', 'edit-reference', 'edit-other'].map(action => ({ c, action }))))(
  '$c.provider / $action retains the existing non-Zen onboarding behavior', async ({ c, action }) => {
    const f = await fixture(c, [{ id: c.id }]);
    render(<ModelStep {...f.props} />);
    await waitFor(() => expect(f.discovery).toHaveLength(1));
    await addModel(c.id, true);
    expect(openEditor().value).toBe(String(c.reference));
    if (action === 'rename') fireEvent.change(screen.getByLabelText('onboarding.model.displayName'), { target: { value: 'Control model' } });
    if (action.startsWith('edit-')) { setContext(888888); setContext(action === 'edit-reference' ? c.reference : 786432); }
    saveEditor();
    const explicit = action === 'edit-other' ? 786432 : action === 'edit-reference' && c.provider === 'kimi-coding' ? c.reference : undefined;
    await finish(f, c, explicit);
    await verifyColdSession(c, explicit ?? c.implicit);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  },
);
