import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

const root = process.env.HANA_OAUTH_FIXTURE_ROOT;
if (!root) throw new Error('HANA_OAUTH_FIXTURE_ROOT must point to an isolated test directory');
let networkAttempts = 0;
let mockFetchCalls = 0;
globalThis.fetch = async () => { networkAttempts++; throw new Error('Synthetic probe forbids network'); };
net.Socket.prototype.connect = function () { networkAttempts++; throw new Error('Synthetic probe forbids sockets'); };
const { AuthStorage, completeSimple, createModelRegistry, getAvailableModels, SessionManager } = await import('../../lib/pi-sdk/index.ts');
const { buildSessionCacheSnapshot } = await import('../../core/session-cache-snapshot.ts');
const { runSessionSnapshotSideTask } = await import('../../lib/llm/session-snapshot-side-task-runner.ts');
const { ProviderCatalogStore } = await import('../../core/provider-catalog.ts');
const { ProviderRegistry } = await import('../../core/provider-registry.ts');
const { syncModels } = await import('../../core/model-sync.ts');
const { createAssistantMessageEventStream } = await import('@earendil-works/pi-ai');
const version = JSON.parse(await fs.readFile(new URL('../../node_modules/@earendil-works/pi-ai/package.json', import.meta.url), 'utf8')).version;
const ids = ['azure-openai-responses', 'azure', 'custom-azure'];
const apis = ['openai-completions', 'azure-openai-responses'];
const modelId = 'gpt-5.4';
const configuredBaseUrl = 'https://synthetic-configured.openai.azure.com/openai/v1';
const envBaseUrl = 'https://synthetic-environment.openai.azure.com/openai/v1';
const envResource = 'synthetic-environment-resource';
const envKey = 'synthetic-environment-key';
const deploymentMap = 'gpt-5.4=synthetic-env-deployment,deepseek-v4-pro=synthetic-env-completions';
const scenarios = [
  { name: 'clean', env: {} },
  { name: 'endpoint', env: { AZURE_OPENAI_BASE_URL: envBaseUrl } },
  { name: 'resource', env: { AZURE_OPENAI_RESOURCE_NAME: envResource } },
  { name: 'deployment', env: { AZURE_OPENAI_DEPLOYMENT_NAME_MAP: deploymentMap } },
  { name: 'combined', env: { AZURE_OPENAI_BASE_URL: envBaseUrl, AZURE_OPENAI_RESOURCE_NAME: envResource, AZURE_OPENAI_DEPLOYMENT_NAME_MAP: deploymentMap } },
];
// The launcher supplies a system-only whitelist; this child never reads real Azure settings.
const azureEnvNames = ['AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_BASE_URL', 'AZURE_OPENAI_RESOURCE_NAME', 'AZURE_OPENAI_DEPLOYMENT_NAME_MAP', 'AZURE_OPENAI_API_VERSION'];
for (const name of azureEnvNames) assert.equal(process.env[name], undefined, 'Launcher must isolate ' + name);
function useSyntheticEnvironment(env) {
  for (const name of azureEnvNames) delete process.env[name];
  Object.assign(process.env, { AZURE_OPENAI_API_KEY: envKey }, env);
}

const results = [];
const routing = [];
const failures = [];
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const directRequests = { completeSimple };
const sideTaskRequests = {
  async completeSimple(model, context, options) {
    const snapshot = buildSessionCacheSnapshot({ model, messages: context.messages, systemPrompt: 'Synthetic snapshot' });
    let rejection;
    await assert.rejects(runSessionSnapshotSideTask({
      snapshot, model, options,
      suffixMessage: { role: 'user', content: 'Synthetic side task', timestamp: 4 },
      // Omit streamFn to exercise Hana's actual completeSimple fallback.
    }), error => {
      rejection = error;
      return /Synthetic dispatch captured/.test(error.message);
    });
    return { stopReason: 'error', errorMessage: rejection.message };
  },
};
function messagesFor(model) {
  return [
    { role: 'user', content: [{ type: 'text', text: 'Synthetic request' }], timestamp: 1 },
    { role: 'assistant', api: model.api, provider: model.provider, model: model.id, stopReason: 'toolUse', timestamp: 2, usage,
      content: [{ type: 'thinking', thinking: '', thinkingSignature: JSON.stringify({ type: 'reasoning', id: 'rs_synthetic', summary: [] }) }, { type: 'toolCall', id: 'call_synthetic|fc_synthetic', name: 'synthetic_tool', arguments: {} }] },
    { role: 'toolResult', toolCallId: 'call_synthetic|fc_synthetic', toolName: 'synthetic_tool', isError: false, content: [{ type: 'text', text: 'Synthetic complete' }], timestamp: 3 },
  ];
}

