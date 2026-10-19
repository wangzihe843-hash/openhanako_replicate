# Xingye lore in prompts: chat (OpenHanako) vs desktop runtime collector

Two different code paths feed Xingye设定 into LLM prompts. They are **not** interchangeable: confusing them leads to the wrong conclusion that `insertionMode === "always"` lore is “missing” when it does not appear next to keyword hits.

## OpenHanako **chat** system prompt (`core/agent.ts` + `shared/*`)

The agent builds two **separate** sections when stable / runtime lore is available:

1. **Stable / “always”-style core lore → `# 星野核心设定`**  
   The Markdown heading used in the assembled system prompt is `# 星野核心设定` (see `core/agent.ts` around the `section("# 星野核心设定", …)` call). The body is produced by `readXingyeStableLoreMemoryForPromptSync` from `shared/xingye-lore-memory-file.js`, using current canonical entries with a managed-file fallback for older installs.

2. **Keyword-triggered runtime lore → `# 星野设定参考`**  
   For chat, runtime text comes from `buildXingyeRuntimeLoreContext` in `shared/xingye-lore-context.js`. That helper titles the runtime block with the constant `RUNTIME_LORE_TITLE` (`# 星野设定参考`, same file) and calls `selectXingyeLoreEntries` with `mode: 'keyword'`. The shared selector checks scope/source eligibility, enabled/canonical state and keyword matches before ordering and fitting entries into the caller's character budget.

So for **chat**, “always” lore is **supposed** to show up under the **核心设定** path (the stable file reader + that prompt section), **not** repeated inside the **设定参考** block. The integration test `tests/agent-xingye-lore-prompt.test.js` encodes this explicitly: an `insertionMode: "always"` entry must **not** appear in the `# 星野设定参考` runtime injection scenario (`it("excludes disabled draft manual and always lore from the runtime block", …)`).

**Takeaway:** seeing no `always` rows inside the chat **`# 星野设定参考`** segment is **intentional layering**, not evidence that `always` lore is ignored for chat — it is carried by the **`# 星野核心设定`** branch instead.

### Related naming in shared helpers (not always identical to the final chat heading)

`shared/xingye-lore-context.js` uses bracketed titles inside its own composed stable text (`STABLE_LORE_TITLE` / `【星野始终生效设定】`) and the `# 星野设定参考` constant for the runtime composer. Chat wraps stable file output under `# 星野核心设定` in `core/agent.ts`; do not assume every sub-builder uses the same punctuation as the final agent section title.

## Desktop / in-app AI: `collectXingyeLoreRuntimeContext` (`desktop/.../xingye-lore-runtime-context.ts`)

Phone, relationship-state, and other React-side flows use **`collectXingyeLoreRuntimeContext`** + **`formatXingyeLoreRuntimeContextBlock`**, which render a **`【星野设定参考】`**-prefixed block (see the formatter in that file). That module’s file header documents default inclusion of both `always` and `keyword` modes (`includeAlways` / `includeKeyword` toggles). The collector calls the same `selectXingyeLoreEntries` as the chat runtime wrapper, with its own inputs, mode switches and formatter.

Both callers reuse eligibility, ordering and budget-fit logic: full entries are considered first, then remaining space may hold one shortened entry. Their storage inputs, wrappers and budgets still differ. The desktop store currently omits scope/source metadata and its collector supplies no runtime scope; the chat file readers prefilter those fields. Main chat stable lore retains its separate file-reader path. Server-side Phone context in `shared/xingye-phone-context.js` uses the shared stable and keyword wrappers, then applies the existing section budget.

## Code locations (headings, selection, tests)

### Chat: `core/agent.ts`

- `buildSystemPrompt`: stable heading **`# 星野核心设定`** uses `readXingyeStableLoreMemoryForPromptSync`; runtime lore comes from `readXingyeRuntimeLoreEntriesSync` + `buildXingyeRuntimeLoreContext` after `---`.
- Both sections enter `selectXingyeContextSections` before final prompt assembly.

### Chat: `shared/xingye-lore-memory-file.js`

- `readXingyeStableLoreMemoryForPromptSync`: stable lore body for the `# 星野核心设定` wrapper.

### Chat: `shared/xingye-runtime-lore-file.js`

- `readXingyeRuntimeLoreEntriesSync`: loads and filters JSON entries fed into `buildXingyeRuntimeLoreContext`.

### Chat: `shared/xingye-lore-context.js`

- `STABLE_LORE_TITLE` → **`【星野始终生效设定】`**; `RUNTIME_LORE_TITLE` → **`# 星野设定参考`**.
- `buildXingyeStableLoreMemoryContext` / `buildXingyeRuntimeLoreContext`: call `selectXingyeLoreEntries` with `always` / `keyword` mode and their own formatter/compose functions.
- `selectXingyeLoreEntries`: shared eligibility, keyword matching, ordering, full-entry fit and deferred truncation. Optional `onDecision` details refine exclusion labels without changing selection.

### Chat: regression expectations — `tests/agent-xingye-lore-prompt.test.js`

- Injects **`# 星野设定参考`** when keyword runtime lore matches.
- Asserts **`insertionMode: "always"`** workspace lore is **not** in the runtime block (among other exclusions).
- Ordering: **`# 星野核心设定`** appears before **`# 星野设定参考`** when both exist.

### Desktop: `desktop/src/react/xingye/xingye-lore-runtime-context.ts`

- Module contract: default inclusion of `always` / `keyword`, `includeAlways` / `includeKeyword` toggles.
- `collectXingyeLoreRuntimeContext`: loads store entries and passes mode/query/category-priority options to the shared selector.
- `formatXingyeLoreRuntimeContextBlock` → **`【星野设定参考】`** prefix.

### Desktop: example call sites

- `desktop/src/react/xingye/xingye-phone-ai.ts` — `collectXingyeLoreRuntimeContext` / `formatXingyeLoreRuntimeContextBlock`.
- `desktop/src/react/xingye/xingye-state-ai.ts` — same for relationship-state lore.

### Other UI copy

- `desktop/src/react/xingye/xingye-phone-prompts.ts` — **`【关于上方"星野设定参考"】`** (prompt guidance string).
