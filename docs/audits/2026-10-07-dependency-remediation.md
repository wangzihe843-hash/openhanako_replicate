# 2026-10-07 依赖告警分组修复与 Mac 验收交接

2026-10-08 续修：昨日独立验收指出的 CLI 闭包、shell manifest 和 Mermaid 图外动画阻塞已完成修补与聚焦验证，见 [续修交接](2026-10-08-dependency-followup.md)。下文保留 10 月 7 日首次交接的历史状态与原始证据；其中 Mermaid“未修复”的结论由续修报告更新。仍未 commit/push，等待父会话重新独立全量 Mac 验收。

## 结论与范围

以 `67aad2c06b8906657d0d7962ab57545dc05d5ae6` 为基线完成本轮依赖修补、代理策略适配和聚焦验证，**未 commit、未 push**。本地原始 `npm audit --json` 从 **64 个受影响包条目降至 26 个**；没有清零。剩余条目见下文。另发现 Mermaid 全局 `@keyframes` 样式问题，保留为未修复项，不能以 audit 或普通选择器测试通过宣称完整 CSS 隔离。

当前交父会话安排全新、独立的全量 Mac 验收。上一轮路径修复的 15362 pass / 12 skip、DMG 和 npm start 结果不能作为本轮依赖的验收结果。Windows 专项按用户要求延后。本轮没有加入 L3/L4、hibernate 或云端另行准备的 Mac 模块修复。

唯一业务代码变更在 `lib/net/outbound-proxy.ts`。此外修改依赖清单和锁文件，新增七个聚焦测试文件，并修复现有 Electron CSP 测试在 Mac 上使用未配置 loopback 地址的问题。没有修改生产 CSP、sandbox、ACL、系统信任、密钥、原生模块 ABI 配置或 `.npmrc`。

## 基线与可比证据

所有本机原始证据位于 [tmp/dependency-remediation-2026-10-07](../../tmp/dependency-remediation-2026-10-07/)，该目录被 Git 忽略，交接时应保留；不是随 commit 自动提交的附件。

| 指标 | 修复前 | 修复后 |
| --- | ---: | ---: |
| 受影响包条目 | 64 | 26 |
| low / moderate / high / critical | 4 / 26 / 34 / 0 | 4 / 17 / 5 / 0 |
| `via` 对象内去重的 GHSA 公告 URL | 182 | 8 |
| audit dependency total | 1348 | 1307 |
| `npm audit --json` 退出码 | 1 | 1 |
| `npm ls --all --json` 退出码 | 0 | 0 |

64/26 是 npm 归因后的包条目数量；182/8 是公告 URL 去重数量，均不能直接解释为独立可利用漏洞数。修复后八个 URL 均已在修复前结果中出现。两个 audit 的退出码 1 均表示发现漏洞，完整 JSON 和 stderr 已保存，未当作“无输出”。最初受沙箱 DNS 限制的失败输出也单独保留。

| 文件 | SHA-256 |
| --- | --- |
| 基线 package-lock.json | `8dac816329a11212136393316818ae83a7d57fd0146d699e11f6a10c08b89d7f` |
| 最终 package-lock.json | `1240cc744766f1970c7508faff462e4a19d3571605386eb80e7ce79b986505f3` |
| 未变更的 .npmrc | `ce00fe5025692993005d3a5350ff13f8a568d604158041df74f1d229a2dfb607` |

原文：[修复前 audit](../../tmp/dependency-remediation-2026-10-07/npm-audit-before.json)、[修复后 audit](../../tmp/dependency-remediation-2026-10-07/npm-audit-after.json)、[修复前实际安装树](../../tmp/dependency-remediation-2026-10-07/npm-ls-before.json)、[修复后实际安装树](../../tmp/dependency-remediation-2026-10-07/npm-ls-after.json)。最终 audit 采集于 2026-10-07 14:17 UTC，此后锁文件未改变。