async function captureRequest(runtime, model, label, expected, options = {}, method = 'streamSimple') {
  const requests = [];
  let payload;
  const suppliedOptions = {
    maxTokens: 64, maxRetries: 0, headers: { 'x-synthetic-request': label }, ...options,
    onPayload(value) { payload = value; },
    async fetch(input, init) {
      mockFetchCalls++;
      const request = new Request(input, init);
      requests.push({ url: request.url, body: JSON.parse(await request.text()),
        apiKey: request.headers.get('api-key'), authorization: request.headers.get('authorization'),
        customHeader: request.headers.get('x-synthetic-request') });
      // Exercise the final SDK HTTP request without any socket or provider execution.
      return new Response(JSON.stringify({ error: { message: 'Synthetic dispatch captured', type: 'synthetic_probe' } }), {
        status: 400, headers: { 'content-type': 'application/json' },
      });
    },
  };
  const requestOptionsBefore = JSON.stringify(suppliedOptions);
  const environmentBefore = azureEnvNames.map(name => process.env[name]);
  const pending = runtime[method](model, { messages: messagesFor(model) }, suppliedOptions);
  const output = await (method.startsWith('complete') ? pending : pending.result());
  const request = requests[0];
  const expectedUrl = model.api === 'azure-openai-responses'
    ? expected.baseUrl + '/responses?api-version=v1'
    : expected.baseUrl + '/chat/completions';
  const observation = { label, id: model.provider, api: model.api, method, expectedUrl, url: request?.url,
    expectedModel: expected.model ?? model.id, requestModel: request?.body.model,
    expectedKey: expected.key, apiKey: request?.apiKey, authorization: request?.authorization };
  routing.push(observation);
  try {
    assert.equal(requests.length, 1, label + ': one mock request');
    assert.equal(output.stopReason, 'error');
    assert.match(output.errorMessage, /Synthetic dispatch captured/);
    assert.equal(request.url, expectedUrl, label + ': configured final URL');
    assert.equal(request.body.model, expected.model ?? model.id, label + ': configured deployment');
    assert.equal(request.apiKey, model.api === 'azure-openai-responses' ? expected.key : null);
    assert.equal(request.authorization, model.api === 'openai-completions' ? 'Bearer ' + expected.key : null);
    assert.equal(request.customHeader, label);
    assert.equal(JSON.stringify(suppliedOptions), requestOptionsBefore, 'Caller options must not be mutated');
    assert.deepEqual(azureEnvNames.map(name => process.env[name]), environmentBefore, 'Requests must not mutate process Azure settings');
    assert.deepEqual(request.body, JSON.parse(JSON.stringify(payload)), 'onPayload must observe the dispatched body');
    observation.passed = true;
  } catch (error) {
    observation.passed = false;
    failures.push({ label, message: error.message });
  }
  return payload;
}

