# 剩余 warning 分块修复与复审（2026-09-14）

最终检查完成后，2,987 个源码文件的 SHA-256 与复跑前冻结值全部一致。

本轮承接 2026-09-13 清单：三名 subagent 分别处理前端、后端、server/shared/sandbox，随后交叉复审，主任务负责集成、类型检查、warning 门禁、持久化与构建核验。用户已授权全部完成并通过审查后 commit & push。此前紧急 W01–W03 与本轮一起交付。

## 结果与优先级清单

| 任务 | 本轮状态 | 结果 / 后续边界 |
| --- | --- | --- |
| W01–W03 | 已完成 | 巡检保留用户当前指令、日志读取失败不覆盖历史、快捷聊天回滚按服务端确认值同步并核验宿主；详见上一份紧急修复报告。 |
| W04 | 已完成 | checkpoint 显式区分 created / skipped / failed；失败包含会话和文件关联，保留原工具结果及 best-effort 执行策略。 |
| W05 | 225 处均已审查 | 84 处调整行为或反馈，141 处保留明确契约；不能把“补注释后 warning 消失”等同于修了 bug。完整逐点表另附。 |
| W06–W07 | 已完成 | 预览消费显式输入；手机 store 使用订阅快照，写操作后读取最新值；cover/iframe/owner/profile/model 字段依赖明确，保留草稿与连接隔离。 |
| W08–W09 | 已完成 | usePanel 稳定回调与 reloadKey，滚动 Hook 补依赖，清理捕获的同一 DOM 节点。 |
| W10–W13 | 已完成 | 稳定翻译 fallback 并响应语言变化；简化派生值，移除已证实不消费的依赖，图片预加载使用相邻 FileRef 版本快照。全部 33 条 Hook 诊断退出。 |
| W14 | 首批契约已完成，继续分批 | 补运行时身份/就绪/路径、消息数组、取消返回值、会话压缩恢复的可空结果契约；继续通过 Pi adapter。尚未把整个 engine/coordinator 注入图转为严格接口。 |
| W15 | 首批边界已完成，继续分批 | 模型能力归一化使用真实输出类型和 unknown 输入，插件路由使用 Hono/参数收窄；剩余消息事件、MCP、chat-slice 等仍需逐模块治理。 |
| W16 | 首批测试工厂已完成，继续分批 | 新增 HanaToolContext 工厂，默认未配置 I/O 直接失败，替换插件工具的空对象强转；模型隔离测试补真实模型/session 类型。剩余大量 any mock 仍需治理。 |
| W17–W22 | 已完成 | 清理未使用绑定/参数、const、转义和失效 suppressions；保留副作用调用、秘密字段过滤与 timer 初始化顺序。 |
| W23 | 已实现 | 新 warning 按文件、规则、消息和 AST 上下文识别，不能通过删除另一条 warning 抵消；跨 callback 和 CRLF/LF 有回归。CI 保存完整 JSON，常规检查不自动更新 baseline。 |
| V01 | 已修实现；原生验证待补 | deny-read 路径无法可靠探测时失败关闭；只有 stat/lstat 均 ENOENT 才允许跳过。Windows 注入测试不能代替 Linux 原生 bwrap。 |
| V02 | 已修实现；ACL 场景待补 | server-info 独占临时文件、先验证权限再写 token、原子发布；失败不发 ready。任意 Windows HANA_HOME 的父目录 ACL 隔离仍待目标环境验证。 |
| B01 | 保留并核对产物 | 19 条 classic script 提示对应旧启动脚本；保留执行顺序，theme.js 由后续 build:theme 生成。 |
| B02 | 一项修复，一项有意保留 | screenshot 已统一静态引用；sidebar-ui-slice 延迟读取 stores 用于避免初始化反向循环，不为了消警告改成静态边。 |
| B03 | 已测量，性能优化仍待单独任务 | 保存入口/大 chunk 原始及 gzip 体积；未抬高阈值，未声称实际首屏速度改善。 |
| B04 | 无扩大，保留旧项 | 完整闭包仅新增 nonfatal-error.ts；原有 mobile-workbench 一条边界耦合继续保留。 |

## 这轮发现并补修的行为问题

