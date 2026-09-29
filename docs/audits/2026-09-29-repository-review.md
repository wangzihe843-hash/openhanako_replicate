# 全仓分块检查与持久化兼容审查 — 2026-09-29

## 范围与方法

基线为 `feature/xingye-mvp` 的 `583cdff67c1395ec302edc8e27ae6796254f6557`。检查包含先前已完成、尚未提交的删除角色会话续接修复。按模块并行阅读实现、检查调用关系、构造缺陷回归，再交叉审查修复和执行仓库验证。没有更新依赖版本。

| 分块 | 检查范围 |
| --- | --- |
| 会话与持久化 | Pi 0.87 适配、上下文投影、压缩、分支、媒体清理、恢复、模型生命周期、记忆素材与持久化指纹 |
| 星野业务 | 角色切换与存储绑定、世界书、记忆候选与固定记忆、秘密空间、社交分发、群聊去重、主动互动和草稿 |
| 服务与权限 | HTTP/WS、文件上传、沙盒与 ResourceIO、审批与工具上下文、桥接媒体、插件协议、Electron IPC/preload |
| 客户端与交付 | CLI 发现/启动/聊天、前端会话切换与重连、构建脚本、workspace 包、静态检查、全仓测试 |

## 已确认并修复的问题

- 删除角色后续接旧会话直接遍历原始分支，忽略 `context_edit` 和压缩边界。改为读取 Pi 的 `buildSessionContext()`；真实 SessionManager 回归证明省略、替换、当前分支、压缩和空上下文行为，并检查旧文件不被改写。
- 本地零模型请求压缩同样会把省略/替换前的消息重新写入 checkpoint。改用 `buildSessionProjection()`，并拒绝复用无法证明符合当前编辑语义的旧 rolling summary；保留近期尾部的原始边界。
- 媒体清理只处理原始 message，`context_edit.replacement` 中的图片/音频可在 `refreshContext()` 后重新出现。清理现在覆盖替换内容，同时保留 omission edit 和 Pi 索引引用。
- 星野固定记忆的 GET→PUT 操作可以覆盖期间新增的记忆。服务端支持可选 `expectedPins`，在同步替换前比较快照，冲突返回 409；候选保留待确认状态，秘密空间保留原记录并展示失败原因。设置页保存队列按成功写入推进基线，自动刷新保留未保存编辑；快照绑定角色和实际连接，防止同 connectionId 换地址后套用旧响应。旧客户端不携带此字段时维持原接口行为。
- 秘密空间详情页的固定记忆失败提示原来只放在列表 footer，详情操作失败不可见。提示改为显示在两种视图共同的容器。
- 朋友圈反应分发只查当前角色缓存，其他角色的关系状态缺失时回退成朋友，可能让宿敌错误点赞。现在缓存缺失时读取目标角色自己的关系文件，不切换全局角色绑定；当前角色继续优先使用尚未 flush 的最新缓存。
- 上传敏感路径检查遗漏 Windows 大小写别名及敏感目录链接的目标。路径比较改用项目既有的文件系统身份函数。
- 沙盒 PathGuard 对具体文件和受保护目录存在同类遗漏。大小写别名和 junction 现在遵守同一权限规则，原始 canonicalPath 保留给调用方。
- 桥接媒体手工解析 `file:` URL，未解码空格、中文、`#` 和 `%`。改用 Node 的 `fileURLToPath()`，解码后继续执行原有路径授权。
- CLI 服务发现读取 `null` 元数据会崩溃，越界端口和非字符串/空白 token 会被误判可用。校验失败现在返回结构化的不可用结果。

## 持久化兼容性声明

分类：**compatible**。`DATA_EPOCH` 保持 1；Pi 三包保持 0.87.1，JSONL 保持 v3。SQLite DDL/user_version、文件路径和存储注册项均未调整，不需要迁移现有数据。

官方 scanner/generator 的初次差异核对显示：存储清单仍为 64 个 store、888 个写入位置；指纹 payload 的变化仅为 `session-jsonl` 中两处引用的 `core/session-coordinator.ts` 可执行源码 hash。这是将续接素材改为已有 SDK 上下文投影所致，不是新存储结构。

