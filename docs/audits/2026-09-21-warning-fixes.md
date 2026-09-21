# 2026-09-21 warning 复审：修复与验证

本轮处理 [修复前审查](2026-09-21-warning-review.md) 的 R01–R09。三个 subagents 分别负责后端、前端、星野与插件；完成后轮换交叉复审，主任务复核源码、重跑原始探针并统一执行质量门禁。用户已授权通过检查后 commit & push。

**前一轮结束时的状态（后续见 [继续排查与修复](2026-09-21-warning-followup.md)）：修复保留在工作区，未 commit、未 push。** 最终全量检查仍有 1 项角色面板用例失败，未满足用户“没什么问题就 commit & push”的条件。HEAD 仍为 fa004739011be91932a58a03e263f2eaa6a7e8f7。具体阻塞见下文，不以定向通过或重跑碰绿替代诊断。

## 修复结果

| 编号 | 修复后的行为 | 主要回归证据 |
| --- | --- | --- |
| R01 | 成功节点的 journal/完成元数据写入失败时不重新执行节点；完成错误不能被 parallel/pipeline/catch 或子工作流吞成成功；只对可靠持久化记录提供有条件的 resume 指引。缓存键在执行前固定。 | workflow-completion-regressions、既有 workflow host/journal/tool/cancellation；EACCES 与 ENOSPC 原始探针均只执行一次。 |
| R02 | 图片任务每轮提交有独立运行期标识；旧 query/submit/尺寸读取及迟到事件不能覆盖新轮或取消结果；同轮查询合并、并发重试互斥。 | media-attempt-regressions、既有 media poller/retry/completion；原始探针确认新轮仍在轮询且不交付旧文件。 |
| R03 | 插件 onload 超时后，onunload/异步 disposable 也有清理期限；继续尝试其余清理，释放贡献并加载后续插件。旧代次回调不能污染重载结果。 | plugin-manager-cleanup、既有 plugin-manager；原始挂起探针由阻塞变为完成，坏插件 failed、后续插件 loaded。 |
| R04 | Lore 按优先级输出，未改正文的 retained 块也会重排；4,000 字符包括 prompt 标题和完整块开销。旧文件排序不替换正文，手写内容保留。 | lore-memory-file、agent-xingye-lore-prompt、runtime-lore；原始探针高优先级正文保留，prompt 恰为 4,000 字符。 |
| R05 | boolean 支持 true/false/未设置，enum 保持原始值类型；已知 schema 拒绝新无效默认值，保留自定义/旧配置的兼容入口。多个历史错误值可以逐项纠正。 | media-defaults-validation 的真实 route→manager→存储链路、MediaProviderDetail.schema、media-provider-legacy-repair 联合回归。 |
| R06 | 延迟/重叠 hydration 不恢复已清空或更新的草稿；清空回执只解除对应版本保护。同会话 PUT 按连接、surface 和 path/id 别名排序，不阻塞不同草稿。 | input-draft-persistence：22 项，覆盖清空、发送入口、旧回执、保存乱序、失败恢复、服务器切换与身份映射补齐。 |
| R07 | 对话累计与消费标记在现有事件日志原子提交，跨重启与七天清理仍累计；旧日志从剩余历史迁移。无法精确恢复的迟到历史草稿采用明确的保守基准。 | xingye-auto-draft-counter、heartbeat-consumer/storage；原始探针累计为 20/40/60/80，60 与 80 时触发阈值，每轮仅保留 20 条事件。 |
| R08 | 归档恢复允许读取 HTTP 错误响应，409 到达冲突处理分支。 | session-actions-restore-http 经真实 hanaFetch 覆盖 200、409、500、网络失败及合法空冲突列表。 |
| R09 | 默认 Vitest 排除已被 Git 忽略的 output，保留全部正式测试。 | 最终默认收集 1,367 个文件，与 tracked + 本轮新增测试逐一核对，无遗漏、无额外文件。 |

## 复审中补齐的问题

