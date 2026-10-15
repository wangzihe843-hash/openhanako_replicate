// Node 24, no installed packages. Executes the actual policy and both lookup
// implementations. The loader only supports their browser JSON/extensionless
// import syntax; it does not replace any product function or model data.
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { URL } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('/model-context-defaults')) specifier += '.ts';
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith('/known-models.json') || url.endsWith('/known-model-fallbacks.json')) {
      return { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
const { kimiContextChecks } = await import('../fixtures/kimi-context-checks.ts');
for (const check of kimiContextChecks) test(check.name, check.run);
