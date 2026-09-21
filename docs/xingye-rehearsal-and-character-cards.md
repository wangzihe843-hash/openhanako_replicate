# 设定试演与 ST V2 JSON 角色卡

本页对应陪伴型 Agent 实施计划的 M1、M2。实现沿用既有角色资料、世界书、Pi 会话和模型调用入口。

## 设定试演与开场白工坊

在角色详情中打开「试演与开场白工坊」。日常、冲突、边界三种情境都可修改，也可以切换为开场白创作。生成会使用已配置模型；可给上一稿反馈，保存多稿、对照正文与行为理由，再手动编辑。

试演通过一次性文本请求生成，不创建 AgentSession，不提供工具，也不写正式聊天、关系数值或长期记忆。取消会中断请求及后续模型降级；角色或服务器变化后，晚到结果不会应用到新位置。草稿保存在当前角色既有 `xingye/lore-studio/session.json` 的可选字段中；读取或保存失败会显示错误。

人设补丁只允许既有九个工坊字段，并需逐项勾选采纳。示例对白、默认开场各自单独采纳，替换前可以查看原文。默认开场只影响以后明确创建的新聊天。人设摘要与 OpenHanako 核心人格之间仍沿用角色详情的明确同步操作。

## 新聊天开场

角色详情的「新聊天开场白」可预览默认开场、备选开场或选择空白聊天。点击创建后，服务器再次核对已保存的原文和角色归属，向全新的 Pi 会话写入一次作者提供的 assistant 文本，再切换到该聊天。开场文本写入不执行模型生成或工具，也不覆盖已有会话；该入口不再额外安排会话创建后的外观摘要刷新。角色尚未初始化时，既有初始化与后台维护仍照常进行。开场超过 16000 字符时需要先缩短；预览过期会要求重新读取。

## ST V2 JSON 支持范围

通过既有角色卡导入入口上传 `spec: chara_card_v2`、`spec_version: 2.0` 的 JSON。确认前的报告分别列出已映射、保留但不执行、需要人工调整的内容。此处是声明过的字段子集适配，不是完整 SillyTavern 前端语义。

| 内容 | 行为 |
| --- | --- |
| name、description、personality | 映射角色名、人设资料和初始核心人格文本 |
| scenario、mes_example | 作为默认场景和表达参考进入既有主聊天/Phone 路径，分别使用 2000/4000 字符预算；示例不是已发生的记忆 |
| first_mes、alternate_greetings | 保存为可编辑、可预览选择的新聊天开场 |
| character_book | constant、keys、enabled 映射既有 canonical 世界书；沿用当前选择器、优先级和预算 |
| selective、case_sensitive、条目扩展规则 | 保留原值，相关条目以禁用的手动条目导入，需人工调整 |
| insertion_order、position、世界书扫描参数 | 保留，但不复刻酒馆的插入位置或扫描算法 |
| creator_notes、作者、标签、版本 | 保留；作者注释在导入报告可见，不作为提示指令 |
| system_prompt、post_history_instructions、未知扩展/脚本/正则 | 仅保留，不替换平台提示、权限或执行规则 |
| 宏 | 场景、示例、开场仅替换 `{{char}}` / `{{user}}`；其它宏及人格/世界书中的宏保留为文本并报告 |
| PNG、V3 | 不在 M2 范围，明确拒绝；PNG 属于后续 M3 |

导入在 Agent.init 前落盘角色资料和世界书，失败沿角色创建回滚处理。同名卡片遵守既有唯一角色 ID 规则。

导出仍走既有角色卡 ZIP：原生 `card.json` 包含当前可移植人设和世界书；ST 来源角色另附 `sillytavern-v2.json`。原始卡片保存在资料中的独立兼容命名空间，未知字段得以保留；当前已编辑、清空或删除的受支持字段覆盖原始值，不能因归档原文而复活。损坏的权威资料不能静默当作空值或旧镜像导出。

## 设计依据

- [Greeting Workshop 固定版本源码](https://github.com/BlueprintCoding/SillyTavern-Character-Tag-Manager/blob/c15d6d7b2989d163128f7c93e5003899b5ad6995/stcm_custom_greetings.js)：参考分角色草稿、反馈与候选对比；不采用覆盖现有首条消息的接入方式。
- [Character Card V2 原始规范](https://github.com/malfoyslastname/character-card-spec-v2/blob/main/spec_v2.md)：核对字段形状、作者注释与未知扩展保留要求；不宣称未实现的系统提示替换等完整语义。
- [SillyTavern 固定版本](https://github.com/SillyTavern/SillyTavern/blob/8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8/src/endpoints/characters.js) 与 [Nora 固定版本兼容矩阵](https://github.com/LoveMaker-art/noras-tavern/blob/7ad4ad83c0235f44a84d37188ed362afb50da1a6/docs/architecture/COMPLEX-CARD-COMPATIBILITY-MATRIX.md)、[Story Profile](https://github.com/LoveMaker-art/noras-tavern/blob/7ad4ad83c0235f44a84d37188ed362afb50da1a6/story-profile/README.md)：参考原始字段优先级、兼容矩阵和 Story Profile 边界，具体审查记录见本轮 audit。

测试验证存储、路由、运行时与 UI 行为；模型回复的角色表达质量仍取决于实际使用的模型。
