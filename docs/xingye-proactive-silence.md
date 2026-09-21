# S5：主动陪伴的沉默、安静时段与重复抑制

实施日期：2026-09-21。基于 `feature/xingye-mvp` 的 S1–S3 提交 `453d38ff`，对应《陪伴型 Agent 设计融合与实施优先级计划》的 S5 / §3.6。

## 使用入口与行为

在「设置 → 巡检」选择助手，可调整「自动巡检」及「巡检安静时段」。安静时段默认关闭，编辑开始、结束时间或开关后点击「保存安静时段」生效。时间采用**服务端所在机器的本地时区**；远程客户端与服务端可能位于不同时区。支持跨午夜，例如 `23:00–08:00`，包含开始时刻、不包含结束时刻；开始与结束不能相同。配置启用但时间无效时暂停巡检，避免误开启。

开关含义统一如下：

| 控制 | 自动巡检 | 小手机中的手动巡检 |
| --- | --- | --- |
| 巡检总开关关闭 | 暂停 | 暂停 |
| 单助手自动巡检关闭，总开关开启 | 停止定时触发 | 安静时段外仍可显式触发 |
| 安静时段内 | 暂停 | 暂停 |
| 总开关与自动巡检均开启，且在安静时段外 | 按既有间隔触发 | 保留既有两分钟手动冷却 |

关闭或重新配置巡检会取消在途执行。运行期间跨入安静时段也会发出取消信号；策略检查每秒执行一次。安静时段结束后可恢复后续巡检，不会保留上一轮已取消的控制器。以上设置只控制 heartbeat 巡检，不改变用户独立建立的 cron 定时任务。

## 什么情况下可以保持沉默

心跳继续检查工作台和既有事件，但对话条数、离线时长及联系人间隔本身不再要求角色表达。没有新的合适素材、事件已过期或已表达、关系或场景不适合、用户正忙时，可以不联系、不通知、不提议草稿。原有“累计 50 条对话必须提议草稿”和“联系人到期必须 DM”已改为可选评估。

草稿仍由用户在对应面板确认后生效，不因为巡检读取或提出建议就变成已发生的事实。现实工作通知与剧情表达区分；剧情分支变化不构成重复提醒已完成工作的新理由。当前规则通过既有巡检提示实现，不新增 M7 话题池、候选生命周期数据库或新的调度器，也没有对真实模型的表达质量作效果保证。

来源引用只来自**本轮新消费事件**，最多列出 12 个事件 ID 与短描述，供工具填写 `sourceEventIds`。提示要求只选择实际支持草稿的事件；不会把所有历史事件重新注入。

## 去重与取消的准确边界

事件消费继续使用 `lib/xingye/heartbeat-consumer.js` 的每助手锁及 `events/log.json` 中的持久 `consumedBy` 回执。并发消费者、重新创建巡检实例不会再次消费同一条仍受回执覆盖的事件。消费身份依附助手和事件，不随当前剧情分支或巡检会话变化。

这不是副作用的“恰好一次”承诺。消费回执表示事件已供巡检审阅，不能证明模型已成功表达或通知已送达；消费者先写回执，后续执行失败不会自动重新投递事件。既有事件保留期和去重键清理规则保持不变；若上游重新生成了不同 ID 的同类事件，不由此次修改按语义合并。各草稿模块也没有新增跨模块 `sourceEventIds` 原子去重，不能仅凭来源 ID 就声称相同草稿永不重提。

暂停、安静时段与五分钟超时会向真实隔离执行传递 `AbortSignal`。取消后不发布迟到的成功结果、礼物或正常完成通知，也不继续后续笺巡检。主巡检与笺巡检的取消都会保留正确的 skipped / failed 结果；超时仍是失败。`heartbeat_skipped` 提供暂停、安静时段或超时的结束证据，由手动巡检界面结束等待，不运行成功后的附加行为。

取消依赖既有执行器和工具对信号的处理，**不会撤销取消前已经完成的写入、发送或其他操作**。这次修改没有增加事务回滚或第二套外部投递回执。

## 前置审查与采用依据

实施前先阅读本地模块及下列计划、报告与原始来源；报告中的建议与原项目的真实保证分别对待：

