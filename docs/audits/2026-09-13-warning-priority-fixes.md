# Warning 优先问题修复与增量核对（2026-09-13）

基线提交：`65beae1248320d4a78394aeff65f1cc3cbe2d991`。本轮按用户要求修复 warning 核查中的 9 组优先问题；没有修改 ESLint 规则，没有批量删除类型检查、依赖或禁用注释。

## 修复范围

| 编号 | 修复后的行为 |
| --- | --- |
| E01 配置恢复 | 读取权限/I/O 失败不当成配置损坏；备份失败停止恢复；原字节成功保留后才用凭据写入器原子发布模板；发布失败上报。 |
| E02 数据库恢复 | 查询后关闭 SQLite 句柄；临时锁定/I/O 错误不误判为损坏。备份先移动 sidecar、最后主库，失败回滚；回滚不完整阻止该 Agent 初始化。下一次重试在打开数据库前检测 UUID 备份组中孤立的 WAL/SHM，须先还原或补全该组；完整历史备份允许继续。 |
| E03 聊天取消 | 两步取消独立处理异常；首步失败仍尝试父会话取消。失败返回 rejected/cancel_failed 与可显示错误，保留真实 streaming；过期请求不取消替换流，同流并发取消共享请求。 |
| E04 迁移扫描 | #30/#38/#39 仅在确认可选根目录不存在时跳过；权限、I/O、文件占用和根目录仍在的 ENOENT 继续失败并保留重试资格。 |
| E05 经验分类 | 删除失败及清空索引失败上抛到保存接口，返回失败而不是 ok:true；仅已不存在的文件允许幂等删除。 |
| E06 浏览器状态 | 挂起须先持久化成功并收到宿主确认，失败保留状态；关闭失败保留跟踪，关闭成功但磁盘清理失败保留不可恢复的清理记录以供重试；LRU 失败有界且守住容量。调用方仅在真正完成后记录挂起/关闭成功。 |
| S1 观察值乱序 | 读取、清空和 owner 生命周期协调，过期读取不能恢复被清空的值；失败保留值并提示。此实验已退休，仅修复仍保留的兼容渲染入口，未重新启用实验。 |
| S2 模型列表乱序 | 缓存读取和手动获取共享请求版本，旧响应不覆盖新列表；provider/连接切换和卸载使旧请求失效，已接受写入不擅自重发。 |
| S3 通讯录提示 | 按当前 store 快照的有效文本消息数订阅，同长度正文更新、最新会话排序变化也正确刷新。 |

独立复核发现并补修 E02 的跨重试保护：只抛出一次内存异常不足以阻止下一次初始化。保留在磁盘上的同组 sidecar、主库命名关系作为持久证据，无需新增数据库 schema 或恢复 journal。回滚/重试新增用例覆盖 corrupt、healthy、missing 三种主库状态，以及人工恢复后重试、完整历史备份与普通失败非致命路径。

## 为什么 warning 曾增加

保存的 2026-09-09 最终结果对应 `6ad93159d483045493c1e4a45e3d14fded29514b`，为 **8,190**；上一轮大修提交 `65beae12` 的结果为 **8,273**，净增 **83**。两提交间 ESLint 配置未改变。此前只比较两份同为 8,273 的最终检查，不能回答相对更早版本为何增长。

| 规则 | 6ad93159 | 65beae12 | 净增 |
| --- | ---: | ---: | ---: |
| no-explicit-any | 7,744 | 7,820 | +76 |
| no-empty | 243 | 245 | +2 |
| no-unused-vars | 125 | 127 | +2 |
| exhaustive-deps | 34 | 36 | +2 |
| prefer-const | 22 | 23 | +1 |
| no-useless-escape | 17 | 17 | 0 |
| 无效 eslint-disable | 5 | 5 | 0 |
| 合计 | 8,190 | 8,273 | +83 |

按同一测试归类口径，测试代码净增 **64**、非测试代码净增 **19**。新出现的 lint 文件贡献 44 条，既有文件净增 39 条。这是上一轮修复和补测试带入的类型/整理债务，不是本轮读报告、构建临时文件或统计规则造成的增长。

主要文件增量：`tests/runtime-review-regressions.test.ts` +12、`core/session-coordinator.ts` +9、`tests/session-coordinator-ensure-loaded-race.test.ts` +9、`tests/cli-chat-lifecycle.test.ts` +9、`tests/loop/loop-controller.test.ts` +5。完整逐文件差值在 `output/warnings-priority-fixes-2026-09-13/prior-warning-growth.json`。

## 持久化兼容性评审

- DATA_EPOCH 仍为 1；SQLite 表、user_version、现有 JSON 字段均不变。
- 配置恢复使用既有 `writeSecretFileSync`，补充其 agent-profile 持久化站点登记；不改变正常配置载入格式。
- 数据库备份仍为 facts.db.bak-* 家族，新增 UUID 防止同毫秒重名；sidecar 同前缀配组。只有此新 UUID 格式的孤立 sidecar 会被视为未完成恢复，旧式时间戳备份不被追溯改判。
- 对新的不完整恢复组停止 Agent 初始化是一项故障处理行为变更，保护仍需恢复的数据。解除 I/O 故障本身不能消除孤立 sidecar，需把其还原到原位置或补全同组主库后再尝试。
- 迁移扫描不新增迁移版本，不重跑历史已登记完成的收据，不撤销既有用户配置；此前已被旧代码误登记为完成的状态不能由本轮自动识别。
- 浏览器 hostClosed 只是运行时清理标记，冷存储序列化结构不变；强制退出前未成功落盘的清理仍不能承诺持久化。
- 持久化站点清单、源码指纹和 CLI 依赖清单按实际改动重新生成；没有提高 DATA_EPOCH 或改变开源导出边界。

