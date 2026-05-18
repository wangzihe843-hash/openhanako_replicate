# `xingye_propose_draft`：心跳巡检 → 待确认草稿

让 agent 在心跳巡检里向小手机/秘密空间各模块**主动生成草稿**、用户**确认后**才进「已生成」列表的一整套流水线。本文是给后续接新模块（Schedule、Moments、Mail、Secret Space 各类等）的人看的——告诉你要碰哪几个文件、为什么这么分、有哪些坑。

> 本文只描述既有约定，**与代码冲突时以代码为准**。代码入口见各 §「关键文件」表。

---

## 1. 三层结构

```
┌──────────────────────────────────────────────────────────────┐
│ Skill 层（agent 看到的指导）                                 │
│   skills2set/xingye-{module}-draft/SKILL.md                  │
│   → SkillManager 启动时扫盘 → Pi SDK 注入 agent system prompt│
└──────────────────────────────┬───────────────────────────────┘
                               │ 读完决定要不要写
                               ▼
┌──────────────────────────────────────────────────────────────┐
│ Tool 层（agent 真正调用的入口，单一 dispatch）               │
│   lib/tools/xingye-propose-draft-tool.js                     │
│   → execute switch(module) → 各模块 append{Module}DraftServer│
└──────────────────────────────┬───────────────────────────────┘
                               │ 写盘到
                               ▼
┌──────────────────────────────────────────────────────────────┐
│ Store / UI 层（用户看到与确认草稿的地方）                    │
│   HANA_HOME/agents/{agentId}/xingye/{module}/drafts.jsonl    │
│   ├─ 渲染端 store：list/append/confirm/discard {Module}Draft │
│   └─ Phone{Module}App.tsx：「待确认草稿」分组 + 确认/丢弃   │
└──────────────────────────────────────────────────────────────┘
```

确认（confirm）路径：把 draft 从 `{module}/drafts.jsonl` 原子地搬到 `{module}/entries.jsonl`（或该模块对应的「已生成」存储），并发对应的 `{module}.entry_appended` + `{module}.draft_confirmed` 事件。丢弃（discard）只删 draft，不进 entries、不发 entry_appended。

---

## 2. 加新模块的步骤清单

以加 `schedule` 为例。新模块叫 `{module}` = `schedule`，下文按这个占位符写。

### 2.1 服务端

| 步骤 | 文件 | 改什么 |
| --- | --- | --- |
| ① | `lib/xingye/{module}-drafts.js` | 新建 `append{Module}DraftServer({ agentDir, agentId, input })`。参考 [lib/xingye/journal-drafts.js](../lib/xingye/journal-drafts.js)，落 `{module}/drafts.jsonl` + 发 `{module}.draft_proposed` 事件。 |
| ② | `lib/tools/xingye-propose-draft-tool.js` | `SUPPORTED_MODULES` 加 `"{module}"`；schema 加一个 `{module}: Type.Optional(Type.Object({...}))` 块描述该模块的 payload 字段；execute switch 加 `case "{module}"` 调 (①) 的 helper。 |
| ③ | `desktop/src/react/xingye/xingye-event-log.ts` 和 `lib/xingye/heartbeat-consumer.js` 的 `TYPE_LABEL_ZH` / `TYPE_ORDER_ZH` | 把 `{module}.draft_proposed / discarded / confirmed` 三个事件类型登记进去，否则心跳摘要里就显示 raw type 字符串。 |
| ④ | `lib/desk/heartbeat.js` 的 mustPropose directive 菜单（中文 + English 两段） + `tests/heartbeat-auto-draft-directive.test.js` 的模块名断言 | **容易忘——2026-05 接入 6 个模块时全部跳过了这一步**。`computeAutoDraftStaleness` 用 `.endsWith(".draft_proposed")` 判断阈值，本身模块无关；但 mustPropose=true 时给 agent 看的 directive 列表是硬编码的，新模块不补进去 → 强制产出时 agent 永远不会从这个模块挑。directive 里写一行 `` - `{module}`（模块中文说明） ``，测试里加 `expect(prompt).toContain("{module}")`。 |

### 2.2 渲染端 store

