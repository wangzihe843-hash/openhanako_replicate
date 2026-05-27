import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import { formatXingyeSpeakerContextForPrompt } from './xingye-speaker-context';
import type { NewsEraId } from './xingye-news-era-resolver';
import { NEWS_ERA_LABELS } from './xingye-news-era-resolver';
import { getNewsEraStyle, type NewsEraStyleDescriptor } from './xingye-news-era-style';
import {
  AT_LEAST_ONE_OF_RELATIONSHIP_SECTION_KINDS,
  NEWS_MASTHEAD_MAX,
  NEWS_SECTION_KINDS,
  NEWS_SECTION_REGISTRY,
  NEWS_SECTIONS_PER_ISSUE,
  REQUIRED_SECTION_KINDS,
  type NewsSectionKind,
} from './xingye-news-types';
import {
  WORLD_TIMELINE_SCOPE_LABELS,
  type WorldTimelineEvent,
} from './xingye-news-timeline';

/**
 * 构造「小手机报纸」一期内容的 prompt。
 *
 * 设计要点：
 *  - 模型一次生整张报纸（masthead + 2-4 个板块），让板块之间能互文。
 *  - 板块定义全部从 NEWS_SECTION_REGISTRY 取，prompt 端只负责"组装"。
 *  - 视角强约束：第三人称客观报道 / 第三方专栏，**禁止** TA 第一人称自述、用户对话原文复读。
 *  - 字数强约束：每个 section.body 必须在 [min, max] 内；超长 normalize 会截断，模型应当尽量贴近 max。
 *  - continuityAnchorBlock 是新闻专属"反重复锚点"：列出近期已用过的 masthead /
 *    headline 标题 / gossip 开头，要求本期与之**不同主题、不同笔调切口**。
 */
