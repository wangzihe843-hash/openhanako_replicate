# 桌面端 AI 生成中的 `collectXingyeLoreRuntimeContext`

本文件**只解释现有行为**，不引入新逻辑、不修改任何选择规则。代码以
`desktop/src/react/xingye/xingye-lore-runtime-context.ts` 中的实现为准；本文与代码冲突时，**以代码为准**。

> 范围：本文只覆盖**桌面端**（Electron / `desktop/src/react/xingye/*`）中
> 「小手机（Phone）」「秘密空间（SecretSpace）」「TA 状态（Relationship State）」
> 这三类 AI 生成路径如何取用「星野设定库（Lore）」作为 prompt 背景。
>
> 服务端 / `core/agent.js` / `shared/xingye-lore-context.js` 走的是另一条
> "stable + runtime"（`buildXingyeStableLoreMemoryContext` /
> `buildXingyeRuntimeLoreContext`）链路，**不在本文范围内**。

---

## 1. 关键文件与函数

| 角色 | 文件 | 关键导出 |
| --- | --- | --- |
| 设定库存储（来源） | `desktop/src/react/xingye/xingye-lore-store.ts` | `listLoreEntries`, `XingyeLoreEntry`, `XingyeLoreInsertionMode = 'always' \| 'keyword' \| 'manual'` |
| 运行期挑选器（核心） | `desktop/src/react/xingye/xingye-lore-runtime-context.ts` | `collectXingyeLoreRuntimeContext`, `buildXingyeLoreRuntimeQueryText`, `formatXingyeLoreRuntimeContextBlock` |
| 小手机 AI 生成 | `desktop/src/react/xingye/xingye-phone-ai.ts` | `buildLoreContextForPhone`（内部辅助），各 `*WithAI` 入口 |
| 小手机 prompt 渲染 | `desktop/src/react/xingye/xingye-phone-prompts.ts` | `renderLoreContextSection`（内部辅助），各 `build*Prompt` |
| TA 状态 AI 生成 | `desktop/src/react/xingye/xingye-state-ai.ts` | `buildLoreContextForRelationshipState`（内部辅助），`generateRelationshipStateSuggestion` |
| 秘密空间（预留映射） | `desktop/src/react/xingye/xingye-secret-space-ai-context.ts` | `buildSecretSpaceLoreRuntimeOptions`, `getSecretSpaceLorePurpose` |

`collectXingyeLoreRuntimeContext` 的签名见
`desktop/src/react/xingye/xingye-lore-runtime-context.ts`：

```ts
collectXingyeLoreRuntimeContext(
  agentId: string | null | undefined,
  options?: XingyeLoreRuntimeContextOptions,
  storage?: StorageLike | null,
): XingyeLoreRuntimeContext
```

它**只读** `xingye-lore-store` 中**当前 `agentId` 自身**的条目，不写任何持久层、不调用模型、不做向量检索。

---

## 2. `insertionMode` 三态语义

`XingyeLoreEntry.insertionMode` 取自 `xingye-lore-store.ts` 中的
`XingyeLoreInsertionMode = 'always' | 'keyword' | 'manual'`，
`collectXingyeLoreRuntimeContext` 对三态的处理如下（与
`xingye-lore-runtime-context.ts` 中候选过滤循环一一对应）：

### 2.1 `always` — 长期稳定背景，默认包含

- 含义：**长期稳定的角色背景**，应当在每次 AI 生成时都作为 prompt 背景出现。
- 行为：
  - 默认 `includeAlways !== false` 时，符合
    `enabled === true` && `visibility === 'canonical'` 的 `always` 条目会**直接进入候选**，
    `reason = 'always'`，`matchedKeywords = []`。
  - 不需要任何关键词命中。
- 关闭方式：调用方传 `options.includeAlways = false`（目前桌面端三个 AI
  生成入口都未传，等同于默认启用）。

### 2.2 `keyword` — 命中关键词时按需包含

- 含义：**仅当本轮上下文涉及该条目时**才作为背景出现。
- 行为：
  - 默认 `includeKeyword !== false` 时进入候选筛选；
  - 该条目自身的 `keywords` 必须命中以下任一来源（见
    `collectMatchedKeywords`，`xingye-lore-runtime-context.ts`）：
    1. `options.queryText`：以**整段拼好的查询文本**做大小写不敏感的
       `String.includes` 子串匹配（中文按普通 substring 处理，**不使用正则**）。
    2. `options.keywords`：调用方显式给出的关键词数组，做大小写不敏感的**集合命中**。
  - 至少匹配到一个 keyword 才会进入候选，并且 `matchedKeywords` 字段
    记录的是**条目自身 keywords 中被命中的那些**。
