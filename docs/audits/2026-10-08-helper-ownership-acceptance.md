# Hana helper 所有权修复与独立验收 — 2026-10-08

结论：**helper 所有权候选在明确允许的验收范围内通过，可提交至
`feature/xingye-mvp`。** 本记录不表示正式 AppKit serve、真实 Computer Use 或整个
Mac GUI 已验收。修复和独立验收分开执行，告警修正后再次独立复验。

## 基线与提交范围

- 基线为 `5e20b160eb10f5700216b6fa7d3072ed5868d335`；最终候选包含 10 个源码/测试文件，
  加本验收文档。提交准备时逐文件 SHA-256 和模式匹配独立复验冻结清单，暂存区为空。
- 范围为 macOS provider、helper Swift package/main、socket lease、daemon 构建补丁、
  无 GUI native probe，以及相关 provider/native 生命周期测试。
- Cua 仍固定为 `d38bfbfb6b1d4296903477f517b1a0fa54af497b`。没有升级依赖、修改
  package/lockfile、warning baseline、main/Pi/发布配置、路径安全或会话休眠分支。
- ignored `output/`、原始日志、构建二进制及用户数据不纳入提交。没有替换开发 helper。

## 修复机制

原问题是 provider 附着其他 daemon 后误认所有权并停服，以及 native DaemonServer
退出或失败时对共享 socket 的无条件 unlink。

provider 现在把附着与自有 ChildProcess 分开：附着不授予停止权。新 child 带随机实例
ID，就绪需要匹配实例握手且 child 未退出。停止和失败回收只对自己保存的 ChildProcess
发送信号，等待退出；不向共享路径发送全局 shutdown，也不使用保存的数字 PID 或进程组
kill。SIGTERM 超时后才对同一 child 使用 SIGKILL；退出无法确认时保留归属并报告错误。

启动 bundled helper 前检查 `version --daemon-protocol`；旧二进制缺少
`hana-daemon-ownership-v1` 时拒绝启动。已有旧 daemon 可以附着，但附着者没有停止权。
正式 helper 的能力引用修补后的 `DaemonServer.hanaOwnershipProtocol` 导出符号，
漏用补丁不能由 wrapper 自行宣称该能力。

native lease 在持久 `.lock` 文件上持有生命周期排他 flock，覆盖准备、绑定、初始化失败、
服务和退出清理。锁文件不 unlink；已有活跃 legacy socket 即使不参与锁协议也不能覆盖。
只有 ECONNREFUSED/ENOENT 且文件身份不变时回收 stale socket。清理需要 lock 身份和目标
device/inode/type/owner 仍匹配，保留替换后的 socket/pid 文件。失败关闭已打开 fd；accept
loop 已关闭的 fd 不重复关闭。该协议不能控制外部非合作程序之后自行 unlink 或同用户恶意
替换路径，保留这一协议边界。

正常 helper 构建入口把 lease 与补丁应用到固定 Cua checkout。独立验收核对了从 pin 原始
源码重算的补丁、幂等性及生成 lease，并通过未改动的 `buildComputerUseHelper` 入口实际
编译正式产品到独立 staging 输出；该目录只有正式 helper，没有 test probe。

## 本轮独立复验

以下检查都实际执行，exit 0：

| 检查 | 结果 |
| --- | --- |
| 7 文件定向 Vitest | **101 通过 / 0 失败 / 0 跳过** |
| `npm run typecheck` | 三个 tsconfig 通过 |
| `npm run lint:warnings` | **7827 warnings；新增 0、减少 54、errors 0** |
| `npm run lint:boundary` | 1 个已跟踪边界债务，无新增 |
| `git diff --check` | 无问题 |

定向文件为 `computer-use-macos-cua-provider`、`computer-use-macos-daemon-ownership`、
`computer-use-host`、`computer-use-helper-build-script`、`computer-use-helper-cursor-source`、
`computer-use-packaging-contract`、`computer-use-windows-uia-provider`，均位于 `tests/`。

首次独立验收发现官方 warning ratchet exit 1，新增 4 个源码锚点。旧报告的每文件/规则
warning 总数净减少 5，不能替代按具体 site 执行的门禁。修复者仅调整 provider 和既有
provider test 的类型标注后，本轮独立执行官方门禁通过；baseline、lint 脚本和配置未修改。

## 复用的上一轮证据与依据