export function buildNewsDraftPrompt(args: {
  agent: Pick<Agent, 'id' | 'name' | 'yuan'>;
  userName?: string;
  profile: XingyeRoleProfile | null | undefined;
  /** 当期出版日（ISO）。模型可以读到，但不要原样写进正文。 */
  issueDateIso: string;
  /** 用户在弹窗里写的"今天想读什么"提示（可空）。 */
  userIntent: string;
  recentSceneBlock: string;
  stableLoreBlock: string;
  keywordLoreBlock: string;
  relationshipBlock: string;
  heartbeatBlock: string;
  /** 历史 masthead / 头条 / 感情专栏开头样本，跨期防重复用。 */
  continuityAnchorBlock: string;
  /** resolveNewsEra 给出的笔调 era（modern_or_future 兜底）。 */
  era: NewsEraId;
  /** era 对应的笔调描述符。**调用方应**用 getNewsEraStyle(era) 取，与 era 保持一致。 */
  eraStyle: NewsEraStyleDescriptor;
  /**
   * 「往期新闻」模式标记。打开后：
   *  - 篇章基调从「今日报纸」改为「N 天前的旧期，按时间线还原当时世态」
   *  - 不再要求至少一个 gossip/review；缺失时不报错
   *  - 现代/未来时代的头版 witness/evidence 仍然要求（保证视觉版面）
   *  - 调用方应同时传 `excludeKinds` 把感情类 / 关系类板块排除
   *  - 调用方应同时传 `timelineSeed` 把当期要覆盖的事件列出来
   */
  historicalMode?: boolean;
  /**
   * 不允许出现的板块 kind。historical 模式下默认 ['gossip_column','review','letters_to_editor']。
   * 这些 kind 会被从「板块选择规则」「各板块说明」里移除；模型若仍然返回，normalize 不会拒收，
   * 但 prompt 已尽力告诉它"别选"。
   */
  excludeKinds?: readonly NewsSectionKind[];
  /**
   * historical 模式下的「时间线种子」：本期报纸**应基于这些事件**展开。
   * 通常 2-4 条；模型把它们组装成 headline_world / second_news 等世态板块。
   */
  timelineSeed?: readonly WorldTimelineEvent[];
}): string {
  const {
    agent,
    userName,
    profile,
    issueDateIso,
    userIntent,
    recentSceneBlock,
    stableLoreBlock,
    keywordLoreBlock,
    relationshipBlock,
    heartbeatBlock,
    continuityAnchorBlock,
    era,
    eraStyle,
    historicalMode = false,
    excludeKinds = [],
    timelineSeed = [],
  } = args;
  // 兜底：万一调用方传的 eraStyle 与 era 不匹配，按 era 重取一次（防止断链）。
  const style = eraStyle ?? getNewsEraStyle(era);
  const eraLabel = NEWS_ERA_LABELS[era] ?? NEWS_ERA_LABELS.modern_or_future;
  const excludeSet = new Set<NewsSectionKind>(excludeKinds);

  const currentUserName = userName?.trim() || '用户';
  const currentAgentName = profile?.displayName?.trim() || agent.name || '当前角色';
  const speakerContextBlock = formatXingyeSpeakerContextForPrompt({
    userName: currentUserName,
    agentName: currentAgentName,
    gender: profile?.gender,
  });

  const requiredKindList = REQUIRED_SECTION_KINDS.join(' / ');
  // historical 模式下感情类板块默认被排除，"至少含一个 gossip/review"规则不再适用。
  const remainingRelationshipKinds = AT_LEAST_ONE_OF_RELATIONSHIP_SECTION_KINDS.filter(
    (k) => !excludeSet.has(k),
  );
  const relationshipKindList = remainingRelationshipKinds.join(' / ');

  const sectionGuideLines: string[] = [];
  for (const kind of NEWS_SECTION_KINDS) {
    if (excludeSet.has(kind)) continue;
    const def = NEWS_SECTION_REGISTRY[kind];
    const titleCands = def.titleCandidates.map((t) => `「${t}」`).join('、');
    const [minC, maxC] = def.targetChars;
    sectionGuideLines.push(
      `- ${kind}（${def.label}）：${def.taskPrompt}`
      + ` 字数 ${minC}-${maxC} 字。标题必须从这些候选里选一个填入：${titleCands}。`,
    );
  }
  const excludedKindList = excludeKinds.length
    ? excludeKinds.map((k) => `\`${k}\``).join(' / ')
    : '';

  const schemaExample = {
    masthead: 'string',
    sections: [
      {
        kind: '上面 10 个 kind 之一',
        title: 'string（必须是对应 kind 的 titleCandidates 之一）',
        body: 'string',
        byline: 'string（可选，虚构记者/笔名/化名）',
      },
    ],
  };

  // 现代/未来时代生成端没有生图能力，头版的视觉节奏完全由 witness + evidence
  // 这两段结构化文字撑起来。这两段只在 era === 'modern_or_future' 时强制要求。
  //
  // ⚠️ 历史坑：这段最早的"正确示例"直接抄了设计稿 mo-1 的 mock data，那是一份
  // "狗仔跟拍主角"的样本，导致模型把 headline_world 写成了关于 TA 的八卦——
  // 直接违反 registry 里 `headline_world.taskPrompt` 的"世态新闻，不要写成 TA 的
  // 日记或感情独白"。schema 上「TA 的八卦」属于 `gossip_column`，不是 headline。
  // 现在的示例已经换成「世态事件」（街区基建 / 城市公告 / 群体事件），witness 是
  // 这些事件的目击者证词，evidence 是这些事件本身的时间线——不是跟拍 TA。
  const modernHeadlineExtraGuide: string[] = era === 'modern_or_future'
    ? [
        '## 现代/未来时代 · 头版附加要求（必读）',
        '本期是「现代或未来」时代（笔调为狗仔小报体）。生成端没有相片，头版的视觉节奏完全由两段',
        '结构化文字撑起来。`sections` 中 `kind === "headline_world"` 的那一条**必须**在 body 之外，',
        '**额外输出 `witness` 字段**，并**强烈建议**输出 `evidence` 字段。',
        '',
        '### ⚠️ headline_world 仍然是「世态新闻」，不是「狗仔追 TA」',
        `- 头版讲的应当是 **${currentAgentName} 所处世界的事**（城市基建、街区事件、社区公告、`
        + '突发治安、产业新闻、自然异象 ……），第三人称客观报道笔调。',
        `- **禁止**把 ${currentAgentName} / ${currentUserName} 写成头版主角。`
        + `${currentAgentName} 可以作为"次要被提及对象"（例如在群体事件中她恰好在场），`
        + `但头版的主语**不是** ${currentAgentName}。`,
        `- 关于 ${currentAgentName} 与 ${currentUserName} 的私人动向 / 关系八卦 → 走 \`gossip_column\`，**不要**塞进 headline_world。`,
        `- witness.quote 是**头版事件**的目击者证词（路人 / 救援 / 商户 / 工作人员），**不是关于 ${currentAgentName} 的评价**。`,
        `- evidence 是**头版事件本身**的时间线（事件如何展开），**不是跟拍 ${currentAgentName} 的踪迹**。`,
        '',
        '### 头版扩展字段 schema（仅 headline_world 使用；其它 kind 写了会被丢弃）',
        JSON.stringify(
          {
            kind: 'headline_world',
            title: '…',
            byline: '现代记者笔名（如「夜城市政线 · 苏 Q」「街区线记者 K」），不要写真名',
            body: '一整段 180-260 字的世态事件正文',
            witness: {
              quote: '一句**事件目击者**的原话，≤ 50 字。不要带「」，组件会自动加。',
              attribution: '落款，形如「事发街区便利店店员·对本报记者」「应急小组成员·匿名」',
            },
            evidence: [
              { time: 'HH:MM', text: '≤ 24 字一句话，写**事件本身**的可观测动作' },
            ],
          },
          null,
          2,
        ),
        '',
        '### 5 条硬约束',
        '1. `witness.quote` 是一句**引用**，不是叙述。要像真有人在被采访那样说话，可以带语气词、断句、犹豫，**但不要带「」引号**（组件会自动加）。',
        '2. `witness.attribution` 要包含**地点/职业 + 说话语境**两段，用 `·` 连接。例「事发街区便利店店员·对本报记者」「应急小组成员·匿名」。**不要写真实姓名**。',
        '3. `evidence` 是「世态事件本身」的时间线，第三人称、动作化、短句。时间用 HH:MM（24 小时制），间隔通常几分钟到几十分钟。**不要**写心理活动，**也不要**把它写成跟拍主角的路线。',
        '4. `evidence` 数组 2-5 条，按时间升序。条目之间要有"叙事增益"：从「事件初起」→「事态扩大」→「关键节点」→「暂时平息 / 仍在持续」。',
        '5. 如果本期头版讲的不是连续事件而是一次性公告（例如政策变更），可以**省略 evidence**，但 `witness` 仍然必须有（找一个事件相关方引述一句）。',
        '',
        '### ❌ 错误示例（不要这样）',
        `- 头版主语是 ${currentAgentName} 自己（"某医生最近频繁出入 …"）→ 这属于 gossip_column，不是 headline_world`,
        '- `witness.quote: "「他来了三次。」"` → 不要带引号',
        '- `evidence` 写「主角心里很慌乱」→ 心理活动不可观测',
        `- \`evidence\` 写「${currentAgentName} 自西门入便利店、与某女子接头 …」→ 这是跟拍 TA，应写到 gossip_column 里去`,
        '- `witness.attribution: "张三"` → 不要真实姓名',
        '',
        '### ✅ 正确示例（世态事件：旧城区基建故障）',
        JSON.stringify(
          {
            title: '头版大事',
            byline: '街区线记者 · K',
            body: '本市旧六区供水网络今晨 03 时起出现大面积异常，至发稿时已影响约一万二千户居民。市政应急小组初步判断为主干管腐蚀加剧叠加昨夜骤降气温所致，正调度备用水源车进场，但因夜间道路施工，进场速度低于预期。受影响居民多在社交频段中抱怨"龙头时通时断"，部分商户已被迫提前歇业。',
            witness: {
              quote: '从凌晨三点开始就一阵一阵的，烧水做夜宵都做不成，街上全是端着锅去借水的。',
              attribution: '旧六区夜市摊主·对本报记者',
            },
            evidence: [
              { time: '02:58', text: '旧六区供水压力首次报警。' },
              { time: '03:14', text: '市政应急小组接到首批居民投诉。' },
              { time: '04:20', text: '备用水源车进场，因施工绕行延误。' },
              { time: '06:05', text: '局部恢复供水，主干管尚未修复。' },
            ],
          },
          null,
          2,
        ),
        '',
      ]
    : [];

  const eraGuideLines: string[] = [
    `本期报纸的 era（已由系统按 agent 设定识别）：**${era}** — ${eraLabel}。`,
    `笔调：**${style.toneName}**。${style.toneSummary}`,
    '',
    '### 写作守则（按本笔调严格执行）',
    ...style.writingStyleGuide,
    '',
    '### 标题与 headline 风格',
    ...style.headlineStyleGuide,
    '',
    '### 本笔调专属禁忌',
    ...style.taboos.map((t) => `- ${t}`),
  ];

  /* ── historical 模式专属：时间线种子 block + 开篇说明 ── */
  // 时间线种子块：当 historicalMode=true 时，把当期要覆盖的事件结构化打印给模型。
  // 模型应当把这些事件**作为头版/次条/讣告等世态板块的素材**展开，而不是凭空虚构。
  const historicalIntroLines: string[] = historicalMode
    ? [
      '## 「往期新闻」模式（必读）',
      '本期是按用户请求生成的**往期报纸**——是 TA 所处世界在某个**已过去的时间点**发行的旧期。',
      '内容应当严格围绕「下方时间线种子」展开，把它们写成当时世态新闻的版面；',
      '**不要**写成"TA 与用户当下的日常"——往期报纸里**根本没有用户的位置**。',
      `- ${currentUserName}（用户）一律**不出现**在本期任何板块的正文 / 标题 / byline / witness / evidence 中。`,
      `- ${currentAgentName} 可以作为当时世界中的某个 NPC 被次要提及（例如「某医师在场救治」），但**不能**作为头版主角。`,
      '- 报纸笔调与 era 同今日报纸一致（按下方笔调规则走），但时间线背景请贴合下方时间线种子里的时代标签。',
      '',
    ]
    : [];

  // 时间线种子的格式化（仅 historical）。
  const timelineSeedLines: string[] = historicalMode && timelineSeed.length
    ? [
      '## 本期时间线种子（必须基于这些事件展开；按时间升序）',
      ...timelineSeed.map((evt, i) => {
        const scopeLabel = WORLD_TIMELINE_SCOPE_LABELS[evt.scope] ?? evt.scope;
        return `${i + 1}. [${scopeLabel}] ${evt.dateLabel}｜${evt.title}：${evt.summary}`;
      }),
      '',
      '### 用法',
      '- 头版要闻（headline_world）从上述事件中挑**影响最广**的一条作主线，可整合相关事件补背景。',
      '- 次条（second_news）选另一条不同主题的事件。',
      '- 其它世态板块（street_snap / advertisement / weather）可以呼应任一事件做画面 / 物件 / 氛围铺陈。',
      '- obituary（讣告）参见下方专属约束。',
      '',
    ]
    : [];

  // historical 模式下 obituary 的硬约束：
  //   - 允许 NPC / 亲朋好友的死亡 / 误会 / 心情，但**不能**涉及 agent-user 互动。
  //   - 如果 background / lore 没明写 agent 的感情线（前任 / 已故配偶等），
  //     就**不要**编造任何感情类悼念。
  const historicalObituaryRule: string[] = historicalMode
    ? [
      '## 讣告（obituary）板块在「往期」模式下的硬约束',
      `- 允许为 ${currentAgentName} 的亲朋好友 / 前同事 / 师门长辈 / 重要 NPC 的死亡 / 误会 / 心情写悼念，但仅限**下方设定库里有明确依据**的对象。`,
      `- **严禁**写 ${currentAgentName} 与 ${currentUserName} 之间的事件 / 关系 / 互动——往期报纸里没有 ${currentUserName}。`,
      `- 如果下方"## 当前角色 profile"的 background / personality 字段**没有**提到 ${currentAgentName} 的感情线（前男友/前女友/前夫/前妻/已故恋人等），**禁止**写任何与"TA 的感情关系"相关的讣告或悼念。宁可省略这个板块。`,
      '- 抽象悼念（"她最后一丝犹豫，殁于昨夜"）这种笔法仍可使用，但抽象对象不能指向用户。',
      '',
    ]
    : [];

  const parts: string[] = [
    '你是星野模式「小手机报纸」一期内容生成器。只返回严格 JSON，不要 Markdown，不要解释。',
    '',
    ...historicalIntroLines,
    '## 生成目标',
    historicalMode
      ? '生成 TA 所处世界**某个过往时间点**的一张第三方报纸。由虚构的报社记者 / 专栏作者撰写，'
        + '内容紧扣下方"## 本期时间线种子"列出的世态事件，**不涉及**用户。'
      : '生成"当前角色（TA）手机里出现的一张第三方报纸"。这份报纸由虚构的报社记者 / 专栏作者撰写，'
        + '从外部视角报道 TA 所处的世界、以及 TA 与用户的关系动向。**不是 TA 的日记、不是 TA 的朋友圈、'
        + '不是 TA 的私人短信**——而是一份对外发行的报刊，TA 只是其中被报道的对象之一。',
    '',
    '## 视角硬约束（违反就重写）',
    `- 全文第三人称。${currentAgentName}（即 TA）应被作为新闻对象提及，**禁止** TA 的第一人称内心独白。`,
    `- ${currentUserName}（即用户）也是新闻对象，**禁止**用户的第一人称来信或对话原文复读。`,
    '- 板块作者全部是"虚构记者 / 专栏作者 / 投书读者"等第三方；署名（byline）若给出必须是化名 / 笔名 / 匿名。',
    `- 报道笔调贴合 TA 所在的世界观（${eraLabel}），详见下方「笔调与报刊年代」。`,
    '- 不要出现「根据聊天记录」「用户让我」「系统提示」「模型」「AI」「prompt」「OpenHanako」「设定库」等元叙述。',
    '',
    '## 世界观锁定（铁律，违反必重写）',
    //
    // 这一段是为了堵住 prompt 各 block（lore-memory / keyword 触发的 lore / 最近聊天 /
    // 跨期连续性锚点）里夹带的「别 era 关键词」污染本期世界观的问题。
    //
    // 出现过的 bug 现象：一个边境医生（modern_or_future）的 agent，因为 lore-memory
    // 或历史报纸里写过 / 提过西幻词，模型把"南方边境之雷恩郡 / 圣安德烈教区 / 魔晶 /
    // 炼金术士 / 白塔"塞进了本期头版，整篇变成西幻译文体——但 era 系统侧仍判定为现代。
    //
    // 这条铁律明确告诉模型：era 已经定了，下方任何 block 出现别 era 的词都视为噪声。
    `- 本期 era 已由系统锁定为 **${era}**（${eraLabel}）。**这是不可商量的硬设定**。`,
    '- 「世界观词汇」（朝代 / 王国 / 货币 / 物件 / 地名 / 称谓 / 物理规律）**只能从下方「## 当前角色」的 profile 字段抽取**。',
    '- 下方「## 设定库（always 项 / lore-memory.md）」「## 设定库（关键词触发）」「## 最近聊天 / 场景摘要」'
    + '「## 跨期连续性锚点」等 block 里若出现**不属于本期 era 的关键词**（例如本期是 modern_or_future 但 lore 里冒出'
    + '「魔晶 / 教廷 / 雷恩郡 / 主教 / 灵石 / 丹药 / 朝堂」等他 era 词），**一律视为与本期无关**，禁止抄进正文、'
    + '禁止借用做地名 / 物件 / 称谓。这些 block 只能作为「感情 / 关系 / 事件素材」参考，**不是世界观词汇库**。',
    `- 检查清单（生成完自检）：通读全文，若发现任何词不属于「${eraLabel}」的常识范围，把它替换为本期 era 的等价词；`
    + '不要保留任何"看起来很有氛围但其实是别 era 的"借用词。',
    '',
    '## 笔调与报刊年代（按 era 分化，必读）',
    ...eraGuideLines,
    '',
    '## 板块选择规则',
    `- 本期总共生成 ${NEWS_SECTIONS_PER_ISSUE.min}-${NEWS_SECTIONS_PER_ISSUE.max} 个板块（含必选）。`,
    `- **必含**：${requiredKindList}（头版要闻必须有，且只能有一个）。`,
    ...(remainingRelationshipKinds.length
      ? [`- **至少含 1 个**：${relationshipKindList}（感情视角是本期必备）。`]
      : ['- 本期为「往期世界时间线」模式，**不要求**生成感情类板块；如果模型仍想表达"世态人情"，请走 `street_snap`（街角速写）或 `obituary`（讣告 / 纪念），但严守下方铁律。']),
    ...(excludedKindList
      ? [`- **禁选**：${excludedKindList}（本期模式下这些板块**禁止出现**——模型若返回，会被系统丢弃）。`]
      : []),
    '- 其他板块按当期素材自行挑选，但同一 kind **只能出现一次**。',
    '- 选板块时优先选与当期素材匹配的：素材充足时多挑、素材稀薄时只生 2-3 个不要硬凑。',
    '',
    '## 板块语义边界（铁律，跨 era 通用）',
    //
    // 历史坑：现代狗仔体 prompt 曾把"狗仔跟拍主角"当 headline 范本，导致 LLM 把
    // 关于 TA 的私事写到了 headline_world 里。下面这块明确各 kind 的主语边界，
    // 三个 era 都适用。
    //
    `- \`headline_world\` / \`second_news\` 是**世态新闻**：主语是 ${currentAgentName} 所在世界的**事件 / 街区 / 城市设施 / 群体 / 自然异象**，**不是** ${currentAgentName} 自己。`
    + `${currentAgentName} **最多**作为「被波及的市民之一」被次要提及，**不能**做头版主语；关于她个人的踪迹 / 关系 / 私事一律放到 \`gossip_column\`。`,
    `- \`gossip_column\` / \`review\` / \`letters_to_editor\` 才是关于 ${currentAgentName} 与 ${currentUserName} 的板块：`
    + '这里可以写"那位""咱们这位主角""TA 又被拍到""他对她说"等。',
    `- 自检：写完头版后通读一遍，如果主语 / 中心事件是 ${currentAgentName} 或 ${currentUserName}，**改写为世态事件**或**搬到 gossip_column**。`,
    '',
    '## 字数硬约束',
    '- 每个 section.body 必须落在该 kind 标注的 [min, max] 字数范围内。',
    '- 超出 max 会被系统截断成省略号，所以**写到接近 max 但不超过 max** 是最理想的。',
    '- 短板块（讣告 / 广告 / 天气）就是要短，不要写到 100 字。',
    '',
    '## 各板块说明 + 字数范围 + 标题候选',
    ...sectionGuideLines,
    '',
    `## masthead（报头）：长度 ≤ ${NEWS_MASTHEAD_MAX} 字`,
    `- ${style.mastheadStyleGuide}`,
    `- 仿名样本（仅作笔调锚点，不必照抄；首次发刊时可在样本风格内自创一个紧贴 lore 的报名）：${style.exampleMastheads.map((m) => `「${m}」`).join('、')}。`,
    '- **报头跨期应保持稳定**：如果下方"近期报头样本"已经定下了一个报名，请沿用相同报名，'
    + '只换期号 / 日期；不要每期换一个报名。',
    '',
    '## byline（虚构记者 / 笔名）风格',
    `- ${style.bylineStyleGuide}`,
    `- 仿名样本：${style.exampleBylines.map((b) => `「${b}」`).join('、')}。`,
    '- byline 不是必填——短板块（讣告 / 广告 / 天气）可以不署名。',
    '',
    '## 输出 JSON schema（结构必须严格一致；额外字段会被丢弃）',
    JSON.stringify(schemaExample, null, 2),
    '',
    ...modernHeadlineExtraGuide,
    ...historicalObituaryRule,
    '## 当前角色',
    JSON.stringify(
      {
        id: agent.id,
        name: agent.name,
        yuan: agent.yuan,
        profile: profile ?? null,
      },
      null,
      2,
    ),
    '',
    speakerContextBlock,
    '',
    ...timelineSeedLines,
    `## 当期出版日：${issueDateIso}`,
    '',
    '## 用户附言（可空）',
    userIntent || '（无；自由发挥）',
    '',
    '## 设定库（always 项 / lore-memory.md）',
    stableLoreBlock || '（无）',
    '',
    '## 设定库（关键词触发）',
    keywordLoreBlock || '（无）',
    '',
    // historical 模式下，下面这三个 block 是「当下状态」——往期报纸不该看到，
    // 完全屏蔽（连 header 都不打印），避免模型被「最近聊天」误导写成今日报纸。
    ...(historicalMode ? [] : [
      '## 最近聊天 / 场景摘要',
      recentSceneBlock || '（无）',
      '',
      '## 当前关系状态',
      relationshipBlock || '（无）',
      '',
      '## 最近一次桌面巡检的 UI 反馈（可空）',
      heartbeatBlock || '（无）',
      '',
    ]),
    '## 跨期连续性锚点（防重复，必读）',
    continuityAnchorBlock || '（无；这是 TA 的第一期报纸）',
    '',
    '## 收尾',
    '现在生成本期报纸的 JSON。只输出 JSON 对象本身，不要 ```json``` 围栏，不要任何解释文字。',
  ];

  return parts.join('\n');
}