- 关闭方式：调用方传 `options.includeKeyword = false`（桌面端三个 AI
  生成入口都未传，等同于默认启用）。

### 2.3 `manual` — 永远不自动包含

- 含义：**只供用户手动塞入** prompt 的条目（例如带剧透的设定）。
- 行为：在
  `xingye-lore-runtime-context.ts` 的候选循环里，
  `entry.insertionMode === 'manual'` 一律 `continue`，**永远不进入候选**，
  和 `includeAlways` / `includeKeyword` / `keywords` 都无关。

> 三态之外的过滤：候选首先必须满足
> `entry.enabled === true` 且 `entry.visibility === 'canonical'`，
> 否则在 `manual` 之前就被跳过。

---

## 3. 排序、预算与渲染

排序与截断在 `xingye-lore-runtime-context.ts` 中固定：

- **排序**：`listLoreEntries` 已按 `priority` 降序、`updatedAt` 降序排序，
  `always` 与 `keyword` 候选**共用同一份排序**，没有为 `always` 单独提权。
- **分类提权（可选）**：当调用方传入非空 `options.priorityBoostCategories` 时，
  属于这些分类的候选会被**稳定置顶**——整体排到队首，组内仍保持
  `priority` 降序 → `updatedAt` 降序，从而**优先占用 `maxChars` 预算**。
  不传 / 空数组时此步**完全不生效**，排序与上一行一致。具体置顶用的是导出的
  纯函数 `applyCategoryBoostOrder`，同一函数也被各小手机模块的 always 块
  （`buildStableLoreFromAlwaysEntries`）复用，使两条取 lore 路径同步提权。
  当前传入提权的调用方：通讯录/短信（合并读，`['relationship']`）、
  邮件（init **拆 personal / bulk 两段调用**：私人邮件 inbox/sent/drafts 段 `['relationship']`、
  推广/垃圾 promotions/spam 段 `['worldview']` 且硬隔离掉关系状态/通讯录——见
  `generateMailInitDraftsWithAI` 的 `runPass`；两段各自 keyword + always 两路）、
  文件管理（keyword + always 两路，按目标文件夹映射，人际关系/关于 user→`['relationship']`、世界观→`['worldview']`）。
  **TA 状态、朋友圈经评估刻意不提权**：TA 状态只关心「对 user」、笼统提
  `relationship` 会把「对其他 agent」的关系噪声一起提上来；朋友圈对具体实体的
  「看法」来自 phone_contact meta / 关系状态并已按场景分路径注入，lore 分类提权不是正确杠杆。
- **`maxChars`**：默认 `2_000`，三个桌面端调用方目前都显式传 `2_000`（对齐默认）。
- **截断策略**：按排序逐条尝试加入，**累计 `formatEntryBlock` 文本长度**
  超过 `maxChars` 时跳过该条（不做内容截断、不做无界拼接），
  并把 `truncated` 标记为 `true`。
- **渲染**：`formatXingyeLoreRuntimeContextBlock(context)` 在
  `entries` 为空时返回**空字符串**，否则输出形如：

  ```text
  【星野设定参考】
  - 标题：...
    分类：...
    内容：...
  ```

  调用方拿到空串时**必须**跳过整段，不能在 prompt 里写出空标题。

> 注意：`shared/xingye-lore-context.js` 里的
> `buildXingyeStableLoreMemoryContext` / `buildXingyeRuntimeLoreContext`
> 用的是 `【星野核心设定】` / `# 星野设定参考`（带冗长说明） 两套**不同的**
> 渲染模板，**不要**与本文的 `【星野设定参考】` 段落混淆——前者是服务端
> 注入路径，后者是桌面端 AI 生成 prompt 的一段背景参考。

---

## 4. 桌面端三个调用点

以下三处都**只**消费 `collectXingyeLoreRuntimeContext` + `formatXingyeLoreRuntimeContextBlock`
的输出，再交给各自的 `build*Prompt` 渲染。它们都不直接读 lore-store，也不
绕开本节描述的三态规则。

### 4.1 小手机（Phone）

