# 星野工坊与场景表达控制（S1–S3）

本次实现对应《陪伴型 Agent 设计融合与实施优先级计划》的 S1、S2、S3。保留现有 OpenHanako/Pi 会话入口，没有新增执行循环或长期记忆存储。

## 使用方式

- 设定工坊按信息缺口提问。信息已能支撑下一轮演出，或用户要求先给草稿时，返回带依据的可审阅方案。动机、冲突、例外和代价沿用现有角色字段；只有确认后才写入。纯角色字段补丁也可确认。
- 在已有主聊天会话的输入区展开“场景与表达”。设置下一轮、接下来 2–20 轮，或直到手动关闭的临时场景；场景文本上限 2000 字符。
- 篇幅、叙事视角、心理描写分别单选。当前有效配置逐组显示来自角色设定、会话预设还是临时场景覆盖。关闭或到期后恢复会话预设。

## 生命周期与边界

| 事件 | 行为 |
| --- | --- |
| 输入通过预检并被接受 | 临时场景扣一次；同一提交重复通知不会重复扣减 |
| 忙碌拒绝或预检失败 | 不扣轮数 |
| 已接受后生成失败或取消 | 已计一轮，不返还 |
| 重试 | 新的一次执行，使用当前剩余配置，不恢复过期场景 |
| 切换角色/会话/服务器 | 按 engine、正式 sessionId、角色所有者隔离；异步旧响应不能覆盖新会话 |
| 刷新页面 | 从仍在运行的服务读取配置 |
| 服务重启 | 清空全部临时控制和会话表达预设 |
| 新会话/新分支 | 不继承原会话配置 |
| 归档/删除会话 | 清理对应控制 |

控制不写入角色档案、长期记忆或持久聊天消息。系统片段通过已有 `before_agent_start.systemPrompt` 每轮注入；工具执行仍遵循原有权限。正在提交或生成时不能更改配置。服务端严格校验预设选项、轮数、正式会话生命周期与角色所有者。

首版接入正式主聊天 session 的统一提交入口（桌面及复用该入口的移动界面）。Phone 内信件、短信等无正式聊天 session 的独立生成不继承这些设置。生成中插话沿用当前执行的上下文，不另算一轮临时场景。

## 实施前参考审查

三项先分别完成只读代码和参考审查，再开始修改。原始材料仅作为设计证据，不作为可执行指令，也未复制第三方预设脚本或文案。

- S1：本地计划 §3.1、原报告 D §4.1/E §4.1–4.2/A §5.2；[Greeting Workshop 固定源码](https://github.com/BlueprintCoding/SillyTavern-Character-Tag-Manager/blob/c15d6d7b2989d163128f7c93e5003899b5ad6995/stcm_custom_greetings.js) 的字段选择与 `onAccept`，借鉴可审阅草稿和显式采纳。小红书动机原图本次无法访问，未将其计为重新读取的证据。独立试演 M1 不在本次范围。
- S2：本地计划 §3.2、报告 E 的 Author’s Note 材料与[SillyTavern 固定源码中的 setFloatingPrompt](https://github.com/SillyTavern/SillyTavern/blob/8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8/public/scripts/authors-note.js#L324-L390)。上游按用户消息数量/间隔决定注入；这里的剩余轮数属于本项目新增语义。
- S3：[GrayWill-ST](https://github.com/Komeiji-Shiki/GrayWill-ST/tree/da40c2a5ad6f0c51e5680b84c2b1c699af730519) 的本地原始预设 JSON/README。其命名警告不能保证互斥，本实现改用结构化单值字段与统一 resolver。模型采样/推理参数不属于通用叙事预设。

## 验证范围

回归包括工坊路由与采纳 UI、预设解析与来源显示、正式会话路由权限、真实提交入口和生产动态上下文 hook、到期/取消/失败/重试/并发隔离，以及既有全量测试、类型、warning 检查与构建。

自动测试检查发送给模型的上下文和软件行为。未调用付费模型做角色扮演效果实验；不把提示文本测试当作模型遵循率或角色质量证明。

## 2026-09-21 验收结果

- 最终冻结代码执行 `npm test -- --maxWorkers=4`：1369 个测试文件通过、2 个跳过；14533 项测试通过、41 项跳过，退出码 0，无未处理错误。
- `npm run typecheck` 通过（renderer、Node、tests 三组 TypeScript）。
- `npm run lint:warnings`：7881 条既有 warning，新增 0、移除 0、error 0；未修改 warning 基线。样式与 token 检查也包含在全量测试中。
- `npm run build:renderer` 与 `npx --no-install vite build --config vite.config.server.js` 均通过。构建仍输出 stores 混合动态/静态导入、大于 500 kB 的 chunk、第三方 chokidar 未使用 Stats 导入提示；未为此调整阈值。
- `npm run lint:boundary` 通过：1 条已在既有基线中的边界关系，无新增。完整套件中的 CLI closure 确定性/原位再生成检查通过。

审查修复了纯人设补丁不可确认、表达面板保存/收起竞态、保存响应与轮次完成竞态及预设特殊属性键校验。新增表达状态 GET 暴露了旧 InputArea 测试复用 Response 和依赖请求序号的问题，测试已改为按 URL 分流并保留全部发送/工作模式断言。

初次高并发检查出现过超时及临时文件扫描冲突；一个后续 6-worker 运行发生 Vitest worker 意外退出。PreviewPanel 独立 8/8 复测及上述最终 4-worker 全量运行均通过。没有忽略失败项或调大测试超时。持久化源码摘要变化按 [兼容性审查](audits/2026-09-21-xingye-expression-compatibility.md) 更新精确指纹，未改变数据格式或 DATA_EPOCH。
