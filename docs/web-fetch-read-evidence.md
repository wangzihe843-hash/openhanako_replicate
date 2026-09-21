# S9：单次网页读取证据

范围是既有 `web_fetch` 工具（`core/agent.ts` 已将它列为已知 URL 的首选读取入口），不是新导入系统或统一 TaskOutcome。调用仍通过现有工具结果进入会话；`details.readEvidence` 与模型可见文本包含相同证据。

## 状态与边界

- `complete`：已取得并返回该次响应的全部文本，且没有已知解析缺失。目前只对支持的非 HTML 文本与成功解析的 JSON 使用此状态。
- `partial`：取得部分可读内容，但存在服务端分段响应（206/Content-Range）、输出截断、JSON 格式错误、HTML 解析回退或无法确认的 HTML 覆盖。HTML 一律保守标记 `html_coverage_unverified`，不会以可读正文、摘要或 HTTP 200 推断原文完整。图片/音视频等引用、脚本未执行、密码登录表单另列原因。
- `failed`：无可读正文、HTTP 错误、非支持文本 MIME、超时、取消、解析后为空、无效输入或安全检查失败。返回 `isError: true`，供既有工具结果投影处理。

`scope=single_response_text` 仅覆盖本次响应文本，不证明整站、分页、图片内容、登录后的原文、动态加载内容或外链已经读取。`sourceUrl` 与 `resolvedUrl` 保留原始和最终来源；`responseTextHash` 是完整解码响应文本的 SHA-256，`outputTextHash` 只覆盖实际返回的正文（不含来源头、截断提示和证据尾注）。`processorVersion=web-fetch/1` 固定此处理口径；提取/返回字符数使用 JavaScript UTF-16 长度。

每次调用独立生成证据。重试失败不覆盖上次会话结果，也不会借用上次成功哈希。此入口没有导入 checkpoint 或持久化状态，未添加新数据库。保留逐跳 SSRF 检查，补齐 303 与重定向协议检查；执行取消与请求超时贯穿请求和正文读取。

## 实施前核对的参考

- 计划 §5.1 与增量评估报告 B §4.3/5.1：访问、正文获取、解析覆盖、可用性必须分开，生成内容不能冒充原文。
- [GBrain import-checkpoint 固定版本](https://github.com/garrytan/gbrain/blob/43597b19e50a3abf56409337f248f7966860293c/src/core/import-checkpoint.ts)：本地完整源文件已核对；只有成功处理才进入完成集，失败不推进完成记录。此处借鉴证据与成功判定，未引入其 checkpoint。
- [OpenCLI bridge-readiness 固定版本](https://github.com/jackwener/opencli/blob/8271afc67e8504bda94c147f446ee29775d08274/src/browser/bridge-readiness.ts)：本地源文件已核对；桥接 ready 是连接层状态，不能代表页面数据完整。

## 验证

`tests/web-fetch.test.ts` 覆盖完整文本、JSON/坏 JSON、哈希口径、截断、HTML/媒体/登录表单/脚本、空正文、解析回退、二进制或未知 MIME、HTTP 错误、303、危险重定向、失败重试、取消、超时及非法长度。与既有 web-reader、tool-outcome 测试一并验证。测试使用确定性网络替身，不访问用户登录状态或真实付费模型。
