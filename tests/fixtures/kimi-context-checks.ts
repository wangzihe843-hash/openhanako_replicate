import assert from 'node:assert/strict';
import { applyModelContextDefault } from '../../shared/model-context-defaults.ts';
import { lookupKnown, lookupKnownProvider, lookupKnownWithSource } from '../../shared/known-models.ts';
import { lookupReferenceModelMeta } from '../../desktop/src/react/utils/model-metadata.ts';
import { officialKimiEndpoints, nonOfficialKimiEndpoints } from './kimi-context-cases.ts';

const provider = 'kimi-coding';
const id = 'kimi-for-coding';
const official = 'https://api.kimi.com/coding/v1';
const reference = Object.freeze({ context: 262144, maxContext: 1048576, maxOutput: 32768,
  compat: Object.freeze({ thinkingFormat: 'kimi' }) });

export const kimiContextChecks = [
  ...officialKimiEndpoints.map(endpoint => ({
    name: `official K2.8 default: ${endpoint}`,
    run() {
      const result = applyModelContextDefault(reference, provider, id, endpoint);
      assert.deepEqual(result, { ...reference, context: 1048576 });
      assert.notEqual(result, reference);
      assert.equal(result.compat, reference.compat);
      assert.equal(reference.context, 262144);
      assert.equal(lookupKnown(provider, id, endpoint).context, 1048576);
      assert.equal(lookupKnownWithSource(provider, id, endpoint).source, 'provider');
      assert.equal(lookupReferenceModelMeta(id, provider, endpoint).context, 1048576);
    },
  })),
  ...nonOfficialKimiEndpoints.map(endpoint => ({
    name: `no promotion for endpoint: ${JSON.stringify(endpoint)}`,
    run() {
      assert.equal(applyModelContextDefault(reference, provider, id, endpoint), reference);
      assert.equal(lookupKnown(provider, id, endpoint).context, 262144);
      assert.equal(lookupReferenceModelMeta(id, provider, endpoint).context, 262144);
    },
  })),
  {
    name: 'exact provider and raw model ID only, with no fallback or namespace promotion',
    run() {
      for (const p of ['Kimi-Coding', 'moonshot', 'custom', '']) {
        assert.equal(applyModelContextDefault(reference, p, id, official), reference);
        assert.deepEqual(lookupKnown(p, id, official), lookupKnown(p, id));
        assert.deepEqual(lookupReferenceModelMeta(id, p, official), lookupReferenceModelMeta(id, p));
      }
      for (const modelId of ['KIMI-FOR-CODING', 'namespace/kimi-for-coding', 'kimi-for-coding ',
        'k3', 'k3-256k', 'kimi-for-coding-highspeed', 'unknown-model']) {
        assert.equal(applyModelContextDefault(reference, provider, modelId, official), reference);
        assert.deepEqual(lookupKnown(provider, modelId, official), lookupKnown(provider, modelId));
        assert.deepEqual(lookupReferenceModelMeta(modelId, provider, official), lookupReferenceModelMeta(modelId, provider));
      }
    },
  },
  {
    name: 'lookup cache and protocol-only lookup remain unmodified across endpoint switches',
    run() {
      const cached = lookupKnownProvider(provider, id);
      const before = structuredClone(cached);
      for (const endpoint of [official, 'https://proxy.example/coding', 'https://api.kimi.ai/coding']) {
        const expected = endpoint.includes('proxy.example') ? 262144 : 1048576;
        assert.equal(lookupKnown(provider, id, endpoint).context, expected);
        assert.equal(lookupReferenceModelMeta(id, provider, endpoint).context, expected);
        assert.equal(lookupKnownProvider(provider, id), cached);
        assert.deepEqual(cached, before);
      }
      assert.equal(lookupKnown(provider, id), cached);
      assert.equal(cached.context, 262144);
    },
  },
  {
    name: 'only context changes; maxContext does not enable K3; Moonshot output remains local',
    run() {
      const { context: _old, ...before } = lookupKnown(provider, id);
      const { context: _new, ...after } = lookupKnown(provider, id, official);
      assert.deepEqual(after, before);
      assert.equal(after.maxOutput, 32768);
      assert.equal(lookupKnown(provider, 'k3', official).context, 262144);
      assert.equal(lookupKnown(provider, 'k3', official).maxContext, 1048576);
      assert.equal(lookupKnown('moonshot', 'kimi-k3', official).maxOutput, 131072);
      const already = Object.freeze({ context: 1048576 });
      assert.equal(applyModelContextDefault(already, provider, id, official), already);
    },
  },
];
