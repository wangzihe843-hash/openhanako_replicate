import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runBundlePull } from "../cli/bundle.ts";
const require = createRequire(import.meta.url);
const roots: string[] = [];
const home = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-policy-')); roots.push(p); return p; };
afterEach(() => { roots.splice(0).forEach(p => fs.rmSync(p, { recursive: true, force: true })); vi.restoreAllMocks(); });
function loadShell(packaged: boolean) {
  const handlers: Record<string, (...args: unknown[]) => unknown> = {};
  const updater = { autoDownload: true, autoInstallOnAppQuit: true, allowPrerelease: false,
    checkForUpdates: vi.fn(async () => ({})), downloadUpdate: vi.fn(async () => null),
    quitAndInstall: vi.fn(), setFeedURL: vi.fn(), on: vi.fn() };
  const timer = vi.fn();
  const fetch = vi.fn(async () => { throw Error('network forbidden'); });
  const filename = path.resolve('desktop/auto-updater.cjs');
  const shellRequire = createRequire(filename);
  const mod = { exports: {} as {
    initAutoUpdater(window: null, config: { hanakoHome: string }): void;
    checkForUpdatesAuto(): Promise<void>;
    getState(): { status: string };
    setUpdateChannel(channel: string): void;
  } };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module: mod, exports: mod.exports, require: (id: string) => id === 'electron' ? {
      ipcMain: { handle: (name: string, fn: (...args: unknown[]) => unknown) => { handlers[name] = fn; } }, BrowserWindow: { getAllWindows: () => [] },
      app: { isPackaged: packaged, getVersion: () => '1.0.0', getPath: () => home() },
    } : id === 'electron-updater' ? { autoUpdater: updater } : shellRequire(id),
    process: { env: { HANA_UPDATE_FEED_URL: 'https://override.invalid/', HANA_INVITE_API_URL: 'https://invite.invalid/' }, platform: process.platform },
    console, fetch, setInterval: timer, setTimeout: timer, setImmediate,
  }, { filename });
  return { mod: mod.exports, handlers, updater, timer, fetch };
}
describe('fork default offline update policy', () => {
  for (const packaged of [true, false]) it(`blocks shell background and all IPC in packaged=${packaged}`, async () => {
    const s = loadShell(packaged); const h = home();
    const channel = path.join(h, 'update-channel.json');
    fs.writeFileSync(channel, JSON.stringify({ version: 1, active: true, feedUrl: 'https://legacy.invalid/', deviceId: 'synthetic' }));
    const before = fs.readFileSync(channel, 'utf8');
    s.mod.initAutoUpdater(null, { hanakoHome: h });
    await s.mod.checkForUpdatesAuto();
    expect(s.mod.getState().status).toBe('disabled');
    expect(await s.handlers['auto-update-check']()).toMatchObject({ status: 'disabled' });
    expect(await s.handlers['auto-update-download']()).toBe(false);
    expect(await s.handlers['auto-update-install']()).toBe(false);
    await s.handlers['auto-update-set-channel'](null, 'beta'); s.mod.setUpdateChannel('beta');
    expect(await s.handlers['invite:status']()).toMatchObject({ configured: false, active: false });
    expect(await s.handlers['invite:redeem'](null, 'synthetic')).toMatchObject({ ok: false, reason: 'disabled' });
    expect(await s.handlers['invite:activate'](null, { feedUrl: 'https://legacy.invalid/' })).toMatchObject({ configured: false, active: false });
    expect(fs.readFileSync(channel, 'utf8')).toBe(before);
    expect(fs.readdirSync(h)).toEqual(['update-channel.json']);
    expect(s.updater.checkForUpdates).not.toHaveBeenCalled(); expect(s.updater.downloadUpdate).not.toHaveBeenCalled();
    expect(s.updater.quitAndInstall).not.toHaveBeenCalled(); expect(s.updater.setFeedURL).not.toHaveBeenCalled();
    expect(s.updater.autoInstallOnAppQuit).toBe(false); expect(s.updater.autoDownload).toBe(false);
    expect(s.updater.allowPrerelease).toBe(false); expect(s.timer).not.toHaveBeenCalled(); expect(s.fetch).not.toHaveBeenCalled();
  });
  it('blocks shared OTA, manifest overrides and scheduler before network or state mutation', async () => {
    const ota = require('../desktop/src/shared/artifact-ota.cjs'); const core = require('../shared/artifact-core/ota-core.cjs');
    const h = home(); const sentinel = path.join(h, 'ota-state.json'); fs.writeFileSync(sentinel, '{"stable":{"available":{"version":"9.0.0"}}}');
    const before = fs.readFileSync(sentinel, 'utf8');
    const fetchOnce = vi.fn(async () => { throw Error('network forbidden'); });
    const opts = { homeDir: h, keyset: [{ keyId: 'synthetic', publicKey: 'unused' }], currentShellVersion: '1.0.0', platformArch: 'darwin-arm64', serverProtocolVersion: 1,
      fetchOnce, devBypass: { hasDevOverride: () => true, resolveDevManifestOverride: () => 'https://override.invalid/' } };
    expect(await core.checkOnce(opts)).toMatchObject({ outcome: 'disabled' });
    expect(await core.downloadAndApplyArtifacts(opts)).toMatchObject({ ok: false });
    expect(await core.downloadAndApplyRendererArtifact(opts)).toMatchObject({ ok: false });
    await expect(core.fetchChannelManifest(opts)).rejects.toThrow(/online updates/i);
    const spy = vi.spyOn(globalThis, 'setTimeout');
    expect(ota.scheduleBackgroundOtaChecks(opts)).toBeNull(); expect(spy).not.toHaveBeenCalled();
    expect(fetchOnce).not.toHaveBeenCalled(); expect(fs.readFileSync(sentinel, 'utf8')).toBe(before);
    expect(fs.readdirSync(h)).toEqual(['ota-state.json']);
  });
  it('blocks CLI pull before injectable download and retains local status', async () => {
    const download = vi.fn(async () => ({ ok: true as const, version: '9.0.0' }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runBundlePull({ hanaHome: home(), download })).toBe(1); expect(download).not.toHaveBeenCalled();
  });
  it('loads bundled history without network', async () => {
    const { createUpdateDigestHistoryLoader } = require('../desktop/src/shared/update-digest-history.cjs');
    const fetchImpl = vi.fn(async () => { throw Error('forbidden'); });
    const load = createUpdateDigestHistoryLoader({ fetchImpl, normalize: (x: unknown) => x, readBundledEntries: () => [{ version: '1.0.0' }] });
    expect(await load()).toMatchObject({ source: 'bundled', complete: false }); expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('native content update IPC policy', () => {
  for (const packaged of [true, false]) it(`blocks direct check/apply/scheduling in packaged=${packaged} and preserves local recovery status`, async () => {
    const source = fs.readFileSync('desktop/main.cjs', 'utf8');
    const ast = ts.createSourceFile('main.cjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const functions = ['startBackgroundOtaSchedulerOnce', 'applyTrainUpdateNow'];
    const channels = ['train-update-check', 'train-update-apply', 'train-update-status', 'train-fallback-notice-ack'];
    const selected = ast.statements.filter(node => {
      if (ts.isFunctionDeclaration(node)) return functions.includes(node.name?.text || '');
      if (!ts.isExpressionStatement(node) || !ts.isCallExpression(node.expression)) return false;
      const call = node.expression;
      return call.expression.getText(ast) === 'wrapIpcHandler' && ts.isStringLiteral(call.arguments[0]) && channels.includes(call.arguments[0].text);
    });
    expect(selected).toHaveLength(6);
    const handlers: Record<string, (...args: unknown[]) => unknown> = {};
    const checkOnce = vi.fn(); const downloadAndApplyArtifacts = vi.fn(); const scheduleBackgroundOtaChecks = vi.fn();
    const notice = { kind: 'renderer', fromVersion: '9.0.0', toVersion: '1.0.0', quarantinedTrain: 9 };
    const context = vm.createContext({ updatePolicy: require('../shared/update-policy.cjs'), app: { isPackaged: packaged },
      artifactOta: { checkOnce, downloadAndApplyArtifacts, scheduleBackgroundOtaChecks,
        readStagedTrainStatus: async () => ({ staged: true, available: { version: '9.0.0' }, lastCheckedAt: '2026-01-01', minShellBlocked: true }) },
      wrapIpcHandler: (key: string, fn: (...args: unknown[]) => unknown) => { handlers[key] = fn; }, readUpdateChannelPreference: () => 'beta',
      getCurrentContentVersion: () => '1.0.0', _crashFallbackNotice: notice, hanakoHome: home(),
    });
    vm.runInContext(selected.map(node => node.getText(ast)).join('\n'), context);
    vm.runInContext('startBackgroundOtaSchedulerOnce()', context);
    expect(await handlers['train-update-check']()).toMatchObject({ outcome: 'disabled' });
    expect(await handlers['train-update-apply']({ sender: {} })).toMatchObject({ ok: false });
    expect(checkOnce).not.toHaveBeenCalled(); expect(downloadAndApplyArtifacts).not.toHaveBeenCalled(); expect(scheduleBackgroundOtaChecks).not.toHaveBeenCalled();
    expect(await handlers['train-update-status']()).toMatchObject({ onlineUpdatesEnabled: false, currentVersion: '1.0.0', available: null, lastCheckedAt: null, fallbackNotice: notice });
    expect(await handlers['train-fallback-notice-ack']()).toMatchObject({ ok: true });
    expect(((await handlers['train-update-status']()) as { fallbackNotice: unknown }).fallbackNotice).toBeNull();
  });
});

it('pins the fork build policy and keeps release jobs disabled', () => {
  const policy = require('../shared/update-policy.cjs');
  expect(Object.isFrozen(policy)).toBe(true); expect(policy.onlineUpdatesEnabled).toBe(false);
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  expect(pkg.build.publish).toEqual([{ provider: 'github', owner: 'wangzihe843-hash', repo: 'openhanako_replicate' }]);
  expect(pkg.scripts['install:local']).toContain('owner: wangzihe843-hash');
  expect(pkg.scripts['install:local']).toContain('repo: openhanako_replicate');
  for (const [file, jobs] of [['build.yml', ['release', 'publish-train']], ['publish-train.yml', ['publish-train']]] as const) {
    const source = fs.readFileSync(`.github/workflows/${file}`, 'utf8');
    for (const job of jobs) expect(source.slice(source.indexOf(`  ${job}:`)).split('\n').slice(0, 5).join('\n')).toContain('if: ${{ false }}');
  }
});
