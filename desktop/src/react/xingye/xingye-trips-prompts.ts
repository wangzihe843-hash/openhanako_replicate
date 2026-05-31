import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import { formatXingyeSpeakerContextForPrompt } from './xingye-speaker-context';
import { TRIP_MODE_KEYS } from './xingye-trips-store';

/**
 * 构造「行程历史批量生成」prompt：让模型扮演当前 agent，从设定库 / 记忆里**提取
 * TA 真实走过的几段路**，呈现为旧车票（硬板票）。
 *
 * 核心约束（对应用户反馈与设计稿 README）：
 *  - 行程是**过去式**：已经发生、走过的一段路。和「日程」（未来安排 / 约定）严格区分，
 *    不要写「下次要去」「打算去」这类未发生的计划。
 *  - 地点来自设定库 / 记忆里**已出现的真实地点**；可补合理的途经小地点（巷口 / 哨卡 / 岔口）。
 *  - 交通方式**按世界观推断**（见「世界观交通工具指南」），禁止默认现代公交体系；
 *    `mode` 收敛到 8 个图标键，`modeLabel` 写贴世界观的真实载具名。
 *  - 时刻 / 编号 / 票资等票面字段也按世界观写（见「世界观时间写法指南」）——人设偏古
 *    （玄幻 / 西幻 / 仙侠 / 古代）时优先用时辰 / 旧历。
 *  - 徒步段只连真实地点，绝不连「车站 / 站台」。
 *  - 每条行程的起点、终点各写一句**第一人称亲笔批注**（noteFrom / noteTo），克制、具体。
 */
