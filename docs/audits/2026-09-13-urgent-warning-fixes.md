# 紧急 warning 关联缺陷修复（2026-09-13）

已完成[剩余 warning 清单](D:/18133/projects/openhanako_replicate/docs/audits/2026-09-13-remaining-warnings-fix-list.md)中的 **W01、W02、W03**。本轮重点是防止持久内容被覆盖、恢复快捷聊天设置的一致性。全量 ESLint 为 **8,248 warning、0 error**，较修复前减少 4 条。

基线：`feature/xingye-mvp`，HEAD `fa576e12dd67b196e45ca121fd761d479c068eb9`。用户在审查后明确授权修复紧急 bug，并允许分块委派。两名实现 agent 分别负责巡检与设置，一名独立 reviewer 复核，主任务完成集成验证。本轮尚未提交或推送。

## 1. 已完成的修复

### W01 · P1 · 笺状态更新覆盖用户当前指令

[heartbeat.ts](D:/18133/projects/openhanako_replicate/lib/desk/heartbeat.ts:389)现在必须成功读取当前 `jian.md`，才允许写状态。用户在巡检期间改写或清空的指令按当前内容保留；删除、EACCES、EIO 直接向工具调用方返回失败，不用巡检开始时的旧快照重建文件。旧快照仍可出现在历史执行记录内，既有状态块格式和原子发布方式保留。

新增回归验证当前编辑、空内容、删除、读取失败与 rename 发布失败；读取失败时不发起覆盖，原有字节保持。

### W02 · P1 · 巡检日志读取失败后覆盖旧历史

[日志读取](D:/18133/projects/openhanako_replicate/lib/desk/heartbeat.ts:579)现在区分“确实不存在”与“无法读取”：仅 `readFile` 报 ENOENT 且随后 `lstat` 同样确认不存在，才允许以空日志创建。EACCES/EIO、目标仍存在的 ENOENT、无法确认不存在、无法可靠解码均拒绝写回。[预览读取](D:/18133/projects/openhanako_replicate/lib/desk/heartbeat.ts:603)可以降级，但会记录警告；后续追加仍需通过严格读取。截断发布失败也记录警告。

保留混合 UTF-8/cp936 逐行兼容，取消“出现 UTF-8 BOM 就认定全部字节有效”的假设；无法解码时保留原文件，避免替换字符进入历史。回归包含真正新日志、BOM/混合编码、非法字节、51 条旧历史的预览故障及原子发布失败。

### W03 · P2 · 快捷聊天回滚后的界面、共享快照和宿主状态不一致

[GeneralTab.tsx](D:/18133/projects/openhanako_replicate/desktop/src/react/settings/tabs/GeneralTab.tsx:309)按服务端确认结果同步组件与共享快照：

- 首次 PUT 结果不明时 GET 核对，不自动补发 PUT；已确认保存、随后注册失败时才尝试回滚。
- 回滚确认成功后，同步恢复共享快照，并核验再次注册的返回结果。
- 回滚响应丢失或失败时，GET 读取服务端实际值；读取成功后重新应用并核验宿主快捷键。宿主仍失败会明确报告，已确认的设置值保持显示。
- 无法读取确认时，清除不可信快照、停用快捷聊天输入，显示读取失败与“重试”。重试读取并恢复宿主，不重放之前的写入；共享快照留空，等待正常完整快照加载，避免旧缓存重新成为成功状态。
- 请求固定到原连接，owner/连接切换或组件卸载后的响应不能更新当前组件/快照，也不能触发新的补偿写入。保留原始失败与恢复失败信息。

独立复审曾发现“GET 确认后没有重新注册宿主”的遗漏，现已补齐对应实现和回归。新测试挂载实际 React 组件，使用实际 `settings/api.ts` 的 HTTP 校验和实际 `updateSettingsSnapshot`；网络与 Electron 宿主边界采用可控模拟。

## 2. 验证结果

