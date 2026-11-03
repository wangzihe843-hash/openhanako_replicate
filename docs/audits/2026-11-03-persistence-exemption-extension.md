# Limited persistence exemption extension — 2026-11-03

Twelve existing exemptions move from **2026-10-31** to **2026-11-17**, inclusive in UTC. The existing default scanner rejects them from **2026-11-18**. There is no automatic renewal. Review remaining work by 2026-11-10.

This bounded extension unblocks the PC01 compatible source review while inherited persistence ownership work is repaired in small changes. It does not establish ownership or runtime safety for the **110 deferred write sites**. IDs, owners, reasons, kinds, match expressions and source scope are unchanged. Some rules match a whole source file; that existing attribution gap remains until each target is proved.

Point identities remain in `build/persistence-store-inventory.json`, selected by the exact `exemptionId` below (sourceFile, kind, excerpt, ordinal). The frozen source hashes and all 110 line/kind locations below make this review reproducible. Lines are review locators; the inventory uses excerpt/ordinal identities. Each listed source is byte-identical to feature `04a2b8544fd0b02bab13ce18039a69d64186bbb7`.

| Exemption ID | Deferred sites | Follow-up |
| --- | ---: | --- |
| `character-card-copy-helper` | 2 | Prove the current copyPlanAsset staging destinations. |
| `compat-directory-seeding` | 1 | Attribute each fixed directory target. |
| `conditional-plugin-install-cleanup` | 2 | Separate installation staging and operating-system temp cleanup. |
| `conditional-upload-target` | 4 | Prove both session-files and legacy-upload branches. |
| `config-scope-migration-helper` | 2 | Attribute original-config backup and cleanup writes. |
| `cross-store-first-run-bootstrap` | 15 | Attribute each seeded template and backup target. |
| `cross-store-legacy-migrations` | 70 | Review individual migration functions and targets in small changes. |
| `data-epoch-durable-json-primitive` | 5 | Attribute the atomic JSON primitive to its stamp/journal callers. |
| `desktop-gpu-json-primitive` | 3 | Close ownership of the fixed GPU JSON targets. |
| `desktop-legacy-update-path-cleanup` | 2 | Prove the exact legacy paths and cleanup bounds. |
| `local-user-account-atomic-helper` | 2 | Attribute users/auth targets and secret-write behavior. |
| `server-identity-atomic-helper` | 2 | Attribute server-node and registry callers. |

## Frozen point scope

All entries below have old expiry `2026-10-31` and new expiry `2026-11-17`. The ownerModule equals the sourceFile for these twelve rules.

- `character-card-copy-helper` — `lib/character-cards/service.ts`; SHA-256 `112054f0c2c8fe85133a5cede25bc67cb01814439e618012674a51b78b34d8ea`.
  Points: `482:copy-file`, `476:mkdir`.

- `compat-directory-seeding` — `lib/compat/checks/dirs.ts`; SHA-256 `e9b0e9483cc1955176ed4e0ac7b9438bcbda22c5a7419ea9138f93ef3cfbdfe3`.
  Points: `28:mkdir`.

- `conditional-plugin-install-cleanup` — `server/routes/plugins.ts`; SHA-256 `dc8b63823c194138f8e61938dd64761c5e5e9e1195f3bc04e5c71ed660413ea5`.
  Points: `427:remove-path`, `561:remove-path`.

- `conditional-upload-target` — `server/routes/upload.ts`; SHA-256 `8964c68cd4a0f3ce2460320eb864a3e686b78b7ddc6f83c71695137522f64de8`.
  Points: `386:copy-file`, `279:mkdir`, `439:mkdir`, `498:write-file`.

- `config-scope-migration-helper` — `shared/migrate-config-scope.ts`; SHA-256 `e8606c87dfd1a05965c577283bc20a2193c954eda0a01593182d3eef7c13a454`.
  Points: `160:secret-write`, `157:secret-write`.

- `cross-store-first-run-bootstrap` — `core/first-run.ts`; SHA-256 `777c14715fc64339aa138e8dbc6089e48212dcc416bddd18b79361d1cc299413`.
  Points: `188:copy-file`, `243:copy-file`, `176:mkdir`, `254:mkdir`, `179:mkdir`, `180:mkdir`, `177:mkdir`, `178:mkdir`, `58:mkdir`, `111:mkdir`, `59:mkdir`, `164:rename`, `201:secret-write`, `127:write-file`, `118:write-file`.