本轮没有把已有结果算作新跑。独立对自己的上轮快照和当前两个类型编辑文件分别执行
TypeScript 5.9.3 transpile（ES2022/ESNext、isolatedModules、无 source maps）与 esbuild
TS transform，输出 JavaScript 均逐字节相同，两侧 TS diagnostics 为 0。完整 provider
Node ESM bundle 也与上轮逐字节相同。其余 8 个候选源码、4 个相关 native 二进制、生成的
DaemonServer/lease 及相关配置没有变化，所以复用下列适用证据，没有机械重跑全量/native。

| 上一轮实际检查 | 结果和证据限度 |
| --- | --- |
| 允许范围全仓 Vitest | **15525 通过 / 0 失败 / 21 跳过，total 15546**；两个真实 Electron UI 文件未运行 |
| 隔离 native 生命周期 | **10/10**；真实 DaemonServer 与空 ToolRegistry，不启动 AppKit |
| 正式 staging helper 配合 native 用例 | **10/10**；正式 helper 仅 status/version，daemon 仍是无 GUI probe |
| provider/native 衔接 | **6/6**；真 provider、ChildProcess/socket；serve 映射到 probe，工具响应 stub |
| 真实旧二进制能力保护 | version 返回 `0.1.0`；provider 拒绝启动，spawn=0；未运行旧 AppKit serve |
| Swift release / 正式 helper 构建入口 | exit 0；构建到 scratch/staging，没有安装或替换现有开发产物 |

全仓明确排除 `tests/mermaid-style-isolation.test.ts` 和
`tests/server-connection-csp.test.ts`，因为它们会启动真实 Electron renderer。21 跳过包含
5 个平台条件用例、6 个 Windows opt-in smoke、10 个单独 opt-in 执行的 native 用例；
单独 native 的通过不能改写全量中的跳过统计，也不与全量测试数相加。

隔离 native 与衔接场景实际覆盖实例匹配、附着释放、竞争启动、初始化失败回滚、旧 child
退出后附着 replacement、旧实例退出保留替换路径、stale socket 恢复、锁释放、活跃 legacy
listener、锁路径/非 socket/pid 文件保护。纯 mock 用例不是 native 证据；桥接和 probe
也不代表正式 AppKit helper 的完整行为。就绪探测期间 child 提前退出另有定向 mock 覆盖。

上一轮普通沙箱阻止 compiler cache/dsymutil 写入及 bind/listen，正式 `require_escalated`
复跑后成功；没有明确审批拒绝，没有关闭系统保护或通过换路径绕过拒绝。本轮复验全部
普通沙箱执行。测试用本轮创建的隔离临时 socket、子进程及 listener，只清理明确归属对象。

## 本机证据索引与产物身份

原始本机证据未入版本控制：

- `output/helper-ownership-independent-2026-10-08/`：上一轮命令/结果、native/full/bridge/
  旧二进制/正式构建记录及 candidate 快照。
- `output/helper-ownership-independent-recheck-2026-10-08/`：本轮 `commands.json`、
  `equivalence.json`、`reused-evidence.json`、`final-manifest.json`、各项报告与 handoff。

正式 scratch 与 staging helper 的 SHA-256 一致：
`956e4f9047275093b749f69eaad09081371e2e275a6b6025ee3d34e7124c5aee`。
probe 为 `eeb080da3c373d542246fbf272ac97785c5d6fa398c548379beea634f49b5d0c`。
原开发 dist helper 仍为旧版本，SHA-256
`7c0c2dbcc28e558c23553644fa61f96b851bb675055c5005b7b06c3e7c782129`。
后续使用/打包需要通过正常 helper 构建更新二进制；本次提交源码不等于已替换部署产物。

## 明确未验范围

正式 AppKit serve、ConfigStore/AgentCursor 初始化、真实 UI 工具执行期间退出、隐私授权、
TCC、屏幕捕获、键鼠、完整应用 E2E、签名安装包/公证、正式 Windows runtime 未验证。
本轮不启动上述路径、不触碰真实用户 socket 或现有 daemon、不处理其他并行 session 问题。
此前桌宠 GUI 的暂缓授权不作为本轮新 helper 行为的通过证据。

此记录与本轮修复仅发布到 feature 分支，不合并 main、不创建 PR 或修改 CI。仓库现有 CI
只针对 main push 或面向 main 的 PR 触发；feature push 本身不作为该新提交 CI 通过证据。
