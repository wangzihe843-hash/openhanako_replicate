# 2026-10-08 依赖修补续修交接

本轮针对 [昨日独立验收回执](../../tmp/dependency-independent-mac-2026-10-07/root-acceptance-receipt.md) 中的三项测试失败，以及真实 Mermaid 图外动画污染，完成最小修补与相关验证。当前可以交父会话安排全新 `gpt-6.1-sol` / `high` 独立 Mac 验收；**未 commit、未 push，不能把本次聚焦验证视为独立全量通过**。

HEAD 保持 `67aad2c06b8906657d0d7962ab57545dc05d5ae6`。恢复工作时，暂停记录中的 20 个候选文件哈希全部匹配；没有覆盖已保存修改。路径安全、会话休眠平台标记任务继续暂停，helper 所有权候选保持 HOLD，未应用云端生命周期补丁，未修改系统设置、认证或权限。

## 构建记录

使用项目现有命令 `node scripts/compute-cli-closure.mjs` 重新生成闭包。文件从 7159 变为 **7114**，NFT 从 6415 变为 **6370**。精确差异为增加 **13** 个路径、删除 **58** 个路径，其余条目内容未变：Axios 的旧 ESM 路径退出实际 NFT 闭包，新增其代理依赖；Hono 增加 router/buffer/crypto 路径并移除旧 smart-router 路径。未手工修计数或删除失败断言。

生成器同时重算 `build/open-boundary-baseline.json`，结果与原文件字节相同。完整逐路径差异见 [closure-diff.json](../../tmp/dependency-followup-2026-10-08/closure-diff.json)。

`build/shell-surface-manifest.json` 的 `generatedBy` 是 `manual census`，没有独立生成命令；按其指定来源 `package.json devDependencies.electron`，只将 Electron 版本从 42.3.0 改为 **42.10.0**。原有前向、反向和版本一致性测试均保留，两个测试文件现在 **66 pass / 0 fail**。

## Mermaid 修复

原 `securityLevel: strict` 会在生成 SVG 时将临时样式插入应用文档。只清理返回的 SVG 无法保护生成期间。新配置使用上游 `securityLevel: sandbox`，让临时渲染在隔离文档内完成；同时启用 `suppressErrorRendering`，由现有应用错误显示负责失败反馈，避免遗留临时错误图。

应用在 inert template 内读取上游返回的 iframe 内容，校验预期的 sandbox/base64 格式，解码后重新执行 DOMPurify 的严格 SVG 策略。该策略与 Mermaid 11.16.1 strict 分支相同，保留 foreignObject 和 dominant-baseline；新增“恰好一个 SVG 根元素”的格式检查。未加载返回的 data URL，也未关闭 sanitizer。

清洗后的 SVG 放入每张图独立的 Shadow DOM，隔离其 `@keyframes` 名称；图表仍以 SVG 展示。将原页面 SVG 的 display/max-width/height/margin 规则带入该作用域，保留响应式尺寸、HTML 标签、中文、合法边动画、源码显示/复制、异步竞态保护和编辑鼠标事件。没有修改生产 CSP，也没有把最终展示替换为可交互 iframe。

