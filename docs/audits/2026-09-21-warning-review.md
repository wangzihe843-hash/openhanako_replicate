# Warning 与行为问题分块复审（2026-09-21）

> 本报告记录修复前的审查状态；后续修改和最终验证见 [修复与验证报告](2026-09-21-warning-fixes.md)。

本轮由 3 个 subagents 分别审查前端、后端运行时、星野与插件，主任务复核调用链并独立重跑全部复现探针。确认 **9 项可修复问题：1 项 P1、8 项 P2**，其中 8 项为行为问题，另 1 项为主任务在全量验证中发现的测试范围配置问题。这些发现不等于新增了 9 条 lint warning，也不表示已在用户现场发生。

审查基线为 `feature/xingye-mvp`，提交 `fa004739011be91932a58a03e263f2eaa6a7e8f7`；起始工作区干净。本轮只进行审查、验证并新增本报告与忽略目录内的证据，没有修业务代码、更新依赖或 warning baseline，也没有提交、推送。以下 R 编号仅用于本报告，不沿用旧报告编号。

**当前 warning 实测**

执行 `npm run lint:warnings`，退出 0。扫描 2,924 个文件，855 个文件存在 warning，共 **7,888 warning / 0 error**；相对已提交基线新增 0、移除 0。

| 规则 | 总数 | 非测试 | 测试 |
| --- | ---: | ---: | ---: |
| `@typescript-eslint/no-explicit-any` | 7,759 | 4,696 | 3,063 |
| `no-empty` | 129 | 129 | 0 |
| **合计** | **7,888** | **4,825** | **3,063** |

当前 Hook 依赖、未使用变量、`prefer-const` 等规则均没有 warning。测试口径包含 `tests/`、`__tests__/`、`.test.`、`.spec.`；非测试也包含脚本，并不全部是产品运行时代码。显式 `any` 占约 98.36%，需要按接口逐步治理；不能由此推断这些位置全部有 bug。现有 lint 排除 `.cjs` 与生成目录，因此数字也不代表全项目所有运行时警告。

**修复顺序**

| 编号 | 优先级 | 确认的问题 | 建议顺序 |
| --- | --- | --- | --- |
| R01 | P1 | 工作流完成状态保存失败，重放已成功执行的节点 | 最先修，防止重复副作用 |
| R02 | P2 | 图片取消后重试，旧请求覆盖新结果并停止轮询 | 随后修任务轮次隔离 |
| R03 | P2 | 插件清理无限等待，使加载超时失效 | 随后修启动可用性 |
| R04 | P2 | 低优先级长 Lore 挤出最高优先级核心设定 | 修复角色上下文正确性 |
| R05 | P2 | 布尔型媒体默认参数保存成字符串，阻断生成 | 修复设置类型边界 |
| R06 | P2 | 清除或消费后的输入草稿被迟到响应恢复 | 修复草稿加载时序 |
| R07 | P2 | 事件清理丢失自动草稿累计计数 | 修复长期行为触发 |
| R08 | P2 | 归档恢复的 409 冲突分支不可达 | 修复错误反馈及测试 mock |
| R09 | P2 | 默认测试命令误收集本地审查材料 | 补齐测试范围，建议先于下一轮验证处理 |

**R01 · 工作流完成状态保存失败会重放成功节点**

定位：[host-api.ts:309](D:/18133/projects/openhanako_replicate/lib/workflow/host-api.ts:309)，关键行 309–315。`attemptOnce()` 已成功后，`onAgentEvent(done)` 和 journal 记录仍在自动重试的同一个 `try/catch` 内。完成事件经 [workflow-tool.ts:475](D:/18133/projects/openhanako_replicate/lib/tools/workflow-tool.ts:475) 调用 `finishRun()`，后者在 [subagent-thread-store.ts:261](D:/18133/projects/openhanako_replicate/lib/subagent-thread-store.ts:261) 保存状态；底层 `mkdirSync/atomicWriteSync` 的 I/O 异常会向外传播。