export function buildTripsHistoryPrompt(args: {
  agent: Pick<Agent, 'id' | 'name' | 'yuan'>;
  userName?: string;
  profile: XingyeRoleProfile | null | undefined;
  stableLoreBlock: string;
  keywordLoreBlock: string;
  /** 期望生成几条（1–6）。 */
  desiredCount?: number;
  /**
   * 以下为「手动更新（update 模式）」专用上下文。首次打开（history 模式）时这些
   * 通常为空——user 视角的最近聊天还没内容——不传即可。
   */
  recentSceneBlock?: string;
  relationshipBlock?: string;
  heartbeatBlock?: string;
  /** 已记录行程的去重锚点（from→to · chapter 列表）；update 模式下提示模型避开重复。 */
  existingTripsAnchor?: string;
  /** 'history' = 首次打开按 lore 批量；'update' = 从最近聊天 / 巡检里补一段没记过的路。 */
  mode?: 'history' | 'update';
}): string {
  const { agent, userName, profile, stableLoreBlock, keywordLoreBlock } = args;
  const mode = args.mode ?? 'history';
  const count = Math.max(1, Math.min(6, Math.floor(args.desiredCount ?? 4)));
  const recentSceneBlock = args.recentSceneBlock?.trim() || '';
  const relationshipBlock = args.relationshipBlock?.trim() || '';
  const heartbeatBlock = args.heartbeatBlock?.trim() || '';
  const existingTripsAnchor = args.existingTripsAnchor?.trim() || '';

  const currentUserName = userName?.trim() || '用户';
  const currentAgentName = profile?.displayName?.trim() || agent.name || '当前角色';
  const speakerContextBlock = formatXingyeSpeakerContextForPrompt({
    userName: currentUserName,
    agentName: currentAgentName,
    gender: profile?.gender,
  });

  const tripSchema = {
    chapter: 'string',
    when: 'string',
    serial: 'string',
    cls: 'string',
    mode: `<one of: ${TRIP_MODE_KEYS.join(' | ')}>`,
    modeLabel: 'string',
    from: { name: 'string', meta: 'string' },
    to: { name: 'string', meta: 'string' },
    duration: 'string',
    distance: 'string',
    pass: 'string',
    stampText: 'string',
    noteFrom: 'string',
    noteTo: 'string',
    mood: 'string',
    moodTags: ['string'],
    route: [
      { kind: 'stop', major: true, time: 'string', name: 'string', sub: 'string' },
      { kind: 'seg', mode: '<icon key>', label: 'string', detail: 'string' },
      { kind: 'stop', via: true, name: 'string' },
      { kind: 'stop', major: true, time: 'string', name: 'string', sub: 'string' },
    ],
  };

  const parts: string[] = [
    '你是星野模式「小手机行程」记录生成器。只返回严格 JSON，不要 Markdown，不要解释。',
    '',
    mode === 'update'
      ? `生成目标：从下方【最近场景】【近期巡检】里 TA 提到或浮现的、**之前还没记进行程**的过去旅程取材，`
        + `结合设定补全细节，产出 ${count} 条**新的、与【已记录的行程】不重复**的行程（仍是 TA 过去真实走过的路）。`
        + '只是模拟，不连接任何真实地图 / 导航 / 票务系统。'
      : `生成目标：这是当前角色自己手机里的「行程」——TA **过去真实走过的路**。请一次性产出 ${count} 条`
        + '**互不重复**的行程，由 TA 自己回忆写出来；只是模拟，不连接任何真实地图 / 导航 / 票务系统。',
    '',
    '【最重要 · 行程 ≠ 日程】',
    '- 行程只记**已经发生、走过的一段路**（过去式）。绝不要写「下次要去」「打算去」「约好去」这类未发生的计划——那是「日程」app 的事。',
    '- 每条都应该是一段**完结的旅程**：从某地出发、途经哪些地方、到达某地，已经走完了。',
    '',
    `输出 JSON schema（仅此结构）：一个对象 { "trips": [ ... ] }，trips 数组长度必须 = ${count}。每个元素是：`,
    JSON.stringify(tripSchema, null, 2),
    '',
    '字段要求：',
    '- chapter：分组用的「时期 / 章节」，按 TA 人生阶段或地域聚合（「童年 · 北门」「少年 · 学医」「行医 · 山道」）。同一份数据里允许多条共用一个 chapter。',
    '- when：票面时间戳，**按世界观写**（见下方「世界观时间写法指南」），可以是旧历 / 季节 / 事件（「停电夜」「霜降前」「撤离令第三日」）。',
    '- serial：票面编号，等宽展示，**风格随科技档位**：现代 / 近现代用数字 / 字母编号或月日（「盐路 · 0417」「KX-1042」「05-21 班」）；古代 / 仙侠才用干支 / 旧历（「北门 · 丙申 0003」「渡 · 七月廿一」）。',
    '- cls：班次 / 类别小标，2–4 字（「徒步」「搭载」「摆渡」「驮运」「撤离」）。',
    `- mode：从 ${TRIP_MODE_KEYS.map((m) => `"${m}"`).join(' / ')} 里挑一个**最接近**的图标键（决定画哪个图标）。含义：`
      + 'walk 徒步 / ride 骑乘（马·驴·骆驼·灵兽·坐骑）/ cart 车马（货车·马车·牛车·驮队·黄包车·板车）/ '
      + 'transit 车行（现代汽车·公交·出租·网约车）/ boat 行船（渡船·摆渡·轮船·法舟·漕船）/ '
      + 'rail 轨道（火车·地铁·电车·磁轨·缆车）/ fly 飞行（飞机·飞艇·飞行兽·御剑·穿梭舱·飞舟）/ mystic 术法（传送阵·缩地成寸）。',
    '- modeLabel：**真正贴世界观的载具名**（自由文本，可含换乘），例「徒步 · 岑姨背着」「搭货车 · 徒步过哨」「御剑 · 逆风」「网约车」。这才是票面给人看的方式描述。',
    '- from / to：起点、终点。name 是地名，meta 是副标（「后院 · 第三阶」「废弃灯塔」），meta 可空字符串。',
    '- duration：用时，**与下方时间写法指南同一档位**：现代 / 近现代用「四十分钟」「一个钟头」「大半天」；古代 / 仙侠才用「一时辰」「两刻」；科幻用「半个周期」。别给现代角色套时辰 / 刻。',
    '- distance：路程（「一里」「十里山道」「三里水路」）。',
    '- pass：第三枚元信息——通行凭证 / 票资 / 天气，按世界观；**票资用 TA 世界的货币**（现代「车资 ¥3」「油钱」，古代才「船资半钱」），通行凭证如「医牌」「撤离令」「通行证」。实在没有就写 "—"。',
    '- stampText：印章字样，2–4 字（「到家」「已过哨」「不渡」「送达」「清点讫」）。',
    '- noteFrom / noteTo：**TA 对起点、终点的第一人称亲笔批注**（详见下方「亲笔批注写法」）。',
    '- mood：一段第一人称随笔，30–200 字，写这趟路当时的心境 / 发生的事（衬线正文，区别于亲笔批注的短句）。',
    '- moodTags：2–4 个 2–6 字短标签（「停电」「右踝扭伤」「岑姨」）。',
    '- route：竖向路线时间轴，详见下方「route 规则」。',
    '',
    '──────────────────',
    '【世界观交通工具指南】（mode / modeLabel / route 必读）',
    '──────────────────',
    '先从 profile / 设定 / 最近线索判断 TA 所处的世界观与时代，再选**贴合**的交通方式。'
      + '**禁止默认现代公交 / 地铁 / 出租 / 私家车 / 轮船 / 飞机这一套**，除非设定明确是现代都市。'
      + '同一份数据里方式要**有差异**，不要每条都同一种。下表仅示意，按 lore 取词：',
    '',
    '◆ 现代都市 → 地铁 / 公交 / 网约车 / 共享单车 / 步行 / 轮渡 / 高铁（mode: transit / rail / boat / walk）。',
    '◆ 中国古代 / 武侠江湖 → 步行 / 骑马 / 骡队 / 渡船 / 轿子 / 漕船 / 驿马（mode: walk / ride / cart / boat）。',
    '◆ 民国 → 步行 / 黄包车 / 有轨电车 / 绿皮火车 / 江轮 / 脚夫挑担（mode: walk / cart / rail / boat）。',
    '◆ 西幻 / 中世纪 / D&D 风 → 步行 / 坐骑 / 马车 / 驮队山道 / 河船 / 商队（mode: walk / ride / cart / boat）。',
    '◆ 玄幻 / 仙侠 / 修真 → 御剑飞行 / 灵兽坐骑 / 法舟渡江 / 传送阵 / 步辇 / 缩地成寸（mode: fly / ride / boat / mystic / walk）。',
    '◆ 科幻 / 赛博朋克 / 太空歌剧 → 磁轨 / 穿梭舱 / 飞行器 / 步行甬道 / 货运无人机 / 轨道缆车（mode: rail / fly / transit / walk）。',
    '◆ 战乱 / 边境 / 末日废土（**这是处境不是科技档位，按底层时代取载具**）→ 现代战乱：徒步 / 搭运盐货车 / 旧摆渡 / 撤离车队 / 手摇轨道车；古代战乱：徒步 / 驮队 / 驿马 / 渡船（mode: walk / cart / boat / rail）。',
    '',
    '判断流程：① 先定**科技档位**（现代 / 近代 / 古代 / 仙侠 / 科幻……——注意「战乱 / 边境 / 末日」是**处境**不是科技档位，'
      + '按它底层的时代判断：现代战乱用卡车 / 摆渡，古代战乱才用驮队 / 马）；② 选 modeLabel（世界观真实载具）；'
      + '③ 再挑最接近的 mode 图标键；④ 多条之间方式错开。',
    '',
    '──────────────────',
    '【世界观时间写法指南】（when / route.time 必读）',
    '──────────────────',
    '时刻 / 时间戳**也按世界观写**，这是世界观信号。**关键：时间写法取决于 TA 世界的「科技水平」，'
      + '而不是取决于是否打仗 / 是否偏远 / 是否苦难**——「战乱」「边境」「末日废土」**不等于古代**，'
      + '一个现代或近代的战乱边境同样用钟点，绝不要因为「打仗 / 荒凉」就套古代计时。先判断科技档位，再选写法：',
    '- 现代 / 近现代（出现钟表、电灯 / 电力、汽车 / 卡车、电话、枪炮、温度计、诊所 / 医院等任一信号——'
      + '**含现代战乱 / 边境 / 末日废土**）→ 用钟点：24 小时制（「07:20」「18:45」）或「清晨 / 傍晚 / 后半夜」。'
      + '**这类世界绝不要用「时辰 / 一炷香 / 两刻 / 掌灯时分」等古代计时**；when 用月日 / 事件（「停电夜」「撤离令第三日」「霜降那周」）。',
    '- 古代 / 武侠 / 仙侠 / 玄幻 / 西幻 / 中世纪（无机械钟表，以日晷 / 更香 / 天色计时；含此类世界里的战乱）→ '
      + '用**时辰**（子时 / 丑时 / 寅时 / 卯时 / 辰时 / 巳时 / 午时 / 未时 / 申时 / 酉时 / 戌时 / 亥时），'
      + '或「一炷香」「两刻」「天蒙蒙亮」「掌灯时分」；when 用旧历 / 节气 / 事件（「霜降前」「七月廿一」）。',
    '- 民国 / 蒸汽 / 旧工业（钟表已普及但仍有旧习）→ 钟点与旧式可混用（「晌午」「后晌三点」），when 用年号 / 季节。',
    '- 科幻 / 未来 → 用周期 / 星历 / 舱段时（「第三舱段时」「周期 12」），自洽即可。',
    '判断依据：看 lore / profile 里的**科技线索**——有炮火 / 枪械、汽车 / 卡车、电力 / 电灯、钟表、电话、'
      + '温度计、诊所 / 医院等近现代事物，就是近现代世界，用钟点；**只有**在确实只见刀剑、马匹、油灯且无机械钟表时才用时辰。'
      + '**拿不准时优先用现代钟点写法，不要无依据地套古风**。',
    '',
    '──────────────────',
    '【route 规则】（竖向路线时间轴）',
    '──────────────────',
    '- 每个节点是 stop（真实地点）或 seg（两地之间的方式）。',
    '- stop：major=true 表示起讫 / 换乘（实心大点，带 time/sub）；via=true 表示途经（小空心点，通常只给 name）。',
    '- **第一个和最后一个 stop 必须 major=true**——亲笔批注挂在它们身上。',
    '- seg：mode（该段图标键）+ label（方式描述）+ detail（用时 / 距离）。',
    '- **关键不变量 · 徒步段只连真实地点，绝不连「车站 / 站台」**：seg.mode="walk" 前后接的应是巷口 / 哨卡 / 断桥 / 石阶 / 码头这类真实地点。人不会沿着公交站走路。',
    '- **乘载段两端是「上车地」「下车地」**：搭车 / 乘船的 seg，两端 stop 是上 / 下载具的真实地点，不要把途经点写成站台。',
    '- route 要和 from/to、mode 自洽：典型 5–8 个节点（起点 stop → seg → 途经 via → seg → 终点 stop）。',
    '',
    '──────────────────',
    '【亲笔批注写法】（noteFrom / noteTo）',
    '──────────────────',
    '- 起点、终点各**一句** TA 的第一人称亲笔批注，像随手写在票根边上的字（会用手写体渲染）。',
    '- 短句、克制；写**具体的、只有 TA 会在意的细节**（某级台阶、某行刻字、某个铺位、某件随身物），不要泛泛抒情。',
    '- 贴紧人物语气与价值观（参考设定里的「说话风格 / 性格」）；温柔藏在实用提醒里（提前备药 / 检查伤口 / 走左边 / 留干铺位给孩子），而非直白表白。',
    '- 不要写成 user 视角或第三人称；就是 TA 自己写给自己看的。',
    '',
    '通则：不要出现「根据设定」「用户让我」「系统提示」「模型」「AI」「设定库」等元叙述；'
      + '只能是 agent 第一人称回忆这趟路的口吻。信息不足时，宁可少写几条也不要编造与设定无关的新地名。',
    '',
    speakerContextBlock,
    `- 视角：把 TA 写成「我」，把 ${currentUserName} 写成「${currentUserName}」；不要写成「TA / 她 / 他」或「您」。`,
    '',
    '当前角色（基础身份）：',
    JSON.stringify({ id: agent.id, name: currentAgentName, yuan: agent.yuan, profile: profile ?? null }, null, 2),
    ...(recentSceneBlock
      ? ['', '【最近场景（OpenHanako 对话摘录；从这里找 TA 提到 / 浮现的过去旅程）】', recentSceneBlock]
      : []),
    ...(relationshipBlock
      ? ['', '【当前关系状态（语气 / 称呼参考；不要直接照搬进票面）】', relationshipBlock]
      : []),
    ...(heartbeatBlock
      ? ['', '【上次巡检结果（近期 TA 的内部活动线索）】', heartbeatBlock]
      : []),
    ...(existingTripsAnchor
      ? ['', '【已记录的行程（去重锚点——不要重复这些 from→to / chapter，只补没记过的路）】', existingTripsAnchor]
      : []),
    '',
    '【星野核心设定摘录（stable lore；用来识别世界观 / 时代，提取真实地点与合理交通方式）】',
    stableLoreBlock.trim() || '（无）',
    '',
    '【按需命中的设定库关键词条目（仅命中项；可能含地名 / 时代 / 交通线索）】',
    keywordLoreBlock.trim() || '（无）',
    '',
    `记住：只输出 { "trips": [...] } 一个 JSON 对象；trips 长度 = ${count}；每条 from→to / chapter 互不重复；`
      + '全部是**过去走过的路**（不是未来计划）；交通方式与时间写法都贴 TA 的世界观；首尾 route stop 必 major=true 且带亲笔批注。'
      + (mode === 'update'
        ? '务必**避开上面【已记录的行程】里出现过的 from→to / chapter**，只产出之前没记过的新路；信息不足时宁可少产几条也不要硬凑或重复。'
        : ''),
  ];

  return parts.join('\n');
}
