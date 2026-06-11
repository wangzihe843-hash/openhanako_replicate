import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import { formatXingyeSpeakerContextForPrompt } from './xingye-speaker-context';

/**
 * 购物 / 二手「评价」prompt。
 *
 * 共同约束（见 SHARED_REVIEW_RULES）：
 * - 评价档位三种倾向：好评(满意) / 中评(一般) / 差评(不满意)。模型只回**定性** sentiment，
 *   星级由调用方本地映射（1–2 差评 / 3 中评 / 4–5 好评）——遵循「LLM 只回定性、数值本地生成」。
 * - **是否评价**由模型按"满意度 + 人设"判定：满意 / 一般 → 大概率不评（reviewed:false）；
 *   特别满意 / 特别不满意 → 评（reviewed:true）。但外向 / 爱分享生活 / 条件拮据想拿好评返现的
 *   人设 → 大概率每条都评。不评 → 不要写 text（系统会显示默认好评）。
 * - 生成依据优先级：lore（高）+ 详情 reason/content + (二手)买家聊天 > 最近聊天（中）。
 *   用来防止崩人设、以及"本来买给 user 结果写成 agent 自用"这类事实漂移。
 * - 禁止真实电商平台名 / 链接 / 支付订单运单号 / emoji / 「我是 AI / 模型 / 系统」等元叙述。
 */

const SHARED_REVIEW_RULES: string[] = [
  '──────────────────',
  '【评价生成通用规则】',
  '──────────────────',
  '1. 评价倾向只有三种（用 sentiment 字段表达，不要自己写星级数字）：',
  '   - "good"  = 好评：满意 / 很喜欢 / 超出预期。',
  '   - "neutral" = 中评：一般 / 凑合 / 有点小问题但能接受。',
  '   - "bad"   = 差评：不满意 / 货不对板 / 体验差。',
  '2. **是否作出评价**（reviewed 字段，true/false）按"满意度 + 性格"判断，要像真人：',
  '   - 满意 / 一般 这种**不上不下**的情况 → **大概率 reviewed:false**（懒得评，沉默）。',
  '   - **特别满意** 或 **特别不满意** → reviewed:true（情绪强烈才想说几句）。',
  '   - 但如果 TA / 买家的人设是**外向、爱分享生活、话痨**，或**条件拮据、很在意那点好评返现 / 积分** →',
  '     哪怕只是一般也大概率 reviewed:true，条条都评。请结合下方人设 / 聊天判断属于哪种人。',
  '   - reviewed:false 时 sentiment 仍照实给（供参考），但 **text 必须留空字符串**——系统会显示「默认好评」。',
  '3. text（评价正文，reviewed:true 时必填）：',
  '   - 8–50 字，口语化，像真实电商 / 二手平台评价；可以有错别字感的随口语气，但不要 emoji、不要颜文字。',
  '   - 好评夸具体的点（用料 / 成色 / 物流 / 卖家态度 / 比预期好）；差评吐槽具体的点（和描述不符 / 有瑕疵 / 包装差 / 态度）。',
  '   - 不写真实平台名、品牌型号 SKU、链接、订单 / 运单 / 支付号、手机号、地址。',
  '4. 严格贴合下方设定与上下文：',
  '   - **lore / 世界观（最高优先）**：口吻、称呼、货币、时代都要符合，别崩人设（古风别冒现代词，反之亦然）。',
  '   - **详情里的 reason / content**：这是这件东西的真实来历 / 用途 / 心情，评价要据此写。',
  '   - **特别注意用途**：如果 reason / 最近聊天显示这东西其实是**买来送人 / 送给对方的礼物**，',
  '     评价口吻要尊重真实用途（"送人的，对方挺喜欢"），**不要**写成 TA 自己在用 / 自用很爽。',
  '   - 最近聊天作为中等优先的背景参考，别和它矛盾。',
  '5. 不要任何元叙述（"根据聊天""系统提示""作为 AI / 助手 / 模型"），不要解释，只返回严格 JSON。',
];