默认 `nodeRetries=2`，`EACCES/ENOSPC` 又会被归入可重试异常。因此，执行器成功但完成元数据首次保存失败时，节点执行了 **2 次**后报告成功；持续保存失败时，执行 **3 次**才报告失败。写文件、发送消息等节点若已经完成副作用，就可能重复执行。成功结果还没写入 journal，失败信息中的 resume 提示也不能据此保证跳过这些执行。

修复方向：将节点执行重试与完成结果发布分开，持久化失败不得再次调用执行器；保留已经完成的结果，单独处理结果记录和恢复。验收应注入“执行已成功、完成状态写入失败”，断言执行器始终只调用一次，同时准确向调用方反馈持久化失败。还需覆盖 journal 保存失败、正常执行失败重试与取消。

证据：[探针](D:/18133/projects/openhanako_replicate/.cache/review-20260921/backend-probe.mjs)、[结果](D:/18133/projects/openhanako_replicate/.cache/review-20260921/backend-probe-result.json)。使用真实 workflow tool 和线程 store，仅对 `_save()` 注入错误；执行器以计数器代表已完成动作，没有执行实际外部副作用。

**R02 · 图片取消后重试会接纳上一轮的迟到结果**

定位：[poller.ts:412](D:/18133/projects/openhanako_replicate/core/media/poller.ts:412)，关键行 412–414。查询返回后只检查 `_cancelled.has(taskId)`，而 [add():138](D:/18133/projects/openhanako_replicate/core/media/poller.ts:138) 会清除该标记。图片重试复用同一 taskId，并在 [image-task-runner.ts:479](D:/18133/projects/openhanako_replicate/core/media/image-task-runner.ts:479) 重置状态、重新加入轮询，旧查询仍可能在途。

复现顺序是“旧查询未返回 → 取消 → 重试被接受 → 旧查询返回图片 → 新提交返回新 provider ID”。最终任务是 `status=done`、`adapterTaskId=new-provider-id`，图片却为 `old-attempt.png`；`stillPolled=false`，旧图片还触发完成事件。新生成任务因此失去后续轮询。同一生命周期缺口也出现在读取图片尺寸的 await：在第 357 行或第 442 行等待期间取消，后续仍把 `cancelled` 改回 `done`。

修复方向：为每轮提交/重试建立独立执行版本，所有异步成功、失败、尺寸读取及事件发布前核验版本和活动状态。验收覆盖取消后立即重试、迟到成功、迟到失败、读取尺寸期间取消，断言旧轮次不能修改新任务或发布完成事件。

证据：[探针](D:/18133/projects/openhanako_replicate/.cache/review-20260921/backend-media-probe.mjs)、[结果](D:/18133/projects/openhanako_replicate/.cache/review-20260921/backend-media-probe-result.json)。使用真实 Poller、retryImageTask 和 TaskStore 方法，磁盘保存、provider、图片读取与事件传输由内存夹具替代。

**R03 · 插件清理等待会绕过加载超时**

定位：[plugin-manager.ts:1606](D:/18133/projects/openhanako_replicate/core/plugin-manager.ts:1606)，关键行 1604–1608。加载超时后，[加载边界:634](D:/18133/projects/openhanako_replicate/core/plugin-manager.ts:634) 仍等待 `_cleanupPluginEntry()`；其中 `await instance.onunload()` 没有期限。若初始化等待外部资源、清理又等待同一初始化完成，就无法退出超时处理。

隔离夹具设置加载超时为 30ms；250ms 后 `loadAll()` 仍未结束，故障插件仍为 `loading`，后续正常插件尚未加载。源码中的 Promise 没有后续解除条件，不只是超时计时略有偏差。[engine.ts:2795](D:/18133/projects/openhanako_replicate/core/engine.ts:2795) 在启动时等待 `loadAll()`，故障会阻塞后续初始化。这里使用的是用户允许的 full-access 插件，不是未授权插件执行。

修复方向：为清理增加独立期限，并在插件生命周期钩子不能结束时继续处理可控的 disposables 和贡献注册表；保留迟到回调的取消/版本防护。验收覆盖挂起的 `onload/onunload`，断言加载最终结束、坏插件明确失败、后续正常插件能加载。