| 步骤 | 文件 | 改什么 |
| --- | --- | --- |
| ⑤ | `desktop/src/react/xingye/xingye-{module}-store.ts` | 加 `XINGYE_{MODULE}_DRAFTS_JSONL` 常量 + `XingyeXxxDraft` 类型 + `list{Module}Drafts` / `append{Module}Draft` / `discard{Module}Draft` / `confirm{Module}Draft` 四个函数。参考 [xingye-journal-store.ts](../desktop/src/react/xingye/xingye-journal-store.ts) 的 draft 区块；`confirm` 内部先 append 到 entries 再删 draft（写入失败保留 draft 不重复写 entry）。 |

### 2.3 渲染端 UI

| 步骤 | 文件 | 改什么 |
| --- | --- | --- |
| ⑥ | `desktop/src/react/xingye/Phone{Module}App.tsx` | 顶部加「待确认草稿」分组：可行内编辑、`确认生成` / `丢弃` 两个按钮，busy 状态隔离。参考 [PhoneJournalApp.tsx](../desktop/src/react/xingye/PhoneJournalApp.tsx) 的 `pendingDrafts` 区块。 |

### 2.4 Skill 文档（最重要——别跳过）

| 步骤 | 文件 | 改什么 |
| --- | --- | --- |
| ⑦ | `skills2set/xingye-{module}-draft/SKILL.md` | 写一份 skill markdown：触发条件、必填字段、写作要点（第一人称、贴角色、`reason` 必填、宁可不写）、不要做什么。**必须**带 `display-name-{lang}` 覆盖，见 §3。 |

### 2.5 测试

| 步骤 | 文件 | 改什么 |
| --- | --- | --- |
| ⑧ | `desktop/src/react/xingye/xingye-{module}-store.test.ts` | 复制 journal store 的 draft 子 describe（list/append/discard/confirm + 不写 entries）改成本模块字段。 |
| ⑨ | `desktop/src/react/xingye/xingye-producer-events.test.ts` | 加「`{module}-store drafts` producer 契约」一段，确认 `{module}.draft_proposed/discarded/confirmed` 三个事件按预期触发。 |
| ⑩ | `tests/xingye-{module}-drafts.test.js` 或扩 `tests/xingye-journal-drafts.test.js` | 验证 dispatch tool 的 `module="{module}"` 分支 + `append{Module}DraftServer` 直接 fs 写。 |
| ⑪ | **`desktop/src/react/xingye/Phone{Module}App.test.tsx` 的 `pending draft section` describe**（已有就 append、没有就新建） | **容易忘——2026-05 接入的 6 个模块里 5 个跳过了**。最少 4 条 case：(a) 无草稿不渲染段、(b) confirm 转发字段、(c) discard 调对 + 不漏调 confirm/append、(d) 取消 `window.confirm` 草稿保留。mock `./xingye-{module}-drafts` 模块，参考 [PhoneMailApp.test.tsx](../desktop/src/react/xingye/PhoneMailApp.test.tsx)。 |

**[tests/xingye-propose-draft-skill-sync.test.js](../tests/xingye-propose-draft-skill-sync.test.js)** 这个不变量测试**不需要改**——它会自动校验你新加的 enum 项有对应 `skills2set/xingye-{module}-draft/SKILL.md`，反向也校验。enum 和 skill 漂了直接红。

> ⚠️ **directive 菜单（步骤 ④）和 UI 集成测试（步骤 ⑪）目前没有不变量测试守着**——SUPPORTED_MODULES 加了一项、忘做这两步，没有任何东西会红。提交前手动 grep：
> ```
> grep -nE "\"{module}\"|'{module}'|`{module}`" lib/desk/heartbeat.js tests/heartbeat-auto-draft-directive.test.js desktop/src/react/xingye/Phone{Module}App.test.tsx
> ```
> 三个文件都至少有一处命中才算齐活。

---

## 3. 命名约定：为什么必须写 `display-name-{lang}`

> 这是 `xingye-journal-draft` 上线时踩的坑：UI 显示成了「兴业草稿」而不是「星野日记草稿」。