最终相对基线有 **61 项新增、102 项删除、124 项变更**的 lock `packages` 路径；变更数包含根清单，以及版本相同但元数据或提升位置变化的条目，不等于升级了 124 个包。完整 before/after 字段保存在 [final-lock-diff.json](../../tmp/dependency-remediation-2026-10-07/final-lock-diff.json)，逐路径摘要和每次安装归属见 [grouped-lock-changes.md](../../tmp/dependency-remediation-2026-10-07/grouped-lock-changes.md)。各批记录会重叠，不能直接相加代替最终差异。

保留 `save-exact=true`、`min-release-age=1`、audit 和 lock 约束。对相对基线新增的 **139 个 name@version**，已逐一读取 npm 官方 registry 发布元数据，核验正式版本、至少一天发布年龄、tarball integrity 与 engines；最短发布年龄为 1.5101 天。开发 Node 24.21.0 和打包 Node 24.15.0 的 engines 均匹配。见 [all-new-version-verification.json](../../tmp/dependency-remediation-2026-10-07/all-new-version-verification.json)、[packaged-node-engine-check.json](../../tmp/dependency-remediation-2026-10-07/packaged-node-engine-check.json) 及对应 `registry-*.raw.json`。没有使用 `npm audit fix --force`、全面追 latest 或自动升级 Pi。

## 分组取舍与适配

以下版本是实际锁定版本，不是原清单范围。

| 分组 | 主要版本变化 | 取舍与验证范围 |
| --- | --- | --- |
| 1：Markdown/YAML | markdown-it 14.1.1 → 14.3.1；js-yaml 4.1.1 → 4.3.2；linkify-it 5.0.0 → 5.0.2 | 保持同主版本；实际 `linkify`、`typographer` 和 skill frontmatter 入口，覆盖复杂度输入、合并限额、正常 aliases/时间戳/优先级。 |
| 2：富文本/图表 | Tiptap 六个直接包 3.22.0 → 3.30.5；ProseMirror view 1.41.7 → 1.42.6、model 1.25.4 → 1.25.12；Mermaid 11.10.1 → 11.16.1；DOMPurify 3.4.2 → 3.4.16 | Tiptap 与 Mermaid 自身也有公告，因此不只更新两个传递包。Mermaid 新版声明的 parser 1.2.1 移除旧 langium/chevrotain 链；使用父包兼容范围，未强塞传递大版本。真实编辑器粘贴、正常图表、普通 CSS 选择器范围和 SVG sanitizer 均验证；全局 keyframes 仍有残余。 |
| 3：网络 | 根 Undici 7.24.7 → 7.30.0；Hono 4.12.9 → 4.13.11；node-server 1.19.11 → 1.19.17 | HTTP/WS、无 Content-Length 的 body limit、abort、流、redirect、CONNECT proxy 回归。node-ws 1.3.0 保留；node-server 2.x 不强行绕过 peer 范围。 |
| 4：飞书 | SDK 1.59.0 → 1.71.1；Axios 1.13.6 → 1.20.0；form-data 4.0.5 → 4.0.6；qs 6.15.0 → 6.16.0 | SDK 官方依赖放宽后自然解析 Axios，未新增全局 Axios override。真实 SDK 的假 token、text/image/file、错误响应、WS，以及 NFT 裁剪后实际加载均通过。 |
| 5：桌面/构建 | Electron 42.3.0 → 42.10.0；updater 6.8.3 → 6.8.9；builder-util-runtime 9.5.1 → 9.7.0；builder 26.8.1 → 26.15.0；Vite 7.3.1 → 7.3.5 | 保持主版本；42.10.0 满足本轮指定兼容下限，实际 Mac 二进制已安装并运行 CSP 测试。验证 updater 跨源重定向凭据剥离、客户端构建和真实 NFT。全量 DMG/npm start 仍交父会话。 |
| 6：运行时传递包 | xmldom 0.8.11 → 0.8.15；lodash 4.17.23 → 4.18.1；lodash-es 4.17.21 → 4.18.1；ip-address 10.1.0 → 10.7.3；tmp 0.2.5 → 0.2.7 | 在现有父依赖范围内更新；文档转换、代理和 ZIP 保护回归。lodash-es 随第 2 批解析，其余在第 6 批。 |
| 7：开发传递包 | Babel 7.29.7–7.29.9 家族、humanfs、browserslist、nanoid 3.3.20、postcss 8.5.29、source-map-js 1.2.2 等 | 按现有范围定点 update；所有实际新增版本统一复核 release age、integrity、Node engines。构建与 lint 检查覆盖适配。 |