function baseIdentityBlocks(args: {
  agent: Pick<Agent, 'id' | 'name' | 'yuan'>;
  currentAgentName: string;
  currentUserName: string;
  profile: XingyeRoleProfile | null | undefined;
  stableLoreBlock: string;
  keywordLoreBlock: string;
  recentSceneBlock: string;
  relationshipBlock: string;
}): string[] {
  const {
    agent,
    currentAgentName,
    currentUserName,
    profile,
    stableLoreBlock,
    keywordLoreBlock,
    recentSceneBlock,
    relationshipBlock,
  } = args;
  return [
    '当前角色（基础身份）：',
    JSON.stringify(
      { id: agent.id, name: currentAgentName, yuan: agent.yuan, profile: profile ?? null },
      null,
      2,
    ),
    '',
    '【星野核心设定摘录（stable lore；最高优先：锚定 TA 的口吻 / 世界观 / 货币 / 时代）】',
    stableLoreBlock.trim() || '（无）',
    '',
    '【按需命中的设定库关键词条目（仅命中项）】',
    keywordLoreBlock.trim() || '（无）',
    '',
    `【最近 OpenHanako 聊天（中等优先背景；可能藏着这东西的真实用途 / 是否送给 ${currentUserName}）】`,
    recentSceneBlock.trim() || '（无）',
    '',
    `【当前对 ${currentUserName} 的关系状态摘要（若有；情绪 / 边界参考）】`,
    relationshipBlock.trim() || '（无）',
  ];
}

/**
 * 购物评价：TA 是**买家**，对【商品 + 店家】写一条买家评价；若差评，店家可能追加小作文回复。
 *
 * 输出 schema：
 *   {
 *     agent:  { reviewed: bool, sentiment: "good|neutral|bad", text: string },  // TA(买家) 评商品
 *     sellerReply: string   // 店家对差评的道歉小作文候选；调用方仅在 agent 差评时按概率采用
 *   }
 */
export function buildShoppingReviewPrompt(args: {
  agent: Pick<Agent, 'id' | 'name' | 'yuan'>;
  userName?: string;
  profile: XingyeRoleProfile | null | undefined;
  entry: {
    itemName: string;
    /** 'received'（已收到）/ 'returned'（已退掉） */
    status: string;
    category?: string;
    seller?: string;
    reason?: string;
    imaginedPrice?: string;
    content?: string;
    tags?: string[];
  };
  /**
   * 周期性补货品的复购信号（仅"已收到的消耗品、且之前买过同款"才传；见 computeShoppingPurchaseContext）。
   * 用来**下调再次写评价的概率**——老顾客对用惯的东西通常懒得反复评。不传 → 按原逻辑判定是否评价。
   */
  repeatPurchase?: {
    /** 这是同一核心品类的第几次购买（≥2）。 */
    purchaseCount: number;
    /** 之前几次里有没有「不满」信号（差评 / 退货）。false = 之前都好评 / 中评 / 没评。 */
    priorDissatisfied: boolean;
  };
  stableLoreBlock: string;
  keywordLoreBlock: string;
  recentSceneBlock: string;
  relationshipBlock: string;
}): string {
  const { agent, userName, profile, entry, repeatPurchase } = args;
  const currentUserName = userName?.trim() || '用户';
  const currentAgentName = profile?.displayName?.trim() || agent.name || '当前角色';
  const speakerContextBlock = formatXingyeSpeakerContextForPrompt({
    userName: currentUserName,
    agentName: currentAgentName,
    gender: profile?.gender,
  });
  const sellerName = entry.seller?.trim() || '店家';
  const isReturned = entry.status === 'returned';

  const parts: string[] = [
    '你是星野模式「购物评价」生成器。只返回严格 JSON，不要 Markdown，不要解释。',
    '',
    `生成目标：当前角色（${currentAgentName}）作为**买家**，在自己手机的购物记录里，对刚${isReturned ? '退掉' : '收到'}的这件商品写一条买家评价。`,
    '这是历史快照，不连接真实平台、不会真的发布、不触发任何外部行为。',
    isReturned
      ? '这件东西是 TA **已退掉**的：评价语境通常偏中评 / 差评（和想象不一样才退），但也可能只是"东西没问题、TA 自己不需要了"——请按下方 reason 判断，不要无脑差评。'
      : '这件东西是 TA **已收到**的：好 / 中 / 差都有可能，按下方 reason / content 的情绪判断。',
    '',
    ...SHARED_REVIEW_RULES,
    '',
    '──────────────────',
    '【本模块额外要求】',
    '──────────────────',
    `- agent 这一侧 = TA(买家) 对【商品本身 + 店家「${sellerName}」】的评价。`,
    `- sellerReply = 店家「${sellerName}」针对**差评**的道歉小作文候选（客服腔："很抱歉给您带来不好的购物体验…我们会…"）。`,
    '  **无论 agent 是不是差评都要给一段** sellerReply 候选（调用方只在 TA 差评时按概率采用，其余情况丢弃）。',
    '  长度 20–70 字，官方客服话术感，礼貌克制，不甩锅、不真发优惠券链接、不写联系方式。',
    ...(repeatPurchase && !isReturned
      ? [
        '',
        `- **复购信号**：这已经是 TA 第 ${repeatPurchase.purchaseCount} 次买这件周期性补货的东西了`
        + (repeatPurchase.priorDissatisfied ? '（前几次还出过不满）。' : '（前几次都没什么不满）。'),
        repeatPurchase.priorDissatisfied
          ? '  老毛病若这次还在，TA 可能又要吐槽；按 reason / content 判断这次到底好没好，别无脑好评。'
          : '  老顾客对用惯的东西通常懒得反复写评价——**reviewed 更倾向 false**（买了就买了、不特地评），'
            + '除非这次特别惊喜或特别翻车才评。',
        '  （这条只下调"是否评价"的概率，不推翻上面"话痨 / 爱分享 / 在意返现的人设仍可能条条都评"的判断。）',
      ]
      : []),
    '',
    '输出 JSON schema（仅此结构，字段名必须一致）：',
    JSON.stringify(
      {
        agent: { reviewed: true, sentiment: '<good | neutral | bad>', text: 'string' },
        sellerReply: 'string',
      },
      null,
      2,
    ),
    '- agent.reviewed=false 时 agent.text 必须是空字符串 ""。',
    '- 只输出这两个顶层字段，不要附带星级数字 / 时间戳 / 其它字段。',
    '',
    speakerContextBlock,
    `- 视角：把 TA 写成「我」，把 ${currentUserName} 写成「${currentUserName}」；不要写「您好亲」式电商客服腔到 agent 评价里（那是 sellerReply 的腔调）。`,
    '',
    '──────────────────',
    '【商品信息（这是 TA 买的东西）】',
    '──────────────────',
    JSON.stringify(
      {
        itemName: entry.itemName,
        status: entry.status,
        category: entry.category?.trim() || null,
        seller: entry.seller?.trim() || null,
        imaginedPrice: entry.imaginedPrice?.trim() || null,
        reason: entry.reason?.trim() || null,
        content: entry.content?.trim() || null,
        tags: entry.tags ?? [],
      },
      null,
      2,
    ),
    '',
    ...baseIdentityBlocks({
      agent,
      currentAgentName,
      currentUserName,
      profile,
      stableLoreBlock: args.stableLoreBlock,
      keywordLoreBlock: args.keywordLoreBlock,
      recentSceneBlock: args.recentSceneBlock,
      relationshipBlock: args.relationshipBlock,
    }),
    '',
    '记住：只输出 { agent, sellerReply } 一个 JSON 对象；agent.reviewed=false 时 text 留空；sentiment 只回 good/neutral/bad，不要写星级。',
  ];

  return parts.join('\n');
}

