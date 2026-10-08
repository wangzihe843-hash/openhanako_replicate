# macOS 开发版验收与本轮发布范围 — 2026-10-08

本轮状态：**用户授权提交并普通推送 `feature/xingye-mvp`，其余未验证交互暂缓。**
用户最新明确指示：“先commit&push吧,我手动拖动这个桌宠是能动的,剩下几个不知道怎么测试”。
这项授权允许在下列未验证项保留的情况下提交开发版；不表示完整原生验收或正式安装包验收通过。
本记录更新此前交接中的 HOLD 和快捷键待确认状态，保留各阶段证据的实际限度。

## 候选与证据范围

- 提交前基线为 `12a9037756d5680fd725cec3a1679e1ce2ba56fd`，分支为 `feature/xingye-mvp`。
- 提交准备时，24 个候选的状态集合与逐文件 SHA-256 全部匹配既有
  `output/mac-dev-launch-entry-2026-10-08/final-24-file-manifest.json`，暂存区为空。
  本轮仅增加本验收记录；原候选源码、测试、文档和指纹字节保持不变。
- 桌面生命周期、macOS 桌宠、快捷键修饰键区分、音频 entitlement、兼容性指纹及开发启动入口
  构成本次提交范围。本轮开始时已比远端领先路径修复、依赖修复两个本地提交，随普通推送一并发布。
- 依据本机既有最终交接、有界 CU 对照、实体键盘结果和清理记录汇总；原始日志、截图、
  隔离配置及用户数据不纳入提交，ignored `output/` 仅作为本机证据来源。
- 本轮不使用 Computer Use，不重启 UI，不合并、变更或推送 `main`，不同步 Pi。

## 已通过的自动检查

最终 24 候选的同代码全量结果为 **15,516 通过 / 0 失败 / 11 跳过 / 15,527 总计**，
`approved-full-tests.json` 的 `success=true`。11 个跳过均为 Windows 条件项，不计为通过。
该结果包含开发入口加入后的测试，区别于旧 21 候选的 15,505 通过结果。

既有 `approved-checks.json` 中全量、typecheck、lint、warning ratchet 和 boundary 均 exit 0。
lint 为 7,836 个既有 warning、0 error，warning ratchet 新增 0、移除 45；boundary 保留
1 条已知基线边，不表示全仓无 warning 或无边界债务。早期沙箱运行的 EPERM 失败以及兼容性
指纹更新前的失败属于历史记录；最终相同源码的正式授权全量已经通过。

相关既有构建与运行证据通过：`build:packages`、`build:client`、full/open server offline build、
NFT/native load、full/open isolated smoke，以及修复后的换端口重连与过期回复抑制。
这些构建复用相同生产源码；新增入口、文档及入口测试未改变其输入。隔离开发入口实际运行
`npm start` 自带桌面构建并正常退出。未重建正式安装包或 DMG。

同一最终全量中的聚焦结果为 pet lifecycle 23/23、runtime lifecycle 41/41、launcher 11/11、
audio contract 4/4、shortcut 20/20。本轮只核对证据、哈希、文档和提交差异，不无故重跑全量。
兼容性审查及指纹说明见 [持久化兼容性记录](2026-10-08-macos-desktop-persistence-compatibility.md)。

## 原生与用户实际操作结果

| 项目 | 结果与限度 |
| --- | --- |
| Finder 双击开发入口 | PASS；实际从 Finder 启动开发入口并出现应用窗口，不代表首次配置已经完成 |
| Command+Q | PASS；正常退出，既有进程独立核验与隔离 hook 的 willQuit/code=0 吻合 |
| 主窗关闭后桌宠保留、桌宠恢复主窗 | PASS，既有 AX 元素操作证据；不扩展为真实坐标首击验收 |
| 桌宠暂停/继续、置顶切换 | PASS，既有 AX 状态与隔离持久化结果吻合；不扩展为焦点、透明或坐标命中通过 |
| Ctrl/Cmd/Ctrl+Cmd 快捷键录制和显示 | PASS；正确记录、显示各修饰键，注册另有同源码 native 证据；录制通过不代表三个组合均实际触发通过 |
| 用户实体 Control+K，HanaAgent 前台 | PASS；用户确认先隐藏 Quick Chat，点击主窗后按键，小窗重新出现 |
| 用户实体 Control+K，Finder 前台 | PASS；用户明确确认按键前菜单栏显示 Finder，按键后 Quick Chat 出现 |
| 用户基本手动拖动桌宠 | PASS，仅依据用户最新直接报告“能动”；没有边界、跨屏、接缝、混 DPI 或位置恢复的通过证据 |

两个实体快捷键结果汇总记录于 **07:15:15.529 UTC**。这是结果记录时间，用户未提供按键的
精确 UTC 时间。Quick Chat 已存在的截图/AX 确认时间为 **07:07:55.703 UTC**，不能替代按键时间。

## CU 对照异常的准确归类

有界对照的唯一坐标点击于 **06:34:08.578 UTC** 返回
`-10005: noWindowsAvailable`，之后桌宠 AX 和截图仍正常。此项为 CU 工具窗口定位错误，
不记产品点击失败，也不记坐标点击通过。CU Control+K 在 **06:35:20.916 UTC** 未观察到触发，
随后用户实体操作在两个前台均通过；CU 按键未触发的机制、replayd 因果关系和具体产品 bug
均未确认。本轮不扩大诊断或修复范围。

## 明确未验证与暂缓

以下结果保持 **NOT VERIFIED / DEFERRED**，按本轮用户授权暂缓，不计为通过：

- 其他应用焦点、非激活展示、透明合成、真实坐标首击和键盘访问的完整原生表现。
- 点击和滚动穿透、系统菜单栏恢复鼠标交互，以及保存穿透后重启恢复。
- 单屏 Spaces、其他应用全屏、pin/unpin 下实际参与行为、Mission Control、Stage Manager、
  Cmd-H/app hide、隐藏登录启动及未完成的菜单/locale/保存选项复验。
- 拖动边界、接缝停留、负坐标或布局间隙、位置恢复、Dock/显示比例变化及睡眠唤醒。
  基本手动拖动通过不覆盖这些项目。
- 双屏、混 DPI、拔插：缺少相应硬件，沿用此前暂缓决定。
- 正式签名 App/DMG、Developer ID、公证，以及 Windows 专项：沿用此前暂缓决定。
- 麦克风：仅配置、静态 entitlement 和打包合同核查通过；没有实际录音通过证据。
- Command+K、Control+Command+K 的实体触发尚未验证；不由 Control+K 结果推定。

此前测试进程和三个明确归属的临时 scope 已于约 **07:17 UTC** 完成清理，保留真实开发 HOME
和其他用户应用。本轮不重新申请 Electron 权限、不修改系统设置、不处理此前暂缓的 helper
或其他修复草稿。开发启动和退出方法见 [Mac 开发入口](../mac-dev-launcher.md)，
桌宠原生验收清单见 [macOS 桌宠](../desktop-pet-macos.md)。