| 检查 | 结果 |
| --- | --- |
| 后端、巡检、偏好、持久化登记及 tripwire | 13 文件、157 项通过 |
| GeneralTab 与 SettingsContent 挂载测试 | 2 文件、27 项通过 |
| 合计 | **15 文件、184 项通过，0 失败** |
| 新增故障回归 | 心跳 17 项、快捷聊天 16 项，共 33 项 |
| TypeScript | `tsconfig.json`、`tsconfig.node.json`、`tsconfig.test.json` 均通过 |
| 全量 ESLint | 2,908 文件，8,248 warning、0 error |
| Boundary | 通过；保留原有 1 条已登记边，不增加或删除基线 |

全量 warning 减少项：`no-empty` 228 → 225，`no-explicit-any` 7,820 → 7,819，其余规则数量不变。两个修改的生产文件以外，诊断计数不变；新增测试没有 warning。未调整 lint 规则、忽略目录或增加 suppression。

集成运行使用独立的 `HANA_HOME`、`HANAKO_HOME`、`USERPROFILE`、Pi 目录、日志和临时目录，没有使用真实用户数据或模型调用。详细命令、退出码及结果保存在 [integration](D:/18133/projects/openhanako_replicate/output/urgent-warning-fixes-2026-09-13/integration/verified-sources.json)、[后端结果](D:/18133/projects/openhanako_replicate/output/urgent-warning-fixes-2026-09-13/integration/tests-backend.json)、[前端结果](D:/18133/projects/openhanako_replicate/output/urgent-warning-fixes-2026-09-13/integration/tests-frontend.json)与[lint 对比](D:/18133/projects/openhanako_replicate/output/urgent-warning-fixes-2026-09-13/integration/lint-comparison.json)。`output/` 是本地忽略的证据目录，未加入版本管理。

验证范围是上述定向测试、全量类型/lint 及兼容性检查；未重跑全仓测试、应用打包或真实 Electron 全局快捷键测试。文件系统故障由测试注入，校验真实工具路径在故障下的行为与临时文件字节，不代表已在用户环境复现操作系统故障。

## 3. 持久化兼容性

通过只读调用当前生成器验证，未改写已提交收据：

- store inventory 与 startup receipt 生成结果逐字节相同：62 个 store、862 个写入发现位置。
- `assertCommittedPersistenceSchemaFingerprint` 通过，DATA_EPOCH 保持 **1**。
- 当前 payload 为 `sha256:481be9d19271d9bc7d47602bd4bad296c85f711b7c862b9b5ab815bb5b3b68be`，与当前已提交指纹一致。
- CLI 源码及声明资产图 719 项与已提交记录一致，包括来源关系、根入口、动态调用声明。此次未重新执行完整 NFT 依赖追踪；没有依赖或运行资产变更。

[只读兼容性结果](D:/18133/projects/openhanako_replicate/output/urgent-warning-fixes-2026-09-13/integration/compatibility.json)。heartbeat 属于既有 `external-heartbeat-workspace` 豁免，本次没有修改登记策略、豁免、epoch、schema/protocol 源码或原子写入格式。指纹一致说明登记范围内结构一致；对豁免代码的行为保护另由代码审查、源文件 SHA-256 与故障回归验证。

本次修复没有引入跨进程锁或 CAS，因此不承诺解决读取成功后、原子替换前的跨进程并发写入竞争。快捷聊天也没有新增服务端版本比较协议；本次覆盖的是确认、失败恢复与当前 UI 归属边界。

## 4. 清单状态与证据更正

W01—W03 已完成；W04 起其余异常处理、Hook 依赖、类型债务和构建告警任务继续保留在原清单，未标记完成。

原审查探针的 HTTP 校验提取自 `hooks/use-hana-fetch.ts`，并非 GeneralTab 实际导入的 `settings/api.ts`。两者都校验非成功 HTTP 状态，原缺陷判断成立，但“使用该组件实际封装”的描述不准确。原清单已纠正，修复回归现在使用实际 settings API，并覆盖非成功 HTTP、网络异常和响应丢失。