**R04 · 高优先级 Lore 会被截出实际模型上下文**

定位：[xingye-lore-memory-file.js:146](D:/18133/projects/openhanako_replicate/shared/xingye-lore-memory-file.js:146)，关键行 146–150。候选按 priority 降序选取，但每块都插到 managed section 开头，最终顺序反转。写入预算只计算正文，读取又对包含标题和标记的完整文本截断至 4000 字符。

使用默认预算，给 priority=100 的 66 字符核心设定和 priority=1 的约 3900 字符背景，写出的文件为 4444 字符；核心正文落在 offset 4334。最终 prompt 长 4000，低优先级背景仍在，最高优先级设定完全消失。[agent.ts:1682](D:/18133/projects/openhanako_replicate/core/agent.ts:1682) 实际将该读取结果注入“星野核心设定”，所以影响模型可见上下文。原始设定仍保存在文件中，本项不是磁盘数据删除。

修复方向：按优先级确定完整输出次序，预算包含标题、标记等开销；已有块未变化或单条更新后也应维持正确顺序。验收覆盖上述两条合法设定、多个同优先级条目、更新顺序变化、边界预算和同步/异步读取一致性。

**R05 · 媒体布尔默认参数被保存成字符串**

定位：[MediaProviderDetail.tsx:183](D:/18133/projects/openhanako_replicate/desktop/src/react/settings/tabs/media/MediaProviderDetail.tsx:183)，关键行 183–189。schema 控件只区分数字和其他类型；布尔参数使用文本框，输入 `true/false` 后直接保存字符串。

复现使用仓库实际 Volcengine 模型 `doubao-seedream-3-0-t2i` 的 `watermark: boolean` schema。真实组件回调产生 `watermark: "true"`；进一步经过真实 Hono 保存路由、配置 manager 方法和配置归一化/校验，返回 **HTTP 200 / ok=true**，native 和 legacy 两套配置仍保留字符串。后续实际 `resolveMediaParameters()` 抛出 `Media parameter "watermark" must be boolean`。同类内置 schema 在 DashScope 也存在，因此用户会看到设置保存成功，该模型模式的后续生成却持续失败，直到清空或纠正默认值。

保存调用链为 [MediaTab.tsx:309](D:/18133/projects/openhanako_replicate/desktop/src/react/settings/tabs/MediaTab.tsx:309) → [media.ts:92](D:/18133/projects/openhanako_replicate/server/routes/media.ts:92) → [universal-media-manager.ts:415](D:/18133/projects/openhanako_replicate/core/media/universal-media-manager.ts:415)。现有保存检查未校验每个 mode 参数的内层 schema；不存在一个下游归一化步骤替界面修正该值。

修复方向：为布尔参数提供保留 JSON 类型的控件，区分“默认/未覆盖”“true”“false”，并在保存端验证内层参数 schema。带 enum 的控件也应按原始枚举类型回写。验收用真实 provider schema 贯通组件、保存路由和参数解析器，覆盖 true、false 和恢复默认，避免只断言字符串 UI 状态。

**R06 · 迟到的草稿加载响应会恢复已经清除的草稿**

定位：[input-draft-persistence.ts:74](D:/18133/projects/openhanako_replicate/desktop/src/react/stores/input-draft-persistence.ts:74)，关键行 74–77。hydrate 只以“当前 drafts 是否还存在这个键”判定是否可写入；[clearDraft:198](D:/18133/projects/openhanako_replicate/desktop/src/react/stores/input-slice.ts:198) 则直接删键，没有记录此次清除发生在加载请求之后。

启动时 [app-init.ts:257](D:/18133/projects/openhanako_replicate/desktop/src/react/app-init.ts:257) 异步加载草稿；用户发送首页内容并创建会话后，[session-actions.ts:1258](D:/18133/projects/openhanako_replicate/desktop/src/react/stores/session-actions.ts:1258) 清除首页草稿。若先前 GET 响应此后才到，旧草稿被作为“缺失键”重新填回。真实 input slice 与 hydration 函数已复现：清除时键不存在，响应到达后又变成旧服务端文本。

