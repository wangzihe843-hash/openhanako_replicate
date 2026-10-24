import { afterAll } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const policyPath = require.resolve("../../shared/update-policy.cjs");
const original = require(policyPath);
require.cache[policyPath]!.exports = Object.freeze({ ...original, onlineUpdatesEnabled: true });
afterAll(() => {
  require.cache[policyPath]!.exports = original;
  for (const name of ["../../shared/artifact-core/ota-core.cjs", "../../desktop/src/shared/artifact-ota.cjs", "../../desktop/src/shared/update-digest-history.cjs"]) {
    delete require.cache[require.resolve(name)];
  }
});