选版依据包括上游 [markdown-it 14.3.1](https://github.com/markdown-it/markdown-it/releases/tag/14.3.1)、[js-yaml 4.3.2](https://github.com/nodeca/js-yaml/releases/tag/4.3.2)、[DOMPurify 3.4.16](https://github.com/cure53/DOMPurify/releases/tag/3.4.16)、[Mermaid 11.16.1](https://github.com/mermaid-js/mermaid/releases/tag/mermaid@11.16.1)、[Undici 7.30.0](https://github.com/nodejs/undici/releases/tag/v7.30.0)、[Hono 4.13.11](https://github.com/honojs/hono/releases/tag/v4.13.11)、[飞书放宽 Axios 范围的提交](https://github.com/larksuite/node-sdk/commit/8b3e0df3af9401c263dc96026e1c7f17460a21cc)、[Axios 1.20.0](https://github.com/axios/axios/releases/tag/v1.20.0)、[Electron 42.10.0](https://github.com/electron/electron/releases/tag/v42.10.0)、[builder 26.15.0](https://github.com/electron-userland/electron-builder/releases/tag/electron-builder@26.15.0) 和 [Vite 7.3.5](https://github.com/vitejs/vite/releases/tag/v7.3.5)。具体受影响范围保留在修复前 audit 原文和分类文件，未只依赖“最新版本”标签。

Tiptap React 的两个可选菜单依赖允许 `^3.30.5`，自动解析曾选到 3.31.4，而后者 peer 要求 core/pm 精确 3.31.4。因此新增**仅限 @tiptap/react 子树**的两个 3.30.5 override，保持同一发布家族；没有盲目覆盖 ProseMirror。原有 brace-expansion/form-data/qs/tough-cookie/tar overrides 未改。

Pi core/ai/coding-agent 均为 1.0.3；三包及 coding-agent 嵌套 Undici 8.10.2 的 lock 对象与基线完全相同。根 Undici 为 7.30.0；此更新**不等于修复 Node 自带 fetch 的内置 Undici**。Pi postinstall 校验通过。

## 代理策略修复

原代码向 proxy-agent 6 传入 URL 字符串，但该版本构造函数接收 options。这使预期的手工代理配置失效，并可能读取原始环境变量中的 PAC/FTP 链。现改用 `getProxyForUrl`，每次请求及重定向均从当前配置与传入环境生成受支持协议策略，保留 loopback/noProxy 规则。Telegram 的底层 request 显式设置 `proxy: false`，避免其先读取原始环境再覆盖应用策略。

唯一一次独立候选复核发现：Telegram 长期保留 options 时，初版修复会捕获旧配置。现保留稳定 Agent 引用，切换配置时清理旧连接池，由 callback 每次读取当前策略。原候选有两项生命周期断言失败，修复后单元与真实 loopback 网络验证覆盖 **direct → proxy A → proxy B → direct**、环境覆盖、重定向、回环绕过。不是只把 PAC 包从 audit 输出中隐藏；依赖仍在，残余如下。

## 剩余 audit 条目：26 包 / 8 公告 URL

下面各组包集合合计为 26；request 的两个公告共同归在 UUID/request 组，避免重复计数。表中“路径未使用/受限制”不等于上游漏洞已修复。

| 组别与包条目 | 公告与版本边界 | 本轮处置及限制 |
| --- | --- | --- |
| **4 high**：basic-ftp、get-uri、pac-proxy-agent、proxy-agent | GHSA-c475-qrg2-pj4r；basic-ftp ≤6.2.0，修复 6.2.1 | get-uri 6 依赖 basic-ftp 5.x，升级超出其范围。业务代理入口已按上述策略拒绝 PAC/FTP，真实网络回归通过；不声称任意第三方代码都无法调用该链。 |
| **1 high**：extract-zip | GHSA-jmr9-qjv8-65gv、GHSA-7pqw-9j4j-h8q3；2.0.1 无已发布修复 | 业务 ZIP 解压均经 `lib/extract-zip.ts` 拒绝 symlink 的 wrapper，正常压缩包及隔离 canary 测试通过。保留功能和保护；不把该结论推广到外部工具或其他 tar 解压路径。Electron 下载链已转到其父包声明的 `@electron-internal/extract-zip` 1.0.5。 |
| **3 low**：katex、mermaid、@traptitech/markdown-it-katex | GHSA-238p-pmpm-9mq7；<0.18.2 | 当前 0.16.47；现有父包约束 0.16，跨 pre-1 minor 要独立兼容迁移。公告需先有原型污染；部分 Markdown 输出不统一经过 sanitizer，不能用 Tiptap 修复推断已阻断所有污染来源。 |
| **1 low**：esbuild | GHSA-g7r4-m6w7-qqqr；≥0.27.3 <0.28.1 | 当前 0.27.4，Vite 7 约束 0.27。公告针对 Windows 开发服务器路径；代码使用 build/transform，未找到 esbuild.serve 调用。本轮 Mac 不因此跨 pre-1 minor 强改，也不声称 Windows 已验证。 |
| **7 moderate**：uuid、exceljs、@cypress/request、@cypress/request-promise、node-telegram-bot-api、request、request-promise-core | UUID：GHSA-w5hq-g745-h8pq，<11.1.1；request：GHSA-p8p7-x288-28g6，无已发布修复 | UUID 8.3.2/3.4.0 由父依赖约束；所查 ExcelJS/request 路径使用 v4，UUID 公告涉及带调用者 buffer 的 v3/v5/v6，未找到相应调用。旧 request 为 request-promise-core peer 自动安装；实际 @cypress/request-promise 注入 @cypress/request，未找到业务加载旧 request 的路径。这是源码范围结论，不是全局不可达保证。 |
| **10 moderate**：sprintf-js、argparse、mammoth、roarr、global-agent、@electron/get、app-builder-lib、dmg-builder、electron-builder、electron-builder-squirrel-windows | GHSA-hp3w-g68c-fv3c；sprintf-js 无已发布修复 | Mammoth 相关路径为 CLI argparse，业务文档转换未使用该 CLI；另一条为 builder → @electron/get 3.1 → global-agent/roarr。未找到攻击者控制格式串的业务调用。未采用 audit 建议的 builder 旧版或 Mammoth 0.3.29 降级。 |

每条公告、npm 当前 range/fixAvailable、受影响安装位置和依赖传播边均完整保留于 [npm-audit-after.json](../../tmp/dependency-remediation-2026-10-07/npm-audit-after.json) 和 [audit-after-classification.json](../../tmp/dependency-remediation-2026-10-07/audit-after-classification.json)。上游 KaTeX 说明见 [GHSA-238p-pmpm-9mq7](https://github.com/KaTeX/KaTeX/security/advisories/GHSA-238p-pmpm-9mq7)，sprintf-js 原始报告见 [issue 237](https://github.com/alexei/sprintf.js/issues/237)。原始安装日志内的 deprecation 提示也保留；例如 builder 间接使用的 glob 10.5.0 并未为消除提示而盲目跨主版本。

## audit 之外的已知残余

**Hono node-server serveStatic 双重解码。** 上游 [GHSA-rmxm-3fg6-px4f](https://github.com/honojs/node-server/security/advisories/GHSA-rmxm-3fg6-px4f) 影响 ≥1.19.10 <2.1.3，当前 1.19.17 仍在范围内，修复为 2.1.3。此公告未列在本次 npm audit 原文里。本项目未导入该包的 `serveStatic`/`serve-static`，使用 createAdaptorServer、createNodeWebSocket 及自己的 mobile-static realpath 边界。node-ws 1.3.0 的 peer 为 node-server `^1.19.2`，因此本轮不强改到 2.x；也未把 hono/cors 公告套到项目自写 cors-policy。

**Mermaid 全局 keyframes，未修复。** 独立候选复核发现 themeCSS 和 fontFamily 两种输入均可在生成 SVG 的 style 中留下未命名空间化的 `@keyframes hana-pulse`。主任务随后使用真实 `renderMermaidDiagrams` + Mermaid 11.16.1 复现输出；只用 jsdom 补几何接口，没有替换解析器或 sanitizer。应用多处 CSS 正使用同名动画，因此存在影响图表外状态动画的可能。示例为：

```text
%%{init: {"themeCSS":"@keyframes hana-pulse { from {opacity:0} to {opacity:0} }"}}%%
flowchart LR
A-->B
```

fontFamily 变体、完整输入与输出 SVG 见 [mermaid-residual.json](../../tmp/dependency-remediation-2026-10-07/mermaid-residual.json)；复现脚本为 `mermaid-residual-probe.mjs`。当前证据证明生成了全局动画规则，**没有在真实 Electron 界面复现外部视觉影响，也没有执行 XSS**。普通选择器隔离测试通过不覆盖此问题。未找到已核实的上游修复，本轮未仓促删除合法动画或新增 CSS 解析/隔离架构；该项需父会话另行决定修复或明确接受残余。

独立复核仅进行了一次；最初候选 patch SHA-256 为 `71b4daa22672636cf79f1f5354ba1ca72f447641b36407dcec9f3cdac403bd4d`。两项发现与处理摘要见 [candidate-review-disposition.json](../../tmp/dependency-remediation-2026-10-07/candidate-review-disposition.json)。复核者的 loopback 命令因权限审批超时没有运行，网络成功结论来自主任务之后获准执行的回归，不冒称复核者已验证网络。

## 聚焦验证与兼容范围

日志均为上述证据目录下同名 `.log`，命令、时间、退出码与锁哈希在 `.result.json`。不同批次测试相互重叠，不能把以下 pass 数相加当作全量测试量。

| 证据标签 | 结果 | 主要覆盖 |
| --- | --- | --- |
| group1-retest | 7 文件 / 88 pass | YAML 合并限额和语义、实际 Markdown 配置、隔离超时输入 |
| group2-editor-retest | 8 文件 / 61 pass | 实际富文本粘贴、上下文属性、Tiptap 属性合并、真实 Mermaid |
| group3-network-test-open | 11 文件 / 98 pass | Hono HTTP/WS、Undici abort/proxy/redirect/stream |
| group4-feishu-finaltest | 7 文件 / 62 pass | 假认证、文字、图片、文件、错误响应、真实 SDK WS |
| group5-toolchain-test | 10 文件 / 92 pass | updater 凭据重定向、桌面启动契约、构建工具适配 |
| group6-runtime-test | 7 文件 / 51 pass | 文档解析、正常 ZIP 与 symlink 防护、代理 |
| proxy-lifecycle-network | 6 文件 / 45 pass | 保留 Telegram options 时 direct/proxy A/proxy B/direct 的真实请求 |
| final-focused-suite | 11 文件 / 99 pass | 最终依赖聚焦组合；命令中另有一个不存在的 renderer 文件参数，未计作执行，真实 renderer 已在第 2 批覆盖 |
| final-electron-csp-pass | 4 文件 / 18 pass | 实际 Mac Electron 42.10.0、HTTP/HTTPS、WS、Cookie、重定向拒绝、CSP 及文档授权 |
| postinstall-pi-check | 退出 0 | `[verify-pi-sdk] all checks passed` |
| final-typecheck-confirmed | 退出 0 | 三个 tsconfig |
| final-lint-confirmed | 退出 0 | 7836 warnings；新增 0、移除 45、error 0；原 ratchet 未降低 |
| final-build-client | 退出 0 | main/preload/renderer/splash/theme |
| final-build-server-lifecycle | 退出 0 | 最终代理代码的 open Mac 构建与真实 NFT 裁剪 |
| final-nft-confirmed | 退出 0 | 裁剪后真实 SDK 1.71.1 / Axios 1.20.0、Telegram、Pi、Undici 路径；SQLite 和 node-pty |
| final-open-server-smoke | 退出 0 | 清空继承凭据环境、临时 HANA_HOME；打包 Node 启动 HTTP 200；缺少必需资源时可归因失败 |

NFT 实际保留 5186 文件、删除 18790 文件（约 112 MB），没有退回未裁剪树。其 Mac 打包 Node 为 24.15.0 / ABI 137，SQLite `:memory:` 查询及 node-pty `/usr/bin/true` 启动成功；jieba/anydoc 构建检查也通过。保留 Node 服务端与 Electron ABI 的区分，未统一重编 native modules，`npmRebuild: false` 未变。详见 [nft-runtime-smoke.json](../../tmp/dependency-remediation-2026-10-07/nft-runtime-smoke.json)。

测试使用合成输入、假凭据、`.invalid` 域名和 loopback 端点；没有生产飞书/Telegram 请求。首次失败和修正过程保留：沙箱 bind EPERM、测试用假飞书 URL 的端口占位符误解、SDK 上传返回结构断言、ClipboardEvent 类型、NFT harness 的 package exports/Pi 路径选择等。它们已与真实产品问题分开记录，未通过放松安全断言、关闭 CSP 或丢弃失败日志获得通过。忽略目录里的辅助脚本补充 globals，生成的浏览器 bundle 放入已有忽略规则覆盖的 output 目录；没有改 lint 规则。

## 用户看到的 Electron 弹窗

2026-10-07 14:32:39–14:33:04 UTC 的 `final-electron-mac-retry`，在 Mac 手动运行原 Windows 专用 `tests/fixtures/server-connection-csp-electron.cjs` 时，监听 `127.0.0.3` 失败并弹出主进程异常。这属于本次测试进程；没有加载产品主入口。原脚本未记录 PID，不能补称知道失败 PID。测试超时退出后检查确认没有本项目 Electron 测试进程残留。

已将监听统一为 127.0.0.1，URL 用 localhost 的不同端口保留不同 origin。生产初始 connect-src 不允许 localhost，因此原先“连接前拒绝/保存后需 reload/无关 origin 仍拒绝”的断言继续有效。补充 listen 错误拒绝、结构化错误输出、异常退出与 PID 记录。测试 wrapper 现在在 Mac 和 Windows 启用，并从 Electron 安装器的 path.txt 解析真实二进制，避开 Vitest 的 Electron mock。

修复后真实 Electron 的 HTTP/HTTPS 两场景均通过，成功进程 PID 71197 仅对应成功手动复测，不是失败进程。详见 [csp-failure-incident.json](../../tmp/dependency-remediation-2026-10-07/csp-failure-incident.json) 和 [成功场景 JSON](../../output/dependency-remediation-2026-10-07/electron-csp-mac/result.json)。没有新增 loopback alias、修改系统证书信任或关闭应用安全选项。

## 父会话后续验收

在上述锁哈希及本轮最终源文件基础上，由新上下文独立执行全量 Mac 测试、完整服务器/seed 验证、原生 helper、实际 npm start 和 DMG/打包验收。不可沿用路径修复 commit 的旧结果；Windows 未验证。若后续应用云端补丁或再次修改依赖，需重新关联测试与源文件状态。

本阶段完成了有兼容依据的依赖修补和必要适配，未承诺所有安全问题解决。26 个 audit 包条目、node-server 未使用 helper 的公告、Mermaid keyframes 问题均留存交接。完整最终文件清单、哈希与可应用差异在本机 `final-state.json` / `final-candidate.patch`；它们包括新增测试，避免普通 `git diff` 漏掉未跟踪文件。
