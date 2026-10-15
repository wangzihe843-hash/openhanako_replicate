export const officialKimiEndpoints = ['api.kimi.com', 'api.kimi.ai'].flatMap(host =>
  ['/coding', '/coding/', '/coding/v1', '/coding/v1/', '/coding/v1///'].flatMap(pathname =>
    [`https://${host}${pathname}`, `https://${host}:443${pathname}`]));

export const nonOfficialKimiEndpoints = [
  undefined, '', 'not a URL', 'https://api.kimi.com', 'http://api.kimi.com/coding',
  'https://proxy.example/coding', 'https://api.kimi.com.evil.example/coding',
  'https://sub.api.kimi.com/coding', 'https://api.kimi.ai.evil.example/coding',
  'https://api.kimi.com:8443/coding', 'https://api.kimi.ai:80/coding',
  'https://user@api.kimi.com/coding', 'https://user:pass@api.kimi.ai/coding',
  'https://@api.kimi.com/coding', 'https://api.kimi.com/coding?x=1',
  'https://api.kimi.com/coding?', 'https://api.kimi.ai/coding#x', 'https://api.kimi.ai/coding#',
  'https://api.kimi.com/coding/v2', 'https://api.kimi.com/coding/v1/models',
  'https://api.kimi.com/coding-extra', 'https://api.kimi.com/CODING',
  'https://api.kimi.com//coding', 'https://api.kimi.com/other/../coding',
  'https://api.kimi.com/coding/./v1', 'https://api.kimi.com/%63oding',
  'https://api.%6bimi.com/coding', 'https://api.kimi.com./coding',
  ' https://api.kimi.com/coding', 'https://api.kimi.com/coding\n',
  'https://api.kimi.com\\coding', 'https:////api.kimi.com/coding',
];

export const kimiExplicitBudgets: Array<{ context?: number; contextWindow?: number }> = [
  { context: 262144 }, { context: 1048576 }, { context: 123456 },
  { contextWindow: 262144 }, { contextWindow: 1048576 }, { contextWindow: 123456 },
  { context: 123456, contextWindow: 234567 },
];

export type KimiModelEntry = string | {
  id: string;
  api?: string;
  name?: string;
  context?: number;
  contextWindow?: number;
};

// Independent expectations for the existing runtime projection, including the
// .com transport override. Do not derive these from the production resolver.
const endpoints = [
  { label: 'com', base_url: 'https://api.kimi.com/coding/v1', ordinary: 1048576, providerBuiltin: false },
  { label: 'ai', base_url: 'https://api.kimi.ai/coding/v1', ordinary: 1048576, providerBuiltin: true },
  { label: 'proxy', base_url: 'https://proxy.example/coding/v1', ordinary: 262144, providerBuiltin: true },
  { label: 'missing', base_url: undefined, ordinary: 1048576, providerBuiltin: false },
];
const apis = [undefined, 'openai-completions', 'anthropic-messages'];
export const kimiProjectionCases = endpoints.flatMap(endpoint => apis.flatMap(api => apis.map(modelApi => {
  const builtin = modelApi === 'anthropic-messages'
    || (!modelApi && api === 'anthropic-messages' && endpoint.providerBuiltin);
  return { ...endpoint, api, modelApi, builtin, expected: builtin ? 1048576 : endpoint.ordinary };
})));

interface KimiDiscoveryCase {
  label: string;
  source: { base_url?: string; api?: string; models: KimiModelEntry[] };
  request: { base_url?: string; api?: string };
  forceDefaults: boolean;
  add: boolean;
  expected: number;
}

const reviewBudgets = [{}, { context: 262144 }, { contextWindow: 1048576 }, { context: 123456, contextWindow: 234567 }];
export const kimiDiscoveryCases: KimiDiscoveryCase[] = [];
for (const c of kimiProjectionCases) {
  for (const [index, budget] of reviewBudgets.entries()) {
    kimiDiscoveryCases.push({
      label: `same/${c.label}/${c.api}/${c.modelApi}/${index}`,
      source: { base_url: c.base_url, api: c.api, models: [{ id: 'kimi-for-coding', ...(c.modelApi ? { api: c.modelApi } : {}), ...budget }] },
      request: {}, forceDefaults: false, add: false,
      expected: c.builtin ? budget.contextWindow ?? budget.context ?? c.expected : budget.context ?? budget.contextWindow ?? c.expected,
    });
  }
}
for (const source of endpoints.slice(0, 3)) for (const target of kimiProjectionCases.filter(c => c.base_url && c.api)) {
  for (const api of apis.slice(1)) for (const budget of [reviewBudgets[0], reviewBudgets[3]]) {
    if (source.base_url === target.base_url && api === target.api) continue;
    kimiDiscoveryCases.push({
      label: `switch/${source.label}-${target.label}/${api}-${target.api}/${target.modelApi}/${JSON.stringify(budget)}`,
      source: { base_url: source.base_url, api, models: [{ id: 'kimi-for-coding', ...(target.modelApi ? { api: target.modelApi } : {}), ...budget }] },
      request: { base_url: target.base_url, api: target.api }, forceDefaults: false, add: false,
      expected: target.builtin ? budget.contextWindow ?? budget.context ?? target.expected : budget.context ?? budget.contextWindow ?? target.expected,
    });
  }
}
for (const c of kimiProjectionCases.filter(c => !c.modelApi)) for (const forceDefaults of [false, true]) {
  kimiDiscoveryCases.push({
    label: `pending/${c.label}/${c.api}/${forceDefaults}`,
    source: { base_url: c.base_url, api: c.api, models: [] }, request: {}, forceDefaults, add: true, expected: c.expected,
  });
}
