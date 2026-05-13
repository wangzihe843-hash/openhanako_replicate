# Xingye lore in prompts: chat (OpenHanako) vs desktop runtime collector

Two different code paths feed Xingye设定 into LLM prompts. They are **not** interchangeable: confusing them leads to the wrong conclusion that `insertionMode === "always"` lore is “missing” when it does not appear next to keyword hits.

## OpenHanako **chat** system prompt (`core/agent.js` + `shared/*`)

The agent builds two **separate** sections when stable / runtime lore is available:

1. **Stable / “always”-style core lore → `# 星野核心设定`**  
   The Markdown heading used in the assembled system prompt is `# 星野核心设定` (see `core/agent.js` around the `section("# 星野核心设定", …)` call). The body is produced by `readXingyeStableLoreMemoryForPromptSync` from `shared/xingye-lore-memory-file.js` (import and call sites in the same file as that heading).

2. **Keyword-triggered runtime lore → `# 星野设定参考`**  
   For chat, runtime text comes from `buildXingyeRuntimeLoreContext` in `shared/xingye-lore-context.js`. That helper titles the runtime block with the constant `RUNTIME_LORE_TITLE` (`# 星野设定参考`, same file). Only entries passing `isRuntimeLoreCandidate` are considered there — that predicate requires `insertionMode === 'keyword'` (and other guards), while stable candidates use `isStableLoreCandidate` with `insertionMode === 'always'` and category restrictions.

So for **chat**, “always” lore is **supposed** to show up under the **核心设定** path (managed stable lore file + that prompt section), **not** repeated inside the **设定参考** block. The integration test `tests/agent-xingye-lore-prompt.test.js` encodes this explicitly: an `insertionMode: "always"` entry must **not** appear in the `# 星野设定参考` runtime injection scenario (`it("excludes disabled draft manual and always lore from the runtime block", …)`).

**Takeaway:** seeing no `always` rows inside the chat **`# 星野设定参考`** segment is **intentional layering**, not evidence that `always` lore is ignored for chat — it is carried by the **`# 星野核心设定`** branch instead.

### Related naming in shared helpers (not always identical to the final chat heading)

`shared/xingye-lore-context.js` uses bracketed titles inside its own composed stable text (`STABLE_LORE_TITLE` / `【星野核心设定】`) and the `# 星野设定参考` constant for the runtime composer. Chat wraps stable file output under `# 星野核心设定` in `core/agent.js`; do not assume every sub-builder uses the same punctuation as the final agent section title.

## Desktop / in-app AI: `collectXingyeLoreRuntimeContext` (`desktop/.../xingye-lore-runtime-context.ts`)

Phone, relationship-state, and other React-side flows use **`collectXingyeLoreRuntimeContext`** + **`formatXingyeLoreRuntimeContextBlock`**, which render a **`【星野设定参考】`**-prefixed block (see the formatter in that file). That module’s file header documents default inclusion of both `always` and `keyword` modes (`includeAlways` / `includeKeyword` toggles). This is a **different** selection and formatting layer from the chat `buildXingyeRuntimeLoreContext` path above.

When comparing logs or prompts, treat **chat shared/core assembly** and **desktop `collectXingyeLoreRuntimeContext` output** as **parallel implementations**, not one implementation reused in both places.

## Code locations (headings, selection, tests)

### Chat: `core/agent.js`

- Xingye lore-related imports: `readXingyeStableLoreMemoryForPromptSync`, `buildXingyeRuntimeLoreContext`, `readXingyeRuntimeLoreEntriesSync` — lines **40–42**.
- Stable section heading **`# 星野核心设定`**, body from `readXingyeStableLoreMemoryForPromptSync` — lines **1154–1168**.
- Runtime lore from `readXingyeRuntimeLoreEntriesSync` + `buildXingyeRuntimeLoreContext`, appended after `---` — lines **1174–1190**.

### Chat: `shared/xingye-lore-memory-file.js`

- `readXingyeStableLoreMemoryForPromptSync` (stable lore body for the `# 星野核心设定` wrapper) — line **315** onward.

### Chat: `shared/xingye-runtime-lore-file.js`

- `readXingyeRuntimeLoreEntriesSync` (loads JSON entries fed into `buildXingyeRuntimeLoreContext`) — line **99** onward.

### Chat: `shared/xingye-lore-context.js`

- `STABLE_LORE_TITLE` → **`【星野核心设定】`** — line **3**.
- `RUNTIME_LORE_TITLE` → **`# 星野设定参考`** — line **6**.
- Stable vs runtime **candidate predicates**: `isStableLoreCandidate` requires `insertionMode === 'always'` (and category allow-list) — lines **52–60**; `isRuntimeLoreCandidate` requires `insertionMode === 'keyword'` — lines **63–71**.
- `buildXingyeRuntimeLoreContext` filters with `isRuntimeLoreCandidate` then keyword match — lines **214–232**.

### Chat: regression expectations — `tests/agent-xingye-lore-prompt.test.js`

- Injects **`# 星野设定参考`** when keyword runtime lore matches — lines **166–177**.
- Asserts **`insertionMode: "always"`** workspace lore is **not** in the runtime block (among other exclusions) — lines **208–227**.
- Ordering: **`# 星野核心设定`** appears before **`# 星野设定参考`** when both exist — lines **230–244**.

### Desktop: `desktop/src/react/xingye/xingye-lore-runtime-context.ts`

- Module contract: default inclusion of `always` / `keyword`, `includeAlways` / `includeKeyword` toggles — lines **8–16** and options type **48–55**.
- `collectXingyeLoreRuntimeContext` selection loop (`always` vs `keyword` branches) — lines **158–204**.
- `formatXingyeLoreRuntimeContextBlock` → **`【星野设定参考】`** prefix — lines **227–232**.

### Desktop: example call sites

- `desktop/src/react/xingye/xingye-phone-ai.ts` — `collectXingyeLoreRuntimeContext` / `formatXingyeLoreRuntimeContextBlock` — lines **102–107**.
- `desktop/src/react/xingye/xingye-state-ai.ts` — same for relationship-state lore — lines **57–62**.

### Other UI copy

- `desktop/src/react/xingye/xingye-phone-prompts.ts` — **`【关于上方"星野设定参考"】`** (prompt guidance string), line **23**.