- 续接读取原始历史、按已有格式创建新会话；省略/替换记录继续保留在源历史里。
- 本地压缩仍写现有 compaction entry；媒体清理只修改既有内容块，既有附件路径引用保留。
- `expectedPins` 是可选 HTTP 请求前置条件，不持久化为新字段；pinned 文件格式不变。
- UI/导出和长期记忆素材的完整历史读取语义没有被整体替换成压缩后的模型上下文。
- 修复不会追溯重写已经生成的旧续接摘要或记忆。没有扫描或修改真实用户资料、凭证和会话数据库。
- 回退本次代码不要求数据格式回滚，但会恢复这些缺陷；若回退到 Pi 0.80.3，则仍须遵守此前 Pi 升级的数据快照要求，不能只降依赖。

据此重新生成 `build/persistence-schema-fingerprint.json` 的 compatible 审查收据。旧审查文档保留，不提高 lint 或边界警告基线。

`build/cli-runtime-closure.json` 同时由现有 census 流程刷新。差异仅为三条源码 import 来源：本地压缩引用 Pi facade、沙盒及上传检查引用既有 link-aware-fs；没有增加运行时文件或外部依赖，没有调整 open/closed 边界基线。

## 验证记录

源码冻结后运行 `npm test -- --maxWorkers=2 --reporter=default --reporter=json --outputFile.json=output/repository-review-20260929/vitest-final.json`：**14,880 通过、0 失败、41 跳过**；1,413 个文件通过、2 个文件跳过，共 1,415 个文件，耗时 936.66 秒。JSON 报告 `success: true`。所有新增回归包含在此次完整运行中。

| 检查 | 结果 |
| --- | --- |
| 完整 TypeScript 检查 | 三个 tsconfig 全部通过 |
| lint warning ratchet | 0 error、0 新增 warning、15 个 warning 移除；现存 7,866 个 warning，基线未提高 |
| Pi SDK verifier | 通过，新增检查公开导出 `buildSessionProjection`，保留原有 deep-import 防漂移检查 |
| open/closed boundary lint | 通过；保留 1 条既有跟踪边，不增加或放宽基线 |
| 四个 workspace 包 | 全部构建通过 |
| 桌面 client 构建 | main、preload、renderer、splash、theme 通过；最后类型调整后再次构建 renderer 通过 |
| 当前服务端 bundle | 构建通过 |
| 当前 bundle 实际 HTTP 冒烟 | 10 项通过：原生 SQLite/Jieba/Anydoc、启动与身份、健康存储、鉴权拒绝、星野路径限制、话题/经验接口、优雅关闭和进程重启后的持久化 |
| 差异检查 | `git diff --check` 通过 |

当前 bundle 冒烟使用忽略目录内的现有 `smoke-full-server.mjs` 适配副本，将启动目标改为本次构建的 bundle 和当前 Node，其余断言、隔离用户目录及清理约束保持；它不构成独立安装包或安装器验证。构建仍有大 chunk、splash 非 module 脚本和依赖未使用 import 的提示，没有用改阈值隐藏这些提示。

第一轮默认并发的全仓运行发现大量既有 10/15 秒截止时间触发，也运行到了审查中故意新增的失败回归。该次失败结果不作为通过证据。修复回归先证明失败，再验证修复；最终全仓运行限制 worker 并发后全部通过，保留了原测试断言和超时。

桌面运行冒烟实际执行后未通过，不能计为已验证：启动链首先执行现有 `dist-sandbox/win-x64/hana-win-sandbox.exe` guardian，Node 报 `spawn UNKNOWN / errno -4094`。无参数最小探针复现同一问题；.NET 原生进程启动探针进一步返回 `NativeErrorCode=4551`，Windows 明确提示“应用程序控制策略已阻止此文件”。因此本轮无法实测完整 Electron→guardian→server 链。没有改动系统策略、二进制或启动路径绕过拦截，没有将超时当作正常通过。

### 后续桌面启动排查

上述首次验证之后，用户明确要求关闭本机智能应用控制。通过 Windows 安全中心关闭后，确认 `SmartAppControlState = Off`，Defender 实时防护、行为监控与三个网络配置的防火墙仍开启；原 guardian 可以正常执行。这一系统设置变化不是仓库代码修复。

拦截解除后的首次桌面冒烟在 45 秒处失败，日志停留于服务模块导入，尚未进入主窗口创建。单独在全新临时数据目录测量四组模块导入，总耗时约 20.6 秒；CPU profile 中同步读文件约 13.4 秒、打开文件约 2.7 秒。随后的原版完整桌面冒烟通过，没有复现死锁。文件读取占主要时间，但这些数据不足以断言具体由杀毒扫描、缓存或磁盘哪一项造成。