修复方向：记录键的修改/清除版本或清除标记，hydrate 只应用请求发起后没有发生本地修改的键；同时保留首次加载与恢复归档的正常填充行为。验收应延迟 GET，在此期间 set/clear/send，再返回旧数据，确认草稿不会复活。完整 React 发送流程本轮只作静态调用链核对，动态验证在 store 层完成。

**R07 · 事件清理破坏自动草稿的累计触发计数**

定位：[heartbeat-consumer.js:664](D:/18133/projects/openhanako_replicate/lib/xingye/heartbeat-consumer.js:664)。`computeAutoDraftStaleness(log.events)` 只统计当前保留的事件；[markConsumed:616](D:/18133/projects/openhanako_replicate/lib/xingye/heartbeat-consumer.js:616) 又会清理超过七天的已消费事件，未保留独立的累计对话数和上次草稿基准。

在隔离时间线上每隔八天增加 20 条对话、从未产出草稿，实际累计到 60、80 条时，返回值始终只有 `chatTurnsSinceLastDraft=40`、`mustPropose=false`。在这种使用节奏下，默认 50 条阈值不能触发。“累计”契约见 [heartbeat.ts:219](D:/18133/projects/openhanako_replicate/lib/desk/heartbeat.ts:219)，不是本轮将窗口计数误当作产品要求。

修复方向：在事件清理前持久化单调计数，并在草稿产出时更新基准，不能从可清理事件窗口重新推算。验收覆盖跨多次保留窗口、重启、草稿产出重置、旧数据迁移和重复事件，避免为了修计数而无限保留事件。

R03、R04、R07 的共同证据：[探针](D:/18133/projects/openhanako_replicate/.cache/review-20260921/xingye-plugin-probes.mjs)、[结果](D:/18133/projects/openhanako_replicate/.cache/review-20260921/xingye-plugin-probe-results.json)。使用缓存目录内合成角色、事件和插件，没有读取真实用户数据或连接真实服务。

**R08 · 归档恢复的 HTTP 409 被默认抛错提前截走**

定位：[session-actions.ts:1394](D:/18133/projects/openhanako_replicate/desktop/src/react/stores/session-actions.ts:1394)，调用在 1394–1401 行，冲突判断在 1403 行。此处调用的 [hanaFetch](D:/18133/projects/openhanako_replicate/desktop/src/react/hooks/use-hana-fetch.ts:66) 默认对非 2xx 抛错，未设置 `throwOnHttpError: false`；因此服务器返回 409 时，代码直接进入 catch，返回 `status: 'error'`，无法进入 `status: 'conflict'` 分支。

真实 HTTP 包装加原始 restoreSession 函数已复现返回通用 error。归档弹窗因此只能显示通用恢复失败，无法说明“同名文件已存在”。本项不意味着覆盖已有会话；服务端冲突保护仍生效。现有单元测试把 hanaFetch mock 成直接返回 409，绕过了生产包装契约，所以未能发现问题。

修复方向：明确使用允许读取 HTTP 错误响应的调用方式，仍将网络异常与其他错误保留为失败。验收使用实际 HTTP 包装，仅 mock 底层 fetch，分别返回 200、409、500 和网络异常。

R05、R06、R08 的共同证据：[探针](D:/18133/projects/openhanako_replicate/.cache/review-20260921/frontend-probe.mjs)、[结果](D:/18133/projects/openhanako_replicate/.cache/review-20260921/frontend-probe-results.jsonl)。探针在内存转译实际源码；组件 Hook/元素树、网络和 store 容器由夹具提供，不是浏览器端到端验证。

**R09 · 默认测试范围遗漏 output 排除，旧审查文件导致整套检查失败**

