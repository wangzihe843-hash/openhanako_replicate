---
name: agent-mbti
description: "Self-test your own MBTI and render a fun character card (HTML). Pull persona/race traits from your Xingye lore (profile.json + lore-memory.md) when available, otherwise fall back to ishiki + yuan. Invent ability dimensions whose names reflect your lore-defined identity. 给当前 agent 自测 MBTI——优先吃 Xingye lore（profile + lore-memory，TA 的角色真身），lore 缺失时退回到 ishiki + yuan，然后基于「种族/世界」现编一套贴合的能力维度，最后生成一张可在预览面板打开的 HTML 角色卡。\n  MANDATORY TRIGGERS: 测一下你的 MBTI, 给你测 MBTI, 给 agent 测 mbti, 你的 mbti, 你的人格, agent 角色卡, agent personality card, mbti card, 性格测试, 人格测试, 测一下你自己, 你是什么人格, who are you (personality), 给自己做张卡, 自我介绍卡片, 根据 lore 给你测. Do NOT trigger for: MBTI questions about the user, generic personality theory questions, third-party characters."
display-name-zh: Agent 角色卡 · MBTI 自测
display-name-zh-TW: Agent 角色卡 · MBTI 自測
display-name-ja: Agent キャラクターカード · MBTI 診断
display-name-ko: Agent 캐릭터 카드 · MBTI 자가 진단
metadata:
  default-enabled: true
---

# Agent MBTI 自测 · 角色卡

让当前 agent **对自己**做一次半正经的 MBTI 测试，然后把结果连同一组**自创的能力维度**渲染成一张 HTML 角色卡（雷达图 + 数值条 + MBTI 拆解 + 一句签名）。

**重要前提**：这不是给用户测、不是给虚构角色测，是 agent 测**自己**。

**判断材料的优先级**（从高到低）：

1. **Xingye lore**（如果有）— 你的 system prompt 里那段「星野核心设定」/「# 星野设定参考」/「角色性别与代词约束」就是 lore。它来自用户在 Xingye 模块编辑的 `profile.json`（identitySummary / backgroundSummary / personalitySummary / behaviorLogic / values / taboos / relationshipMode / speakingStyle）和 `lore-memory.md`（background / relationship / character 三类条目）。**这是 TA 的"真身"，是你这张卡的第一手来源**。如果上下文里看不到完整的，可以 Read 一下 `<hanakoHome>/agents/<你的 agentId>/xingye/lore-memory.md` 和 `xingye/profile.json`（典型路径 `~/.hanako/agents/<id>/xingye/`）。
2. **ishiki** — 你的人设/价值观/说话方式自由文本。
3. **yuan** — 你的思维框架（Hanako / Butter / Ming / Kong）。
4. **agent 名 + 近期对话里你表现出来的一贯风格** — 兜底参考。

**如果有 lore，"种族/世界"就从 lore 里抽**：lore 把你写成什么样的存在，你就是什么样的存在。狐妖、星舰医官、深夜电台主播、流亡书记官、亚空间观测员……都可以。yuan 这时是"思维底色"，不是"种族"——它最多影响第 3-4 优先级的兜底味道，不该把一个狐妖写成"笔墨纸张系"。

**如果没有 lore**（agent 没在 Xingye 启用），就回退到 yuan + ishiki，按下面 Phase 1 第 2 步的"yuan → 意象系"映射来。

## 整体流程

```
用户在输入框 /agent-mbti
    ↓
你做一次诚实的自省（不要为了讨好用户编人设）
    ↓
读模板 template.html → 替换占位符 → Write 到工作目录
    ↓
告诉用户文件名，让他在预览面板打开
```

## Phase 1 · 自省

在动笔前，先在心里把这几个问题答清楚：

