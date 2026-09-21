# S8：已登记任务状态诊断

入口：设置 → 插件 → 诊断按钮。沿用 `/api/plugins/diagnostics` 的 TaskRegistry 快照，展示登记任务的类型、任务 ID、状态、进度、已记录原因、更新时间及本次读取时间。再次点击诊断按钮手动刷新；刷新失败时保留上次快照并显示失败提示，不会将失败请求解释成空任务列表。

插件元数据中的摘要只接受非空文本用于标题，对象、数组或空白值回退任务 ID，避免合法插件元数据导致诊断页崩溃。

状态完整保留 pending、running、paused、blocked、recovering、completed、failed、canceled 和 aborted；未知值显示未知状态。阻塞与失败分开，取消与中止分开。没有记录阻塞原因时明确显示未记录，不根据角色回复猜测原因。completed 只表示执行流程完成，界面说明不代表业务结果已验证；输出的积极措辞不参与状态判定。

这条展示路径直接读取既有 registry，没有新增调度器、TaskOutcome、审批或任务操作。真实 workflow 由 `lib/tools/workflow-tool.ts` 注册，在正常结束/错误结束时分别 complete/fail，取消保持已有 aborted 终态；插件通过既有 `task:update` 等总线接口提供 blocked 等状态。已从 registry 移除的任务不会出现，这不是完整任务历史，也不覆盖所有工具。

## 前置审查

已核对计划 S8/§5.1、报告 A §5.6，以及本地固定版本原文：

- [OpenHands Event 基类](https://github.com/OpenHands/software-agent-sdk/blob/6a1e4d0f08dcdd02786526a51b7965e1877008bc/openhands-sdk/openhands/sdk/event/base.py)：不可变事件与模型可见投影分别处理。
- [OpenHands EventStore](https://github.com/OpenHands/software-agent-sdk/blob/6a1e4d0f08dcdd02786526a51b7965e1877008bc/openhands-sdk/openhands/sdk/conversation/event_store.py)：先写记录再更新索引，重复 ID 与父事件校验。这里借鉴事实先于展示的边界，没有复制其事件日志实现。
- [Codex item 协议](https://github.com/openai/codex/blob/1bfd383890b1bd7fab0d1b3d5e05129a9e293d8a/codex-rs/app-server-protocol/src/protocol/v2/item.rs)：执行状态独立于命令输出与模型回复；不将外部枚举替代本项目现有状态。

## 验证

UI 测试通过真实 TaskRegistry 与现有总线生成九类状态，核对状态/原因、移除后刷新、未知状态、失败和格式错误响应保留快照、恢复后清空错误。路由测试通过真实 registry 核对原始状态和原因完整返回。另运行既有 TaskRegistry、任务总线、workflow 执行/取消/完成回归测试。

测试未启动真实模型任务；结果说明的是程序状态投影与现有执行回归，不能据此宣称业务结果得到验证。
