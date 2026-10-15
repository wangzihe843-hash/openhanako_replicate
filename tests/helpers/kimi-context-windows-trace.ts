// Temporary, bounded Windows observations. Never serialize errors, credentials or fixtures.
import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { URL as NodeURL } from 'node:url';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { ModelRuntime } from '../../node_modules/@earendil-works/pi-coding-agent/dist/core/model-runtime.js';
import { ModelConfig } from '../../node_modules/@earendil-works/pi-coding-agent/dist/core/model-config.js';
import { FileAuthStorageBackend } from '../../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js';

type Scope = Record<string, any>;
const als = new AsyncLocalStorage<Scope>();
const started = performance.now();
const ids = new WeakMap<object, string>();
const reads = new WeakMap<object, string>();
const fixtures = new Map<string, { revision: number; manager?: any }>();
const pending = new Map<string, Scope>();
const restores: Array<() => void> = [];
const modelsSeen = new WeakSet<object>();
let serial = 0, caseScope: Scope = {}, buffer: Scope[] = [], broken = false;
let flushTimer: ReturnType<typeof setInterval>;
const output = process.env.KIMI_DIAG_TRACE;
const lag = monitorEventLoopDelay({ resolution: 20 });
let lastElu = performance.eventLoopUtilization();
const now = () => performance.now() - started;
const identity = (value: object, kind: string) => {
  if (!ids.has(value)) ids.set(value, `${kind}-${++serial}`);
  return ids.get(value);
};
const provider = (id: any) => ['kimi-coding', 'xai-oauth'].includes(id) ? id : 'other';
const api = (value: any) => ['anthropic-messages', 'openai-completions'].includes(value) ? value : value == null ? 'absent' : 'other';
const name = (value: any) => value === 'Renamed Kimi' ? 'renamed' : value == null ? 'absent' : 'other';
const number = (value: any) => typeof value === 'number' && Number.isFinite(value) ? value : null;
export function errorFields(error: any): Scope {
  const classes = ['Error', 'TypeError', 'SyntaxError', 'ReferenceError', 'RangeError', 'AssertionError', 'AbortError', 'DOMException', 'ModelsError', 'CredentialSynchronizationError'];
  const codes = ['EPERM', 'EACCES', 'EBUSY', 'ELOCKED', 'ENOENT', 'ENOTEMPTY', 'ABORT_ERR', 'ETIMEDOUT', 'EINVAL',
    'ERR_INVALID_ARG_VALUE', 'ERR_INVALID_URL', 'MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND'];
  const syscalls = ['mkdir', 'rename', 'open', 'read', 'write', 'unlink', 'rmdir', 'stat'];
  return { error_class: classes.includes(error?.name) ? error.name : 'other',
    error_code: codes.includes(error?.code) ? error.code : error?.code == null ? 'absent' : 'other',
    syscall: syscalls.includes(error?.syscall) ? error.syscall : 'other' };
}
function homeFor(value: any) {
  if (typeof value !== 'string') return undefined;
  return [...fixtures.keys()].find(home => value === home || value.startsWith(home + path.sep));
}
function role(value: any) {
  const base = typeof value === 'string' ? path.basename(value) : '';
  return ['auth.json', 'models.json', 'models-store.json', 'providers.json', 'provider-catalog.json'].includes(base) ? base : 'fixture-other';
}
function counts() {
  const spans = [...pending.values()];
  return { pending_put_count: spans.filter(s => s.kind === 'PUT').length,
    pending_runtime_refresh_count: spans.filter(s => s.kind === 'runtime.refresh').length,
    pending_span_count: spans.length };
}
export function emit(event: string, fields: Scope = {}, scope = als.getStore() ?? caseScope) {
  // All call sites supply only synthetic, enumerated fields. No arbitrary message text.
  try {
    buffer.push({ cohort: process.env.KIMI_DIAG_COHORT, process_index: Number(process.env.KIMI_DIAG_PROCESS_INDEX),
      ...scope, event, monotonic_ms: now(), ...counts(), ...fields });
    if (buffer.length > 250_000) { broken = true; buffer = []; }
  } catch { broken = true; }
}
export function flush() {
  if (!output) { broken = true; return; }
  try {
    if (buffer.length) { const batch = buffer; buffer = []; fs.appendFileSync(output, batch.map(e => JSON.stringify(e)).join('\n') + '\n'); }
  } catch { broken = true; }
}
function sampleModel(model: any, prefix: string): Scope {
  return { [`${prefix}_present`]: !!model, [`${prefix}_api`]: api(model?.api),
    [`${prefix}_context`]: number(model?.context), [`${prefix}_contextWindow`]: number(model?.contextWindow),
    [`${prefix}_name`]: name(model?.name) };
}
function snapshot(runtime: any): Scope {
  const configured = runtime.config?.getProvider('kimi-coding');
  const m = configured?.models?.find((m: any) => m.id === 'kimi-for-coding')
    ?? configured?.modelOverrides?.['kimi-for-coding'];
  const available = runtime.snapshot?.available?.find((m: any) => m.provider === 'kimi-coding' && m.id === 'kimi-for-coding');
  return { config_read_id: runtime.config && reads.get(runtime.config), config_error: !!runtime.config?.getError(),
    ...sampleModel(m, 'config'), ...sampleModel(available, 'runtime'),
    availability_seq: number(runtime.availabilityRefreshSeq),
    kimi_generation: number(runtime.models?.refreshGenerations?.get('kimi-coding')),
    xai_generation: number(runtime.models?.refreshGenerations?.get('xai-oauth')) };
}
function resultFields(value: any): Scope {
  return { sdk_aborted: typeof value?.aborted === 'boolean' ? value.aborted : undefined,
    sdk_error_count: value?.errors instanceof Map ? value.errors.size : undefined,
    sdk_errors: value?.errors instanceof Map ? [...value.errors].map(([id, err]) => ({ provider_id: provider(id), ...errorFields(err) })) : undefined };
}
type Hook = { scope?: (self: any, args: any[]) => Scope; before?: (self: any, args: any[]) => void;
  end?: (self: any, value: any, args: any[], spanId: string) => Scope;
  filter?: (self: any, args: any[]) => boolean };
