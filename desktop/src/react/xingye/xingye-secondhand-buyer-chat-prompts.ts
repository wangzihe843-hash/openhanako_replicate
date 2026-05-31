import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import { formatXingyeSpeakerContextForPrompt } from './xingye-speaker-context';
import type { SecondhandBuyerChatStatus } from './xingye-secondhand-buyer-chat-store';

/**
 * 构造「二手 · 与买家聊天记录」prompt：让模型扮演**买家 + 卖家两端**生成一段
 * 仿闲鱼/咸鱼的二手 IM 对话快照。
 *
 * - seller = 当前 agent（TA 自己），口吻必须严格符合 agent 人设 + lore
 * - buyer = 虚构 NPC（来自 entry.metadata.buyer 文本，例如「巷口的旧书客」）；
 *           没有显式 buyer 时由模型按世界观即兴起一个，但**不要**用真实平台账号名
 * - 一次性生成整段对话（buyer 先开口）；不分批，不分轮，单 JSON 返回
 *
 * 收尾基调由 status 自动决定（用户没有选项介入）：
 *   - 'sold'        → 末尾两条：成交确认 / 约取货 / 收款（虚构氛围，不写真实支付链接）
 *   - 'negotiating' → 末尾留悬而未决：买家说「再考虑下」/「能不能再松点」，TA 也没强推
 */
