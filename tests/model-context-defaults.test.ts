import { describe, expect, it } from 'vitest';
import { kimiContextChecks } from './fixtures/kimi-context-checks.ts';
import { kimiExplicitBudgets, kimiProjectionCases } from './fixtures/kimi-context-cases.ts';
import { resolveKimiContextBudget } from '../shared/model-context-defaults.ts';
import { getPiModel } from '../lib/pi-sdk/index.ts';

describe('K2.8 endpoint-scoped context defaults', () => {
  for (const check of kimiContextChecks) it(check.name, check.run);

  it('pins the renderer builtin budget to the installed exact Pi K2.8 model', () => {
    expect(getPiModel('kimi-coding', 'kimi-for-coding').contextWindow).toBe(1048576);
  });

  it.each(kimiProjectionCases)('separates budget projection from transport at $label/$api/$modelApi', c => {
    for (const budget of [{}, ...kimiExplicitBudgets]) {
      const input = { provider: 'kimi-coding', modelId: 'kimi-for-coding',
        baseUrl: c.base_url ?? 'https://api.kimi.com/coding/v1', providerApi: c.api,
        model: { api: c.modelApi, ...budget } };
      const before = structuredClone(input);
      const expected = c.builtin ? budget.contextWindow ?? budget.context ?? c.expected : budget.context ?? budget.contextWindow ?? c.expected;
      expect(resolveKimiContextBudget(input)).toEqual({ context: expected,
        projection: c.builtin ? 'builtin' : 'ordinary',
        source: Object.keys(budget).length ? 'explicit' : c.builtin ? 'builtin' : 'reference' });
      expect(input).toEqual(before);
    }
  });

  it('uses model API ahead of provider-owned known API and provider API', () => {
    const input = { provider: 'kimi-coding', modelId: 'kimi-for-coding',
      baseUrl: 'https://proxy.example/coding/v1', providerApi: 'openai-completions',
      providerKnownApi: 'anthropic-messages' };
    expect(resolveKimiContextBudget(input)?.context).toBe(1048576);
    expect(resolveKimiContextBudget({ ...input, model: { api: 'openai-completions' } })?.context).toBe(262144);
    expect(resolveKimiContextBudget({ ...input, provider: 'proxy' })).toBeUndefined();
    expect(resolveKimiContextBudget({ ...input, modelId: 'k3' })).toBeUndefined();
  });
});