- 调用方：`desktop/src/react/xingye/xingye-phone-ai.ts` 中的
  `buildLoreContextForPhone(...)`（内部辅助）。
- 调用形态（来自 `xingye-phone-ai.ts`）：

  ```ts
  const queryText = buildXingyeLoreRuntimeQueryText([
    ...profileParts,            // ownerProfile 的 displayName / shortBio / identitySummary 等
    recentContext?.summaryText, // 最近聊天摘要
    ...contactParts,            // 至多 20 个联系人的 displayName/remark/impression 等
    ...smsParts,                // 最近短信的 latest / latestContent
    ...reasonParts,             // 变更原因
  ]);
  const context = collectXingyeLoreRuntimeContext(agentId, {
    purpose,                    // 'phone_contacts' | 'phone_sms'
    queryText,
    maxChars: 2_000,
    priorityBoostCategories: ['relationship'], // 关系类设定优先占预算，别被高优先背景/世界观挤掉
  });
  return formatXingyeLoreRuntimeContextBlock(context);
  ```

- `purpose` 取值：
  - `'phone_contacts'`：联系人补全 / 增量更新 / 全量重生成 / 回滚后更新。
  - `'phone_sms'`：短信首次生成 / 增量更新。
- 产物 `loreContextText` 透传给 `xingye-phone-prompts.ts` 中的各
  `buildContactsEnrichmentPrompt` / `buildVirtualContactGenerationPrompt`
  / `buildContactRegenerateAllPrompt` / `buildContactIncrementalUpdatePrompt`
  / `buildContactRollbackAndUpdatePrompt` / `buildSmsHistoryPrompt`
  / `buildSmsIncrementalUpdatePrompt`，由 `renderLoreContextSection` 决定
  是否插入 prompt 段落（空串 / undefined 直接跳过整段）。
- `includeAlways` / `includeKeyword` 均**未显式传入**，因此：
  - 所有 `enabled` && `canonical` && `always` 条目都会被纳入候选；
  - `keyword` 条目要求其 `keywords` 命中上面拼出的 `queryText`
    （也就是 owner 资料 + 最近聊天摘要 + 联系人摘要 + 短信摘要 + 变更原因里
    的任一子串）；
  - `manual` 条目**永远不会**出现在小手机的 prompt 背景里。
- `priorityBoostCategories: ['relationship']` 是小手机链路**独有**的一步：通讯录 / 短信
  本质是关系场景，命中的 `relationship` 类设定会被置顶、优先占满 `maxChars`，避免被
  同预算里 `priority` 更高的背景 / 世界观 lore 挤掉。它**只影响排序与预算占用**，不改变
  「哪些条目有资格成为候选」——`always` 仍默认进、`keyword` 仍要命中 `queryText`、
  `manual` 仍永不进。其它调用点（TA 状态 / 秘密空间预留）都不传此项。

### 4.2 TA 状态（Relationship State）

- 调用方：`desktop/src/react/xingye/xingye-state-ai.ts` 中的
  `buildLoreContextForRelationshipState(...)`（内部辅助），最终被
  `generateRelationshipStateSuggestion(...)` 使用。
- 调用形态（来自 `xingye-state-ai.ts`）：

  ```ts
  const queryText = buildXingyeLoreRuntimeQueryText([
    ...profileParts,                      // displayName / shortBio / identitySummary 等
    ...stateParts,                        // mood / relationshipLabel / stateSummary / lastReason
    params.recentChatSummary.trim() || undefined,
  ]);
  const context = collectXingyeLoreRuntimeContext(params.agentId, {
    purpose: 'relationship_state',
    queryText,
    maxChars: 2000,
  });
  return formatXingyeLoreRuntimeContextBlock(context);
  ```

- `purpose`：固定 `'relationship_state'`。
- 产物 `loreContextText` 由 `xingye-state-prompts.ts` 的
  `buildRelationshipStatePrompt(...)` 消费。
- 三态行为与小手机一致：`always` 默认进；`keyword` 需命中
  「资料 / 当前关系状态 / 最近聊天摘要」拼出的 `queryText`；`manual` 一律不进。
- 当上层调用方已经备好一段 `args.loreContextText`（非空），会**直接复用**而不
  再次调用 `collectXingyeLoreRuntimeContext`——这是出于复用，不影响选择规则。

### 4.3 秘密空间（SecretSpace，预留位）

