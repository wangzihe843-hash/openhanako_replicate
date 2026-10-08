# Mac 开发版双击启动

开发环境已准备好后，在 Finder 打开项目文件夹，双击根目录的 **`Start-HanaAgent-Dev.command`**。它会打开终端，自动进入项目并执行现有的 `npm start`；等待桌面前端资源构建完毕，应用窗口就会打开。项目路径可以包含空格，文件需保留在项目根目录。

退出时，在应用菜单选择“退出”或按 **Command+Q**。仅关闭主窗口可能只是隐藏应用。等终端显示“开发启动进程已结束”后，可关闭终端窗口。重复启动会遵循应用现有的单实例规则。

## 环境和数据

- 需要 Node **`>=24.12.0 <25`** 与配套 npm，以及按 [README](../README.md#安装与启动) 安装好的项目依赖和 workspace 构建产物。
- 入口依次查找当前用户的 `~/.local/node-v24.*-darwin-<架构>/bin`、当前进程 PATH 和常见 Homebrew 安装位置；当前预置的 `~/.local/node-v24.21.0-darwin-arm64/bin` 可直接识别，不绑定用户名。如果显式设置了 `HANA_DEV_NODE_BIN`，入口优先检查该 Node 路径及其同目录的 npm，配置错误会停止。
- 入口仅为本次启动补充 PATH，不加载或修改 shell profile，也不执行 `brew shellenv` / `eval`。应用本身保留已有的登录 shell PATH 解析；现有 `scripts/launch.js` 会把所选 Node 的绝对路径传给源码服务端。
- 沿用现有开发数据默认值 `~/.hanako-dev`；若环境中明确设置了 `HANA_HOME`，仍使用该目录。测试请使用独立数据目录，升级前先退出并备份数据。

## 遇到错误

启动失败会在终端显示原因和退出码，并在交互终端等待回车。依赖未安装时，先按 README 完成一次开发环境准备；入口不会每次自动安装或升级依赖。`npm start` 自带的 preload、renderer、splash、theme 构建仍会正常执行。

这是源码开发入口，不是正式签名的 App / DMG。若 macOS 显示安全拦截，请保留提示并反馈；入口不修改 Gatekeeper、隔离属性或系统安全设置，也不创建开机启动项、桌面或 Dock 快捷方式。
