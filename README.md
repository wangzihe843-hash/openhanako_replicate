# 星野陪伴型 Agent（OpenHanako Replicate）

一个在 [OpenHanako / HanaAgent](https://github.com/liliMozi/openhanako) 基础上开发的陪伴与角色扮演（RP）项目，同时保留可执行真实任务的工具 Agent 能力。

我们希望角色能有连贯的人设、可追溯的记忆和自己的生活细节，也希望它在处理文件、搜索资料、执行任务时保持可靠。当前的开发重点，是让这两种体验共存，并把剧情内容、真实用户信息与真实操作的边界说清楚。

“星野陪伴型 Agent”是本仓库的描述性称呼；本项目与同名商业产品没有官方关联。应用名称、包名和部分界面仍沿用 HanaAgent / Hanako。

- 开发分支：[feature/xingye-mvp](https://github.com/wangzihe843-hash/openhanako_replicate/tree/feature/xingye-mvp)
- 当前状态：持续开发中的源码项目；截至 2026-10-06，本 fork 尚未发布可下载的 [Release](https://github.com/wangzihe843-hash/openhanako_replicate/releases)
- 本页说明本 fork 已提交的功能；[README_EN.md](README_EN.md) 仍是上游英文介绍，尚未同步为本 fork 的译文

## 目前能做什么

### 角色、人设与世界书

- 创建和切换角色，编辑角色资料、关系设定与世界书。设定工坊会提出可审阅的方案，确认后再写入
- 在“试演与开场白工坊”中测试日常、冲突、边界等情境，比较多稿，再选择采纳人设补丁、示例对白或新聊天开场
- 导入原生角色卡 ZIP，以及 SillyTavern V2 / V3 JSON、带角色元数据的 PNG；导出沿用角色卡 ZIP。兼容的是明确支持的字段子集，未知扩展会保留，脚本、正则和系统提示覆盖不会直接执行
- 世界书支持启用开关、常驻/关键词/手动条目、优先级、预算与命中诊断。不同对话和生成入口按各自规则选取上下文

试演使用独立的文本生成，不执行工具，也不写入正式聊天、关系数值或长期记忆。详情见[角色卡与试演说明](docs/xingye-rehearsal-and-character-cards.md)、[世界书诊断](docs/xingye-lore-diagnostics.md)。

### 对话表达、记忆范围与剧情分支

- 在主聊天里调整临时场景、篇幅、叙事视角和心理描写，并查看配置来源；这些表达设置在服务重启后清空
- 为新聊天选择兼容旧数据、现实或剧情记忆范围；剧情范围包含世界、分支、角色/导演视角和新记忆可见性。已有模型可见历史不能被静默重新分类
- 对最新完成的文本回复生成“换个说法”候选，预览后采纳或丢弃；候选生成不调用工具。历史回复需先分支处理
- 创建独立剧情分支，保留原会话历史；派生记忆携带来源与有效性信息，源内容修改或撤回后使相关派生内容失效
- “重试任务”区分已完成和状态不明的操作。目前带副作用回执的重试仅覆盖 `channel.post` 试点，不承诺所有工具都能安全重复执行

这些是当前的 L1 / L2 基础能力。剧情会话只允许作用域内的记忆搜索，真实操作应在现实会话中完成。新范围不会自动吸收未分类旧记忆或全部角色设定；分支也不会撤销已经发生的真实操作。

详见[场景与表达控制](docs/xingye-expression-controls.md)、[L1 / L2 使用与验证范围](docs/audits/2026-10-01-l1-l2-runtime-validation.md)。

### 角色生活：小手机、朋友圈与秘密空间

- **小手机**：已接入通讯录、短信、MM Chat、日程、行程、日记、文件、购物、二手、记账、阅读笔记、邮箱、报纸、健康与占卜等角色侧页面，提供相应的记录、查看或生成入口。相册与音频仍是占位入口
- **朋友圈**：以用户或角色身份发表本地动态，点赞、评论、生成角色互动，并审阅和确认 AI 草稿
- **秘密空间**：查看角色状态、回复草稿、梦境、收藏、未发送动态、记忆片段和访谈等内容；各模块有自己的生成与保存流程
- **赠礼**：选择虚拟礼物、查看角色反应与送礼记录
- **群聊**：已有频道和手动提醒角色回复的 MVP，单次触发可回复或保持沉默，带防重复记录；尚未形成完整的多角色剧情调度系统

小手机和这些生活内容属于应用内的角色世界：短信/邮箱不等于真实通信账户，购物/记账/赠礼不执行真实付款，健康数据是角色模拟。秘密空间也不是用于保管真实密码的加密保险箱。角色内容的生成仍会调用所配置的模型。

主动巡检可以结合事件提出待确认草稿，用户确认后再进入对应的正式记录；支持暂停、安静时段和重复抑制。并非所有生成都由巡检触发，也不保证角色永不重复或每次巡检都发言。见[草稿流程](docs/xingye-propose-draft.md)、[主动陪伴与安静时段](docs/xingye-proactive-silence.md)。

### 工具 Agent 与桌面工作流

沿用并持续适配 OpenHanako 的引擎和 Pi SDK，包括文件读写、终端命令、网页读取/搜索、浏览器工具、工作台、技能、插件、定时任务、多 Agent 委派与频道协作，以及 server-first CLI。桌面端另有桌宠窗口。

这些工具可能产生真实的文件修改或外部操作，需要正确配置模型、工作目录、权限及所需服务。桌面原生能力与沙盒实现随平台而异；本地模型、联网模型和插件也有各自的依赖与限制。

## 从源码开始

### 环境要求

- Git
- Node.js **`>=24.12.0 <25`**，与 [package.json](package.json) 的 `engines` 一致
- npm **11.10.0 或以上的兼容版本**；仓库的 `min-release-age=1` 依赖这一能力。近期 Windows 验收使用 Node 24.15.0 / npm 11.12.1，不需要升级到 npm 12
- 原生依赖所需的 Python 与 C/C++ 工具链：Windows 使用 Visual Studio Build Tools 的 C++ 桌面开发组件，macOS 使用 Xcode Command Line Tools，Linux 使用对应的编译工具链
- Linux 的命令沙盒需要可用的 Bubblewrap（`bwrap`）
- Electron 启动需要桌面图形环境；模型生成需要自行配置模型服务，调用费用由相应服务收取

### 安装与启动

```bash
git clone --branch feature/xingye-mvp --single-branch https://github.com/wangzihe843-hash/openhanako_replicate.git
cd openhanako_replicate
npm ci
npm run build:packages
npm start
```

保留安装脚本：`npm ci` 会执行仓库的 Pi SDK 兼容性与版本校验，不要用 `--ignore-scripts` 跳过它。Windows 启动器还会检查并构建沙盒 helper；构建失败时应修复工具链，不要为了启动而关闭安全保护。

首次启动按向导配置模型提供商及对话、轻量工具、大工具模型；后续可在设置中调整。项目保留多类 API/OAuth 提供商和本地模型接入，具体可用性取决于所选提供商与当前适配。完成初始化后，点击左侧栏的“星野”，即可进入角色、聊天、小手机等页面。

### 开发入口

```bash
# 浏览器开发：同时启动本地服务与 Vite，打开终端打印的本地地址
npm run dev:web

# Electron + Vite 热更新：在两个终端分别执行
npm run dev:renderer
npm run start:vite

# 独立服务端；CLI 连接同一数据目录下的服务
npm run server
npm run cli -- --help
```

这些入口应按需要选择，不要把所有启动命令同时执行。浏览器模式不能代替 Electron 原生功能验收。

### 数据与配置

源码启动命令默认使用 `~/.hanako-dev`；打包运行的默认数据目录是 `~/.hanako`。可通过 `HANA_HOME` 指向独立的绝对路径，Windows 下 `~` 指当前用户主目录。主要配置与数据包括：

- 数据根目录下的 `added-models.yaml` 等模型/凭证配置，以及各角色的 `agents/<agentId>/config.yaml`
- 每个角色自己的会话、记忆和 `agents/<agentId>/xingye/` 生活内容
- 由应用管理的 `runtime/pi-sdk/`，无需复用全局 Pi agent 目录

升级、切换分支或尝试迁移前，先退出应用并备份完整数据目录。开发时使用单独的 `HANA_HOME`；不要直接用唯一一份日常数据做测试，也不要把整个目录提交到 Git 或上传到公开 Issue。

## 检查与构建

```bash
# 静态检查和测试
npm run typecheck
npm run lint:warnings
npm run lint:boundary
npm test

# 本地包与桌面前端/主进程构建
npm run build:packages
npm run build:client

# 独立的 open composition 服务端构建及冒烟检查
npm run build:server:open
npm run smoke:server:open
```

`lint:warnings` 会比较已有 warning 基线；通过不代表没有历史 warning。`build:server:open` 是单独的服务端构建路径，不等于完整桌面安装包验收。

完整桌面包使用 `npm run build:server` 的 seed 构建链，需要先有前端产物，并配置 `HANA_SIGN_KEY` 与匹配的 `HANA_SIGN_KEYSET`。本地验证可参考 [CI 的临时测试 key 流程](.github/workflows/ci.yml)；测试 key 不能用于正式分发，私钥不得进入仓库。seed 完整性签名与 Windows/macOS 的操作系统代码签名是两件事。

在上述前置条件就绪后，本地打包使用 `npm run dist -- --publish never`（macOS）、`npm run dist:win -- --publish never` 或 `npm run dist:linux -- --publish never`，显式禁用发布。它们需要对应平台的构建条件；Windows 打包还依赖 MinGit 等资源。具体流程见 [package.json](package.json)、[构建工作流](.github/workflows/build.yml)。

**正式分发尚有前置工作**：`package.json` 中的 `productName`、`appId`、`publish` 和部分更新地址仍沿用上游。发布本 fork 前必须核对并独立配置应用标识、更新源、签名和发布目标，不能把上游安装包或更新渠道当成本 fork 的分发渠道。

### 当前验证边界

近期已有 Windows 源码 Electron、实际打包 EXE、独立服务端及重启持久化的验收记录；Windows 测试包未签名，也未完成实际安装/卸载流程验证。Linux 有构建与打包服务端检查记录，但这些结果不代表三平台桌面体验都已完整验收，更不代表本 fork 已完成 macOS 签名公证。

可查阅 [2026-10-06 Windows 验收记录](docs/audits/2026-10-06-pi-1.0.2-followup-windows.md)及 [Linux L1 / L2 验证记录](docs/audits/2026-10-01-l1-l2-runtime-validation.md)。历史验收只覆盖各自记录的提交与环境，不能自动视为后续版本全部通过。当前 CI 主要在推送 `main` 或向 `main` 提 PR 时触发；直接推送开发分支没有 CI 结果不等于测试通过。

## 安全与隐私边界

- **本地优先不等于完全离线**：模型请求、搜索、浏览器、Bridge 或插件可能把相关内容发送给配置的服务。先确认提供商与插件可信，再处理敏感资料
- **凭证目前以明文保存在数据目录**，未使用操作系统凭证库加密。同一用户权限下的程序可能读取它们；Windows 依赖目录继承的 ACL，应用不会替你重设目录权限
- 文件访问提供 PathGuard；沙盒开启时，命令执行使用对应平台沙盒。关闭沙盒或批准提权可进入直接执行路径。Windows restricted-token 主要提供写隔离，读取与网络仍受当前用户权限约束；它不是网络隔离或对所有宿主能力的统一安全保证
- 对话“换个说法”不执行工具；“编辑并重发”仍是新操作，可能再次产生真实影响。取消或切换剧情分支不会撤销已经完成的文件写入、消息发送等副作用
- 外部角色卡、技能、插件、网页和模型输出都可能包含不可信内容。不要绕过安全警告，不要向未知插件开放高权限，也不要把聊天中的一句“已完成”当作真实执行凭据

[SECURITY.md](SECURITY.md) 含当前凭证存储等技术说明，但其中的上游报告链接和响应时限并非本 fork 的独立承诺。请勿把密钥、令牌、个人数据或可利用漏洞细节直接贴到公开 Issue。

## 接下来要做什么

已有 L1 / L2 是后续工作的基础，以下仍是规划方向，尚未作为完整能力交付：

- **L3：世界状态**。让事实、事件、场景变化与分支状态形成清晰、可验证的叙事状态层
- **L4：多角色剧情编排**。在明确的世界状态与角色知识边界上组织剧情；现有工具子 Agent、共享频道和群聊回复不等于完成这一层
- 继续改进角色表达、长对话一致性和各平台体验，补齐真实模型效果验证与本 fork 独立发布准备

这些方向没有固定发布日期。README 随实际落地内容更新，不把研究候选或未合并修改算作已实现功能。

## 参与与反馈

请到[本 fork 的 Issues](https://github.com/wangzihe843-hash/openhanako_replicate/issues)反馈问题，附上分支/提交、操作系统、Node/npm 版本、复现步骤，以及脱敏后的日志。修改前先阅读相关模块说明；涉及持久化、工具副作用、权限或构建链时，需要同时检查兼容性和失败路径。

[CONTRIBUTING.md](CONTRIBUTING.md)、[插件指南](PLUGINS.md)和 [Plugin SDK](PLUGIN_SDK.md)保留了上游开发背景；其中品牌、投稿政策与分发说明尚未全面针对本 fork 更新。命令和支持范围优先以当前源码及本页为准。

## 项目结构

```text
core/                       Agent、会话、模型与记忆范围编排
lib/                        记忆、工具、权限、角色卡等核心库
lib/xingye/                 角色生活草稿、事件与话题候选
server/                     Hono HTTP / WebSocket 服务与路由
hub/                        调度、巡检、频道与 Agent 通信
desktop/                    Electron 外壳、桌宠及 React 界面
desktop/src/react/xingye/   角色、小手机、朋友圈、秘密空间等 UI
shared/                     跨层协议、配置与上下文工具
plugins/、skills2set/        内置插件与技能
packages/                   工作区子包
scripts/、tests/            构建、检查与回归测试
docs/                       功能说明与按日期记录的验收材料
```

主要技术栈为 Electron、React / Zustand、TypeScript、Vite、Hono、Pi SDK、SQLite 与 Vitest；精确依赖版本以 `package.json` 和 `package-lock.json` 为准。

## 上游、致谢与许可证

本项目基于 [liliMozi/openhanako](https://github.com/liliMozi/openhanako)（HanaAgent / OpenHanako）继续开发，感谢上游提供的 Agent 引擎、桌面应用、工具与记忆基础。保留上游对 [tw93/kami](https://github.com/tw93/kami) 的致谢：beautify 插件的渐进披露式 HTML 美学规范结构受其启发。

代码沿用 [Apache License 2.0](LICENSE)，保留 `Copyright 2025 liliMozi` 等原有许可与版权通知。第三方依赖和素材仍须遵守各自许可证；角色卡、画像或其他导入内容也应确认使用与再分发权利。