- [融合计划 S5 / §3.6](../.codex_refs/陪伴型Agent设计融合与实施优先级计划-2026-09-09.md)：验收要求为重复心跳不重复消费同一事件、安静与暂停生效、允许没有表达、草稿与确认内容区分。
- [A：Agent 设计建议评估与融合方案 §5.10](../.codex_refs/report_references/Agent设计建议评估与融合方案-2026-09-09.md)：沿用现有调度与执行身份，区分剧情表达和现实通知，不复制第二套 Gateway。
- [B：微信公众号全文配图增量评估报告 §4.5](../.codex_refs/report_references/微信公众号全文配图增量评估报告-2026-09-09.md)：暂停需覆盖在途结果，不能只停止下一次定时触发。
- [D：微信收藏评估报告 §4.2–4.3](../.codex_refs/report_references/微信收藏评估报告-2026-09-07.md)：候选产生与最终表达分离，允许空结果，离线时间不能自动解释为想念。[主动心意原始说明](https://www.xiaohongshu.com/s/doc?doc_id=7673180707956099753&note_id=6a7d55540000000028007029)与[Topic Pool 原始说明](https://www.xiaohongshu.com/s/doc?doc_id=7671295712439922929&note_id=6a76aeee0000000025014eaa)在本轮采用的是本地既有报告的阅读记录，不将其描述成此次重新获取全文或运行验证。
- [Spherse trigger executor，固定提交 `1846c72a06fd6e9b4100be69c6f4923d428a327b`](https://github.com/mengrru/spherse/blob/1846c72a06fd6e9b4100be69c6f4923d428a327b/packages/core/src/trigger/executor.ts)：此次完整读取 executor 源码。其触发器到会话、运行日志及终态的连接可作参考；`inProgress` 是进程内 Set，不能替代本地持久消费回执，也不能证明跨重启恰好一次。
- Jarvis 固定提交 `dd8fbf97a3e0f96239a0a465398654be68e88e15` 的 [scheduler.cpp](https://github.com/LYiHub/pub-local-jarvis/blob/dd8fbf97a3e0f96239a0a465398654be68e88e15/native/src/scheduler.cpp) 与 [service.py](https://github.com/LYiHub/pub-local-jarvis/blob/dd8fbf97a3e0f96239a0a465398654be68e88e15/src/jarvis_backend/orchestrator/service.py)：此次读取本地固定源码快照，参考取消标记、旧结果失效与暂停编排，不引入窗口感知或采集进程。
- [OpenClaw resolve-route.ts，固定提交 `0367f4d4b24cf8a7c4aabe6be2b9075c0be5c4e3`](https://github.com/openclaw/openclaw/blob/0367f4d4b24cf8a7c4aabe6be2b9075c0be5c4e3/src/routing/resolve-route.ts)：此次读取本地固定源码快照，参考入口身份与会话作用域的区分；没有复制它的共享会话默认策略。

## 定向验证

2026-09-21 完成 S5 核心及设置界面的最后一轮定向测试：**10 个文件，181 项通过，0 失败**，执行时使用 `--maxWorkers=2`。覆盖文件为：

- `tests/heartbeat-quiet-policy.test.ts`
- `tests/heartbeat-auto-draft-directive.test.js`
- `tests/heartbeat-social-directive.test.js`
- `tests/heartbeat-resilience.test.js`
- `tests/heartbeat-workspace-output.test.ts`
- `tests/heartbeat-persistence-failures.test.ts`
- `tests/scheduler-heartbeat-default.test.ts`
- `tests/xingye-heartbeat-consumer.test.js`
- `tests/xingye-propose-draft-coverage.test.js`
- `desktop/src/react/__tests__/settings/WorkTab.test.tsx`

测试包含安静时段跨午夜与边界、无效配置、消费前阻止、在途取消、安静结束恢复、真实超时信号、笺巡检的暂停/安静/超时、迟到结果抑制、总开关与手动入口语义、并发及重建后的持久消费去重、来源引用和既有草稿确认/丢弃界面覆盖。

这组 181 项结果是 S5 核心定向证据，不包括随后独立补充的手动路由/WebSocket/手机取消提示测试，也不替代主任务最终全量测试、类型检查、warning 差异检查及构建验收。全量结果以本次合并实施记录为准。
