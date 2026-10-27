import { Hono } from 'hono';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'js-yaml';
import { afterEach, expect, it, vi } from 'vitest';
import { createAgentsRoute } from '../server/routes/agents.ts';
import { MASKED_SECRET } from '../shared/secret-custody.ts';

const dirs: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture(scopes = ['settings.write'], baseUrl?: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'u16-settings-')); dirs.push(home);
  const agentsDir = path.join(home, 'agents'); const directory = path.join(agentsDir, 'a'); fs.mkdirSync(directory, { recursive: true });
  const configPath = path.join(directory, 'config.yaml');
  fs.writeFileSync(configPath, YAML.dump({ bridge: { wechat: { botToken: 'SYN_SAVED_TOKEN', enabled: false, ...(baseUrl ? { baseUrl } : {}) } } }));
  const engine = { agentsDir, productDir: process.cwd(), getAgent: id => id === 'a' ? { id: 'a', config: {} } : null,
    updateConfig: vi.fn(), invalidateAgentListCache: vi.fn(), emitEvent: vi.fn(), setLocale: vi.fn(),
  };
  const app = new Hono<{ Variables: { authPrincipal: unknown } }>();
  app.use('*', async (c, next) => { c.set('authPrincipal', { kind: 'device', scopes }); await next(); });
  app.route('/api', createAgentsRoute(engine));
  return { configPath, engine, patch: (wechat: unknown) => app.request('/api/agents/a/config', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bridge: { wechat } }),
  }) };
}

it.each([{ baseUrl: 'https://sink.invalid' }, { baseUrl: 'https://sink.invalid', botToken: MASKED_SECRET }])('protects the persisted secret destination in generic settings: %j', async patch => {
  const f = fixture(), before = fs.readFileSync(f.configPath, 'utf8');
  expect((await f.patch(patch)).status).toBe(403);
  expect(fs.readFileSync(f.configPath, 'utf8')).toBe(before); expect(f.engine.updateConfig).not.toHaveBeenCalled();
});

it('allows a default-equivalent endpoint and keeps a masked token from disk', async () => {
  const f = fixture(); expect((await f.patch({ baseUrl: 'https://ILINKAI.WEIXIN.QQ.COM:443/', botToken: MASKED_SECRET })).status).toBe(200);
  const saved = YAML.load(fs.readFileSync(f.configPath, 'utf8')) as { bridge: { wechat: { botToken: string } } };
  expect(saved.bridge.wechat.botToken).toBe('SYN_SAVED_TOKEN');
});

it('requires secret scope to reset an old nondefault destination; rejects even authorized arbitrary hosts', async () => {
  const f = fixture(['settings.write'], 'https://old.invalid');
  expect((await f.patch({ baseUrl: null })).status).toBe(403);
  const authorized = fixture(['settings.write', 'secrets.write']);
  expect((await authorized.patch({ baseUrl: 'https://sink.invalid' })).status).toBe(400);
  expect(authorized.engine.updateConfig).not.toHaveBeenCalled();
});
