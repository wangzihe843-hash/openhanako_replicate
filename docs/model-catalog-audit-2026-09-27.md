# 预置模型核查（2026-09-27）

本次更新针对应用内置的聊天模型推荐列表，以及新型号所需的能力和请求参数。先核对供应商官方文档、退役公告和模型卡，再修改目录。已安装的 Pi 0.87.1 模型数据只用于交叉核对，不能代替供应商自己的型号和渠道说明。

**DeepSeek 的两个旧默认项状态不同：**`deepseek-v4-flash` 的底层旧模型已退役，官方仍接受旧 ID 并转到 V4.1 Flash；推荐填写 `deepseek-flash`。`deepseek-v4-pro` 仍是有效官方 ID，不能一起删除。新默认顺序为 Flash、Pro，Chat Completions 和 Responses 两个入口保持一致。Flash 支持图片，Pro 为文本模型。[官方价格与模型表](https://api-docs.deepseek.com/quick_start/pricing/)、[Responses 文档](https://api-docs.deepseek.com/guides/responses_api/)

## 各供应商结论

“不再推荐”不等于“已下架”；仅有明确退役证据时才标记下架。第三方托管平台的 ID、能力、上下文及套餐权限单独核查，不能直接套用原厂名称。

| 项目 provider | 本次处理及依据 | 官方来源 |
| --- | --- | --- |
| `deepseek`、`deepseek-responses` | 首选 `deepseek-flash`，保留 `deepseek-v4-pro`；移出旧 Flash / Vision-Exp 推荐项。旧别名仍可请求，但底层已替换。 | [模型表](https://api-docs.deepseek.com/quick_start/pricing/) |
| `openai` | 加入 `gpt-6-sol`、`gpt-6-luna`、`gpt-6-astra`，使用 Responses。保留 5.6 Sol/Terra/Luna 等可用项；未确认的裸 `gpt-5.6` 移出推荐。4.1 nano、o4-mini、o3-mini 将于 10-23 退役，o3 将于 12-11 退役，提前移出推荐，不称为已经下架。 | [Sol](https://developers.openai.com/api/docs/models/gpt-6-sol)、[Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)、[Astra](https://developers.openai.com/api/docs/models/gpt-6-astra)、[退役公告](https://developers.openai.com/api/docs/deprecations) |
| `openai-codex-oauth` | 加入 GPT-6 三款；GPT-5.4 / 5.4-mini 已于 08-31 从 ChatGPT 登录的 Codex 退役。5.5 将于 10-14 退役，目前保留。5.2 移出推荐。OAuth 使用自己的 Responses API 和保守的 272K 上下文预算，不套用 API 的 1.05M。实际可选项取决于账户及管理员开通情况。 | [Codex 模型及退役说明](https://learn.chatgpt.com/docs/models) |
| `anthropic` | 加入 `claude-opus-5-5`、`claude-fable-5-1`，将已有 `claude-sonnet-5`、Haiku 4.5 放到前列。移除已退役的 Opus 4.1、Opus/Sonnet 4、3.7、3.5 系列默认项。保留尚在官方列表中的旧型号。Mythos 5.1 的受限可用性不视为全账户可用，因此未新增为默认。 | [当前模型](https://platform.claude.com/docs/en/models/overview)、[生命周期](https://platform.claude.com/docs/en/about-claude/model-deprecations)、[effort](https://platform.claude.com/docs/en/build-with-claude/effort) |
| `gemini` | 增加 `gemini-3.8-flash`、`gemini-3.5-flash-lite`、已有元数据的 `gemini-3.1-pro-preview`；删除已关闭的 `gemini-3-pro-preview`。3.8 Flash 只允许 low / medium / high，不能发送 minimal。 | [模型目录](https://ai.google.dev/gemini-api/docs/models)、[3.8 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash)、[3.5 Flash Lite](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite) |
| `dashscope` | 增加 `qwen3.8-max`、`qwen3.8-flash`、`qwen3.7-plus`、`qwen3.7-flash`。旧默认中的 `qwen3.5-max`、`qwen3-plus`、`qwen3-mini` 未在官方目录确认，移出推荐，不标记为已退役。 | [模型列表](https://help.aliyun.com/zh/model-studio/models)、[文本模型选型](https://help.aliyun.com/zh/model-studio/text-generation-model)、[思考参数](https://help.aliyun.com/zh/model-studio/deep-thinking) |
| `dashscope-coding` | 按套餐白名单加入 `qwen3.7-plus`、`qwen3.6-plus`；保留 Coder Plus/Next。Coder Flash 不在所查套餐白名单中，移出该套餐默认，不能因此认定其按量付费 API 下架。 | [Coding Plan](https://help.aliyun.com/zh/model-studio/coding-plan) |
| `moonshot` | `moonshot-v1-*` 和 Kimi K2.5 已于 08-31 退役。改为 `kimi-k3`、`kimi-k2.7-code`、`kimi-k2.7-code-highspeed`、`kimi-k2.6`。K3 和 K2.7 Code 始终思考；K3 的图片使用 base64 或平台文件，不能直接传公网图片 URL。 | [模型列表](https://platform.kimi.com/docs/models)、[K3](https://platform.kimi.com/docs/guide/kimi-k3-quickstart)、[K2.7 Code](https://platform.kimi.com/docs/guide/kimi-k2-7-code-quickstart) |
| `zhipu`、`zhipu-coding` | 加入 `glm-5.3`：1M 文本上下文、128K 输出、思考始终开启，effort 为 low/high/max。5.3 Flash 的官方页面本次读取超时，未根据型号名称猜测后加入。 | [GLM-5.3](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3) |
| `opencode-go` | 在已有 GLM 5.2 前加入 `glm-5.3`，按该渠道 Chat Completions 路由处理，不发送其不接受的 `clear_thinking`。该套餐还列有 GPT-6 Luna、Kimi K3、MiMo 2.6、DeepSeek V4.1 等，但不同模型使用不同协议，未一次性把所有路由加入默认。 | [套餐及精确 endpoint / model ID 表](https://opencode.ai/docs/go/) |
| `mimo`、`mimo-token-plan` | 改用 `mimo-v2.6-pro`、`mimo-v2.6-flash`，两者均多模态。V2 Pro/Flash/Omni/TTS 已于 06-30 退役；V2.5 / Pro 将于 10-21 退役，本次提前移出聊天推荐。保留 V2.5 TTS 三项。UltraSpeed 需要定制接入，不默认列入普通套餐。 | [发布记录](https://mimo.mi.com/docs/en-US/updates/model)、[退役记录](https://mimo.mi.com/docs/en-US/updates/deprecate)、[Chat API](https://mimo.mi.com/docs/en-US/api/chat/openai-api)、[套餐](https://mimo.mi.com/docs/en-US/price/token-plan) |
| `minimax`、`minimax-token-plan` | 原目录已含 M3、M2.7；官方仍列出历史 M2.x，未见本次需要删除的已退役项，保持。保留项目已有的 M3 输出/上下文预算，不作无关调大。 | [模型介绍](https://platform.minimax.cn/docs/guides/models-intro)、[套餐](https://platform.minimaxi.com/subscribe/token-plan) |
| `groq` | 首选 `openai/gpt-oss-120b` 和 `openai/gpt-oss-20b`。Mixtral 已于 2025-03-20 退役；原 Llama 3.1/3.3 从 2026-08-16 起仅企业账户继续支持，不再作为通用默认。 | [当前模型](https://console.groq.com/docs/models)、[退役表](https://console.groq.com/docs/deprecations) |
| `mistral` | 加入官方精确 ID `mistral-medium-3-5`；保留 Large/Small/Codestral 的 latest 别名。没有把展示用版本日期拼进 API 名称。 | [Medium 3.5 模型卡](https://docs.mistral.ai/models/mistral-medium-3-5-26-04)、[模型目录](https://docs.mistral.ai/models) |
| `xai` | 加入 `grok-4.7`，使用 Responses，允许 low/medium/high/xhigh。未找到原 4.5/4.3 项目条目的明确退役证据，保留。 | [Grok 4.7](https://docs.x.ai/developers/models/grok-4.7)、[历史退役迁移](https://docs.x.ai/developers/migration/may-15-retirement) |
| `agnes` | `agnes-2.0-flash` 已 deprecated，改用 `agnes-2.5-flash`，相同 Chat Completions 接入。文档未充分定义结构化思考回放，因此继续按普通多模态工具模型使用，不宣称新增思考协议已支持。 | [2.5 Flash](https://agnes-ai.com/en/docs/agnes-25-flash) |
| `baidu-cloud` | 加入官方 `/v2/models` 示例明确列出的 `ernie-5.1`、`ernie-5.0`。5.1 在该表为纯文本，5.0 为多模态；没有按版本号推断二者输入能力相同。 | [模型列表接口](https://cloud.baidu.com/doc/qianfan-api/s/Dmba8k71y) |
| `infini` | 原 R1 已退役，旧 V3-0324 不再推荐；替换为公告明确上线的 `deepseek-v4-pro-0813`、`deepseek-v4-flash-0731`。10-09 的旧 Flash 退役预告与当前日期区分处理。 | [官方更新日志](https://docs.infini-ai.com/gen-studio/changelog.html) |
| `siliconflow` | 采用平台公告中的 `deepseek-ai/DeepSeek-V4-Pro`、`deepseek-ai/DeepSeek-V4-Flash`，移出陈旧 V3-0324/R1 推荐项；不声称这两个精确旧 ID 均已退役。不改写为 DeepSeek 直连的 `deepseek-flash`。 | [服务调整与模型公告](https://docs.siliconflow.cn/docs/release-notes/overview)、[Chat API](https://docs.siliconflow.cn/docs/api/chat-completions-post) |
| `fireworks` | 加入模型卡确认可 serverless 调用的 `accounts/fireworks/models/gpt-oss-120b`，移出旧 R1 推荐项。V4.1 Flash 已上线且 ID 为 `accounts/fireworks/models/deepseek-v4p1-flash`，但有独立协议差异，本次不直接套用 DeepSeek 原厂适配。 | [GPT OSS](https://fireworks.ai/models/fireworks/gpt-oss-120b)、[V4.1 Flash](https://fireworks.ai/models/deepseek-ai/deepseek-v4p1-flash) |
| `together` | 加入 `openai/gpt-oss-120b`；Llama 3.3 仍在 serverless 表中。旧 R1 移出推荐。平台已有 `deepseek-ai/DeepSeek-V4.1-Flash` 等新模型，未将原厂协议当作平台协议直接新增。 | [Serverless 模型表](https://docs.together.ai/docs/serverless/models) |
| `stepfun` | 加入 `step-3.7-flash`；官网厂商仓库提供精确 API 示例及图片输入、256K 上下文信息。中国和国际 API 域名不同，保持原中国入口。Step 5 Preview 未确认精确 API ID，不按产品名猜写。 | [厂商模型仓库与 API 示例](https://github.com/stepfun-ai/Step-3.7-Flash) |
| `perplexity` | 当前仍是 `sonar-pro` / `sonar`，保持。 | [Sonar 模型](https://docs.perplexity.ai/docs/sonar/models) |

## 证据不完整、没有盲改的入口

| provider | 核查结果 |
| --- | --- |
| `baichuan` | [官方 API 文档](https://platform.baichuan-ai.com/docs-v2/api) 仅返回页面壳，无法完整确认 Baichuan4 两项当前供给，暂保留。 |
| `hunyuan` | [腾讯官方说明](https://cloud.tencent.com/document/product/1729/104753) 表明旧平台迁往 TokenHub，原服务与新购买能力不同；未擅自替换旧账户 endpoint 或根据新平台产品名修改旧模型。 |
| `modelscope` | 官网动态模型页未取得足够的服务状态证据；未用模型权重存在来证明免费 API 仍供应，保留原条目。 |
| `kimi-coding` | 套餐固定 ID `kimi-for-coding` 与按量付费 Moonshot 的 K3 ID 不同；官方第三方接入页本次未完整读取，保留既有固定别名。 |
| `volcengine-coding` | 套餐页面本次未返回可核对的完整白名单，保留 `doubao-seed-code`，未根据展示名称猜新 ID。 |
| `volcengine`、`ollama`、`openrouter` | 原本依赖远程/本地动态发现，无固定默认列表。本次不把某个账户当前可见模型写成全局默认。 |

这几项不属于“已确认全部正常”的范围。目录核查也不能证明任意账号的权限、余额、地区和实时可用性。

## 实现边界与参数核对

- `default-models.json` 是推荐列表；`known-models.json` 是能力词典，保留历史模型信息，方便读取历史配置或访问仍托管旧模型的第三方平台。
- 不自动重写用户保存的模型白名单、显式空列表、代理 endpoint、密钥、会话和角色扮演配置。新 provider 或重新选择内置默认时使用新目录。已有用户可以在模型设置中刷新并选择新 ID。
- DeepSeek 新别名接入既有思考/工具回放规则；仅原厂旧 Flash 别名的视觉能力更新为实际后端能力，通用代理的旧 V4 元数据保持不变。
- Kimi K3 / K2.7 Code、GLM 5.3 不发送禁用思考。K3 只发送文档定义的 `reasoning_effort`，省略 `thinking`；K2.7 Code 使用 `thinking.type: enabled`。可调 effort 的型号在辅助请求或旧 off 选择下使用 low；工具历史仍要求真实 `reasoning_content`，不伪造。Kimi 固定采样参数不发送自定义值，K2.7 Code 不发不支持的 effort 字段。
- MiMo 2.6 使用顶层 `thinking.type` 和 `max_completion_tokens`，支持新 Pro 的图片、音视频输入。V2.5 的旧调用兼容和已有能力记录保留。
- 无问芯穹的 [Reasoning 文档](https://docs.infini-ai.com/gen-studio/api/text-generation/tutorial-reasoning/) 明确要求 DeepSeek 使用 `thinking.type`、`reasoning_effort` 和真实工具推理回放，因此为该平台新条目显式登记这套协议。硅基流动的开关则是 `enable_thinking`，本次保守提供关闭/开启（默认 high），不将原厂的全部强度档位套到该平台。
- Gemini 3.8 的能力映射明确排除 off/minimal；GPT-6 与 Grok 4.7 使用模型所属渠道的 Responses 协议。没有复制原厂协议到名称相似的第三方 ID。
- 按百炼表修正旧 Qwen 3.5/3.6 Flash 的 1M 上下文，以及 Qwen 3.6 Max Preview 的 256K 上下文；尤其避免把后者错误声明为 1M，导致超限请求。其他托管平台的同名元数据保持独立。
- 官方未明确给出的输出上限不填猜测值；使用应用既有保守预算。K3 默认输出预算使用 128K，尽管原厂允许更高设置。部分模型的新能力需要另行核实后才能开放，型号上线不等于所有输入和工具协议都已被应用验证。

## 验证记录

所有模型请求验证使用测试密钥或空配置，不读取用户凭据、不向真实供应商发送收费推理请求。结果如下：

- **全量回归及失败项复测：**`npm test -- --maxWorkers=6 --reporter=dot` 首轮 1,383 个文件、14,668 项测试通过，另有 4 个文件中的 5 项失败、41 项跳过。失败原因分别是 CLI 依赖闭包清单需要更新（2 项）、并发负载下服务启动测试超时（1 项）、已有场景表达 CSS 的硬编码阴影颜色（1 项）、旧 DeepSeek Flash 图片能力断言（1 项）。更新闭包清单和断言，阴影颜色改用主题变量；服务启动测试独立复测 15 项通过，相关 5 个文件复测 108 项通过，没有放宽超时或测试规则。
- **最终协议回归：**最终模型目录、兼容层、工具回放、模型同步、辅助调用和引导页相关测试 24 个文件中的 471 项通过；该次仅样式扫描误扫到新生成的 renderer 临时产物而失败。将产物移到仓库根 `.cache/` 后，模型目录与样式共 57 项全部通过，其中新目录及真实 SDK 序列化测试 49 项。SDK 测试在网络发送前截获请求，覆盖 GPT-6 API/OAuth、Claude 5.5、Gemini 3.8、Grok 4.7、DeepSeek Flash、Kimi K3、MiMo 2.6。
- **类型与静态检查：**`npm run typecheck` 三组检查通过，最终补充测试后再次运行 `npx tsc --noEmit -p tsconfig.test.json` 通过。`npm run lint:warnings` 为 0 错误、0 新增警告（保留仓库已有警告）。两个 JSON 目录通过重复键检查，`git diff --check` 通过。
- **构建：**renderer 和最终 server bundle 均成功构建；构建产物放在本次 `.cache/` 目录，不纳入提交。
- **隔离服务实机检查：**用最终 bundle、临时 `HANA_HOME` 和随机本地端口实际启动服务，健康检查及会话存储正常；通过 HTTP 核对 12 个 provider 的新默认项，并验证 Codex 模型发现返回 GPT-6 和渠道专用上下文。所有 provider 均无真实凭据，检查后停止隔离服务。

场景表达组件的 `background: var(--bg-card)`、透明度和布局均未修改，只把原有阴影颜色 `rgba(0, 0, 0, .16)` 换为 `var(--shadow)`，保留用户设置的深色背景。

这些检查验证了目录、参数生成和本机加载，不能替代各账户的真实推理验收；前述证据不完整的平台仍保留原配置，不声称已全面验证其供给状态。
