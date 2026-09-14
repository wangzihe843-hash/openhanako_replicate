# 2026-09-14 warning 修复持久化兼容性复审

结论：本批变更为 **compatible**，保持 DATA_EPOCH 1。复审对象为本次 W01–W23 修复源码及由正式生成器计算的下列 payload，不通过提高 epoch、放宽豁免或跳过指纹检查消除失败。

- 旧 payload：`sha256:481be9d19271d9bc7d47602bd4bad296c85f711b7c862b9b5ab815bb5b3b68be`
- 本次批准 payload：`sha256:0ebd3a777ee36f8fdf3965b94916d6bacb2e575ab1204dda350d3c3882ec8fb2`
- 生成工具仍为 TypeScript 5.9.3 / parse-tree-v1。该方法包含类型节点；模块摘要变化不直接意味着磁盘格式变化。
- 62 个 store，发现写入站点 862 → 866；registry 的公开存储描述、SQLite DDL 和 startup receipt 不变。server-info 站点规则由 write-file 改为 secret-write，扫描器识别新严格写入 helper。

## 逐项审查

| 摘要变化的 store | 代码变化及兼容性理由 |
| --- | --- |
| agent-profile | Agent 运行时类型和创建/回滚错误反馈调整；代理配置字段、Markdown/头像文件名和现有读取路径不变。 |
| channels | 删除未使用绑定、保留消息追加调用；Markdown frontmatter 和消息序列化不变。 |
| desk-cover-upload-staging | 未使用变量整理；上传内容、临时目录归属和文件格式不变。 |
| legacy-upload-cache | 清理异常增加反馈；上传命名、大小/年龄策略不变。 |
| mcp-config | 未使用绑定整理；服务器/连接器别名、认证、默认权限和延迟加载归一化不变。 |
| office-render-jobs | 超时终止失败作为原超时错误 cause；job.json/input.html 和 PDF 输出契约不变。 |
| operational-checkpoints | 仅 ENOENT 视为不存在，其他读/删除失败报告；备份 manifest/SQLite 格式不变。备份 wrapper 新增 created/skipped/failed 工具反馈，不迁移既有 checkpoint。 |
| plugin-download-cache | HTTP 参数收窄和路由类型；ZIP 命名、版本和 SHA256 校验保持。 |
| server-runtime-info | 新文件独占创建，先确认权限再写秘密内容，原子发布；原 JSON 字段及 reader 不变。发布失败阻止 ready，不留下伪成功。 |
| session-jsonl | 运行时消息/取消契约、过滤字段别名和恢复错误反馈；仍由 Pi 0.80.3 adapter 持有会话，CURRENT_SESSION_VERSION 3 不变，既有 Hana metadata/repair 格式不变。 |
| session-sidecars | 仅移除未使用的 reopenError 绑定；索引/标题/视觉 sidecar 读取契约不变。 |
| web-session-registry | 安全字段过滤使用明确别名，继续剔除秘密；验证、有效期和磁盘序列化不变。 |
| windows-sandbox-migration-state | 清理失败反馈；迁移 marker 字段与既有版本判定不变。 |
| xingye-state | heartbeat-consumer 将剔除 relationshipLore 的 rest 解构改为复制后显式 delete，仍不泄漏该字段；profile 未使用导入整理。现有 JSON/JSONL/Markdown 与共享资料协议不变。 |

额外核对：lib/desk/heartbeat.ts 的笺状态和巡检日志保护属于工作区文件操作：读取失败停止覆盖，只有确认缺失日志才允许初始化；既有格式不变。手机联系人订阅使用只读快照，默认用户规范化仍通过原有可写 store 执行；初始化并不增加持久化格式。缺失/屏蔽/删除默认用户、保存后读取最新快照、自动生成仅一次均有实际 store 挂载回归。归档清理 HTTP 响应新增部分失败语义，客户端同步处理，不改变磁盘会话格式。

## 依赖与验证范围

完整 NFT + 源码闭包重新计算后为 9,690 文件：source-graph 709、runtime-asset 11、nft-runtime-trace 8,970；唯一新增文件为 `lib/nonfatal-error.ts`。`core/runtime-contracts.ts` 的 type-only 引用在运行时擦除。export-manifest 为这两个新源文件补充既有分类。开放边界 baseline 逐字段相等，原有 mobile-workbench 一条已知耦合保留。

正式 receipts 由 scan-persistent-stores 和 writePersistenceSchemaFingerprint 生成，写入时固定上述 payload；再次 assertCommittedPersistenceSchemaFingerprint 核对。全量测试、构建与 warning 门禁结果统一记录在 [本轮修复报告](2026-09-14-remaining-warning-fixes.md)。

验证使用隔离临时目录，不读取真实用户 token 或迁移真实用户数据。Windows 上的注入故障测试证明错误处理路径；POSIX 原生权限测试有平台跳过，现有 WSL 无 bwrap/node，未证明原生 bwrap 隔离。严格写入沿用 Windows 父目录继承 ACL，任意 HANA_HOME 的 ACL 隔离仍需目标环境验证。