/**
 * 二手互评：TA 是**卖家**。闲鱼式两条互评——
 *   seller = TA(卖家) 评买家（"感谢收物，爽快"好评 / "到手刀，磨叽半天"差评）
 *   buyer  = 买家 评卖家(TA)/商品（以评商品成色 / 描述是否相符为主，可带卖家印象"人很好很细心"/"有问必答"）
 *
 * 关键：把该 entry 的买家聊天 transcript 喂进来，让两条评价与聊天剧情一致
 * （聊天里到手刀 / 收货不满 → 买家差评、卖家也可能给差评；顺利 → 互好评）。
 *
 * 输出 schema：
 *   {
 *     seller: { reviewed, sentiment, text },   // TA(卖家) → 买家
 *     buyer:  { reviewed, sentiment, text }     // 买家 → 卖家(TA)/商品
 *   }
 */
export function buildSecondhandReviewPrompt(args: {
  agent: Pick<Agent, 'id' | 'name' | 'yuan'>;
  userName?: string;
  profile: XingyeRoleProfile | null | undefined;
  entry: {
    itemName: string;
    /** 'sold'（已售出） */
    status: string;
    category?: string;
    askingPrice?: string;
    delta?: string;
    buyer?: string;
    reason?: string;
    content?: string;
    tags?: string[];
  };
  /** 该 entry 的买家聊天（若有）；按 role/text 顺序传入，作为最高优先的剧情依据。 */
  buyerChatMessages?: Array<{ role: 'buyer' | 'seller'; text: string }>;
  stableLoreBlock: string;
  keywordLoreBlock: string;
  recentSceneBlock: string;
  relationshipBlock: string;
}): string {
  const { agent, userName, profile, entry } = args;
  const currentUserName = userName?.trim() || '用户';
  const currentAgentName = profile?.displayName?.trim() || agent.name || '当前角色';
  const speakerContextBlock = formatXingyeSpeakerContextForPrompt({
    userName: currentUserName,
    agentName: currentAgentName,
    gender: profile?.gender,
  });
  const buyerName = entry.buyer?.trim() || '买家';
  const chat = args.buyerChatMessages ?? [];
  const chatTranscript = chat.length
    ? chat
        .map((m) => `${m.role === 'buyer' ? '买家' : `卖家(${currentAgentName})`}：${m.text}`)
        .join('\n')
    : '';

  const parts: string[] = [
    '你是星野模式「二手互评」生成器。只返回严格 JSON，不要 Markdown，不要解释。',
    '',
    `生成目标：当前角色（${currentAgentName}）是**卖家**，刚把这件二手东西卖给了买家「${buyerName}」。交易完成后双方在二手平台**互相评价**。请同时生成两条评价：`,
    `  - seller = TA(卖家) 对买家的评价（例：好评"感谢收物，爽快人"；差评"到手刀，磨叽半天还挑三拣四"）。`,
    `  - buyer  = 买家 对卖家(TA)/商品的评价：**以评商品为主**（成色、和描述是否相符、包装、值不值），可顺带评卖家印象（"人很好很细心""有问必答""发货快"）。`,
    '这是历史快照，不连接真实平台、不会真的发布。',
    '',
    ...SHARED_REVIEW_RULES,
    '',
    '──────────────────',
    '【本模块额外要求】',
    '──────────────────',
    '- **买家聊天是最高优先的剧情依据**：若下方有买家聊天，两条评价必须和聊天里的氛围一致——',
    '  聊天里买家到手刀 / 收货后挑刺 / 不满意 → 买家大概率差评或中评，卖家(TA) 对买家也可能差评；',
    '  聊天里顺顺利利、客客气气成交 → 大概率互好评。别和聊天剧情打架。',
    '- seller 这一侧要符合 TA 的人设：脾气好的卖家就算遇到砍价也多半还是好评 + 一句无奈；',
    '  心直口快 / 护短的卖家遇到难缠买家可能直接差评。',
    '- buyer 这一侧是**虚构买家**口吻（参考「' + buyerName + '」），别写成真实平台账号名。',
    '',
    '输出 JSON schema（仅此结构，字段名必须一致）：',
    JSON.stringify(
      {
        seller: { reviewed: true, sentiment: '<good | neutral | bad>', text: 'string' },
        buyer: { reviewed: true, sentiment: '<good | neutral | bad>', text: 'string' },
      },
      null,
      2,
    ),
    '- 任一侧 reviewed=false 时，该侧 text 必须是空字符串 ""。',
    '- 只输出这两个顶层字段，不要附带星级数字 / 时间戳 / 其它字段。',
    '',
    speakerContextBlock,
    '',
    '──────────────────',
    '【商品信息（这是 TA 卖掉的东西）】',
    '──────────────────',
    JSON.stringify(
      {
        itemName: entry.itemName,
        status: entry.status,
        category: entry.category?.trim() || null,
        askingPrice: entry.askingPrice?.trim() || null,
        delta: entry.delta?.trim() || null,
        buyer: entry.buyer?.trim() || null,
        reason: entry.reason?.trim() || null,
        content: entry.content?.trim() || null,
        tags: entry.tags ?? [],
      },
      null,
      2,
    ),
    '',
    '──────────────────',
    '【与买家的聊天记录（最高优先剧情依据；若为「（无）」则按商品信息 + 人设自然判断）】',
    '──────────────────',
    chatTranscript || '（无）',
    '',
    ...baseIdentityBlocks({
      agent,
      currentAgentName,
      currentUserName,
      profile,
      stableLoreBlock: args.stableLoreBlock,
      keywordLoreBlock: args.keywordLoreBlock,
      recentSceneBlock: args.recentSceneBlock,
      relationshipBlock: args.relationshipBlock,
    }),
    '',
    '记住：只输出 { seller, buyer } 一个 JSON 对象；与买家聊天剧情一致；reviewed=false 时该侧 text 留空；sentiment 只回 good/neutral/bad。',
  ];

  return parts.join('\n');
}