Skill 默认显示名走 [core/llm-utils.js](../core/llm-utils.js) 的 `translateSkillNames`——把英文 kebab-case 名字喂给翻译模型出短中文名。**模型不知道项目术语**：

- `xingye` 在这个项目里是「星野」（character / 产品线名）
- 翻译模型按拼音 fallback 会翻成「兴业」（兴盛事业），完全不是本意

[lib/skills/skill-metadata.js](../lib/skills/skill-metadata.js) 支持的 frontmatter 覆盖字段：

```yaml
---
name: xingye-{module}-draft
description: "..."
display-name-zh: 星野{中文}草稿
display-name-zh-TW: 星野{繁中}草稿
display-name-ja: 星野{日文}下書き
display-name-ko: 호시노 {韩文} 초안
---
```

[lib/skills/skill-name-translation-cache.js](../lib/skills/skill-name-translation-cache.js) 翻译前**先查 `skill.displayNames[lang]`**：命中 → 直接用、不调模型、不写缓存（确定性、不依赖外部模型）；没有 → 才走 LLM 兜底。所以：

- **所有 `xingye-*` 命名的 skill 都必须写 `display-name-zh` 和 `display-name-zh-TW`**（中文圈用户主力）
- 日韩可选；不写就走 LLM 翻译，会得到一个合理但不一定贴项目的译名
- 字符串长度上限 60 个码点，trim 后空字符串被忽略

支持的位置（优先级低→高）：

```yaml
display-name-zh: 顶层值
metadata:
  display-name-zh: metadata-块的值  # 这个赢
```

---

## 4. 关键不变量

跑下面这几个测试就知道改没改对：

| 测试 | 守的是 |
| --- | --- |
| [tests/xingye-propose-draft-skill-sync.test.js](../tests/xingye-propose-draft-skill-sync.test.js) | dispatch enum ↔ `skills2set/xingye-{module}-draft/` 目录双向同步 |
| [tests/heartbeat-auto-draft-directive.test.js](../tests/heartbeat-auto-draft-directive.test.js) | mustPropose=true 时的 directive prompt 含全部模块名（**只是"含字符串"级别的断言，不能自动发现新模块没补**——加新模块时手动同步） |
| [tests/tool-categories.test.js](../tests/tool-categories.test.js) | `xingye_propose_draft` 在 OPTIONAL_TOOL_NAMES 白名单里 |
| [tests/optional-tool-names-drift.test.js](../tests/optional-tool-names-drift.test.js) | 前端 [AgentToolsSection.tsx](../desktop/src/react/settings/tabs/agent/AgentToolsSection.tsx) 的本地副本与 `shared/tool-categories.js` 同步 |
| [tests/skill-metadata.test.js](../tests/skill-metadata.test.js) | `display-name-{lang}` 解析行为（顶层 / 嵌套 / 空字符串 / 截断） |
| [tests/skill-name-translation-cache.test.js](../tests/skill-name-translation-cache.test.js) | override 短路 LLM、不持久化到缓存；部分语言未覆盖时仍走 LLM 兜底 |

---

## 5. 跑通的快速验证

加完新模块后，dev 模式下：

1. 重启 `npm run start:dev`
2. 把新 skill 复制到 `HANA_HOME/skills/`（每次启动 `syncSkills` 也会做，dev 模式下指向源码仓的话直接同步；指向安装包的话手拷一次）
3. 删除 `HANA_HOME/.ephemeral/skill-name-translations.json` 让 SkillManager 重读
4. 在「设置 → 技能」里给当前 agent 启用 `xingye-{module}-draft`
5. 在「设置 → 助手 → 工具」里确认「星野草稿提议」是开的（默认开）
6. 触发一次心跳巡检，让 agent 真去调一次 `xingye_propose_draft({ module: "{module}", ... })`
7. 打开对应的 Phone{Module}App，应该看到顶部「待确认草稿」分组，点确认/丢弃验证两路径

如果 (6) 没产生草稿，agent 大概率没看到 skill：检查 `config.skills.enabled` 里有没有这个 name，或者翻译缓存是不是把 skill 名字翻得奇怪让 agent 没识别。