长期记忆源读取失败现在停止后续覆盖、删除和 LLM 编译；checkpoint 的不确定 stat 失败不再当作文件不存在；代理创建/恢复中的次要清理错误不会盖掉原始失败。归档批量清理返回实际删除数和逐项失败，界面不再把部分失败显示为成功，也不自动重放删除。

交叉复审修正了手机快照引入的三个边界：写操作后仍用旧快照、只读快照触发默认用户写入、默认用户初始化导致重复生成。实际 store 的挂载回归覆盖缺失/屏蔽/删除默认用户，Contacts 与 SMS 均仅触发一次生成。沙箱终止回归覆盖 Node 以 error 事件报告 kill 失败的行为，保留 aborted/timeout 错误及原始 cause，而非只测试同步 throw。

warning 门禁复审另补了匿名 callback 归属和跨系统换行一致性；移动警告到另一个测试回调会失败，单纯行号位移不会误报。reviewer 对最终前端、后端、sandbox/secret 写入和主任务辅助变更均未留下已确认阻塞项。

## 验证

全量 ESLint 为 **7,888 warning / 0 error**，紧急修复后的 8,248 减少 360（最初 8,252 减少 364）。规则分布为 `no-explicit-any` 7,759、`no-empty` 129，其他规则为 0。基线保留这些具体站点，不关闭规则。

新门禁正常检查模式退出 0：新增 0、移除 0、error 0。三套 TypeScript 检查和 renderer/server bundle 构建通过，完整依赖闭包、持久化指纹和开放边界检查通过。最终完整复跑 **exit 0 / success true**：1,360 个测试文件，14,389 项通过、41 项跳过、0 失败，未报告 worker 异常；耗时约 843 秒，maxWorkers=2。此前首轮发现两个过期源码断言及一次未说明原因的 worker 退出：断言已修正并独立复审，预览面板 8 项隔离回归通过；随后才执行本次完整绿色复跑。定向结果与全量存在重叠，不相加冒充独立覆盖数。41 项跳过包括平台限定的 POSIX 权限/符号链接场景及手动发布包 smoke；不把跳过视为已验证。

运行证据保存在本地 output/remaining-warning-fixes-2026-09-14/，完整 ESLint 诊断在 output/lint-warning-ratchet/。output 不随 Git 提交；可维护的 warning baseline、兼容性 receipts 与下面的逐点结论会提交。

本地 renderer 产物测量（字节 / gzip 字节）：main 为 1,740,049 / 565,974，PreviewEditor 为 646,335 / 217,735，ChatPage 为 581,317 / 183,154，theme-registry 为 576,728 / 188,443。server bundle 为约 5,161.63 kB / 1,372.39 kB。7 个 HTML 产物中，6 页共 19 个经典脚本引用的 src/type/async/defer 与顺序均保持；theme 构建后全部文件存在，实际静态路由两项响应为 200 且内容一致。以上体积不等于用户首屏耗时。

构建范围为现有依赖下的 Vite renderer、theme 和 server bundle；没有重新安装依赖，没有制作或运行完整签名发布安装包。服务端 bundle 的第三方 chokidar Stats 未使用提示仍保留。CI 配置已接入门禁，但既有 workflow 只监听 main 的 push/PR；本次 feature 分支 push 不等于已运行远端 CI。

## 仍需后续验证 / 治理

1. P2：在具备 bwrap 的 Linux 和指定 Windows ACL 环境完成 V01/V02 原生场景；本轮没有读取真实 token 或修改真实用户数据。
2. P2/P3：按 W14–W16 继续减少跨模块和测试 any；本批只交付可审查的第一组真实契约，不以隐式 any、双重强转或关闭规则抵消计数。
3. P3：围绕实际页面首屏测量做 chunk 拆分；保留原始阈值，避免破坏启动顺序。开放边界旧 mobile-workbench 耦合随对应架构迁移处理。

参考：[原始清单](2026-09-13-remaining-warnings-fix-list.md)、[紧急修复](2026-09-13-urgent-warning-fixes.md)、[225 处 catch 结论](2026-09-14-warning-catch-dispositions.md)、[持久化兼容性复审](2026-09-14-warning-fixes-compatibility-review.md)。原报告的历史计数和当时状态保持，以上表格为本次最新状态。