useSyntheticEnvironment({});
// Keep an unconfigured builtin runtime alive beside all configured runtimes.
const builtinStorage = AuthStorage.inMemory();
const builtinRegistry = await createModelRegistry(builtinStorage);
const builtinRuntime = await builtinStorage.getRuntime();
assert.ok(builtinRuntime.getModels('azure').every(model => model.baseUrl === ''));
for (const api of apis) {
  const dir = await fs.mkdtemp(path.join(root, 'tmp', 'azure-compatibility-'));
  const providers = Object.fromEntries(ids.map(id => [id, {
    display_name: 'Synthetic ' + id, base_url: configuredBaseUrl, api,
    api_key: 'synthetic-' + id + '-key', models: [{ id: modelId, api, context: 128000, maxOutput: 1024 }],
  }]));
  const catalog = new ProviderCatalogStore(dir); catalog.saveProviders(providers);
  const hanaRegistry = new ProviderRegistry(dir); hanaRegistry.reload();
  const plans = hanaRegistry.getChatProjectionPlans().filter(plan => ids.includes(plan.sourceProviderId));
  assert.deepEqual(plans.map(plan => plan.runtimeProviderId).sort(), ids.slice().sort());
  const modelPath = path.join(dir, 'models.json');
  const projected = Object.fromEntries(plans.map(plan => [plan.sourceProviderId, plan.config]));
  syncModels(projected, { modelsJsonPath: modelPath, chatProjectionPlans: Object.fromEntries(plans.map(plan => [plan.sourceProviderId, plan])) });
  const catalogBefore = await fs.readFile(catalog.catalogPath, 'utf8');
  const modelsBefore = await fs.readFile(modelPath, 'utf8');
  const storage = AuthStorage.inMemory();
  for (const id of ids) await storage.setRuntimeApiKey(id, providers[id].api_key);
  const registry = await createModelRegistry(storage, modelPath);
  const runtime = await storage.getRuntime();
  const available = await getAvailableModels(registry);
  for (const id of ids) {
    const model = registry.find(id, modelId);
    assert.ok(model); assert.equal(model.provider, id); assert.equal(model.api, api);
    assert.ok(available.some(candidate => candidate.provider === id && candidate.id === model.id));
    assert.equal((await runtime.getAuth(model)).auth.apiKey, providers[id].api_key);
    const file = path.join(dir, id + '.jsonl');
    const entries = [
      { type: 'session', version: 3, id: 'synthetic-' + id, timestamp: '2026-10-01T00:00:00Z', cwd: dir },
      { type: 'model_change', id: 'model001', parentId: null, timestamp: '2026-10-01T00:00:00Z', provider: id, modelId: model.id },
      { type: 'message', id: 'user001', parentId: 'model001', timestamp: '2026-10-01T00:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'Synthetic persisted history' }], timestamp: 1 } },
    ];
    const sessionBefore = entries.map(entry => JSON.stringify(entry)).join('\n') + '\n';
    await fs.writeFile(file, sessionBefore);
    const session = SessionManager.open(file, dir); const context = session.buildSessionContext();
    assert.deepEqual(context.model, { provider: id, modelId: model.id });
    assert.equal(registry.find(context.model.provider, context.model.modelId)?.provider, id);
    assert.equal(context.messages[0].content[0].text, 'Synthetic persisted history');
    for (const scenario of scenarios) {
      useSyntheticEnvironment(scenario.env);
      const payload = await captureRequest(runtime, model, api + '/' + id + '/' + scenario.name, { baseUrl: configuredBaseUrl, key: providers[id].api_key });
      if (api === 'azure-openai-responses') {
        const call = payload.input.find(item => item.type === 'function_call');
        const output = payload.input.find(item => item.type === 'function_call_output');
        assert.equal(call.call_id, output.call_id);
        assert.equal(call.call_id, 'call_synthetic'); assert.equal(call.id, 'fc_synthetic');
        assert.deepEqual(payload.input.filter(item => item.type === 'reasoning').map(item => item.id), ['rs_synthetic']);
      }
    }
    await captureRequest(runtime, model, api + '/' + id + '/stream', { baseUrl: configuredBaseUrl, key: providers[id].api_key }, {}, 'stream');
    for (const [entrypoint, requests] of [['hana-completeSimple', directRequests], ['side-task-fallback', sideTaskRequests]]) {
      await captureRequest(requests, model, api + '/' + id + '/' + entrypoint,
        { baseUrl: configuredBaseUrl, key: providers[id].api_key }, { apiKey: providers[id].api_key }, 'completeSimple');
    }
    assert.equal(await fs.readFile(file, 'utf8'), sessionBefore);
    if (api === 'azure-openai-responses') results.push({ id, api, modelRestored: true, credentialMatched: true, callId: 'call_synthetic', itemId: 'fc_synthetic', reasoningIds: ['rs_synthetic'] });
  }
  assert.equal(await fs.readFile(catalog.catalogPath, 'utf8'), catalogBefore);
  assert.equal(await fs.readFile(modelPath, 'utf8'), modelsBefore);

  const azureModel = registry.find('azure', modelId);
  for (const method of ['complete', 'completeSimple']) {
    await captureRequest(runtime, azureModel, api + '/' + method, { baseUrl: configuredBaseUrl, key: providers.azure.api_key }, {}, method);
  }
  // Explicit request overrides retain their priority; blank overrides cannot revive process env.
  const callerBaseUrl = 'https://synthetic-caller.openai.azure.com/openai/v1';
  await captureRequest(runtime, azureModel, api + '/caller', { baseUrl: callerBaseUrl, key: 'synthetic-caller-key', model: 'synthetic-caller-deployment' }, {
    apiKey: 'synthetic-caller-key', env: { AZURE_OPENAI_BASE_URL: callerBaseUrl, AZURE_OPENAI_DEPLOYMENT_NAME_MAP: modelId + '=synthetic-caller-deployment' },
  });
  await captureRequest(directRequests, azureModel, api + '/hana-completeSimple/caller', { baseUrl: callerBaseUrl, key: 'synthetic-caller-key', model: 'synthetic-caller-deployment' }, {
    apiKey: 'synthetic-caller-key', env: { AZURE_OPENAI_BASE_URL: callerBaseUrl, AZURE_OPENAI_DEPLOYMENT_NAME_MAP: modelId + '=synthetic-caller-deployment' },
  }, 'completeSimple');
  await captureRequest(runtime, azureModel, api + '/caller-resource', { baseUrl: 'https://synthetic-caller-resource.openai.azure.com/openai/v1', key: providers.azure.api_key }, {
    env: { AZURE_OPENAI_RESOURCE_NAME: 'synthetic-caller-resource' },
  });
  await captureRequest(runtime, azureModel, api + '/caller-empty', { baseUrl: configuredBaseUrl, key: providers.azure.api_key }, {
    env: { AZURE_OPENAI_BASE_URL: '', AZURE_OPENAI_DEPLOYMENT_NAME_MAP: '' },
  });

  // A refresh must use the latest provider and per-model endpoint, without rewriting the catalog.
  const changed = JSON.parse(modelsBefore);
  changed.providers.azure.baseUrl = 'https://synthetic-refreshed.openai.azure.com/openai/v1';
  changed.providers.azure.models[0].baseUrl = 'https://synthetic-model.openai.azure.com/openai/v1';
  await fs.writeFile(modelPath, JSON.stringify(changed));
  await registry.refresh({ allowNetwork: false });
  const refreshed = registry.find('azure', modelId);
  assert.equal(refreshed.baseUrl, changed.providers.azure.models[0].baseUrl);
  await captureRequest(runtime, refreshed, api + '/refresh-model', { baseUrl: refreshed.baseUrl, key: providers.azure.api_key });
  delete changed.providers.azure.models[0].baseUrl;
  await fs.writeFile(modelPath, JSON.stringify(changed));
  await registry.refresh({ allowNetwork: false });
  await captureRequest(runtime, registry.find('azure', modelId), api + '/refresh-provider', { baseUrl: changed.providers.azure.baseUrl, key: providers.azure.api_key });

  let extensionCalls = 0;
  function extensionStream(model, _context, options) {
    extensionCalls++;
    assert.equal(options.env, undefined, 'Custom extension stream retains its request options');
    const message = { role: 'assistant', api, provider: model.provider, model: model.id, content: [], usage, stopReason: 'stop', timestamp: 1 };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'done', reason: 'stop', message }); stream.end(message); return stream;
  }
  registry.registerProvider('azure', { api, streamSimple: extensionStream });
  await registry.refresh({ allowNetwork: false });
  assert.equal((await runtime.completeSimple(registry.find('azure', modelId), { messages: [] })).stopReason, 'stop');
  assert.equal(extensionCalls, 1);
  registry.unregisterProvider('azure');
  await registry.refresh({ allowNetwork: false });
  registry.registerProvider({ ...runtime.getProvider('azure'), stream: extensionStream, streamSimple: extensionStream });
  await registry.refresh({ allowNetwork: false });
  assert.equal((await runtime.complete(registry.find('azure', modelId), { messages: [] })).stopReason, 'stop');
  assert.equal((await runtime.completeSimple(registry.find('azure', modelId), { messages: [] })).stopReason, 'stop');
  assert.equal(extensionCalls, 3);
  registry.unregisterProvider('azure');
  await registry.refresh({ allowNetwork: false });
  await captureRequest(runtime, registry.find('azure', modelId), api + '/extension-removed', { baseUrl: changed.providers.azure.baseUrl, key: providers.azure.api_key });
  assert.equal(await fs.readFile(catalog.catalogPath, 'utf8'), catalogBefore);
}