## 当前剩余 warning

最终串行运行 ESLint：扫描 **2,907 个文件，967 个文件有警告，0 error、8,252 warning**。相比本轮开始减少 **21**；相比 9 月 9 日的 8,190 仍多 **62**（上一轮 +83，本轮 -21）。本轮新增的 10 个受检源码/测试文件均为零 warning，没有改规则或新增抑制来降低计数。

| 规则 | 本轮开始 | 本轮结束 | 变化 | 剩余问题的性质 |
| --- | ---: | ---: | ---: | --- |
| no-explicit-any | 7,820 | 7,820 | 0 | 主要是跨模块参数、管理器字段、动态配置和测试 mock 的类型缺口；需要按真实接口补类型。 |
| no-empty | 245 | 228 | -17 | 剩余空 catch 包含可选探测、清理和回退，也有需结合调用方继续核对的异常路径，不能全部视为无害。 |
| no-unused-vars | 127 | 126 | -1 | 混合了残留声明、兼容参数及主动从 rest 对象剔除字段的写法，不能统一删除。 |
| exhaustive-deps | 36 | 33 | -3 | 剩余包含外部状态刷新依赖、稳定性及清理闭包等；不能直接删除规则认为多余的依赖。 |
| prefer-const | 23 | 23 | 0 | 声明整理，部分涉及先声明后赋值及提前返回顺序。 |
| no-useless-escape | 17 | 17 | 0 | 字符串/正则中的多余转义，整理需保持匹配含义。 |
| 无效 eslint-disable | 5 | 5 | 0 | 当前没有相应诊断的旧抑制注释。 |
| **合计** | **8,273** | **8,252** | **-21** | |

剩余按范围为测试 **3,157**、非测试 **5,095**。上述分类延续修复前的全量语法分类与热点审阅；没有逐个证明 8,252 个诊断对应代码的运行时安全性。九组行为修复消除 21 条诊断，两者不是一一对应关系。下一步类型治理应优先明确 core/协议/依赖公共接口，再整理重复 fixture；45 条声明/转义/注释诊断可另做保留语义的清理。

增长的流程原因也已核实：当前 lint 脚本是 eslint .，相关规则为 warn，没有警告增量门槛；因此上一轮即便零 error，仍能引入 83 条 warning。两次提交之间 ESLint 配置、package.json、package-lock.json 均未改变，29 个有净增减的文件全部属于上一轮修复提交。证据：prior-warning-growth.json、prior-warning-growth-by-scope.json、warning-growth-provenance.json 与本轮 final-warning-delta.json。

## 验证

- 九组修复均有对应故障注入或组件回归；新用例覆盖备份/回滚/重试、取消失败、目录访问失败、经验保存失败、浏览器宿主失败、异步响应乱序和 store 更新。
- 三套 TypeScript 检查全部通过：tsconfig.json、tsconfig.node.json、tsconfig.test.json。
- 四个 Vite 构建全部通过：renderer、preload、main、server bundle。此处未做 Electron 安装包发布或真实宿主端到端验收。renderer 仍输出传统 script 标签无法作为 module 打包、静态/动态混合导入无法拆包、chunk 大小提示；这些不计入 ESLint 8,252。
- 全仓 Vitest 首次运行：**1,344 个文件通过、2 个失败、2 个跳过；14,267 条通过、2 条失败、41 条跳过**。失败分别是 channel-store 的书签写入和 memory-compile 的水位线写入，均为 Windows 临时文件覆盖 rename 返回 EPERM，并非断言结果不符。
- 两条失败涉及的测试及实现与 HEAD 语义内容一致；其中 channel-store 测试只有工作区既有换行差异。全仓尚在运行时曾额外复测 memory-compile，失败位置移到另一条 today.md rename。全仓结束后，在独立临时 home 复测这两个文件：**42/42 通过**，没有修改源码、断言或加重试掩盖。具体占用进程/拒绝原因未定位，故本轮不能称为“全仓一次全绿”，也不能据此宣称修复了 Windows 文件系统问题。
- 开源边界检查通过，仍有 1 条已登记债务：server/index.ts → server/routes/mobile-workbench.ts，没有新增边界违规。
- 持久化登记为 **62 个存储、862 个站点**；三个实际 SQLite schema 与 HEAD 比较相同：agent-facts user_version=3、file-history=0、session-manifest=5，DATA_EPOCH=1。指纹为 sha256:481be9d19271d9bc7d47602bd4bad296c85f711b7c862b9b5ab815bb5b3b68be。
- 最终检查前后的 30 个受检改动文件 SHA-256 一致，文档单独收尾；git diff --check 通过，HEAD 未变。本报告记录提交前的验证快照；提交与推送状态以 Git 记录为准。

验证原始结果位于 output/warnings-priority-fixes-2026-09-13/：final-verification.json、tests-final.json、focused-filesystem-recheck.json、types-final-summary.json、build-final-summary.json、eslint-final.json、boundary-final.log、persistence-compatibility-evidence.json。历史失败记录保留，未被复测覆盖。

使用临时 home、模拟宿主/网络和数据库故障；未连接真实模型、微信或实际用户数据库。E02 的独立复核及补修记录见同目录 compat-independent-review.md。
