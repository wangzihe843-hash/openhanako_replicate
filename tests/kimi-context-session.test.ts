import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelManager } from '../core/model-manager.ts';
import { ProviderRegistry } from '../core/provider-registry.ts';
import { SessionCoordinator } from '../core/session-coordinator.ts';
import { HanaEngine } from '../core/engine.ts';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, shouldCompact } from '../lib/pi-sdk/index.ts';
import { installDynamicCompactionReserve } from '../core/session-compaction-runtime.ts';
import type { KimiModelEntry } from './fixtures/kimi-context-cases.ts';

const provider = 'kimi-coding';
const id = 'kimi-for-coding';
let home: string;
const sessions: Array<{ dispose(): void }> = [];
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hana-k28-session-'));
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Session context tests must not call providers'));
});
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

async function fixture(base_url: string, entry: KimiModelEntry = id) {
  new ProviderRegistry(home).saveProvider(provider, { base_url, api: 'openai-completions',
    api_key: 'sk-k28-synthetic-fixture', models: [entry] });
  fs.writeFileSync(path.join(home, 'auth.json'), '{}');
  const manager = new ModelManager({ hanakoHome: home });
  await manager.init();
  await manager.refreshAvailable();
  const file = path.join(home, 'history.jsonl');
  const timestamp = '2026-10-01T00:00:00.000Z';
  const entries = [
    { type: 'session', version: 3, id: 'k28-history', timestamp, cwd: home },
    { type: 'model_change', id: 'model001', parentId: null, timestamp, provider, modelId: id },
    { type: 'message', id: 'user0001', parentId: 'model001', timestamp,
      message: { role: 'user', content: [{ type: 'text', text: 'Retain my history' }], timestamp: 1 } },
    { type: 'message', id: 'assist01', parentId: 'user0001', timestamp,
      message: { role: 'assistant', content: [{ type: 'text', text: 'Prior answer' }],
        api: 'openai-completions', provider, model: id, stopReason: 'stop', timestamp: 2,
        usage: { input: 299000, output: 1000, cacheRead: 0, cacheWrite: 0, totalTokens: 300000,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } },
  ];
  fs.writeFileSync(file, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  const sessionManager = SessionManager.open(file, home);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
    retry: { enabled: false }, cacheWarming: 'off' });
  const resourceLoader = new DefaultResourceLoader({ cwd: home, agentDir: home, settingsManager,
    systemPrompt: 'Synthetic context test', noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd: home, agentDir: home, modelRegistry: manager.modelRegistry,
    sessionManager, settingsManager, resourceLoader, tools: [] });
  sessions.push(session);
  installDynamicCompactionReserve(session);
  const coordinator = new SessionCoordinator({ agentsDir: path.join(home, 'agents'),
    getModels: () => manager, emitEvent: vi.fn(), memoryPressure: { enabled: false } });
  // Seed a cached owner with a real restored SDK session. The refresh itself
  // follows Engine.onProviderChanged -> coordinator -> real adapter binding.
  coordinator.sessions.set(file, { session, sessionPath: file, agentId: 'synthetic-owner', sessionId: 'k28-history' });
  const engine = { _models: manager, _sessionCoord: coordinator,
    _configCoord: { normalizeUtilityApiPreferences: vi.fn() } };
  return { manager, session, file, refresh: () => HanaEngine.prototype.onProviderChanged.call(engine) };
}

function expectWindow(session, contextWindow: number, threshold: number) {
  expect(session.model).toMatchObject({ provider, id, contextWindow });
  expect(session.getContextUsage()).toMatchObject({ tokens: 300000, contextWindow });
  const settings = session.settingsManager.getCompactionSettings();
  expect(contextWindow - settings.reserveTokens).toBe(threshold);
  for (const delta of [-1, 0, 1]) expect(shouldCompact(threshold + delta, contextWindow, settings)).toBe(delta > 0);
  expect(shouldCompact(300000, contextWindow, settings)).toBe(contextWindow === 262144);
}

describe('K2.8 real JSONL cold restore and public hot refresh', () => {
  it.each(['https://api.kimi.com/coding/v1', 'https://api.kimi.ai/coding/v1'])(
    'restores 300K usage against the current official default at %s', async baseUrl => {
      const { session } = await fixture(baseUrl);
      expect(session.sessionManager.getSessionId()).toBe('k28-history');
      expect(session.sessionManager.getEntry('assist01')).toMatchObject({ message: { usage: { totalTokens: 300000 } } });
      expectWindow(session, 1048576, 943718);
    });

  it('refreshes proxy -> official -> proxy -> official with live usage and threshold changes', async () => {
    const { manager, session, file, refresh } = await fixture('https://proxy.example/coding/v1');
    expectWindow(session, 262144, 235929);
    const persisted = fs.readFileSync(file, 'utf8');
    for (const [url, window, threshold] of [['https://api.kimi.com/coding/v1', 1048576, 943718],
      ['https://proxy.example/coding/v1', 262144, 235929], ['https://api.kimi.ai/coding/v1', 1048576, 943718]]) {
      manager.providerRegistry.saveProvider(provider, { base_url: url });
      await refresh();
      expectWindow(session, window as number, threshold as number);
      expect(fs.readFileSync(file, 'utf8')).toBe(persisted);
    }
  });

  it.each([{ context: 262144 }, { contextWindow: 262144 }])('retains explicit 256K on cold restore: %j', async budget => {
    const { session } = await fixture('https://api.kimi.com/coding/v1', { id, ...budget });
    expectWindow(session, 262144, 235929);
  });
});