初稿没有直接作为最终结果交付。主任务与交叉 reviewer 又修正了以下边界，并补回归：完成记录错误被并行封装吞掉、执行中修改 options 导致缓存键漂移、草稿永久清空标记阻止合法恢复、在途 PUT 倒序覆盖清空、sessionPath/sessionId 双身份竞态、多个旧错误媒体默认值无法逐项修正，以及旧插件超时/加载回调干扰新代次。

测试整合还修正了调用私有 poller 旧签名的用例，并将 React+后端联合用例放入已有 tests/*.tsx 检查范围、显式使用其 Vite 环境类型。没有关闭类型规则、扩大 tsconfig 排除范围或以新 warning 抵消旧 warning。三组交叉审查针对 R01–R09 未留下确认的行为缺陷；最终全量另外暴露一项角色面板测试失败，仍作为提交阻塞保留。

## 最终检查

| 检查 | 结果 |
| --- | --- |
| 三套 TypeScript | npm run typecheck 通过，三个检查阶段均为 0 errors。 |
| 全仓 ESLint warning 门禁 | 7,881 warnings / 0 errors；相对原基线新增 0、实际移除 7，全部为 explicit-any。 |
| Warning baseline | 由原脚本 snapshotWarnings/compareWarnings 生成并验证只减少 7 个既有站点；49 行删除、0 行新增，没有放宽规则或增加额度。更新后与实际快照新增 0、移除 0。 |
| 默认测试收集 | 1,367 / 1,367，无遗漏；output 中旧探针/夹具不再参与。 |
| 完整 npm test | 未通过，exit 1：1,364 文件通过 / 1 文件失败 / 2 文件跳过；14,476 项通过 / 1 项失败 / 41 项跳过，0 未处理错误。 |
| Workspace packages | build:packages 通过。 |
| Renderer / server bundle | build:renderer 与 vite.config.server.js 构建通过。 |
| 持久化 | 62 stores / 866 sites；保持 DATA_EPOCH 1，正式生成并核验固定 payload。 |
| 依赖闭包 / 开放边界 | 9,690 个闭包文件与原记录相同；lint:boundary 通过，原有 1 条已知耦合没有增加。 |
| 差异检查 | git diff --check 通过；全量前后 3,054 个源码/config 文件摘要完全一致，无测试残留源码文件。 |

全量测试命令：

```text
npm test -- --maxWorkers=2 --reporter=default --reporter=json --outputFile.json=.cache/fixes-20260921/full-tests-accepted.json
```

测试进程使用隔离的 HANA_HOME、用户配置和临时目录。定向测试和全量测试有重叠，不将次数相加冒充独立覆盖数。主要本地证据位于 `.cache/fixes-20260921/`，完整 ESLint 诊断位于 `output/lint-warning-ratchet/eslint.json`；这些忽略目录不随 Git 提交，源码回归和本报告随提交保留。

## 验证环境调整记录

第一次全量运行中，隔离临时目录被设在仓库 `.cache` 下。session-path-identity-audit 的扫描规则排除绝对路径中含 `.cache` 的夹具，导致 10 项失败；普通系统临时目录下 12/12 通过。已将验证 runner 的整个隔离用户目录移到系统临时目录下的独立子目录，不修改产品扫描规则。

同一次运行另有 loop-controller 用例失败。独立复现捕获到 `EPERM: rename loop-state.json.tmp -> loop-state.json`，发生在持久化阶段，未到暂停/通知断言；原 `.cache` 环境一次通过、第二次失败，普通临时目录下四次均为 22/22。相关 safe-fs、loop 源码及既有用例与 HEAD 无差异，具体占用文件的进程未确定，未用猜测性重试或放宽断言消除错误。原始日志与 `loop-repro-2.json` 保留，第一次全量运行中止，不算作通过。

修正后的统一 runner 已定向通过上述两套 34/34 测试。第二次完整运行覆盖全部 1,367 个文件、14,477 项断言通过、41 项跳过，但捕获 11 条未处理 rejection，退出码 1，不能视为检查通过。错误全部来自 app-init.test.ts 的简化 document 夹具缺少 documentElement，草稿恢复的新 surface 读取暴露了该缺项；没有出现在真实 DOM 的草稿回归中。源码快照确认运行期间 3,054 个源码/config 文件未变化。保留 full-tests-final.log/json 原始证据；JSON reporter 的 success 字段未包含未处理错误，因此门禁以退出码和完整日志为准。

启动夹具最终补齐 12 个 documentElement、11 个草稿 GET 响应和 LAN 场景的 appearance PUT 响应，并断言服务器 home 草稿确实按 electron surface 和正确 connection 恢复。没有 mock 掉 hydrate、修改产品 catch 或隐藏未处理错误。两个 reviewer 分别核对真实入口在 HTML 挂载后调用，认定为测试夹具缺项。定向四套 49/49 通过，进程退出 0，无未处理异常或草稿恢复警告；最终完整运行单独保存在 full-tests-accepted.log/json。

## 尚未解决的提交阻塞

最终完整运行用时 798.48 秒，发现一个失败：`desktop/src/react/xingye/RoleDetailPanel.test.tsx:414`，用例“工坊方案含非基线精确黑化值 → 选「按档位基线」则不落精确值”。点击“按档位基线”后立即断言确认条消失，但 DOM 仍存在 `xingye-corruption-seed-confirm`，显示 AI 精确值 20、档位基线 12。其他 14,476 项断言通过；app-init 的 11 条未处理异常已经消除。第 415 行的第二个断言尚未执行，该用例也未验证此次保存最终落库的数据，因此尚不清楚确认条稍后是否消失或是否写入错误值。

该测试和 RoleDetailPanel/profile-store 生产代码本轮均未修改，同一源码在前一次完整运行中通过，目前只能确认两次完整运行结果不同，记录为 P2 验证阻塞、根因待定；不能据此证明纯测试问题，也不能认定本轮引入产品回归。只读交叉审查发现以下候选原因，尚未完成因果验证：

- `RoleDetailPanel.test.tsx:391-394` 的上一个用例点击主 Save 后，等待的存储值可能已由之前的“采用”保存写入，因此不保证这次保存完成。
- `RoleDetailPanel.test.tsx:412-415` 点击“按档位基线”后立即同步断言，而生产入口 `RoleDetailPanel.tsx:730-734` 会发起异步保存；`profile-store.ts:357/376/382` 依次读、写、通知刷新。
- 用例共享模拟存储 Map，beforeEach 清空，afterEach 的 cleanup 不等待所有在途保存；迟到写入可能影响下一用例。

下一步应使用可控 promise/保存完成标记验证这两个用例的异步隔离，同时检查在途读取是否恢复旧确认状态。不能只增加 timeout、删除断言或重跑直到通过。本轮未修改这个用例，保留 `.cache/fixes-20260921/full-tests-accepted.log/json` 的原始失败，未执行 commit/push。

## 保留的限制与后续问题

- 仍有 7,752 条 explicit-any 和 129 条 no-empty warning；本轮修复的是确认的行为问题，没有声称消除全部技术债。
- Renderer 仍提示混合动态/静态 import 无法拆出独立块，以及部分 chunk 超过 500 kB；server 的第三方 chokidar 仍有 Stats 未使用提示。没有提高 warning 阈值或升级依赖来掩盖它们。
- 星野已清理的历史无法还原。迁移只统计现存历史；迟到草稿早于已清理对话时保守保留累计，可能提前提示草稿；新鲜草稿可校准。详细字段、去重边界和旧版本读取行为见 [持久化兼容性复审](2026-09-21-warning-fixes-compatibility-review.md)。
- 没有调用真实模型/媒体 provider，也没有制作或运行完整签名安装包；平台跳过项以最终测试结果为准，不计入已验证通过。
- 当前 ci.yml 仅监听 main 的 push/PR；feature/xingye-mvp 的 push 本身不代表远端 CI 已执行。
