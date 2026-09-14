# 当前剩余 warning 审查与修复清单（2026-09-13）

> 后续修复状态：W01—W03 已完成，见[紧急修复记录](D:/18133/projects/openhanako_replicate/docs/audits/2026-09-13-urgent-warning-fixes.md)。最新实测为 8,248 warning、0 error。下文数量、问题描述与旧源码行号保留修复前审查基线。

当前项目有 **8,252 条 ESLint warning、0 error**。其中 **7,820 条（94.76%）是显式 `any` 类型债务**，其余 432 条包含异常处理、Hook 依赖和代码整理问题。不能把这些数字理解为 8,252 个运行时 bug，也不能因 lint 退出 0 就认为它们全部无害。

本轮沿 warning 调用链确认了 **3 组应修的行为问题：笺更新覆盖较新的指令、巡检日志读取失败后覆盖历史、快捷聊天设置回滚后状态不一致**。完成 6 个隔离故障场景回放；未操作实际用户数据，也未挂载真实页面。优先处理 W01—W03，再按后面的批次治理。

审查基线：`feature/xingye-mvp`，提交 `fa576e12dd67b196e45ca121fd761d479c068eb9`。开始时 Git 工作区干净。只新增本报告和本地审查材料，没有修改业务代码、检查配置、依赖、持久化收据，也没有提交或推送。附件中的修复记录作为历史证据阅读，不视为本次修改代码的指令。本报告 W 编号独立于附件旧编号。

## 1. 实测数量及成因

使用已安装的 Node v24.15.0、ESLint 9.39.4、TypeScript 5.9.3、react-hooks 插件 5.2.0；执行与项目 lint 相同范围的 `eslint .`，不带 `--fix` 或 `--cache`。

| 规则 | 总数 | 非测试 | 测试 | 建议性质 |
| --- | ---: | ---: | ---: | --- |
| `@typescript-eslint/no-explicit-any` | 7,820 | 4,747 | 3,073 | 按接口和模块补类型 |
| `no-empty` | 228 | 196 | 32 | 先查失败结果和数据保护，再决定处理方式 |
| `@typescript-eslint/no-unused-vars` | 126 | 84 | 42 | 保留过滤字段、兼容签名和有副作用的调用 |
| `react-hooks/exhaustive-deps` | 33 | 33 | 0 | 把真实数据来源与依赖关系写清楚 |
| `prefer-const` | 23 | 17 | 6 | 小范围声明整理 |
| `no-useless-escape` | 17 | 13 | 4 | 保持字符串和正则匹配语义 |
| 无效 `eslint-disable` | 5 | 5 | 0 | 删除过时抑制注释 |
| **合计** | **8,252** | **5,095** | **3,157** | |

扫描 2,907 个文件，967 个文件存在 warning；全部 warning 文件都受 Git 跟踪。测试口径包含 `tests/`、`__tests__/`、`.test.` 和 `.spec.`；非测试包含脚本和构建配置，并非全是产品运行时代码。

与[上轮最终 JSON](D:/18133/projects/openhanako_replicate/output/warnings-priority-fixes-2026-09-13/eslint-final.json)按文件、行列、规则、消息和级别逐项对比：**新增 0、移除 0**。这批剩余 warning 没有在上次修复后继续增长。

历史数量为 8,190 → 8,273 → 8,252：上轮可靠性修复增加 83 条，随后优先问题修复减少 21 条。前两段变化采用[已保存的增量核对报告](D:/18133/projects/openhanako_replicate/docs/audits/2026-09-13-warning-priority-fixes.md)，本次没有重新检出旧提交执行历史 lint。之前处理的是有行为风险的问题，不是把类型债务全部清零。

为什么检查仍能通过：

