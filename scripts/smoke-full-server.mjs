#!/usr/bin/env node
// Exercise the actual packaged runtime without user data, credentials or model calls.
// Run after build:client and build:server: node scripts/smoke-full-server.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
  buildBetterSqliteRuntimeSmokeScript,
  buildJiebaRuntimeSmokeScript,
  buildAnydocRuntimeSmokeScript,
} from './build-server-deps.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const platformDir = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : process.platform;
const serverDir = path.join(root, 'dist-server', `${platformDir}-${process.arch}`);
const executable = path.join(serverDir, process.platform === 'win32' ? 'hana-server.exe' : 'node');
assert(fs.existsSync(executable), 'Build the packaged server first');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hana-full-server-smoke-'));
const home = path.join(scratch, 'home');
const temporary = path.join(scratch, 'tmp');
fs.mkdirSync(temporary);
const env = {};
const allowed = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'SYSTEMDRIVE', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432', 'PROGRAMDATA', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'OS']);
for (const [key, value] of Object.entries(process.env)) {
  if (allowed.has(key.toUpperCase()) && value !== undefined) env[key] = value;
}
Object.assign(env, {
  HANA_ROOT: serverDir, HANA_SERVER_ENTRY: path.join(serverDir, 'bundle', 'index.js'),
  HANA_HOME: home, HANA_HOST: '127.0.0.1', HANA_PORT: '0', HANA_CREATE_STARTUP_SESSION: '0',
  HOME: home, USERPROFILE: home, TEMP: temporary, TMP: temporary,
  APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
});
const children = [];
let checks = 0;
function passed(label) { checks++; console.log(`[full-server-smoke] PASS ${label}`); }
function launch() {
  const child = spawn(executable, [path.join(serverDir, 'bootstrap.js')], {
    cwd: serverDir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const record = { child, output: '', closed: false, error: null };
  child.stdout.on('data', chunk => { record.output += chunk; });
  child.stderr.on('data', chunk => { record.output += chunk; });
  child.on('error', error => { record.error = error; });
  child.once('close', () => { record.closed = true; });
  children.push(record);
  return record;
}
async function ready(record) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (record.error) throw record.error;
    assert(!record.closed, `Server exited before readiness: ${record.output}`);
    try {
      const info = JSON.parse(fs.readFileSync(path.join(home, 'server-info.json'), 'utf8'));
      if (info.pid === record.child.pid && info.port && info.token) {
        assert(['127.0.0.1', 'localhost', '::1'].includes(info.host), 'Server must stay on loopback');
        record.info = info;
        return;
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    await delay(100);
  }
  throw new Error(`Server readiness timed out: ${record.output}`);
}
async function request(record, route, { body, method = body === undefined ? 'GET' : 'POST', status = 200, authenticated = true } = {}) {
  const response = await fetch(`http://127.0.0.1:${record.info.port}${route}`, {
    method,
    headers: { ...(authenticated ? { Authorization: `Bearer ${record.info.token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await response.json();
  assert.equal(response.status, status, `${method} ${route}: ${JSON.stringify(data)}`);
  return data;
}
async function waitClosed(record, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (!record.closed && Date.now() < deadline) await delay(100);
  assert(record.closed, 'Smoke server did not exit');
}
async function shutdown(record) {
  await request(record, '/api/shutdown', { body: {} });
  await waitClosed(record);
  assert.equal(record.child.exitCode, 0, 'Server must shut down cleanly');
}

try {
  for (const [name, source] of [
    ['better-sqlite3', buildBetterSqliteRuntimeSmokeScript()],
    ['jieba', buildJiebaRuntimeSmokeScript()],
    ['anydoc', buildAnydocRuntimeSmokeScript()],
  ]) {
    const native = spawnSync(executable, ['--input-type=module', '--eval', source], {
      cwd: serverDir, env, encoding: 'utf8', windowsHide: true, timeout: 45_000,
    });
    if (native.error) throw native.error;
    assert.equal(native.status, 0, `${name}: ${native.stderr}`);
    passed(`packaged ${name} runtime`);
  }
  const first = launch();
  await ready(first);
  const health = await request(first, '/api/health');
  assert.equal(health.status, 'ok');
  assert.equal(health.sessionStore?.degraded, false);
  assert((await request(first, '/api/server/identity')).serverProtocol !== undefined);
  passed('real packaged startup, identity and healthy session store');
  await request(first, '/api/health', { authenticated: false, status: 403 });
  passed('unauthenticated API request rejected');

  const { agents } = await request(first, '/api/agents');
  const agentId = agents?.[0]?.id;
  assert(typeof agentId === 'string' && /^[A-Za-z0-9_-]+$/.test(agentId));
  const agentRoute = `/api/agents/${agentId}`;
  const relativePath = 'validation/full-server-smoke.json';
  const payload = { marker: 'packaged-round-trip', version: 1 };
  await request(first, '/api/xingye/storage', { body: { action: 'writeJson', agentId, relativePath, data: payload } });
  assert.deepEqual((await request(first, '/api/xingye/storage', { body: { action: 'readJson', agentId, relativePath } })).data, payload);
  await request(first, '/api/xingye/storage', { status: 400, body: { action: 'writeJson', agentId, relativePath: '../escape.json', data: payload } });
  assert(!fs.existsSync(path.join(home, 'agents', agentId, 'escape.json')));
  passed('Xingye storage persists and rejects path traversal');

  const topic = { sourceType: 'reality_source', title: 'Smoke fixture', sourceUrl: 'https://example.com/smoke', reason: 'Explicitly selected fixture; no network fetch', expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
  const created = await request(first, `${agentRoute}/topic-candidates`, { body: topic, status: 201 });
  const duplicate = await request(first, `${agentRoute}/topic-candidates`, { body: topic, status: 201 });
  assert.equal(duplicate.candidate.id, created.candidate.id);
  await request(first, `${agentRoute}/topic-candidates/${created.candidate.id}`, { method: 'PATCH', body: { status: 'used' }, status: 400 });
  await request(first, `${agentRoute}/topic-candidates/${created.candidate.id}`, { method: 'PATCH', body: { status: 'dismissed' } });
  await request(first, `${agentRoute}/topic-candidates`, { body: { ...topic, sourceUrl: 'file:///private' }, status: 400 });
  passed('topic creation, deduplication, dismissal and invalid state/URL rejection');

  await request(first, `${agentRoute}/config`, { method: 'PUT', body: { experience: { enabled: true } } });
  assert.deepEqual((await request(first, `${agentRoute}/experience-versions`)).versions, []);
  await request(first, `${agentRoute}/experience-versions/missing`, { method: 'PATCH', body: { action: 'activate' }, status: 404 });
  await request(first, `${agentRoute}/config`, { method: 'PUT', body: { experience: { enabled: false } } });
  await request(first, `${agentRoute}/experience-versions`, { status: 403 });
  await request(first, '/api/agents/no-such-smoke-agent/topic-candidates', { status: 404 });
  passed('experience enable/pause and missing resource API boundaries');
  await shutdown(first);
  passed('authenticated graceful shutdown');

  const restarted = launch();
  await ready(restarted);
  assert.deepEqual((await request(restarted, '/api/xingye/storage', { body: { action: 'readJson', agentId, relativePath } })).data, payload);
  const topics = await request(restarted, `${agentRoute}/topic-candidates`);
  assert.equal(topics.candidates.find(row => row.id === created.candidate.id)?.status, 'dismissed');
  await request(restarted, `${agentRoute}/experience-versions`, { status: 403 });
  await shutdown(restarted);
  passed('data and companion settings survive a real process restart');
  console.log(`[full-server-smoke] ${checks} checks passed`);
} finally {
  for (const record of children) {
    if (!record.closed) {
      record.child.kill('SIGKILL');
      await waitClosed(record, 5_000);
    }
  }
  const relative = path.relative(os.tmpdir(), scratch);
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Cleanup must stay in the temporary directory');
  fs.rmSync(scratch, { recursive: true, force: true });
}