确认并修正两处验证缺口：

- 冒烟把窗口操作的 45 秒期限同时用于等待整个服务器启动，短于应用本身的 90 秒初始期限和最多 5 分钟启动预算。首次主窗口等待现在复用 `SERVER_INFO_MAX_WAIT_MS` 并增加窗口加载时间，worker/controller 的总截止时间同步调整；后续 UI 操作仍保持 45 秒上限。没有改变应用运行时的启动期限。
- 最后一次单独构建 renderer 清理了此前生成的 `lib/theme.js`，而冒烟只检查两个 HTML，导致主题运行时缺失也能通过。现在启动前检查 preload、splash、两个页面及 theme，页面加载后验证 `window.applyTheme`。运行说明改为先执行 `build:client`；本机已重新构建缺失的 theme。

验证：缺少 theme 时准确拒绝启动；补齐产物后，真实 Electron→guardian→server、主窗口/桌宠、主题、preload、IPC、关闭后重开和隔离数据退出全部通过，总耗时 **11.68 秒**。四个现有启动回归文件共 **32 项测试通过**。`node --check` 和 `git diff --check` 通过。此次桌面启动修正不涉及业务代码或持久化格式；没有重新把前一轮全仓测试记为本次重新执行。

### 主题脚本提交历史与同类遗漏调查

用户进一步要求核对最近更新是否误删主题脚本。检查提交历史、构建配置与本机输出，结论是**主题源码没有被近期提交删除，本次缺失由审查中的单独 renderer 重建造成**：

| 证据 | 结果 |
| --- | --- |
| `5f3f461e`，2026-04-23 | 旧 `desktop/src/lib/theme.js` 正式迁移为 `desktop/src/shared/theme.ts`，新增 Vite IIFE 构建；旧源文件删除和新源文件、构建步骤同次提交 |
| 2026-09-21 至当前 HEAD 的删除历史 | 未发现文件删除记录；9 月 27 日 Pi 升级与后续修复没有修改主题源码或主题构建配置 |
| `583cdff6`，2026-09-27 | renderer 增加 pet 入口；CI 从单独 `build:renderer` 改为完整 `build:client`，没有删掉 theme 步骤，但新增桌面冒烟只查两个 HTML 且启动期限为 45 秒 |
| 本机 `build-client.log`，2026-09-29 16:47 | 完整构建明确产出 `desktop/dist-renderer/lib/theme.js`，5.18 kB |
| 本机 `build-renderer-final.log`，2026-09-29 17:10 | 后续只跑 renderer；`emptyOutDir: true` 清理输出树，审查执行者遗漏了再次构建 theme，这是本次缺失的直接操作原因 |
| 正常启动/发布链 | `start`、`start:dev`、`build:client` 均先 renderer 后 theme；发布 CI 的独立 renderer-box 也明确按此顺序执行 |

补齐本机 theme 后，逐个检查生成 HTML 的直接脚本、样式、图片引用：当前桌面 renderer **150** 个、独立 splash **2** 个、现存 9 月 27 日服务器移动页产物 **10** 个，均无缺失。这一检查不等价于验证所有动态资源或所有历史安装包。

另用临时夹具实际复现两处更早存在的同类校验缺口：`packRendererArtifact()` 在 `theme.js` 缺失时仍生成归档，`copyServerRuntimeAssets()` 只检查 `lib` 目录而未检查 theme，仍复制出缺少该脚本的移动页。这两处检查分别沿自 7 月 11 日和 5 月 17 日；不是最近两天才引入，也没有证据表明现有正常 CI 发布过这样的残缺包。

两处现已加入 theme 文件检查：在替换先前归档或移动页目录之前明确报错；保留正常构建顺序，不通过关闭输出清理来混入陈旧文件。两个新增回归均先在旧实现失败，修复后通过，并验证原产物保留。打包、移动页复制、独立服务器和种子验证四个文件共 **61 项测试通过**；正常产物打包、种子签名验证仍通过。`tsconfig.test.json` 类型检查通过；修改脚本与测试的 ESLint 为 0 error、1 条原有 `any` warning，未新增 warning。

## 实测边界

本机验证环境为 Windows x64 / Node 24.15.0。全仓测试与分块审查不等于不存在任何缺陷的证明。macOS/Linux 原生行为、真实外部消息投递、在线模型响应、安装器和正式发布签名不在本次本机验证范围内。检查日志和临时产物保留在忽略目录 `output/repository-review-20260929/`，不纳入提交。