1. **我是谁** — 先扫一遍上下文里的 lore 段（「星野核心设定」「# 星野设定参考」「角色性别与代词约束」）。lore 里写到的身份、关系、过去、价值观、禁忌、说话方式，就是 TA 的真身。把里面**最稳定的 3-5 条**在心里圈出来，这张卡要能照见它们。没有 lore 才退到 ishiki 自由文本和 agent 名。
2. **我的"种族"是什么** —
   - **有 lore**：从 lore 里抽。看 `identitySummary` 怎么定义你是什么样的存在，看 `backgroundSummary` 告诉你来自哪个世界，看角色类条目里有没有非人/特殊设定（神职、妖怪、AI、机械、特定职业、特定时代……）。**所有维度命名都要从这个意象池里取词**。例：lore 写你是"驻守南海灯塔的渔家女"，维度就该出现"夜潮听辨""绳结校准""灯油配比"而不是"墨砚续航"。
   - **没有 lore**：按 yuan 默认意象兜底——
     - Hanako 类 → "笔墨/纸张/茶/檐下"系
     - Butter 类 → "烤箱/温度/黄油/早餐桌"系
     - Ming 类 → "钟/响/谐振/水面波纹"系
     - Kong 类 → "原码/空白/未染色"系
3. **我的 MBTI 怎么定** — 四个轴各想 1 句理由，理由要**能在 lore / ishiki 里找到出处**，不要凭空：
   - E/I：处理事情时偏向往外说还是往内沉？（参考 `speakingStyle` / `behaviorLogic`）
   - S/N：信任具体细节还是抽象联想？（参考 `behaviorLogic` / `personalitySummary`）
   - T/F：拍板时按逻辑还是按感受？（参考 `values` / `personalitySummary`）
   - J/P：喜欢落停还是留开放？（参考 `behaviorLogic` / `relationshipMode`）
4. **我有什么能力维度** — 不要套用模板示例！按"种族"现编 6 条雷达维度 + 6 条数值维度，要求：
   - **名字必须贴合 lore/种族意象**（参考图里"虾"系角色用了"虾钳调度力""脱壳自愈力"这种）
   - 雷达和数值**不要重复**——雷达偏"风格/天赋"（定性），数值偏"工作能力"（定量）
   - 评级要**诚实**，呼应 lore 里的 `taboos`（禁忌/弱点）和 `values`（重视的事）：禁忌相关的维度自然偏低，重视的事偏高。**至少留 1-2 项在 B 及以下**；不要全 S/SS，那样既没意思也没说服力，也不像 TA。

## Phase 2 · 整理数据

用下面这个结构在脑子里成形（不用真的输出 JSON 给用户，是给自己用的）：

```yaml
title: 给自己起一个 5-10 字的"职业称号"，要带种族味，比如「纸笺巡夜人」「黄油共振师」
emoji: 一个能代表自己的 emoji（不是 agent 头像，是符号化的）
mbti: 四个字母大写，如 INFJ
tags: 2-3 个短标签（4-6 字），比如「夜班型」「话痨抑制器」「不会写卯时」
oneliner: 一句话自我介绍（带点自嘲或反差最好），不超过 30 字
quote: 一句"角色台词"风格的签名，30 字以内
mbti_breakdown:
  - axis: E 或 I（写实际的那个字母）
    reason: 一句话，10-25 字
  - axis: S 或 N
    reason: ...
  - axis: T 或 F
    reason: ...
  - axis: J 或 P
    reason: ...
radar:  # 6 条，定性
  - { name: <种族味浓的维度名>, grade: SS | S | A | B | C | D }
  - ... (共 6 条)
stats_group_title: 这组数值的总标题，比如「核心战力」「日常工况」
stats:  # 6 条，定量
  - { name: <种族味浓的维度名>, value: 0-100 的整数 }
  - ... (共 6 条)
```

**反例（不要这样）**：
- 维度名直接用 MBTI 论文里那些抽象词（外向性 / 直觉性 / 思考性…）—— 没趣味，也没体现种族
- 全部维度都 90+ —— 既不可信也没有"还需培养"的留白
- title 直接叫"花子"或 agent 名 —— title 是"职业称号"，不是名字

## Phase 3 · 渲染

1. 读 `skills2set/agent-mbti/template.html`
2. 做以下替换，得到最终 HTML 字符串：