for (const scenario of scenarios.filter(item => ['endpoint', 'resource', 'combined'].includes(item.name))) {
  useSyntheticEnvironment(scenario.env);
  await builtinRegistry.refresh({ allowNetwork: false });
  for (const api of apis) {
    const model = builtinRuntime.getModels('azure').find(candidate => candidate.api === api);
    assert.equal(model.baseUrl, '', 'Builtin refresh must not acquire a configured endpoint');
    const mapped = new Map((scenario.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP ?? '').split(',').map(entry => entry.split('='))).get(model.id);
    await captureRequest(builtinRuntime, model, api + '/builtin/' + scenario.name, {
      baseUrl: scenario.env.AZURE_OPENAI_BASE_URL ?? 'https://' + envResource + '.openai.azure.com/openai/v1', key: envKey, model: mapped ?? model.id,
    });
    if (scenario.name === 'combined') {
      await captureRequest(directRequests, model, api + '/builtin/hana-completeSimple', {
        baseUrl: envBaseUrl, key: envKey, model: mapped ?? model.id,
      }, {}, 'completeSimple');
    }
  }
}
assert.equal(networkAttempts, 0);
const evidence = { version, results, routing, failures, mockFetchCalls, networkAttempts, syntheticCredentialsOnly: true };
await fs.writeFile(path.join(root, 'evidence/azure-compatibility.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ version, identityCases: results.length, requestCases: routing.length, failures, mockFetchCalls, networkAttempts }, null, 2));
assert.equal(failures.length, 0, 'Configured Azure routing must match the final mock HTTP request; see evidence/azure-compatibility.json');