export function buildSecondhandBuyerChatPrompt(args: {
  agent: Pick<Agent, 'id' | 'name' | 'yuan'>;
  userName?: string;
  profile: XingyeRoleProfile | null | undefined;
  /** 必填：触发聊天生成的二手 entry 关键字段 */
  entry: {
    itemName: string;
    status: SecondhandBuyerChatStatus;
    category?: string;
    askingPrice?: string;
    delta?: string;
    buyer?: string;
    reason?: string;
    content?: string;
    platformStyle?: string;
    tags?: string[];
  };
  /** 期望生成的总消息条数（buyer + seller 合计），8-14 之间；调用方控制随机。 */
  desiredMessageCount: number;
  stableLoreBlock: string;
  keywordLoreBlock: string;
  relationshipBlock: string;
  /**
   * 生成模式：
   *  - 'full'（默认）：从零生成整段对话（buyer 先开口），收尾基调由 status 决定。
   *  - 'append_closing'：保留 priorMessages（之前「在谈」段），**只续写成交收尾的 1–3 条**，
   *    自然衔接最后一条，不重写整段。用于挂牌从「在谈」迁移到「已售」时延续旧聊天。
   */
  mode?: 'full' | 'append_closing';
  /** append_closing 模式下的既有对话（之前「在谈」段）。 */
  priorMessages?: Array<{ role: 'buyer' | 'seller'; text: string }>;
}): string {
  const {
    agent,
    userName,
    profile,
    entry,
    desiredMessageCount,
    stableLoreBlock,
    keywordLoreBlock,
    relationshipBlock,
    mode = 'full',
    priorMessages = [],
  } = args;

  const count = Math.max(6, Math.min(16, Math.floor(desiredMessageCount)));
  const currentUserName = userName?.trim() || '用户';
  const currentAgentName = profile?.displayName?.trim() || agent.name || '当前角色';
  const speakerContextBlock = formatXingyeSpeakerContextForPrompt({
    userName: currentUserName,
    agentName: currentAgentName,
    gender: profile?.gender,
  });

  const buyerHint = entry.buyer?.trim() || '';
  const askingPriceHint = entry.askingPrice?.trim() || '';
  const reasonHint = entry.reason?.trim() || '';
  const contentHint = entry.content?.trim() || '';
  const categoryHint = entry.category?.trim() || '';

  /**
   * append_closing：保留旧「在谈」段，只续写成交收尾的 1–3 条。
   * 单独成 prompt，避免 full 模式那套「整段 / 第一条必须 buyer / 固定条数」的约束。
   */
  if (mode === 'append_closing') {
    const priorTranscript = priorMessages
      .map((m) => `${m.role === 'buyer' ? '买家' : `卖家(${currentAgentName})`}：${m.text}`)
      .join('\n');
    const lastRole = priorMessages.length ? priorMessages[priorMessages.length - 1].role : null;
    const appendParts: string[] = [
      '你是星野模式「二手买家聊天」生成器。只返回严格 JSON，不要 Markdown，不要解释。',
      '',
      `下面是当前角色（${currentAgentName}，卖家）和一位虚构买家之前在 TA 自己手机的二手平台 IM 上的一段聊天，当时停在「还在谈」：`,
      '──────────────────',
      priorTranscript || '（无既有对话）',
      '──────────────────',
      '',
      '现在这件东西**已经成交了**（也可能买家已经收到货了）。请**只续写收尾的那几条新消息**，自然衔接上面最后一条；**不要**重写、不要重复上面已有的任何句子。',
      '',
      '**重要语感**：现实里，对商品满意的买家收到货后大多就不会再找卖家了——所以当买家**还来发消息**时，除了简单敲定成交，也**很有可能是收到货后觉得有点不满意 / 想反馈问题**。下面两种收尾都可以，按上文语气和商品情况自然挑一种：',
      '  A.（简短成交收尾，中性偏正面）买家「那我要了 / 就这个价吧 / 拍了」「收到了，挺好」，卖家「约时间取货 / 邮寄 / 明天来拿 / 那谢谢啦」之类（虚构氛围）。',
      '  B.（收到货后不满意，轻微、不撕破脸）买家收到实物后指出落差——例如成色比想的旧、有没提到的小瑕疵 / 划痕、和描述或图片有点出入、包装太随意压到了……语气是失望 / 较真 / 想讨个说法，但**不是**辱骂、威胁或死缠烂打。卖家按 TA 的人设回应：道歉 +（小幅）补偿 / 补寄，或克制解释（「我描述里写了是旧的呀」「拍的时候光线偏了，见谅」），不必非得谈拢。',
      '',
      '共同要求：',
      '- 只输出 **1–3 条**新消息（buyer + seller 合计）。',
      lastRole
        ? `- 上面最后一条是「${lastRole === 'buyer' ? '买家' : '卖家'}」发的，所以你续写的第一条发话人应当**不同**（一来一回自然衔接）。`
        : '- 买家先开口。',
      '- 单条 8–60 字，口语化，延续之前的语气；不写真实支付链接 / 微信支付宝交易号 / 运单号 / 真实平台名 / emoji；不写「我是 AI / 模型 / 系统」。',
      askingPriceHint
        ? `- 若提到价格 / 补偿，应与之前谈的价位（约「${askingPriceHint}」）一致或只小幅让步，别凭空跳价。`
        : '- 若提到价格 / 补偿，应与之前谈的价位一致或只小幅让步，别凭空跳价。',
      '- 这笔交易**已经完成**（状态＝已售出）：就算走 B 路径买家不满意，也只是售后的小插曲，**不要**写成整单退货 / 取消交易（那会和「已售出」矛盾），最多到小幅补偿为止。',
      '',
      '【输出 JSON schema】（仅此结构；下面是示例，messages 实际 **1–3 条**）',
      JSON.stringify(
        {
          messages: [
            { role: '<buyer | seller>', text: 'string' },
            { role: '<buyer | seller>', text: 'string', afterDelivery: true },
          ],
        },
        null,
        2,
      ),
      '- text 不允许为空或只有标点；除 role / text / afterDelivery 外不要附带其它字段（at / timestamp 由调用方本地补）。',
      '- `afterDelivery`（可选布尔）：**仅当走 B 路径**时，标在**第一条「买家收到货之后才发」的消息**上——表示这条是隔了几天、东西到手后才发的（隔几天由程序本地决定）。走 A、或消息就发生在成交当口的，**不要**加这个字段。',
      '',
      speakerContextBlock,
      '',
      '【商品信息（这是 TA 卖掉的东西）】',
      JSON.stringify(
        {
          itemName: entry.itemName,
          category: categoryHint || null,
          askingPrice: askingPriceHint || null,
          buyerHint: buyerHint || null,
        },
        null,
        2,
      ),
      '',
      '【星野核心设定摘录（锚定 TA 的口吻 / 货币体系一致性）】',
      stableLoreBlock.trim() || '（无）',
      '',
      '【按需命中的设定库关键词条目】',
      keywordLoreBlock.trim() || '（无）',
      '',
      '记住：只输出 { "messages": [...] }，1–3 条，是上面对话的**收尾续写**（成交敲定 或 收到货后的售后反馈，二选一），不要重写整段，第一条发话人与上面最后一条不同。',
    ];
    return appendParts.join('\n');
  }

  const statusBlock =
    entry.status === 'sold'
      ? [
          '【状态收尾基调】= sold（已售出）',
          '- 整段对话的**结局必须是成交**——最后 2–3 条消息要落到「拍了/我要了/这就转给你」或「约时间取货/邮寄」上。',
          '- 不写真实支付链接、不写微信/支付宝交易号、不写运单号；可以是「转好了」「我下午来取」「明天到你说的地方碰头」这种氛围。',
          '- 中段可以有 1–2 个回合的还价拉扯，但最终成交价应与 askingPrice 接近或略低（合理让步）。',
        ].join('\n')
      : [
          '【状态收尾基调】= negotiating（仍在谈）',
          '- 整段对话的**结局必须是悬而未决**——最后 1–2 条消息要落到「我再考虑一下」/「价格还能再松点吗」/「我对比一下别家」/「等我和家人商量」上。',
          '- TA 这一端**不要强推**也不要降到地板价；可以表达「最多再让 N」「我也舍不得，再看看吧」这类有保留的回应。',
          '- 不要给出最终成交动作（不要写「那就拍了」「我要了」「转账给你」）。',
        ].join('\n');

  const parts: string[] = [
    '你是星野模式「二手买家聊天」生成器。只返回严格 JSON，不要 Markdown，不要解释。',
    '',
    `生成目标：模拟当前角色（${currentAgentName}）作为卖家、虚构的买家 NPC 作为买家，在 TA 自己手机的二手平台 IM 上**已经发生过**的一段聊天记录。这是历史快照，不会真的发出去、不会触发任何外部消息。`,
    '不是直播对话，是事后回看；语气贴近真实闲鱼/咸鱼的口语，不要文绉绉。',
    '',
    '──────────────────',
    '【双方设定】',
    '──────────────────',
    `- **卖家（seller）= TA 自己 / ${currentAgentName}**。回话必须严格符合下方「当前角色」+ 「星野核心设定」里 TA 的人设、说话习惯、世界观、性别气质；语气、用词、礼貌度都要像 TA 本人在二手平台跟陌生人议价。`
    + 'TA 想出掉这件东西的真实原因见下方【商品信息】的 reason / content，可作为对话里 TA 回应「为什么卖」的依据，但不要原句照搬，要口语化转述。',
    `- **买家（buyer）= 虚构陌生人**。${buyerHint ? `口吻参考：「${buyerHint}」（从这个标签揣摩对方身份/口气，但人物本身是虚构的，不是真实账号）。` : '请按当前世界观风格起一个合理的买家身份（例：现代「楼下收旧货的」、古风「西市收货郎」、西幻「神殿门口的吟游商人」），全程一致。'} `
    + '买家先开口（第一条消息 role = "buyer"），口吻可以略带砍价/谨慎/挑剔/客气其中之一；不要塑造成强势骚扰或粗鲁的极端形象，也不要写得过分阿谀，正常陌生人沟通就行。',
    '',
    '──────────────────',
    '【对话节奏与内容要求】',
    '──────────────────',
    `- 总消息条数 = **${count}** 条（buyer + seller 合计）。基本左右交替；允许偶尔出现「同一方连发两条短句」（如买家先打招呼再问详情），但不要超过 2 次连发。`,
    '- 单条消息长度：**8–80 字**（最好 15–40 字），口语化，可以有「在吗」「嗯」「我再看看」「这价能商量不」这种碎句；**禁止**长段独白、不要写超过 80 字的消息。',
    '- 推进路径建议（不必死板，按物品/状态自然展开）：',
    '  ① 买家开口（招呼 / 问还在不在）',
    '  ② 问详情（成色、用了多久、有没有原配件、尺寸/规格、能不能多发几张图——但**不要**真的写「图片消息」，可以是「能再描述一下吗」/「上面那个划痕在哪个位置」）',
    '  ③ 中段还价（买家试探低价 / TA 回应底价或解释为什么定这个价）',
    `  ④ 收尾按 status：见下方【状态收尾基调】`,
    '- **绝对禁止**出现：真实电商平台名（淘宝 / 闲鱼 / 拼多多 / 京东 / Amazon / eBay 等）、真实品牌型号 SKU、URL、真实支付/订单/运单号、手机号、身份证号、真实地址、emoji 表情符号（保持纯文本，闲鱼风用文字"哈哈"/"emm"即可）。',
    '- **不要**让 TA 跳出角色说"我是 AI"/"作为助手"，也不要让任何一方提及"模型/系统/prompt"。',
    '',
    statusBlock,
    '',
    '──────────────────',
    '【输出 JSON schema】（仅此结构）',
    '──────────────────',
    JSON.stringify(
      {
        messages: [
          { role: '<one of: buyer | seller>', text: 'string' },
        ],
      },
      null,
      2,
    ),
    `- messages 数组长度严格 = ${count}。`,
    '- 第一条 role 必须是 "buyer"。',
    '- text 不允许为空字符串，不允许只有标点。',
    '- 不要附带任何其它字段（不要返回 at/timestamp/buyerName/title 等），调用方会本地补齐时间戳。',
    '',
    speakerContextBlock,
    '',
    '──────────────────',
    '【商品信息（这是 TA 在卖的东西）】',
    '──────────────────',
    JSON.stringify(
      {
        itemName: entry.itemName,
        status: entry.status,
        category: categoryHint || null,
        askingPrice: askingPriceHint || null,
        delta: entry.delta?.trim() || null,
        buyerHint: buyerHint || null,
        reason: reasonHint || null,
        content: contentHint || null,
        platformStyle: entry.platformStyle ?? null,
        tags: entry.tags ?? [],
      },
      null,
      2,
    ),
    '- 卖家在对话中回答价格时，**优先使用 askingPrice 给出的价位**（口语化转换：「¥1280」可说「1280」或「12 张多一点」；「二两银子」就是「二两」）。',
    '- 如果买家还价，TA 可以适度让步，但不要离谱跌价（参考 delta 的落差感）。',
    '- 不要主动透露 reason / content 的原文；它们是 TA 内心独白，回话时可以"用自己话简单解释一下原因"，但保持克制。',
    '',
    '当前角色（基础身份）：',
    JSON.stringify(
      {
        id: agent.id,
        name: currentAgentName,
        yuan: agent.yuan,
        profile: profile ?? null,
      },
      null,
      2,
    ),
    '',
    '【星野核心设定摘录（stable lore；用来锚定 TA 的口吻 / 世界观 / 货币体系一致性）】',
    stableLoreBlock.trim() || '（无）',
    '',
    '【按需命中的设定库关键词条目（仅命中项；可能含国别 / 时代 / 物品 / 关系线索）】',
    keywordLoreBlock.trim() || '（无）',
    '',
    `【当前对 ${currentUserName} 的关系状态摘要（若有；间接影响 TA 的情绪基调）】`,
    relationshipBlock.trim() || '（无）',
    '',
    `记住：只输出 { "messages": [...] } 一个 JSON 对象，messages 长度严格 = ${count}，第一条 role = "buyer"，按 status="${entry.status}" 的收尾基调结束。`,
  ];

  return parts.join('\n');
}