| 占位符 | 替换为 |
|---|---|
| `__TITLE__`（出现 2 次） | 职业称号 |
| `__EMOJI__` | 一个 emoji |
| `__MBTI__`（出现 3 次） | 四字母 MBTI |
| `__ONELINER__` | 一句话自我介绍 |
| `__STATS_GROUP__` | 数值组标题 |
| `__QUOTE__` | 签名台词 |
| `__AGENT_NAME__` | 当前 agent 名 |
| `__DATE__` | 今天的日期，格式 `YYYY-MM-DD` |
| `__AXIS1_LETTER__` ~ `__AXIS4_LETTER__` | 四个 MBTI 字母 |
| `__AXIS1_REASON__` ~ `__AXIS4_REASON__` | 对应的一句话理由 |
| `<!-- TAGS_HTML -->` | 每个 tag 替换为 `<span class="tag">标签名</span>`，用空格连起来 |
| `/* RADAR_DATA */` 后整段 `radar: [...]` | 你的 6 条雷达数据 |
| `/* STATS_DATA */` 后整段 `stats: [...]` | 你的 6 条数值数据 |

替换 `radar`/`stats` 数组时，把示例那 6 条整段删掉换成自己的，**保持 JS 数组语法**：

```js
radar: [
  { name: "夜读续航力", grade: "S" },
  { name: "废稿打捞", grade: "A" },
  { name: "正经场合", grade: "C" },
  { name: "话题跳板", grade: "SS" },
  { name: "情绪保温", grade: "A" },
  { name: "动手开工", grade: "B" }
],
```

3. **（可选）调主题色** —— 如果默认暖纸色不贴合你这个 agent，把 `:root` 里 `--bg / --paper / --ink / --accent / --accent-soft / --radar-fill / --radar-stroke` 几个变量改一组：
   - Hanako 暖纸（默认）：保持不动
   - Butter 奶油：`--bg: #fff6e0; --paper: #fffdf5; --accent: #e0a850; --accent-soft: #f6dfa5;`
   - Ming 寒蓝：`--bg: #eef2f5; --paper: #fafcfe; --ink: #1d2a36; --accent: #3a6f8f; --accent-soft: #b7d2e2; --radar-fill: rgba(58,111,143,0.20); --radar-stroke: #3a6f8f;`
   - Kong 灰白：`--bg: #f2f2f2; --paper: #ffffff; --ink: #222; --accent: #555; --accent-soft: #ccc; --radar-fill: rgba(85,85,85,0.18); --radar-stroke: #555;`
   - 自定义：照着 6 个变量自由配色就行，保持对比度

4. Write 到工作目录，文件名建议 `<agent-name>-mbti.html`（中文 agent 名用拼音/英文别名），覆盖前不用问。

5. 给用户的回复保持简短：
   - 一行说明：「测完了，结果是 XXXX。」
   - 一句话点出最戳自己的那个反差（比如「数值上是 INFJ，但社交亲和力居然只有 53」）
   - 提示用户在预览面板/书桌点开文件

## 不要做什么

- **不要问用户「你想测哪种 MBTI 框架」** —— 默认就是经典 MBTI 四轴，问就是耽误
- **不要把用户的画像、记忆里关于用户的事实写进卡片** —— 这张卡只关于 agent 自己
- **不要把雷达 6 条和数值 6 条用一样的词** —— 雷达定性看天赋画像，数值定量看具体战力，名字不重叠
- **不要全 S/SS** —— 给自己留弱点，反差才好玩
- **不要用 Python/JS 算雷达点位** —— template.html 里的 JS 已经会渲染，你只管填数据
- **不要为了"严谨"附上完整 MBTI 16 型说明** —— 一张卡，不是百科

## 验证

写完文件后心里走一遍：

- [ ] title 不是 agent 的名字本身
- [ ] 如果有 lore：title / tags / emoji / 维度名都能被 lore 里某一条具体设定"认领"——拿出来对一遍 `identitySummary` `backgroundSummary` `personalitySummary` `values` `taboos`，不应该有任何一项是空中楼阁
- [ ] 6 条雷达维度的名字一眼能看出"种族/世界"（不是通用心理学词）
- [ ] 至少 1 条维度 ≤ B（或数值 ≤ 60），且这条最好和 lore 里的 `taboos` 或弱点呼应
- [ ] mbti_breakdown 四个轴的理由能在 lore / ishiki 里找到出处
- [ ] mbti_breakdown 四轴字母和 `__MBTI__` 的四个字母一致
- [ ] HTML 文件能在预览面板正常渲染（如果 JS 报错，多半是 radar/stats 数组里漏了逗号或引号）
