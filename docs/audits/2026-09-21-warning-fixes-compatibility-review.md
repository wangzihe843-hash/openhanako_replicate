# 2026-09-21 warning 复审修复：持久化兼容性

本批修复的持久化变更判定为 **compatible**，保持 DATA_EPOCH 1。下列结论基于代码差异、真实存储回归和正式生成器；不提高 epoch、不新增豁免、不关闭指纹检查。

- 原 payload：`sha256:0ebd3a777ee36f8fdf3965b94916d6bacb2e575ab1204dda350d3c3882ec8fb2`
- 批准 payload：`sha256:660bd9fe30c878dd1647c36d8a78152e19181f2334970a617de3018c86973afd`
- 生成方式：TypeScript 5.9.3 / parse-tree-v1。源码摘要包含运行逻辑与类型，摘要变化本身不代表磁盘格式不兼容。
- 62 个 store、866 个写入站点；registry、site mappings、startup receipt 均未变化；inventory 仅更新 3 处 Xingye 写调用的代码摘录，不新增站点。没有新持久文件或 SQLite DDL 变更。

| 摘要变化的 store | 变更与兼容理由 |
| --- | --- |
| installed-plugins | 插件清理增加总期限、异步 disposable 处理和加载代次校验；安装 manifest、receipt、配置及目录协议不变。正常卸载继续先等待 onunload，再逆序调用 disposables。 |
| workflow-state | 成功结果先追加 journal，再发布完成元数据；完成记录失败不会触发节点重试，也不能被 parallel/pipeline 的普通错误处理吞成成功。JSONL 的 nodeSeq/key/result/status/ts 及已有附加字段不变。持久化失败状态仅在内存记录，错误反馈不再无条件承诺可安全重放。旧 journal 仍可读取和命中缓存。 |
| xingye-state | lore-memory 的标记格式不变，按优先级重排 managed 块并按完整 prompt 长度计入预算；手写文本保留，读取旧文件不重写正文。events/log.json 保留 version 1，新增可选 autoDraftState，原 consumedBy 增加独立计数消费标记；append、appendOnce、heartbeat 共用同一 agent 锁，状态与标记在同一 JSON 原子提交。 |

autoDraftState 的字段为 `version: 1`、`agentId`、`userTurnCount`、`lastAutoDraftAt`、`lastAutoDraftTurn`、`lastPrunedChatAt`、`baselineUncertain`。旧日志没有该字段时，从尚存事件迁移；迁移不能还原过去已删除的历史。原七天事件保留策略不变，累计次数不随清理丢失。非法计数状态会报告错误而不覆盖原文件。旧版程序可读取原有事件字段，但降级运行可能丢弃新累计状态；本轮没有执行降级或改动用户真实数据。

迟到草稿事件若早于已清理的对话，无法重建精确时间分布：保留累计进度并标记 baselineUncertain，下一次新鲜草稿恢复精确基准。这可能提前提示一次草稿，避免误将进度降回残余日志。计数不会用时间水位丢弃乱序新对话。同 ID 的保留期内重复事件、带计数标记的完整重放可去重；已清理事件若人为剥离标记再重投，无法在不永久保留所有 ID 的前提下精确去重。

旧 lore 标记没有 priority 时，仅借同 agent 的 lore/entries.json 元数据排序已经存在的 managed 块；不从元数据文件补正文。元数据缺失时保留文件已有顺序。默认 4,000 字符预算包括标题、块标记和分隔，截断保留完整闭合标记。

其他修改不改变持久格式：图片任务轮次标识和草稿变更版本只驻留内存；媒体默认参数保存校验沿用现有配置结构；归档恢复仅修正 HTTP 错误分支；测试配置仅排除忽略目录 output。没有依赖升级。

后续复审继续修正懒激活失败的代次清理、装不下的 Lore 单块跳过，以及 renderer 内按连接和角色排序的 profile 读合并写。角色本地选择保护和待确认草稿正文均仅驻留内存；已有 profile.json 字段、API 和目录协议不变。相对于前轮批准 payload sha256:a404ff94e0bb3709fd89b664d2bfa378d2f33d805c795dc44832280cd2d1a092，新增摘要变化只涉及 installed-plugins 和 xingye-state；仍为 62 stores / 866 sites，DATA_EPOCH 1。详见 [后续排查](2026-09-21-warning-followup.md)。

完整源码与 NFT 运行时闭包仍为 9,690 文件（source-graph 709、runtime-asset 11、nft-runtime-trace 8,970），与已提交 closure 逐字段相同；开放边界 baseline 也相同，保留原有 mobile-workbench 的 1 条已知耦合，不增加许可范围。

正式 fingerprint 由 `writePersistenceSchemaFingerprint` 固定上述 payload 生成，再用 `assertCommittedPersistenceSchemaFingerprint` 核对。全量检查结果见 [修复与验证报告](2026-09-21-warning-fixes.md)。