- [ESLint 配置](D:/18133/projects/openhanako_replicate/eslint.config.js:148)主动将多条规则降为 `warn`；[Hook 规则](D:/18133/projects/openhanako_replicate/eslint.config.js:113)也是 `warn`。
- [package.json](D:/18133/projects/openhanako_replicate/package.json)里的 lint 命令是 `eslint .`，没有设置 warning 上限。ESLint 默认允许只有 warning 的检查成功退出。[官方退出码说明](https://eslint.org/docs/latest/use/command-line-interface#exit-codes)
- [后端 tsconfig](D:/18133/projects/openhanako_replicate/tsconfig.node.json:4)和[测试 tsconfig](D:/18133/projects/openhanako_replicate/tsconfig.test.json:5)关闭了 strict/noImplicitAny 等选项。显式 `any` 还会绕过相应类型检查，启用 strict 本身也不会禁止它。[规则说明](https://typescript-eslint.io/rules/no-explicit-any/)
- 当前 lint 排除了 `.cjs`、构建产物和本地研究目录；这份清单不是所有文件、所有类型缺口或所有运行时 warning 的全集。`no-empty` 也不会枚举带注释的 catch 或所有空 Promise 回调。

## 2. 优先修复：已在隔离回放中确认的行为问题

P1 表示可能覆盖已有持久内容，建议下一轮先修；P2 表示状态正确性或关键维护问题；P3 表示一般整理。优先级不表示问题已在用户现场发生。

### W01 · P1 · 笺状态更新必须保留当前用户指令

- [x] 修复[heartbeat.ts:423](D:/18133/projects/openhanako_replicate/lib/desk/heartbeat.ts:423)到原子写入的读取/回退契约；关联 warning 为第 426 行空 catch。

`createJianStatusTool` 捕获巡检开始时的 `instructionSnapshot`。执行时读当前 `jian.md`，任何读错都被吞掉；随后 `currentRaw || instructionSnapshot` 会把旧快照作为用户指令写回。

确认了两个条件路径：① 用户已有较新指令，读取报 EACCES、后续写入成功，较新指令被旧快照覆盖；② 用户在巡检期间把文件内容清空，读取成功但值为 `''`，旧指令仍被重新写回。两条路径均返回“状态已更新”。[工具装配入口](D:/18133/projects/openhanako_replicate/lib/desk/heartbeat.ts:1053)确认快照确实先于工具执行建立。

修复方向：区分读取失败、文件不存在、读取成功但为空；真实读错应停止写入并上报。成功读到的空内容应按当前编辑处理。文件被删除后的行为应明确，不能仅凭旧快照静默恢复。保留既有状态块格式和原子发布方式。

验收：覆盖正常更新、巡检期间改写/清空/删除、EACCES/EIO、发布失败；读取失败时不发起覆盖，原内容保持，调用方收到失败。已有[巡检状态测试](D:/18133/projects/openhanako_replicate/tests/heartbeat-workspace-output.test.ts:120)主要验证正常状态写入，应补上述故障场景。

### W02 · P1 · 巡检日志追加不能把读错当成空日志

- [x] 为[readPatrolLogText](D:/18133/projects/openhanako_replicate/lib/desk/heartbeat.ts:583)的读取结果和[日志追加](D:/18133/projects/openhanako_replicate/lib/desk/heartbeat.ts:645)建立严格的写入前置条件。

该 helper 将所有读取异常转成空字符串。`patrol_update_log` 再把“空字符串 + 新记录”整体原子替换到原文件。隔离回放中，旧日志读取报 EIO、后续写入成功，原历史变成只含最新一条，工具仍返回成功。

这是沿同文件 warning 调用链发现的相关问题：helper 的 catch 带 `return`，**它本身不是新增的一条 `no-empty` warning，也不另加到 8,252 的计数里**。第 608 行截断写入失败则是另一处确实存在的空 catch。

修复方向：展示日志可以采用有明确说明的降级读取；追加日志必须在可靠读到旧内容后再写。仅对确认不存在的新文件使用空初值；编码解析错误也不能无条件转成空内容。保留现有混合 cp936/UTF-8 兼容路径。

验收：原有多条日志在 EIO/EACCES 下逐字节保留，工具明确失败；真正新文件可创建，正常追加和旧编码归一化继续通过。扩展[日志兼容测试](D:/18133/projects/openhanako_replicate/tests/heartbeat-workspace-output.test.ts:84)。

### W03 · P2 · 快捷聊天设置回滚要同步服务端、界面和共享快照

- [x] 修复[GeneralTab.tsx:260](D:/18133/projects/openhanako_replicate/desktop/src/react/settings/tabs/GeneralTab.tsx:260)的保存/宿主注册/回滚流程；关联空 catch 在第 299 行。

首次 PUT 成功后，代码先更新共享 `settingsSnapshot`，再注册快捷键。注册失败时立即把组件值恢复为旧值，但回滚 PUT 的网络异常被吞掉。HTTP 500 本来会由实际 [settings hanaFetch 封装](D:/18133/projects/openhanako_replicate/desktop/src/react/settings/api.ts:27)抛错，也会落入同一个空 catch；再次注册返回的 `ok:false` 则未核验。

隔离回放结果：

| 条件 | 组件状态 | 服务端状态 | 共享快照 |
| --- | --- | --- | --- |
| 回滚网络失败 | 旧值 | 新值 | 新值 |
| 回滚 HTTP 500 | 旧值 | 新值 | 新值 |
| 回滚 PUT 成功 | 旧值 | 旧值 | **新值** |

最后一行说明即使回滚请求成功，共享快照也没有撤回。真实页面还会通过[snapshot 同步 effect](D:/18133/projects/openhanako_replicate/desktop/src/react/settings/tabs/GeneralTab.tsx:218)消费该快照；本轮没有挂载页面验证最终视觉时序，表格仅表示实际回调结束时的状态。

修复方向：保留既有 HTTP 状态校验并向外报告回滚失败，核验再次注册的宿主结果；只有确认后的值才能作为界面/共享快照的最终值。回滚成功同步旧快照，回滚失败保留“状态未确认”并重新读取服务端，不把恢复成功当成既成事实。继续保留原始失败信息，并补充回滚失败信息。

验收：首次保存失败、宿主返回 `ok:false`、回滚网络失败、HTTP 非成功、回滚成功、宿主再次注册失败；页面重新进入后与服务端一致。已有[GeneralTab 测试](D:/18133/projects/openhanako_replicate/desktop/src/react/settings/tabs/__tests__/GeneralTab.test.tsx:262)主要覆盖成功保存，应增加这些结果组合。

**证据范围：**[failure-probes.mjs](D:/18133/projects/openhanako_replicate/output/warnings-review-2026-09-13/failure-probes.mjs)从当前文件提取实际函数/回调并转译执行；只替换文件 I/O、HTTP transport、宿主和状态 setter 等边界；HTTP 状态判断提取自仓库的 `hooks/use-hana-fetch.ts` 封装，并非该组件实际导入的 `settings/api.ts`；二者均校验非成功 HTTP。后续修复的挂载回归已改用实际 settings API。6 个预期问题场景均被断言捕获，详情及源码 SHA-256 见[failure-probes.json](D:/18133/projects/openhanako_replicate/output/warnings-review-2026-09-13/failure-probes.json)。这不是全仓测试，也不证明真实 EACCES/EIO 后一定还能写入；数据覆盖结论成立于“读失败、后续写成功”的条件。

## 3. 其余空 catch 的处理清单

228/228 条 `no-empty` 都是空 catch。测试中的 32 条为 31 个临时资源清理和 1 个 JSONL 夹具容错解析。完整位置见[非 any 索引](D:/18133/projects/openhanako_replicate/output/warnings-review-2026-09-13/non-any.md)，被保护的 try 代码见[empty-catches.json](D:/18133/projects/openhanako_replicate/output/warnings-review-2026-09-13/empty-catches.json)。

| 任务 | 优先级 | 需要做的工作 | 验收要求 |
| --- | --- | --- | --- |
| W04 | P2 | [ ] 补充[checkpoint-wrapper.ts:72](D:/18133/projects/openhanako_replicate/lib/checkpoint-wrapper.ts:72)、第 86 行的备份失败反馈。当前 rm/mv 前备份失败仍执行工具，与本文件既有 best-effort 策略一致，不能直接改成强制阻断。 | 失败能关联到会话和受影响文件，调用方能分辨此次是否有备份；保留工具本来的成功/失败结果，验证已有备份策略。 |
| W05 | P2/P3 | [ ] 对其余 catch 按持久化、取消、回滚、资源清理、可选探测、同步观察者隔离逐项落实错误契约；需要告知的错误记录，允许忽略的写明实际理由。 | 关键写入/恢复失败不得伪装成功；二次清理失败不能遮蔽原始错误；可选探测失败不制造无意义告警。测试清理也需保证不污染后续用例。 |

已检查到合理降级的反例：[preferences-manager.ts:150](D:/18133/projects/openhanako_replicate/core/preferences-manager.ts:150)清理临时文件后仍抛原错误；[agent-manager.ts:623](D:/18133/projects/openhanako_replicate/core/agent-manager.ts:623)是在创建失败后的尽力回滚；[模型错误响应解析](D:/18133/projects/openhanako_replicate/core/media-adapters/openai.ts:220)失败后仍报告原 HTTP 错误。不能统一改成 rethrow，也不能仅批量加注释当作修完。

另有两项应先验证，暂不认定为已确认漏洞：

| 待验证项 | 当前证据与成立条件 | 下一步 |
| --- | --- | --- |
| V01 Linux deny-read 失败处理 | [bwrap.ts:175](D:/18133/projects/openhanako_replicate/lib/sandbox/bwrap.ts:175)探测/遮蔽失败可跳过 deny 路径。还需要该路径经父路径绑定可见，且沙箱内确实能读取，才能认定隔离失败。 | 在 Linux 原生 bwrap 下验证路径探测失败及后续挂载；确认无法落实拒绝规则时的显式失败策略。Windows 回放不能替代。 |
| V02 server-info 权限修正失败 | [server/index.ts:1241](D:/18133/projects/openhanako_replicate/server/index.ts:1241)写文件时给出 0600，第 1261 行又尝试 chmod，但吞掉错误。风险要求既有文件权限过宽、修正失败且其他访问控制未阻止读取。 | 用隔离的 POSIX 文件和 Windows ACL 场景核对；决定如何报告或阻止不安全的发布。本轮未读取实际 token 文件。 |

[Hub 取消回调](D:/18133/projects/openhanako_replicate/hub/agent-executor.ts:324)确实没有接住返回 Promise，但已安装 SDK 的 waitForIdle 当前使用仅 resolve 的运行完成 Promise；本轮没有证据把它定为当前可触发的 unhandled rejection。接口类型治理时应把同步与异步取消契约写清楚。

## 4. 33 条 Hook warning：分组修复而不是照抄依赖建议

当前为缺依赖 9、不必要依赖提示 9、不稳定对象/函数 10、ref 清理 1、复杂表达式/展开数组 4，共 23 个文件。**每条都有处理意见，见[33 条 Hook 清单](D:/18133/projects/openhanako_replicate/output/warnings-review-2026-09-13/hooks-checklist.md)。**

下面 8 组互斥覆盖全部 33 条。它们主要是使依赖关系可检查的重构任务；本轮未确认新的 Hook 竞态，不代表所有页面时序已经验证正确。React 官方也建议在依赖关系难以表达时调整代码结构。[exhaustive-deps 说明](https://react.dev/reference/eslint-plugin-react-hooks/lints/exhaustive-deps)

| 任务 | 优先级 / 条数 | 修复范围与方法 | 验收重点 |
| --- | --- | --- | --- |
| W06 | P2 / 6 | [ ] PreviewPanel、OpenPreviewDocumentWatchBridge、PhoneContactsApp 两处、PhoneSmsApp 两处：把隐藏 getState/localStorage 读取改为显式输入或明确的存储快照订阅。 | 保留连接切换、开关标签、联系人和短信更新的刷新；旧保存不能采用新连接。直接删 version/key 会改变行为。 |
| W07 | P2 / 7 | [ ] PreviewRenderer 的 cover、use-plugin-iframe 两处 initialSize、PhoneContacts 的 ID 签名、OtherModelsSection 两条、PhoneDivination 的 owner/profile：使函数实际消费的字段与依赖采用同一来源。 | 尺寸、资料、生成 hash 和 key 变化及时更新；保留草稿编辑保护、取消标记和内容版本语义，不追加每次 render 新建的对象形成循环。 |
| W08 | P2 / 3 | [ ] [use-panel.ts:18](D:/18133/projects/openhanako_replicate/desktop/src/react/hooks/use-panel.ts:18)统一稳定 loadFn 契约并改掉展开 deps；[滚动 Hook](D:/18133/projects/openhanako_replicate/desktop/src/react/hooks/use-continuous-bottom-scroll.ts:205)补当前已经稳定的 setProgrammaticScrollTop。 | 各面板打开/身份变化只加载所需次数，不因回调重建重复请求；跟随滚动和取消行为不变。 |
| W09 | P3 / 1 | [ ] [PreviewPanel.tsx:338](D:/18133/projects/openhanako_replicate/desktop/src/react/components/PreviewPanel.tsx:338)在 effect 内捕获 DOM，清理同一节点。 | 文档切换、查找开关及卸载不遗留高亮。当前节点通常被复用，未复现用户可见残留。 |
| W10 | P3 / 7 | [ ] 6 条翻译 fallback 不稳定提示，加 AssistantMessage 缺 t：提供稳定 fallback 并明确语言刷新输入。 | 正常启动及无 window.t 的测试路径都稳定；切换语言仍刷新需要翻译的 memo 结果。现有 useI18n 也含内联 fallback，不能只换 Hook 名称。 |
| W11 | P3 / 4 | [ ] ModelSelector 的 current、ModelStep 两条 addedModelIds、ConnectorToolList 的空 tools：稳定派生值或减少无意义 memo。 | 模型增删、选择与工具搜索不变；减少引用重建。本轮没有性能测量。 |
| W12 | P3 / 3 | [ ] 移除已核对未消费的 fileMentionBusy、deskWorkspaceNativeRoot、sending 依赖；对应 InputArea、WorkspaceFileChangeBridge、QuickChatApp。 | 保留文件选择流程、mount/path 订阅及 sendingRef 的实际防重检查。 |
| W13 | P3 / 2 | [ ] ImageStage 的相邻图片版本表达式具名化，并让预加载消费对应版本快照。 | 同一图片 ID 内容更新仍重新预加载；不扩大到无关媒体类型。 |

上轮 S1/S2/S3 对应的观察值乱序、模型列表乱序和通讯录消息计数问题未重复列为待修：当前代码已有请求版本/owner 检查或有效消息数订阅，相关三条旧 warning 已退出清单。

## 5. 7,820 条 any：先补跨模块契约，再清重复断言

全量语法分类没有未匹配点。直接参数类型 2,664、`as any` 2,402、类字段 652、变量声明 634、泛型类型参数 579、属性签名 442、数组 308、其他位置 139。分类按 any 节点直接父节点互斥统计。

| 任务 | 优先级 | 起点与具体工作 | 验收 |
| --- | --- | --- | --- |
| W14 | P2 | [ ] 先为 engine/运行时依赖、会话管理器和压缩器补真实接口。热点：[session-coordinator](D:/18133/projects/openhanako_replicate/core/session-coordinator.ts:1816) 459 个 any、[engine](D:/18133/projects/openhanako_replicate/core/engine.ts:260) 118、[session-compactor](D:/18133/projects/openhanako_replicate/core/session-compactor.ts) 125、[agent](D:/18133/projects/openhanako_replicate/core/agent.ts) 82。 | 跨模块参数、返回值、取消结果和可空值受检查；仍通过既有 Pi adapter，保留会话所有权和取消契约。不能把 any 转移成另一个万能类型。 |
| W15 | P2 | [ ] 梳理消息/事件、模型配置、HTTP/MCP/插件输入与返回值类型。例：[model-capabilities](D:/18133/projects/openhanako_replicate/shared/model-capabilities.ts) 90、[chat-slice](D:/18133/projects/openhanako_replicate/desktop/src/react/stores/chat-slice.ts) 68、[MCP HTTP client](D:/18133/projects/openhanako_replicate/core/mcp/clients/http-client.ts) 60、[插件路由](D:/18133/projects/openhanako_replicate/server/routes/plugins.ts) 76 个 any。 | 已知结构用 interface/type 或现成协议；外部未知值先校验再收窄。只写类型断言不等于验证 JSON。 |
| W16 | P3 | [ ] 为测试建立有类型的 fixture/mock 工厂；测试共有 3,073 个 any，其中 `as any` 1,990 个。优先复用 bridge、session、plugin 的替身。 | 保留真实行为断言；字段不兼容能在编译时发现。不要用 `as unknown as ...` 批量替代，也不要删测试降低计数。 |

这些是分批治理入口，不是对 7,820 处运行时正确性的逐一认证。后端和测试配置较宽松，删掉显式标注后留下隐式 any 也不是改善。可在已经治理的局部范围逐步收紧类型检查，避免无边界的一次性切换。

当前 no-explicit-any 使用默认 `fixToUnknown:false`，**7,820 条都不是默认自动修复项**。官方也说明替换为 unknown 往往会带来需要人工处理的类型错误。[规则选项](https://typescript-eslint.io/rules/no-explicit-any/#fixtounknown)

## 6. 126 条未使用变量与 45 条一般整理项

| 任务 | 优先级 / 数量 | 要做什么 | 必须保留的语义 |
| --- | --- | --- | --- |
| W17 | P3 / 69 | [ ] 清理 25 个导入、41 个局部变量/声明、3 个 catch 绑定。具体位置见非 any 索引。 | 删除绑定前检查初始化副作用和调用结果；不要随变量一起删保存、取消或测试操作。 |
| W18 | P2 / 24 | [ ] 整理对象 rest 中主动剔除字段的写法，例如明确别名或显式安全 DTO。 | [web-session-store.ts:165](D:/18133/projects/openhanako_replicate/core/web-session-store.ts:165)、[设备路由](D:/18133/projects/openhanako_replicate/server/routes/devices.ts:169)的 secret/hash/salt 字段继续被过滤；[desktop-session-submit.ts:805](D:/18133/projects/openhanako_replicate/core/desktop-session-submit.ts:805)仍剔除不应带出的 base64Data。删除解构项会使字段回到 rest。 |
| W19 | P2/P3 / 33 | [ ] 核对未使用参数的真实契约：兼容参数有理由保留，过时接口同步更新调用方。 | [preserveAgentMemoryState](D:/18133/projects/openhanako_replicate/core/session-coordinator.ts:1821)仍被传递，需先确认与 reminderState 等恢复语义的关系；[scheduler.ts:84](D:/18133/projects/openhanako_replicate/hub/scheduler.ts:84)保留旧调用兼容；不能一律加下划线掩盖遗漏。 |
| W20 | P3 / 23 | [ ] 分批改为 const：16 条有默认 fix，7 条先声明后赋值需人工处理。 | [wait-for-socket.ts:4](D:/18133/projects/openhanako_replicate/desktop/src/react/quick-chat/wait-for-socket.ts:4)的提前返回会调用读取 timer 的 cleanup；不能把末尾赋值直接变成后置 const，导致暂时性死区。其余手工点见索引。 |
| W21 | P3 / 17 | [ ] 删除多余转义，涉及路径/附件/模型响应解析和日志脱敏等。 | 保持正则匹配集合和最终字符串；[log-redactor.ts:15](D:/18133/projects/openhanako_replicate/shared/log-redactor.ts:15)尤其要保留原有脱敏能力。 |
| W22 | P3 / 5 | [ ] 删除当前无效的 eslint-disable：WelcomeScreen、SubagentCard、message-text、bridge-manager、diagnose-win32-powershell。 | 只处理本次诊断指定的旧注释，不顺带删除仍有效的抑制。 |

只有 **21 条** warning 带默认 fix（16 个 const + 5 个旧注释）；编辑器 suggestions 不等于默认安全批量修复。W17—W19 合计 126，W20—W22 合计 45。

一个不能夸大的测试例子：[initializedProfile](D:/18133/projects/openhanako_replicate/desktop/src/react/xingye/xingye-contact-profile-ai.test.ts:101)的 overrides 参数确实未使用，但当前调用均未传 overrides，不能据此说现有测试失效。清理参数或为将来的覆盖功能落实语义即可。

## 7. 独立于 ESLint 的 warning

本轮**重新运行了开源边界检查**；构建提示只复核了上轮已保存日志，没有重跑 Vite，因此以下构建数量是历史日志数量。

| 任务 | 当前证据 | 建议 |
| --- | --- | --- |
| B01 传统 script | [renderer 日志第 2 行起](D:/18133/projects/openhanako_replicate/output/warnings-priority-fixes-2026-09-13/vite-config-ts-final.log:2)共 19 条，来自 connection-csp、i18n、theme、platform 的启动标签。 | 检查这些启动资源在产物中存在且执行顺序正确；再确定保留显式静态启动还是迁移模块。不能仅为去提示全改 type=module，改变初始化顺序。 |
| B02 混合静态/动态导入 | 同日志[第 25 行](D:/18133/projects/openhanako_replicate/output/warnings-priority-fixes-2026-09-13/vite-config-ts-final.log:25)和第 28 行共 2 条：screenshot、stores/index。 | 按模块实际加载目的统一入口。提示表示这些动态导入不会把模块移到独立 chunk，不直接代表功能失败。 |
| B03 chunk 大小 | 同日志[第 1364 行](D:/18133/projects/openhanako_replicate/output/warnings-priority-fixes-2026-09-13/vite-config-ts-final.log:1364)有超过 500 kB 的汇总提示。 | 先测首屏加载和实际体积来源，再决定懒加载/拆包；提高告警阈值不减少体积。 |
| B04 开源边界债务 | 本次 `lint:boundary` 退出 0，仍为 1 条：server/index.ts → server/routes/mobile-workbench.ts；[基线](D:/18133/projects/openhanako_replicate/build/open-boundary-baseline.json:5)记录为 evidence-needed。 | 跟进 mobile-workspace 替代的真实状态，确认依赖退出后再生成基线。不要删基线掩盖现有依赖，也不在普通 warning 清理中顺带重切导出范围。 |

没有把这些提示加进 8,252；也没有将前次 Windows EPERM 测试失败/复测记录当成本次失败。本轮未做安装包、完整构建、全仓 Vitest 或三套 TypeScript 检查。

## 8. 推荐执行顺序与完成标准

1. **先修 W01—W03。** 为已确认的数据保护和设置一致性路径补故障回归；定向跑完整相关测试文件。W01/W02 涉及持久写入，应按现有 registry/fingerprint 流程评估实际源码影响，不预先提高 DATA_EPOCH。格式兼容不等于不会覆盖业务内容。
2. **处理 W04—W08、W18/W19，安排 V01/V02 的平台验证。** 优先明确错误结果、状态来源和接口语义。
3. **分批做 W09—W13、W17、W20—W22。** 对纯声明和注释整理运行 lint/typecheck；只有行为变化和具体风险需要新增测试，避免为机械改字补大量镜像测试。
4. **持续处理 W14—W16。** 从公共类型与重复 fixture 入手，逐文件减少可验证的类型缺口。
5. **W23 · P2：[ ] 增加新 warning 的比较检查。** 保留完整诊断，比较本次基线与新增诊断，并报告按规则/文件的变化；不能只比较总数，避免“删一条旧 warning、加一条新风险”互相抵消。已清理模块可单独要求零 warning，待存量治理后再提高全仓门槛。本次未修改任何规则或 CI。

每个实现批次交付时，说明行为变化、对应 warning 的净变化与验证结果。不要用关闭规则、忽略目录、批量 unknown/下划线/注释替换制造“清零”。总数下降并不能替代 W01—W03 的失败路径验收。

## 9. 完整索引与可复核材料

- [summary.json](D:/18133/projects/openhanako_replicate/output/warnings-review-2026-09-13/summary.json)：规则、测试范围、目录、语法位置、自动修复数量及历史清单比较。
- [全部 967 个 warning 文件](D:/18133/projects/openhanako_replicate/output/warnings-review-2026-09-13/files.md)：按数量排序，每个文件都有规则分布。
- [432 条非 any 逐项清单](D:/18133/projects/openhanako_replicate/output/warnings-review-2026-09-13/non-any.md)：文件、行号、规则、原始诊断。
- [全部 8,252 条诊断](D:/18133/projects/openhanako_replicate/output/warnings-review-2026-09-13/warnings.json)、[原始 ESLint JSON](D:/18133/projects/openhanako_replicate/output/warnings-review-2026-09-13/eslint-current.json)。
- [33 条 Hook 的处理意见](D:/18133/projects/openhanako_replicate/output/warnings-review-2026-09-13/hooks-checklist.md)、[228 个空 catch 上下文](D:/18133/projects/openhanako_replicate/output/warnings-review-2026-09-13/empty-catches.json)。
- [隔离回放结果](D:/18133/projects/openhanako_replicate/output/warnings-review-2026-09-13/failure-probes.json)、[可复跑脚本](D:/18133/projects/openhanako_replicate/output/warnings-review-2026-09-13/failure-probes.mjs)。
- [语法分类脚本](D:/18133/projects/openhanako_replicate/output/warnings-review-2026-09-13/inventory.mjs)、[逐项类型分类](D:/18133/projects/openhanako_replicate/output/warnings-review-2026-09-13/syntax-details.json)、[受检源码哈希](D:/18133/projects/openhanako_replicate/output/warnings-review-2026-09-13/source-hashes.json)。
- [最终审查材料核验](D:/18133/projects/openhanako_replicate/output/warnings-review-2026-09-13/verification.json)：诊断数量、文件链接、Hook 覆盖、源码未变及 Git diff 检查。

本报告在 docs/audits 下；详细 JSON、回放和索引位于已忽略的 output 目录，仅在当前工作区可用。全量枚举和语法分类不等于对全部 any 使用、全部异常时序、所有平台或所有页面完成了运行时证明。