这是渲染工具内部的适配，没有新增依赖或页面。CSS 隔离依赖 Shadow DOM；脚本和 HTML 安全仍由 sandbox 渲染及静态 DOMPurify 策略承担，未将 Shadow DOM 描述为任意脚本的安全沙箱。上游依据：[Mermaid 11.16.1 渲染实现](https://github.com/mermaid-js/mermaid/blob/mermaid%4011.16.1/packages/mermaid/src/mermaidAPI.ts)、[Mermaid 安全级别文档](https://mermaid.js.org/config/usage.html#securitylevel)、[Shadow DOM 样式隔离说明](https://developer.mozilla.org/en-US/docs/Web/API/Web_components/Using_shadow_DOM)。

### 真实浏览器证据

新增 `tests/mermaid-style-isolation.test.ts` 和隔离 Electron fixture，使用实际应用渲染器、实际 Mermaid/DOMPurify、生产 connection CSP、`sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`。全部输入是合成数据，拒绝意外网络请求，使用独立临时 userData。

修复前 `followup-isolation-before-confirmed` 因图外 opacity **0 != 1** 失败，保存了原始结果。修复后九个场景全部通过：

- themeCSS、fontFamily、YAML frontmatter、尝试覆盖 securityLevel/secure 四种入口，在渲染过程采样及最终展示时均保持图外 opacity 和 keyframes 为 1。
- 正常流程图、状态图、甘特图和时序图可见，宽度适配 380px 容器；中文标签和合法 `dash` 边动画保留。
- 同源图表复用、源码显示/隐藏、改源重绘、跨 Shadow DOM 的编辑事件、错误源代码可见、无残留 SVG/临时 iframe 均通过。源码复制和旧异步结果不能覆盖新结果，由原有单元测试继续覆盖。

最终结构化结果与各场景 SVG 见 [electron-isolation/result.json](../../tmp/dependency-followup-2026-10-08/electron-isolation/result.json)。上述证据解决本轮已验证的图外动画污染，不代表对所有 Mermaid 图型或所有 CSS 特性的完整安全审计。

### 时序图标签误报的定位

重启前新增的标签检查失败，原因是 fixture 对包含大量 style 文本的 `SVG.textContent` 截取最后 200 个字符；Alice/Bob 标签在 style 之前，已存在但被摘要截掉。暂停前保存的完整 SVG 已含四个 actor text，后续 strict/sandbox 及清洗前后对照也证明标签均保留。这不是确认后的产品标签丢失，未因此添加生产特例。

改为从去除 style 的完整 SVG 副本提取图表文本，并在实际 SVG 中检查 actor text 的可见几何尺寸；原标签存在断言保留。最终 Alice 宽 29.875px、Bob 宽约 22.438px，四个标签高均为 16px。诊断证据见 [labels-probe-result.json](../../tmp/dependency-followup-2026-10-08/labels-probe-result.json)。

另修正两处 fixture 问题：executeJavaScript 初始化不返回含函数的对象；测试用字符串按 JSON 编码传入脚本。jsdom 测试为 iframe 自己的 SVG prototype 提供与原测试相同的几何 stub，未 mock 解析器、sanitizer 或浏览器安全判断。所有首轮失败日志均保留。

## 当前验证结果

以下四组测试文件互不重叠，合计 **11 文件 / 178 pass**；Electron 的 9 个场景归在 1 个测试内，未重复累计。日志、命令、UTC 时间、退出码和锁哈希保存在同名 `.log` / `.result.json`，索引见 [commands.md](../../tmp/dependency-followup-2026-10-08/commands.md)。

| 标签 | 结果 |
| --- | --- |
| followup-manifest-focused | 2 文件 / 66 pass；原三项失败归零 |
| followup-mermaid-boundary-unit | 3 文件 / 21 pass；含清洗正常标签、危险属性移除、异常封装拒绝、非 SVG 拒绝 |
| followup-isolation-labels-verified | 1 文件 / 1 pass，实际 Electron 42.10.0 的 9 场景 |
| followup-renderer-integration | 5 文件 / 90 pass；Markdown、format、ActivityPanel、HTML preview、流式 Markdown |
| followup-typecheck | 三个 tsconfig，退出 0 |
| followup-lint | 7836 warnings / 0 errors，退出 0 |
| followup-warning-ratchet | 新增 0 / 移除 45；baseline 未改，退出 0 |
| followup-boundary | 原有 1 条边界债务，无新增，退出 0 |
| followup-client-build | main/preload/renderer/splash/theme 全部构建，退出 0 |

本轮没有安装或改动依赖，package.json、package-lock.json、.npmrc 与昨日候选一致。锁 SHA-256 仍为 `1240cc744766f1970c7508faff462e4a19d3571605386eb80e7ce79b986505f3`；Pi 三包 1.0.3、其嵌套 Undici 8.10.2 及根 Undici 7.30.0 未变。10 月 7 日 audit 快照仍为 26 个受影响包条目 / 8 个公告 URL；本次未重新请求 audit，不能将旧快照描述为今天新查询。

## 交接边界

原 13 个依赖候选文件继续保留。本次新增修补范围为两份 build 记录、Mermaid 渲染器、两份相关现有单元测试、两份 Electron 回归文件；更新已有依赖 Mermaid 测试与原报告，并新增本报告。完整相对 HEAD 的候选现在为 **21 个文件**，逐文件哈希和完整补丁见 [handoff-state.json](../../tmp/dependency-followup-2026-10-08/handoff-state.json)、[candidate.patch](../../tmp/dependency-followup-2026-10-08/candidate.patch)。

父会话仍需在当前完整候选上重新执行独立全量 Mac 验收；昨天的 DMG、npm start、native/NFT 结果不能直接当作本次完成证明。Windows 专项延期；helper 未授权的 Accessibility/ScreenRecording 动作没有执行。

发布顺序保持：本轮独立验收全过后先本地 commit 作为回退基线，再应用独立云端补丁并统一测试，最后按授权 commit/push。本工作阶段没有提交或推送。