function wrap(target: any, key: string, kind: string, hook: Hook = {}) {
  const original = target[key];
  if (typeof original !== 'function') throw new Error('Missing required diagnostic hook');
  target[key] = function(this: any, ...args: any[]) {
    if (hook.filter && !hook.filter(this, args)) return Reflect.apply(original, this, args);
    hook.before?.(this, args);
    const base = { ...(als.getStore() ?? caseScope), ...hook.scope?.(this, args) };
    const spanId = `span-${++serial}`, begin = now();
    const scoped = { ...base, parent_span_id: base.span_id, span_id: spanId };
    pending.set(spanId, { ...scoped, kind, started_ms: begin });
    emit(`${kind}.begin`, {}, scoped);
    const end = (outcome: string, value: any) => {
      pending.delete(spanId);
      try {
        emit(`${kind}.${outcome}`, { elapsed_ms: now() - begin,
          ...(outcome === 'error' ? errorFields(value) : hook.end?.(this, value, args, spanId)) }, scoped);
      } catch { broken = true; }
    };
    let value: any;
    try { value = als.run(scoped, () => Reflect.apply(original, this, args)); }
    catch (error) { end('error', error); throw error; }
    // Return the original value/Promise. These observers do not gate completion.
    if (value && typeof value.then === 'function') void value.then((v: any) => end('end', v), (e: any) => end('error', e));
    else end('end', value);
    return value;
  };
  restores.push(() => { target[key] = original; });
}
function installModels(runtime: any) {
  const models = runtime.models;
  if (!models || modelsSeen.has(models)) return;
  modelsSeen.add(models);
  const scope = () => ({ runtime_id: identity(runtime, 'runtime') });
  wrap(models, 'refresh', 'models.refresh', { scope, end: (_self, value) => ({ ...resultFields(value), ...snapshot(runtime) }) });
  for (const key of ['supersedeProviderRefresh', 'beginProviderRefresh', 'publishProviderModels']) {
    wrap(models, key, `models.${key}`, { filter: (_self, args) => ['kimi-coding', 'xai-oauth'].includes(args[0]),
      scope: (_self, args) => ({ ...scope(), provider_id: provider(args[0]),
        refresh_generation: number(models.refreshGenerations.get(args[0])),
        publication_generation: key === 'publishProviderModels' ? number(args[1]) : undefined }),
      end: (_self, value, args) => ({ refresh_generation: number(models.refreshGenerations.get(args[0])),
        signal_aborted: key === 'publishProviderModels' ? !!args[2]?.aborted : undefined,
        published: typeof value === 'boolean' ? value : undefined }) });
  }
}
export function install(managerPrototype: any, registryPrototype: any, store: any) {
  let stage = 'guard';
  try {
    if (process.platform !== 'win32' || process.version !== 'v24.15.0' || !output) throw new Error('Native Windows diagnostic only');
    // Resolve before mutating any prototype. An explicit NodeURL also avoids the
    // jsdom/client asset URL transform; resolution remains anchored in the SDK.
    stage = 'lockfile_resolve';
    const require = createRequire(new NodeURL('../../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js', import.meta.url));
    const lockfile = require('proper-lockfile');
    stage = 'hook_install';
    lag.enable();
    flushTimer = setInterval(flush, 250); flushTimer.unref();
    for (const key of ['init', 'reloadAndSync', 'syncAndRefresh', '_removeApiKeyProviderAuthEntries',
      '_applyRuntimeApiKeyOverrides', 'refreshAvailable', '_syncSdkProviderRegistrations']) {
      wrap(managerPrototype, key, `manager.${key}`, { scope: self => ({ manager_id: identity(self, 'manager') }) });
    }
    for (const key of ['saveProvider', 'updateModelEntry']) {
      wrap(registryPrototype, key, `registry.${key}`, {
        scope: () => ({ write_revision: currentRevision() }),
        end: () => { const home = als.getStore()?.fixture_id; const record = [...fixtures.values()].find(f => (f as any).fixture_id === home);
          if (record) record.revision++; return { write_revision: record?.revision }; } });
    }
    const prototype = ModelRuntime.prototype as any;
    for (const key of ['refresh', 'registerProvider', 'unregisterProvider', 'queueAvailabilityRefresh', 'updateModelSnapshot', 'rebuildProviders']) {
      wrap(prototype, key, `runtime.${key}`, {
        before: self => installModels(self),
        scope: (self, args) => ({ runtime_id: identity(self, 'runtime'),
          refresh_origin: key === 'registerProvider' ? 'registration' : key === 'unregisterProvider' ? 'unregistration'
            : (als.getStore()?.refresh_origin ?? (key === 'refresh' ? 'explicit' : undefined)),
          provider_id: ['registerProvider', 'unregisterProvider'].includes(key) ? provider(args[0]) : undefined,
          write_revision: currentRevision() }),
        end: (self, value) => ({ ...snapshot(self), ...resultFields(value), end_write_revision: currentRevision() }) });
    }
    wrap(ModelConfig, 'load', 'config.load', { filter: (_self, args) => !!homeFor(args[0]),
      scope: () => ({ read_id: `read-${++serial}`, write_revision: currentRevision() }),
      end: (_self, value, _args, spanId) => {
        reads.set(value, spanId);
        const c = value.getProvider('kimi-coding');
        return { config_read_id: spanId, config_error: !!value.getError(), end_write_revision: currentRevision(),
          ...sampleModel(c?.models?.find((m: any) => m.id === 'kimi-for-coding') ?? c?.modelOverrides?.['kimi-for-coding'], 'config') };
      } });
    for (const key of ['withLockAsync', 'acquireLockAsync', 'withLock', 'acquireLockSyncWithRetry']) {
      wrap(FileAuthStorageBackend.prototype, key, `auth.${key}`, {
        filter: (self, args) => !!homeFor(self.authPath ?? args[0]), scope: () => ({ file_role: 'auth.json' }) });
    }
    for (const key of ['lock', 'lockSync']) wrap(lockfile, key, `auth.${key}.attempt`, {
      filter: (_self, args) => !!homeFor(args[0]) && role(args[0]) === 'auth.json', scope: () => ({ file_role: 'auth.json' }) });
    wrap(fs, 'renameSync', 'io.rename', { filter: (_self, args) => !!homeFor(args[1]),
      scope: (_self, args) => ({ file_role: role(args[1]), write_revision: currentRevision() }) });
    const unsubscribe = store.subscribe((state: any, previous: any) => {
      if (state.toastType !== previous.toastType || state.toastMessage !== previous.toastMessage || state.toastVisible !== previous.toastVisible)
        emit('toast.change', { toast_type: ['success', 'error'].includes(state.toastType) ? state.toastType : 'other', toast_visible: !!state.toastVisible });
    });
    restores.push(unsubscribe);
    emit('instrumentation.ready', { lock_attempts_observed: true, wait_timeout_ms: 1000, test_timeout_ms: 10000 });
    flush();
    if (broken) throw new Error('Diagnostic instrumentation failed');
  } catch (error) {
    broken = true;
    emit('instrumentation.failure', { installation_stage: stage, ...errorFields(error) });
    flush();
    restoreInstrumentation();
    throw error;
  }
}
function restoreInstrumentation() {
  clearInterval(flushTimer); lag.disable();
  for (const restore of restores.splice(0).reverse()) {
    try { restore(); }
    catch (error) { broken = true; emit('instrumentation.failure', { installation_stage: 'restore', ...errorFields(error) }); }
  }
  flush();
}
function currentRevision() {
  const fixtureId = als.getStore()?.fixture_id;
  return [...fixtures.values()].find(f => (f as any).fixture_id === fixtureId)?.revision;
}
export function beforeTest(home: string) {
  const fixtureId = `fixture-${++serial}`;
  fixtures.set(home, { revision: 0, fixture_id: fixtureId } as any);
  caseScope = { fixture_id: fixtureId };
  emit('beforeEach.done'); flush();
}
export async function runCase(c: any, fn: () => Promise<void>) {
  caseScope = { ...caseScope, test_index: c.test_index, case_key: c.case_key };
  return als.run(caseScope, async () => {
    emit('test.begin');
    try { await fn(); emit('test.body.pass'); }
    catch (error) { emit('test.body.fail', errorFields(error)); flush(); throw error; }
  });
}
export async function budget(index: number, fn: () => Promise<void>) {
  return als.run({ ...als.getStore(), budget_index: index }, async () => {
    emit('budget.begin');
    try { await fn(); emit('budget.pass'); }
    catch (error) { emit('budget.fail', errorFields(error)); throw error; }
    finally { flush(); }
  });
}
export function attachManager(manager: any, home: string) {
  const record = fixtures.get(home); if (record) record.manager = manager;
  const managerId = identity(manager, 'manager');
  if (als.getStore()) als.getStore()!.manager_id = managerId;
  caseScope.manager_id = managerId;
  emit('manager.created', { manager_id: managerId });
}
export function stateSnapshot(manager: any, store: any, reset: boolean) {
  const state = store.getState();
  emit('budget.state', { provider_reset: reset, toast_type: ['success', 'error'].includes(state.toastType) ? state.toastType : 'other',
    toast_visible: !!state.toastVisible,
    ...sampleModel(manager.availableModels.find((m: any) => m.provider === 'kimi-coding' && m.id === 'kimi-for-coding'), 'manager') });
}
export function put(app: any, url: string, options: any) {
  let body: any = {};
  try { body = JSON.parse(options.body); } catch { broken = true; }
  const context = { ...(als.getStore() ?? caseScope), request_id: als.getStore()?.request_id ?? `put-${++serial}`,
    request_has_context: Object.hasOwn(body, 'context'), request_context: number(body.context),
    request_has_contextWindow: Object.hasOwn(body, 'contextWindow'), request_contextWindow: number(body.contextWindow),
    request_name: name(body.name) };
  const target = { request: (u: string, o: any) => app.request(u, o) };
  wrap(target, 'request', 'PUT', { scope: () => context, end: (_self, response) => ({ http_status: response.status }) });
  return als.run(context, () => {
    const result = target.request(url, options);
    void result.then((response: Response) => {
      // The UI receives the original response without awaiting parsing or changing HTTP semantics.
      try {
        void response.clone().json().then((body: any) => emit('PUT.body', { http_status: response.status,
          response_ok: body?.ok === true, response_has_error: typeof body?.error === 'string',
          response_has_code: typeof body?.code === 'string', response_error_category: typeof body?.error !== 'string' ? 'absent'
            : /not found/i.test(body.error) ? 'not_found' : /EPERM|EACCES/i.test(body.error) ? 'permission'
            : /ELOCKED|lock/i.test(body.error) ? 'lock' : 'other' }, context), () => emit('PUT.body.unreadable', {}, context));
      } catch { emit('PUT.body.unreadable', {}, context); broken = true; }
    }, () => {});
    return result;
  });
}
export function onRefresh() { emit('onRefresh.enter'); emit('onRefresh.exit'); }
export async function save(action: string, click: () => void, wait: (poll: () => void) => Promise<void>,
  assert: () => void, count: () => number, panel: () => boolean) {
  return als.run({ ...als.getStore(), action, request_id: `put-${++serial}` }, async () => {
    const clickStart = now(); emit('save.click.begin'); click();
    emit('save.click.return', { elapsed_ms: now() - clickStart });
    const begin = now(); emit('waitFor.begin', { deadline_ms: begin + 1000 });
    try {
      await wait(() => { emit('waitFor.poll', { on_refresh_count: count() }); assert(); });
      emit('waitFor.pass', { elapsed_ms: now() - begin, on_refresh_count: count(), panel_present: panel() });
    } catch (error) {
      emit('waitFor.fail', { elapsed_ms: now() - begin, on_refresh_count: count(), panel_present: panel(), ...errorFields(error) });
      flush(); throw error;
    }
  });
}
export function lifecycle(event: string) { emit(event, {}, caseScope); flush(); }
export function health() {
  const elu = performance.eventLoopUtilization(lastElu); lastElu = performance.eventLoopUtilization();
  emit('eventLoop.sample', { event_loop_max_ms: lag.max / 1e6, event_loop_mean_ms: number(lag.mean / 1e6), event_loop_utilization: elu.utilization }, caseScope);
  lag.reset();
  for (const span of pending.values()) {
    const { kind, started_ms, ...scope } = span;
    emit('pending.span', { pending_kind: kind, started_ms }, scope);
  }
  if (broken) emit('instrumentation.failure');
  flush();
  if (broken) throw new Error('Diagnostic instrumentation failed');
}
export async function finish() {
  try {
    lifecycle('tail.begin');
    // Observation only, after the original cleanup and all planned tests; never changes their result.
    await new Promise(resolve => setTimeout(resolve, 2000));
    lifecycle('tail.end'); health();
  } finally { restoreInstrumentation(); }
}