- `cross-store-legacy-migrations` — `core/migrations.ts`; SHA-256 `327e13a641eb6800931e6a5dd23a546bbb2b93f1a75a51946bfc3dee4326e5b6`.
  Points: `4020:atomic-write`, `1691:atomic-write`, `2988:atomic-write`, `3248:atomic-write`, `4656:atomic-write`, `3281:atomic-write`, `2740:atomic-write`, `4641:atomic-write`, `1182:atomic-write`, `2185:copy-file`, `2303:copy-file`, `3089:copy-file`, `2180:mkdir`, `2298:mkdir`, `718:mkdir`, `3085:mkdir`, `695:mkdir`, `3258:mkdir`, `3131:mkdir`, `4451:persistent-store-constructor`, `4545:persistent-store-constructor`, `4544:persistent-store-constructor`, `3183:remove-path`, `3088:remove-path`, `3097:remove-path`, `4685:rename`, `4703:rename`, `4750:rename`, `4774:rename`, `3678:rename`, `1606:rename`, `3952:rename`, `4076:rename`, `3095:rename`, `1501:secret-write`, `3835:secret-write`, `4216:secret-write`, `3338:secret-write`, `2462:secret-write`, `2546:secret-write`, `2194:secret-write`, `2312:secret-write`, `3846:secret-write`, `4177:secret-write`, `390:secret-write`, `899:secret-write`, `959:secret-write`, `1054:secret-write`, `1115:secret-write`, `2594:secret-write`, `2756:secret-write`, `3728:secret-write`, `1417:secret-write`, `1474:secret-write`, `3516:secret-write`, `3090:write-file`, `3970:write-file`, `4034:write-file`, `4122:write-file`, `719:write-file`, `696:write-file`, `643:write-file`, `1605:write-file`, `3677:write-file`, `3951:write-file`, `4075:write-file`, `4684:write-file`, `4702:write-file`, `4749:write-file`, `4773:write-file`.

- `data-epoch-durable-json-primitive` — `shared/data-epoch.cjs`; SHA-256 `3b30685f891b9321e68efde0970ec941bb77e5cbe58d4d380c20f23d2b59d916`.
  Points: `227:mkdir`, `241:remove-path`, `237:rename`, `232:write-file`, `233:write-file`.

- `desktop-gpu-json-primitive` — `desktop/src/shared/gpu-startup-policy.cjs`; SHA-256 `874f5d91f399529964a3300ea6c3944203e35c9e5322f45f900432629e3e825c`.
  Points: `77:mkdir`, `80:rename`, `79:write-file`.

- `desktop-legacy-update-path-cleanup` — `desktop/auto-updater.cjs`; SHA-256 `d790888c6739e46969ca3ec6783338429e71aa502cb2c6efaea47c3c66e63d42`.
  Points: `504:remove-path`, `501:remove-path`.

- `local-user-account-atomic-helper` — `core/local-user-account.ts`; SHA-256 `60b10db11a7b00f48cc396a845267301d39390f7c1bfb5a81375e279c58db1a6`.
  Points: `256:mkdir`, `257:secret-write`.

- `server-identity-atomic-helper` — `core/server-identity.ts`; SHA-256 `6f8cb08f4a5c8f938cb6e0a6d4da41e9bdaa1e35b4a665fd310fbc08f5bd45e2`.
  Points: `189:atomic-write`, `188:mkdir`.

## Compatibility and limits

PC01 adds the read-only GET `/config.channelUserName` snapshot and rejects PUT of that derived field before writes. Editable `user.name` remains authoritative. Group-chat self-skip retry handling uses the existing optional `retryable` field; no historical rows or data layouts are migrated. The formal fingerprint review preserves all earlier compatibility and rollback restrictions.

The expected receipt delta is twelve exemption deadlines and the already-registered `agent-memory` executable digest for `server/routes/config.ts`, plus payload/review seals. The census remains 65 stores and 905 sites, including these same 110 deferred sites. Startup phases, ownership assignments, schema contracts, SQLite schemas, source digest method/compiler and DATA_EPOCH 1 remain unchanged. Passing this date gate records a temporary exception; it does not certify mixed-version use, safe shared-home downgrade, or completed persistence attribution. Code rollback must restore matching source and generated receipts together and cannot undo stored messages or writes.