定位：[vitest.config.js:18](D:/18133/projects/openhanako_replicate/vitest.config.js:18)，相关排除列表为 18–29 行。配置排除了 `.cache/`、`.codex_refs/` 等本地材料，却没有排除已经被 Git 和 ESLint 忽略的 `output/`。默认 `npm test` 因此会执行该目录中的旧探针和测试夹具。

本次默认命令实际收集 1,366 个文件并退出 1。逐文件对照 `git ls-files` 后确认：1,360 个 Git 跟踪的测试文件全部在结果中，1,358 通过、2 个整文件跳过，测试项为 **14,389 通过 / 41 跳过 / 0 失败**；另外 6 个未跟踪文件全部位于 `output/`，包括 1 个仍断言旧 bug 存在的 replay 文件（3 项失败），以及 5 个临时 fixture（收集时 `expect is not defined`）。这不构成产品功能回归，但使日常标准测试命令失败。日志未报告额外的未处理异常或 worker 退出。

先前的[可靠性报告](D:/18133/projects/openhanako_replicate/docs/audits/reliability-fixes-2026-09-13.md:79)通过命令行 `--exclude=**/output/**` 绕开此目录，说明临时排除没有沉淀到默认配置。修复方向是在测试配置排除本地输出目录，并对测试收集范围做验证；保留旧审查证据，不靠删除用户已有材料来让测试通过。

本轮没有修改配置，只执行 `vitest list --filesOnly --exclude 'output/**'` 核验建议范围；该枚举不等于重跑测试，也不把原命令的失败改写成成功。[Git 跟踪结果核对](D:/18133/projects/openhanako_replicate/.cache/review-20260921/test-inventory-summary.json)、[临时排除后的枚举](D:/18133/projects/openhanako_replicate/.cache/review-20260921/test-files-with-output-excluded.json)。

**检查记录与边界**

- `npm run lint:warnings`：通过，7,888 warning，0 error，新增/移除均为 0。[本轮 ESLint 快照](D:/18133/projects/openhanako_replicate/.cache/review-20260921/eslint.json)、[基线比较](D:/18133/projects/openhanako_replicate/.cache/review-20260921/lint-comparison.json)。
- `npm run typecheck`：通过，包含前端、后端与测试三套 TypeScript 检查。
- 完整默认测试命令：**退出 1，整体未通过**；耗时 837.32 秒。仓库测试 14,389 通过、41 跳过、0 失败，失败来自 R09 的 6 个额外本地文件。跳过不计入已验证通过。[完整日志](D:/18133/projects/openhanako_replicate/.cache/review-20260921/full-tests.log)、[原始 JSON](D:/18133/projects/openhanako_replicate/.cache/review-20260921/full-tests.json)。命令为 `npm test -- --maxWorkers=2 --reporter=default --reporter=json --outputFile.json=.cache/review-20260921/full-tests.json`。
- 4 份独立探针包含 11 组故障、时序或配置场景；主任务均已独立复跑，观察结果与 subagent 一致。R01、R02 还由另一名 subagent 交叉检查了 journal、子会话归属、任务 store 等可能的保护，未发现能排除问题的防护。没有发起实际模型请求、生成图片或外部消息。
- 分块审查覆盖前端状态/设置/输入、后端会话与任务/工作流/媒体、星野持久化与上下文/事件、插件授权与生命周期；主任务补查 CLI、Electron 文件 I/O 与监听。不声称穷举每一行源码、每一处 `any` 或每个平台故障。
- 已对照近期修复报告，未把已有 Phone 动态注入、事件锁或原子写保护重复报告。输入草稿的“跨服务器污染”候选因真实切换入口会重载窗口而未列为确认问题。
- 本轮未重做安装包构建、真实 UI 全流程、Linux bwrap 或任意 Windows 用户目录 ACL 验证；这些不能由本轮类型检查和 mock 测试推定已通过。

后续建议先修 R01 与 R09，再按表中顺序处理其余行为问题并补充真实边界回归，之后逐模块收紧 `any`。对剩余空 catch 按失败后是否可能写入、重复执行或谎报成功判断，单纯添加注释让 warning 消失不算完成行为修复。
