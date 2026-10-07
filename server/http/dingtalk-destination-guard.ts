import type { Context } from "hono";
import { dingTalkCredentialDestinations } from "../../lib/bridge/dingtalk-contract.ts";
import { denySecretMutationWithoutScope, principalHasScope, readAuthPrincipal } from "./capability-guard.ts";

const DESTINATION_FIELDS = ["apiBaseUrl", "restBaseUrl", "streamOpenUrl", "corpId", "authMode"];
type DingTalkConfig = Record<string, unknown> | null | undefined;

function storedSecrets(config: DingTalkConfig) {
  // A canonical empty value can hide a legacy secret until a later null patch
  // deletes that canonical key. Protect every retained copy, including aliases.
  return [config?.clientSecret, config?.appSecret]
    .map(value => value == null ? "" : String(value).trim())
    .filter(Boolean);
}

/** Compare effective destinations, after the caller's own patch/merge rules. */
export function denyDingTalkDestinationChange(c: Context, saved: DingTalkConfig, effective: DingTalkConfig, prefix = "credentials") {
  const principal = readAuthPrincipal(c);
  if (!principal || principalHasScope(principal, "secrets.write")) return null;
  const retained = storedSecrets(effective);
  if (!storedSecrets(saved).some(secret => retained.includes(secret))) return null;

  const beforeConfig = saved || {};
  const afterConfig = effective || {};
  // Ordinary edits must remain possible even when an old endpoint needs repair.
  // Presence matters: deleting a canonical field can activate its legacy alias.
  if (DESTINATION_FIELDS.every(field =>
    Object.hasOwn(beforeConfig, field) === Object.hasOwn(afterConfig, field)
    && beforeConfig[field] === afterConfig[field])) return null;

  const before = dingTalkCredentialDestinations(beforeConfig);
  const after = dingTalkCredentialDestinations(afterConfig);
  const fields = [];
  // The API base also routes subsequent REST calls carrying an access token.
  if (before.apiBaseUrl !== after.apiBaseUrl || before.tokenUrl !== after.tokenUrl) fields.push(`${prefix}.apiBaseUrl`);
  if (before.streamOpenUrl !== after.streamOpenUrl) fields.push(`${prefix}.streamOpenUrl`);
  return denySecretMutationWithoutScope(c, fields);
}