- 文件：`desktop/src/react/xingye/xingye-secret-space-ai-context.ts`。
- 当前实现仅是**纯映射**，不调用 `collectXingyeLoreRuntimeContext`，
  也不调用模型 / 不写持久层 / 不读任何记忆候选。
  它只把 SecretSpace 的 `category` 映射到 `XingyeLoreRuntimeContextPurpose`
  的预留枚举上：

  | `XingyeSecretSpaceLoreCategory` | `XingyeLoreRuntimeContextPurpose` |
  | --- | --- |
  | `dream` | `secret_space_dream` |
  | `draft_reply` | `secret_space_draft_reply` |
  | `unsent_moment` | `secret_space_unsent_moment` |
  | `saved_item` | `secret_space_saved_item` |
  | `memory_fragment` | `secret_space_memory_fragment` |

- `buildSecretSpaceLoreRuntimeOptions(category, seedText?)` 返回一份可以**之后**
  喂给 `collectXingyeLoreRuntimeContext(agentId, options)` 的 options：

  ```ts
  {
    purpose: CATEGORY_TO_PURPOSE[category],
    queryText: buildXingyeLoreRuntimeQueryText([seedText ?? '']),
    maxChars: 2_000,
    includeAlways: true,
    includeKeyword: true,
  }
  ```

- 在这个**预留**形态下，未来的秘密空间 AI 生成路径若按上述 options 调用
  `collectXingyeLoreRuntimeContext` 也会得到同样的三态语义：`always` 默认全进；
  `keyword` 仅在其 `keywords` 命中 `seedText` 形成的 `queryText` 时被纳入；
  `manual` 永远不会自动进入秘密空间 prompt。

---

## 5. 不变量速查（出 bug 时先核这些）

- 桌面端三个调用点（小手机 / TA 状态 / 预留的秘密空间映射）**都不**显式传
  `includeAlways` / `includeKeyword`，因此都使用默认值「都开」。
- 桌面端三个调用点**都不**直接给 `options.keywords`，关键词只通过
  拼好的 `queryText` 子串匹配命中。
- `manual` 条目在桌面端 AI 生成的 prompt 里**永远是缺席的**——这是
  `xingye-lore-runtime-context.ts` 候选循环的硬规则，不依赖调用方配置。
- 只有 `enabled === true` 且 `visibility === 'canonical'` 的条目才有资格成为候选；
  `private` / `draft` 或 `enabled === false` 的条目，无论 `insertionMode` 是什么，
  都不会出现在桌面端 AI 生成的 prompt 里。
- `formatXingyeLoreRuntimeContextBlock` 返回空串时，调用方**必须**跳过整段；
  各 `xingye-phone-prompts.ts` / `xingye-state-prompts.ts` 的
  `renderLoreContextSection` 已实现这一约束。
- 排序由 `listLoreEntries` 一次性完成（`priority` 降序 → `updatedAt` 降序），
  `always` 与 `keyword` 共用同一序，没有为 `always` 单独提权或单独限额。
  唯一例外是调用方显式传 `priorityBoostCategories`（通讯录/短信、邮件、文件管理传；
  TA 状态、朋友圈刻意不传，理由见 §3）：该分类候选会被稳定置顶、优先占预算，
  但仍只在「已是候选」的条目里重排，不改变候选资格。提权对默认关系 lore 真正
  生效需同时覆盖 always 块——邮件 / 文件管理因此在 `buildStableLoreFromAlwaysEntries`
  里复用同一个 `applyCategoryBoostOrder`（markdown 形态的 lore-memory 无分类维度，无法提权）。

---

## 6. 与 `shared/xingye-lore-context.js` 的关系

- `shared/xingye-lore-context.js` 暴露
  `buildXingyeStableLoreMemoryContext` 与 `buildXingyeRuntimeLoreContext`，
  渲染模板分别是 `【星野核心设定】` 与 `# 星野设定参考`，
  服务于**另一条**（非本文范围的）注入路径。
- 桌面端 AI 生成（小手机 / TA 状态 / 秘密空间预留）**不**经过
  `shared/xingye-lore-context.js`，而是走
  `desktop/src/react/xingye/xingye-lore-runtime-context.ts`，
  渲染模板为 `【星野设定参考】`（无冗长说明）。
- 两条链路的三态语义一致（`always` 默认进、`keyword` 命中才进、`manual` 不进），
  但**实现、模板、入口、调用方都不同**，请勿互相替换或合并使用。
