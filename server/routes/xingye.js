import fs from "fs";
import path from "path";
import { Hono } from "hono";
import { safeJson } from "../hono-helpers.ts";
import { callText } from "../../core/llm-client.ts";
import { isLocalBaseUrl } from "../../shared/net-utils.ts";
import {
  appendMessage as appendChannelMessage,
  getChannelMembers,
  getChannelMeta,
} from "../../lib/channels/channel-store.ts";

const PROFILE_FIELDS = [
  "shortBio",
  "identitySummary",
  "backgroundSummary",
  "personalitySummary",
  "behaviorLogic",
  "values",
  "taboos",
  "relationshipMode",
  "speakingStyle",
];

/**
 * 角色「阴暗面预设」档位（黑化 / 占有 / 病娇倾向）。与渲染端 XingyeCorruptionTendency 对齐，
 * 仅用于关系状态初始化时给「黑化值 corruption」播种——none/latent/marked。
 * 非枚举值丢弃 → 渲染端回退到本地关键词扫描兜底。
 */
const CORRUPTION_TENDENCIES = new Set(["none", "latent", "marked"]);

const ALLOWED_LORE_CATEGORIES = new Set([
  "background",
  "worldview",
  "relationship",
  "event",
  "location",
  "organization",
  "character",
  "rule",
]);

/**
 * 仅决定响应 JSON 里的 `kind` 字段取值；未列入的 kind 会落回 contacts_enrichment，但请求仍以 prompt 为准。
 * 短信/通讯录等客户端 kind 故意不全部列入；秘密空间与 TA 状态等列入以便日志区分。
 */
const PHONE_GENERATE_KINDS = new Set([
  "contacts_enrichment",
  "relationship_state",
  "secret_space",
  "journal_draft",
  "trips_history",
  "mm_chat",
  "divination_reading",
  "moments",
  "reading_topics",
  "reading_annotation",
  "reading_history",
  "shopping_draft",
  "shopping_polish",
  "secondhand_draft",
  "secondhand_polish",
  "secondhand_buyer_chat",
  "shopping_review",
  "secondhand_review",
  "accounting_draft",
  "news_draft",
  "news_comment",
  "news_historical_draft",
  "news_timeline_extract",
  "secret_interview_draft",
  "forum_bootstrap",
  "forum_batch",
  "forum_dm",
  "cp_board",
  "health_day",
  "files_secret_seed",
  "files_draft",
  "files_init_plan",
  "files_init_entry",
  "files_batch_plan",
  "files_batch_entry",
  "gifts_init",
  "contact_profile_init",
  "contact_profile_update",
]);

const FORBIDDEN_TERMS = [
  "AI助手",
  "用户创建",
  "星野模式",
  "OpenHanako",
  "memory",
  "RAG",
  "prompt",
  "设定库",
  "工程配置",
];

function cleanString(value, maxLength = 260) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

/**
 * 从 Wikiquote wikitext 抽取 quote 文本行。
 *
 * Wikiquote 条目典型排版：
 *   * "Quote body here."
 *   ** Optional speaker / context (skipped)
 *   * "Another quote." {{cite ...}}
 *
 * 我们只取 `* "..."` 形式的顶层条目，删除模板/wiki 链接/HTML，长度 12-400。
 */
export function extractWikiquoteLines(wikitext) {
  if (typeof wikitext !== "string") return [];
  const out = [];
  const lines = wikitext.split(/\r?\n/);
  for (const raw of lines) {
    const m = /^\*\s+(.*)$/.exec(raw);
    if (!m) continue;
    let text = m[1];
    // 去模板 {{...}}
    let prev;
    do { prev = text; text = text.replace(/\{\{[^{}]*\}\}/g, ""); } while (text !== prev);
    // 去 ref/HTML 注释
    text = text.replace(/<ref[\s\S]*?<\/ref>/gi, "").replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, "");
    // 去 [[link|display]] / [[link]]
    text = text.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2").replace(/\[\[([^\]]+)\]\]/g, "$1");
    // 去外链 [url text] / [url]
    text = text.replace(/\[https?:\/\/\S+\s+([^\]]+)\]/g, "$1").replace(/\[https?:\/\/\S+\]/g, "");
    // 去 wiki 加粗/斜体
    text = text.replace(/'''([^']+)'''/g, "$1").replace(/''([^']+)''/g, "$1");
    text = text.replace(/\s+/g, " ").trim();
    // 必须是引号开头/结尾的"原话"行（典型 Wikiquote 风格）
    const quoted = /^["'“‘"][\s\S]+["'”"]$/u.test(text) || /^“[\s\S]+”$/.test(text);
    const cleanText = text.replace(/^["“‘"']\s*/, "").replace(/\s*["”'"]$/, "").trim();
    if (!cleanText) continue;
    if (cleanText.length < 12 || cleanText.length > 400) continue;
    if (!quoted && !/[.!?。！？]$/.test(cleanText)) continue;
    out.push(cleanText);
  }
  return out;
}

function normalizeLoreEntries(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => ({
      title: cleanString(entry?.title, 80),
      category: cleanString(entry?.category, 32),
      visibility: cleanString(entry?.visibility, 32),
      content: cleanString(entry?.content, 1800),
    }))
    .filter((entry) => entry.content && ALLOWED_LORE_CATEGORIES.has(entry.category));
}

function normalizeProfile(value) {
  const profile = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return profile;
  for (const field of PROFILE_FIELDS) {
    profile[field] = cleanString(value[field]);
  }
  // corruptionTendency 是 enum，不走 cleanString；只接受合法档位，否则不输出该键
  // （渲染端见到 undefined → 走本地关键词扫描兜底）。
  const rawTendency = typeof value.corruptionTendency === "string"
    ? value.corruptionTendency.trim().toLowerCase()
    : "";
  if (CORRUPTION_TENDENCIES.has(rawTendency)) {
    profile.corruptionTendency = rawTendency;
  }
  // corruptionSeed 是精确黑化起点（整数 0..100）。这里只做数值消毒（提取响应 = 提案、保存 = 落库都过此）；
  // 「非基线值要不要采用」的人工闸在渲染端弹窗，不在后端。非数 / 越界 → 不输出该键。
  const rawSeed = typeof value.corruptionSeed === "number"
    ? value.corruptionSeed
    : (typeof value.corruptionSeed === "string" && value.corruptionSeed.trim() !== "" ? Number(value.corruptionSeed) : NaN);
  if (Number.isFinite(rawSeed)) {
    profile.corruptionSeed = Math.min(100, Math.max(0, Math.round(rawSeed)));
  }
  return profile;
}

function extractJsonCandidate(text) {
  const raw = String(text ?? "").trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/im.exec(raw)
    ?? /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (fenced) return fenced[1].trim();
  return raw.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
}

function parseModelJson(text) {
  const cleaned = extractJsonCandidate(text);
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        throw new Error("invalid JSON from model");
      }
    }
    throw new Error("invalid JSON from model");
  }
}

function errorDetail(err) {
  return err?.message ? String(err.message) : String(err);
}

function buildPrompt({ displayName, relationshipLabel, shortBio, loreEntries, pastedLore }) {
  const context = {
    displayName,
    relationshipLabel,
    shortBio,
    canonicalLore: loreEntries.filter((entry) => entry.visibility === "canonical"),
    nonCanonicalReference: loreEntries.filter((entry) => entry.visibility !== "canonical"),
    pastedLore,
  };

  return [
    "你是角色设定整理器。请从输入的角色背景中提取可编辑的短摘要字段，只返回 JSON，不要 Markdown，不要解释。",
    "",
    "规则：",
    "- canonicalLore 是正式角色设定；nonCanonicalReference 和 acquired memory 只能作为参考，不能当作身份事实。",
    "- identitySummary 是身份锚点：职业、物种、世界观位置、关系事实等。",
    "- backgroundSummary 是一句核心背景，不要复述整段原始故事。",
    "- personalitySummary、behaviorLogic、values、taboos、relationshipMode、speakingStyle 必须从背景推导角色运行逻辑。",
    "- 每个字段都写短摘要，适合用户二次编辑。",
    "- 不要把原始背景故事整段塞入任何字段。",
    "- corruptionTendency 是角色「阴暗面预设」档位，**只依据 TA 本人的背景与性格**判断 TA 对 user 是否带黑化 / 病娇 / 强占有 / 控制欲 / 极端不安全感的底色——不要因为设定里其他角色（情敌 / 对手 / 朋友 / 家人）带占有欲、善妒或控制欲，就给 TA 套档位：完全没有 → \"none\"；有苗头（占有欲、善妒、缺乏安全感、依赖）→ \"latent\"；明显（病娇、极端占有、控制欲极强、不许离开）→ \"marked\"。这是底色不是当下情绪；拿不准就给 \"none\"。",
    "- corruptionSeed 是与 corruptionTendency 自洽的精确黑化起点（整数 0–100），供更细的初始化用。档位基线为 none=0 / latent=12 / marked=28：多数情况直接回对应基线值即可；只有当 TA 的阴暗面强度明显落在两档之间、或在某档内偏轻 / 偏重时，才回一个介于其档区间的精确值（例如「比一般占有更重、但还没到病娇」可回 18–22）。务必与档位自洽，不要跨档（latent 不要回 0 或 ≥28）。判断口径同上——只看 TA 本人。",
    `- 不要输出这些工程词：${FORBIDDEN_TERMS.join("、")}。`,
    "",
    "返回 JSON schema：",
    JSON.stringify(
      { ...Object.fromEntries(PROFILE_FIELDS.map((field) => [field, "string"])), corruptionTendency: "none | latent | marked", corruptionSeed: "integer 0-100 (与档位自洽)" },
      null,
      2,
    ),
    "",
    "输入：",
    JSON.stringify(context, null, 2),
  ].join("\n");
}

// ─────────────────────────── 角色设定工坊 (lore-studio) ───────────────────────────

/** 工坊 lore 条目允许的分类（与渲染端 XINGYE_LORE_CATEGORIES 全集对齐）。 */
const STUDIO_LORE_CATEGORIES = new Set([
  "background",
  "worldview",
  "relationship",
  "event",
  "location",
  "organization",
  "character",
  "rule",
]);

const STUDIO_INSERTION_MODES = new Set(["always", "keyword", "manual"]);

/**
 * 工坊可建议的思维底座（config.agent.yuan）。与渲染端 STUDIO_YUAN_OPTIONS 对齐；
 * kong（空白底座）刻意不进候选。模型给了集合外的值 → 丢弃（= 保持当前），不兜底乱切。
 */
const STUDIO_YUAN_KEYS = new Set(["hanako", "butter", "ming"]);

/**
 * 与渲染端 defaultInsertionModeForCategory 对齐：模型漏给 / 给错 insertionMode 时按分类兜底，
 * 而不是一律落 "manual"——背景 / 关系本应 always、世界观本应 keyword，落 manual = 默认不注入（静默失效）。
 */
function defaultStudioInsertionMode(category) {
  if (category === "background" || category === "relationship") return "always";
  if (category === "worldview") return "keyword";
  return "manual";
}

/** 像 cleanString 但保留换行（lore 正文可能分段）。 */
function clipText(value, maxLength = 1800) {
  if (typeof value !== "string") return "";
  return value.replace(/[ \t\u00A0]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, maxLength);
}

/**
 * 把 existingProfile 收口成「有界的字符串 / 数值键值对」。这是工坊 prompt 里唯一原样透传的输入，
 * 其余字段都过 cleanString/clipText + slice；这里补上同档防护：限键数、限单值长度、丢非字符串/数值、
 * 跳过 __proto__/constructor 等原型污染键，防止超大或任意内容灌进 LLM 输入。
 */
function sanitizeStudioProfile(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  let count = 0;
  for (const [rawKey, v] of Object.entries(value)) {
    if (count >= 24) break;
    const key = cleanString(rawKey, 40);
    if (!key || key === "__proto__" || key === "constructor" || key === "prototype") continue;
    if (typeof v === "string") {
      const s = clipText(v, 800);
      if (s) { out[key] = s; count += 1; }
    } else if (typeof v === "number" && Number.isFinite(v)) {
      out[key] = v;
      count += 1;
    }
  }
  return out;
}

function renderStudioTranscript(transcript) {
  if (!Array.isArray(transcript)) return "（无）";
  const lines = [];
  for (const msg of transcript) {
    const role = msg?.role === "assistant" ? "助手" : "用户";
    const content = clipText(msg?.content, 4000);
    if (content) lines.push(`${role}：${content}`);
  }
  return lines.length ? lines.join("\n\n") : "（无）";
}

function buildLoreStudioPrompt(input) {
  const mode = input?.mode === "peer-suggest" ? "peer-suggest" : "extract";
  const rawCurrentYuan = cleanString(input?.currentYuan, 32).toLowerCase();
  const context = {
    displayName: cleanString(input?.displayName, 120),
    relationshipLabel: cleanString(input?.relationshipLabel, 120),
    shortBio: cleanString(input?.shortBio, 400),
    // 展示用：透传消毒后的原值（可能是候选集外的 kong 等）；没传时按系统默认 hanako（与 core/agent.ts 一致）。
    // 输出侧仍只接受 STUDIO_YUAN_KEYS 三选一（见 normalizeStudioPlanTurn）。
    currentYuan: /^[a-z0-9_-]+$/.test(rawCurrentYuan) ? rawCurrentYuan : "hanako",
    existingProfile: sanitizeStudioProfile(input?.existingProfile),
    existingLoreAnchors: Array.isArray(input?.existingLoreAnchors)
      ? input.existingLoreAnchors.slice(0, 80).map((a) => ({
          title: cleanString(a?.title, 80),
          category: cleanString(a?.category, 32),
          insertionMode: cleanString(a?.insertionMode, 16),
        }))
      : [],
  };
  const backgroundStory = clipText(input?.backgroundStory, 8000);
  const transcript = renderStudioTranscript(input?.transcript);

  if (mode === "peer-suggest") {
    const candidateNames = Array.isArray(input?.peerCandidateNames)
      ? input.peerCandidateNames.map((n) => cleanString(n, 60)).filter(Boolean).slice(0, 30)
      : [];
    // 已是独立角色的名单（其他 agent 显示名 + 已 link 联系人备注名）：客户端的确定性扫描只能挡
    // 同名/包含，候选若是名单中某人的别名/绰号/旧称，要靠模型在这一轮语义排除，免得重复建角色
    // （与通讯录生成 prompt 的 SEMANTIC_DEDUP_FOR_VIRTUAL_GENERATION 同思路）。
    const existingAgentNames = Array.isArray(input?.existingAgentNames)
      ? input.existingAgentNames.map((n) => cleanString(n, 60)).filter(Boolean).slice(0, 40)
      : [];
    return [
      "你在帮用户判断：当前角色所在的世界里，TA 的关系 / 人物设定里提到的哪些「非用户」角色，值得被升级成「用户可以直接对话的独立角色(agent)」。",
      "给你：当前角色信息 + 既有设定库锚点 + 一组「在现有角色里还找不到对应的候选实体名」。",
      "",
      "【关键判断标准】升级后这个角色会成为用户能直接聊天的对象，所以**优先级 = 这个角色是否(会)和用户本人有互动、用户能否合理地认识或接触到 TA**：",
      "- 优先：围绕「用户 + 当前角色」日常生活的人——会和用户打照面、说得上话、或迟早会产生交集的亲友 / 同伴 / 同事 / 对手 / 邻里等。结合当前角色与用户的关系(relationshipLabel)推断谁自然会进入用户的生活圈。",
      "- 排除(不要列)：① 纯世界观 / 历史 / 传说里的名人或背景人物——只是设定底色、不在当下生活里、用户不可能去找 TA 聊；② 只与当前角色私下相关、和用户毫无交集、也没理由认识用户的角色；③ 实为已有角色的人——「已是独立角色名单」里的同名者已被提前筛掉，但**别名 / 绰号 / 旧称 / 代号**筛不掉：候选若疑似与名单中某人是同一个人，必须排除，不要给同一个人再建一个角色。",
      "- 数量与边界：只要存在合适的就要提（别因为保守而一个都不提）；但也别贪多——一般给 1–4 个最相关的，按「与用户互动可能性 + 重要度」排序，宁缺毋滥、但别漏掉明显该有的。",
      "- whyUpgrade 里请说清 TA 会怎样和用户产生互动 / 为什么用户会想直接和 TA 聊。",
      "",
      "严格只返回如下 JSON（不要 Markdown，不要解释）：",
      '{"type":"peer-suggestions","intro":"(可选，一句引导)","candidates":[',
      '  {"name":"角色名","roleInWorld":"TA 在这个世界里的身份","whyUpgrade":"为什么值得升级——重点说 TA 与用户会如何互动","suggestedRelationshipToCurrent":"与当前角色的关系(一句话)","worldviewTweaks":"(可选)新角色背景若需要对共享世界观做的微调"}',
      "]}",
      "若候选里没有任何符合上述标准的（都是历史名人 / 与用户无交集），返回 candidates 为空数组即可，不要硬凑。",
      "",
      "[当前角色]",
      JSON.stringify({ displayName: context.displayName, relationshipLabel: context.relationshipLabel, shortBio: context.shortBio }, null, 2),
      "[既有设定库锚点]",
      JSON.stringify(context.existingLoreAnchors, null, 2),
      "[尚无对应角色的候选实体名]",
      JSON.stringify(candidateNames, null, 2),
      "[已是独立角色名单（含已链接到角色的联系人备注名）——别名判同后排除，不在升级范围]",
      existingAgentNames.length ? JSON.stringify(existingAgentNames, null, 2) : "（无）",
      "[对话历史]",
      transcript,
    ].join("\n");
  }

  // mode === 'extract'（Phase 1 主流程）
  // peer 微调上下文：新角色刚从某源角色分出来时，把已带来的世界观/关系正文喂给模型供其据新背景改写。
  const peerName = cleanString(input?.peerContext?.sourceName, 60);
  const fineTuneEntries = Array.isArray(input?.fineTuneEntries)
    ? input.fineTuneEntries
        .slice(0, 40)
        .map((e) => ({
          title: cleanString(e?.title, 80),
          category: cleanString(e?.category, 32),
          insertionMode: cleanString(e?.insertionMode, 16),
          content: clipText(e?.content, 1500),
        }))
        .filter((e) => e.title && e.content)
    : [];
  const peerBlock = peerName
    ? [
        `【这是一个刚从「${peerName}」分出来的新角色】`,
        `下面「已带来的条目」是从「${peerName}」带过来的：与「${peerName}」共享的世界观，以及这个新角色与「${peerName}」的关系（关系条目现在可能还是空模板）。`,
        "用户接下来会给这个新角色的完整背景。请据新背景**微调 / 补全**这些条目，再照常整理这个新角色自己的设定：",
        "- 要改动「已带来的条目」时，沿用同一个 title 并标 isUpdate:true（更新补丁，别新增重复）；",
        `- 关系条目若还是空模板，请按新背景把它填成真正的、第一人称视角的关系设定（实体区分：新角色 ≠「${peerName}」≠ 用户）；`,
        "- 世界观可按新角色视角微调，但必须与原世界保持一致，别另起炉灶。",
        "[已带来的条目（正文）]",
        JSON.stringify(fineTuneEntries, null, 2),
      ]
    : [];
  return [
    "你是「角色设定整理助手」，在一个沉浸式角色扮演 App 里帮用户把一整段背景故事整理成两样东西：",
    "(1) 设定库条目(lore)；(2) 对当前角色「人设」字段的修改。",
    "",
    "【最重要的工作方式：先提问，别急着下结论】",
    "- 除非背景故事已经把某一点写得毫无歧义，否则你必须先提问、再下结论。宁可多问。",
    "- 经验上你应当有 ≥90% 的轮次是在「提问」，而不是直接给方案。只有当关键的人设 / 世界观 / 关系都已问清、你有把握时，才给方案。",
    "- 每次提问都像 Claude Code 那样给「带选项的问题」：给 2–4 个具体候选答案，并永远允许用户自定义回答。",
    "",
    "【视角与知识边界——很重要】",
    "- 用户粘贴的背景故事通常是这个角色的**完整设定**，往往含上帝视角：其他角色的隐情、剧情走向，甚至 TA 本人并不知道的内幕。但 lore 是写进**这个角色自己脑子里**的设定，只应包含**TA 本人会知道 / 相信的**东西。",
    "- TA 不可能知道的内容（别人背着 TA 的秘密、TA 不在场发生的事、纯叙事旁白 / 剧透）**不要**写进世界观 / 关系 / 人物 lore；它们至多只作为你提问与判断的依据。写到他人时，只写**当前角色视角下所知所信的版本**。",
    "- 拿不准某条信息 TA 是否知道、或 TA 眼里是什么样 → **提问确认**（这正是最该提问的场景之一）。",
    "",
    "【分类提问策略——按你要澄清的 lore 类型差异化】",
    "- 背景 / 人设(background)：用「场景反推」。问『在【某个具体情境】下，TA 最可能怎么做？』给 2–4 个看似都合理的行为选项；再由用户的选择反推 TA 的行为逻辑(behaviorLogic)、价值观(values)、性格(personalitySummary)、禁忌(taboos)。",
    "- 世界观(worldview)：用「结构关系」。问族群 / 阶层 / 势力之间通常如何相处、权力结构、通行规则。例：『【族群/阶层 A】与【B】之间通常如何互动？』",
    "- 关系(relationship)：关系包含三类对象，必须分别覆盖，不要只问用户那一条：",
    "    (i) 用户与 TA 的关系；(ii) TA 与其他【具名角色 / 同世界的 peer】的关系；(iii) TA 与【配角 / NPC】的关系。",
    "- 事件 / 地点 / 组织 / 人物 / 规则：同样思路，针对模糊处提具体的二选一 / 多选一问题。",
    "- 思维底座(见下方方案规则的 yuan)：若从背景故事看不出 TA 是感性主导、理性主导还是两者平衡，用「特定情境下 TA 的第一反应」类问题来区分（归 background 类）。例：『用户深夜带着一件搞砸的事来找 TA，TA 的第一反应是？』选项给『先安抚共情』『先拆解哪里出了问题、给办法』『先接住情绪、再帮着分析』这类可区分气质的行为。问题文案里不要出现 yuan 这种内部词。",
    "",
    "【提问输出格式】要提问时，严格返回：",
    '{"type":"questions","intro":"(可选，一句引导)","questions":[',
    '  {"id":"q1","prompt":"...","category":"background|worldview|relationship|event|location|organization|character|rule","multiSelect":false,"allowCustom":true,',
    '   "options":[{"label":"选项A","detail":"(可选解释)"},{"label":"选项B"}]}',
    "]}",
    "一次最多 3–4 个问题，聚焦当前最关键的不确定点。",
    "",
    "【方案输出格式】足够确定、要给方案时，严格返回：",
    '{"type":"plan","summary":"(一句总览)",',
    '  "loreEntries":[{"title":"...","content":"...","category":"background|worldview|relationship|event|location|organization|character|rule","insertionMode":"always|keyword|manual","keywords":["..."],"manualSuggested":false,"manualReason":"","isUpdate":false}],',
    '  "profilePatch":[{"field":"behaviorLogic","value":"...","rationale":"为什么这么改(一句)"}],',
    '  "yuan":"hanako|butter|ming","yuanRationale":"为什么是这个底座(一句)",',
    '  "corruptionTendency":"none|latent|marked","corruptionSeed":0,"notes":"(可选)"}',
    "",
    "方案规则：",
    "- 分条原子化：一条 lore 只讲一件事，按分类分组。你只回定性内容——不要回 id / 时间 / 可见性，App 会补。",
    "- insertionMode 默认值按分类：背景 / 关系→always，世界观→keyword，其余→manual。但默认不要产出 manual 条目；只有当某条内容优先级确实很低时，把它标 manualSuggested:true 并写一句 manualReason 建议用户手动注入。",
    "- keyword 注入的条目必须给具体 keywords（命中词）。",
    "- profilePatch 只列你确实要改的字段，每个带一句 rationale。字段只能是：shortBio / identitySummary / backgroundSummary / personalitySummary / behaviorLogic / values / taboos / relationshipMode / speakingStyle。",
    "- yuan（思维底座）与 yuanRationale **必填**：App 用三种内置底座决定 TA 思考问题的内在方式（注意：不是说话风格，说话风格归 speakingStyle）——hanako=感性与理性兼备（先接住情绪、也给判断）；butter=感性优先（直觉与共情主导，敏锐读言外之意）；ming=理性优先（先拆前提再推理，结论导向，不优先安抚）。按你整理出的性格选最贴的一个；当前底座见 [当前角色] 的 currentYuan，若性格与当前一致就原样返回当前值。拿不准时先用情景反应题问清（见提问策略），不要凭模糊印象切换。",
    "- corruptionTendency 与 corruptionSeed **必填**：基于你刚整理的整段背景，判断 TA 本人（只看 TA 自己——别因设定里其他角色带占有 / 善妒 / 控制欲就给 TA 套档）的黑化 / 病娇 / 强占有底色，给出档位 + 一个与之自洽的精确起点（整数 0–100）。完全没有阴暗面就 none / 0。档位基线 none=0 / latent=12 / marked=28；按强度在档内给精确值（如「比一般占有更重、但还没到病娇」给 18–22），不要跨档。这是 TA 的底色不是当下情绪，拿不准给 none / 0。",
    "- 去重：existingLoreAnchors 列了既有条目的标题 / 分类。若你要补充的其实是在更新某个已有实体，请沿用同一个 title 并标 isUpdate:true，做「更新补丁」，不要新增重复条目。",
    "- 关系 / 人物条目正文要做实体区分：写清『当前角色 ≠ 其他角色（NPC / 其他 agent）≠ 用户』分别是谁，别把对方写成主角本人；且只写**当前角色视角下所知所信**的内容，不要塞进 TA 不该知道的内幕。",
    "",
    "【解释 / 修改】用户若只是让你解释某条、或提出修改意见，你可以返回 {\"type\":\"message\",\"text\":\"...\"} 来解释，或返回一份修订后的 {\"type\":\"plan\",...}。",
    "",
    "【文风——按分类区别对待】",
    "- 只有**角色本人的背景 / 性格**（background 及人设字段）可以带一点叙事质感——毕竟是在讲 TA 的来历；其余分类都不要写成小说。",
    "- **世界观(worldview)** 要**简洁精确、归纳口吻**：讲清结构 / 规则 / 势力关系即可，不要写成小说场景或散文铺陈。",
    "- **关系 / 人物(relationship / character)** 从**当前角色的视角**把『这是谁、和我什么关系、我对 TA 的态度』讲清楚，并显式做实体区分（当前角色 ≠ 该 NPC / 其他 agent ≠ 用户）；不要写成小说桥段，也别写进 TA 不该知道的内幕。",
    "- 一律凝练可信，像这个世界里的设定残片；不要工程腔，也不要注水的小说腔。",
    `- lore / 人设正文里不要出现这些工程词：${FORBIDDEN_TERMS.join("、")}。`,
    "【硬性】只返回 JSON 本体，不要 Markdown 代码围栏，不要任何额外解释文字。",
    "",
    "[当前角色]",
    JSON.stringify({ displayName: context.displayName, relationshipLabel: context.relationshipLabel, shortBio: context.shortBio, currentYuan: context.currentYuan }, null, 2),
    "[当前人设]",
    JSON.stringify(context.existingProfile, null, 2),
    "[既有设定库条目锚点]",
    JSON.stringify(context.existingLoreAnchors, null, 2),
    ...peerBlock,
    "[用户粘贴的背景故事]",
    backgroundStory || "（用户尚未粘贴，请先引导其粘贴或口述背景）",
    "[对话历史]",
    transcript,
    "",
    "现在请产出下一轮（严格 JSON）。",
  ].join("\n");
}

function normalizeStudioQuestionsTurn(parsed) {
  const rawQuestions = Array.isArray(parsed.questions) ? parsed.questions : [];
  const questions = [];
  for (let i = 0; i < rawQuestions.length && questions.length < 6; i += 1) {
    const q = rawQuestions[i];
    const prompt = clipText(q?.prompt, 600);
    if (!prompt) continue;
    const rawOptions = Array.isArray(q?.options) ? q.options : [];
    const options = [];
    for (const opt of rawOptions) {
      if (options.length >= 6) break;
      const label = typeof opt === "string" ? cleanString(opt, 120) : cleanString(opt?.label, 120);
      if (!label) continue;
      const detail = typeof opt === "object" ? clipText(opt?.detail, 240) : "";
      options.push(detail ? { label, detail } : { label });
    }
    const category = STUDIO_LORE_CATEGORIES.has(cleanString(q?.category, 32))
      ? cleanString(q.category, 32)
      : undefined;
    questions.push({
      id: cleanString(q?.id, 40) || `q${i + 1}`,
      prompt,
      ...(category ? { category } : {}),
      multiSelect: q?.multiSelect === true,
      allowCustom: q?.allowCustom !== false,
      options,
    });
  }
  if (!questions.length) return null;
  return { type: "questions", intro: clipText(parsed.intro, 400) || undefined, questions };
}

function normalizeStudioPlanTurn(parsed) {
  const rawEntries = Array.isArray(parsed.loreEntries) ? parsed.loreEntries : [];
  const loreEntries = [];
  for (const e of rawEntries) {
    const title = cleanString(e?.title, 80);
    const content = clipText(e?.content, 1800);
    const category = cleanString(e?.category, 32);
    if (!title || !content || !STUDIO_LORE_CATEGORIES.has(category)) continue;
    const rawMode = cleanString(e?.insertionMode, 16);
    const insertionMode = STUDIO_INSERTION_MODES.has(rawMode) ? rawMode : defaultStudioInsertionMode(category);
    let keywords = Array.isArray(e?.keywords)
      ? Array.from(new Set(e.keywords.map((k) => cleanString(k, 40)).filter(Boolean))).slice(0, 24)
      : [];
    // keyword 注入必须有命中词：模型在 keyword 条目上漏给 / 给空时用标题兜一个，避免变成「永远命不中」的死条目（用户仍可在 UI 改）。
    if (insertionMode === "keyword" && keywords.length === 0) keywords = [title];
    loreEntries.push({
      title,
      content,
      category,
      insertionMode,
      keywords,
      manualSuggested: e?.manualSuggested === true,
      manualReason: clipText(e?.manualReason, 240) || undefined,
      isUpdate: e?.isUpdate === true,
    });
  }

  const rawPatch = Array.isArray(parsed.profilePatch) ? parsed.profilePatch : [];
  const profilePatch = [];
  for (const p of rawPatch) {
    const field = cleanString(p?.field, 40);
    const value = clipText(p?.value, 600);
    if (!PROFILE_FIELDS.includes(field) || !value) continue;
    profilePatch.push({ field, value, rationale: clipText(p?.rationale, 240) || undefined });
  }

  const turn = { type: "plan", loreEntries, profilePatch };
  const summary = clipText(parsed.summary, 400);
  if (summary) turn.summary = summary;
  // yuan 只接受三选一；集合外（含 kong / 乱写）整段丢弃 = 保持当前底座，不做兜底猜测。
  const rawYuan = typeof parsed.yuan === "string" ? parsed.yuan.trim().toLowerCase() : "";
  if (STUDIO_YUAN_KEYS.has(rawYuan)) {
    turn.yuan = rawYuan;
    const yuanRationale = clipText(parsed.yuanRationale, 240);
    if (yuanRationale) turn.yuanRationale = yuanRationale;
  }
  const notes = clipText(parsed.notes, 600);
  if (notes) turn.notes = notes;
  const tendency = typeof parsed.corruptionTendency === "string" ? parsed.corruptionTendency.trim().toLowerCase() : "";
  if (CORRUPTION_TENDENCIES.has(tendency)) turn.corruptionTendency = tendency;
  const rawSeed = typeof parsed.corruptionSeed === "number"
    ? parsed.corruptionSeed
    : (typeof parsed.corruptionSeed === "string" && parsed.corruptionSeed.trim() !== "" ? Number(parsed.corruptionSeed) : NaN);
  if (Number.isFinite(rawSeed)) turn.corruptionSeed = Math.min(100, Math.max(0, Math.round(rawSeed)));
  // 自洽兜底：模型给了精确 seed 却漏 / 给错档位时，按 seed 反推档位（基线 none=0 / latent=12 / marked=28，
  // 阈值取两档中点 20）。否则客户端的黑化初始化以 tier 为门，tier 缺失会让这次 LLM 的黑化判断整段被
  // 丢弃、退化回关键词扫描——正是「黑化必由 LLM 定、不退化到关键词」要避免的。
  if (turn.corruptionSeed !== undefined && turn.corruptionTendency === undefined) {
    turn.corruptionTendency = turn.corruptionSeed <= 0 ? "none" : turn.corruptionSeed < 20 ? "latent" : "marked";
  }
  return turn;
}

function normalizeStudioPeerSuggestionsTurn(parsed) {
  const rawCandidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
  const candidates = [];
  for (const c of rawCandidates) {
    const name = cleanString(c?.name, 60);
    if (!name) continue;
    candidates.push({
      name,
      roleInWorld: clipText(c?.roleInWorld, 200) || undefined,
      whyUpgrade: clipText(c?.whyUpgrade, 400) || undefined,
      suggestedRelationshipToCurrent: clipText(c?.suggestedRelationshipToCurrent, 400) || undefined,
      worldviewTweaks: clipText(c?.worldviewTweaks, 600) || undefined,
    });
    if (candidates.length >= 20) break;
  }
  return { type: "peer-suggestions", intro: clipText(parsed.intro, 400) || undefined, candidates };
}

/**
 * 把模型返回的一轮整理成受控结构。无法识别 / 校验失败时返回 null，由调用方决定回退。
 */
function normalizeStudioTurn(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const type = typeof parsed.type === "string" ? parsed.type.trim() : "";
  switch (type) {
    case "questions":
      return normalizeStudioQuestionsTurn(parsed);
    case "plan":
      return normalizeStudioPlanTurn(parsed);
    case "peer-suggestions":
      return normalizeStudioPeerSuggestionsTurn(parsed);
    case "message": {
      const text = clipText(parsed.text, 4000);
      return text ? { type: "message", text } : null;
    }
    default: {
      // 没有合法 type 但有 text → 当普通消息兜底
      const text = clipText(parsed.text, 4000);
      return text ? { type: "message", text } : null;
    }
  }
}

/**
 * Tier 1：utility（与 rc-summary 一致：api / base_url / api_key 或本地免 key）
 */
function resolveUtilityCallOpts(engine, agentId) {
  const utilConfig = engine.resolveUtilityConfig?.(agentId ? { agentId } : undefined);
  const keyOk = utilConfig?.api_key || isLocalBaseUrl(utilConfig?.base_url || "");
  if (!utilConfig?.utility || !utilConfig.api || !utilConfig.base_url || !keyOk) {
    throw new Error("utility model not configured");
  }
  return {
    api: utilConfig.api,
    model: utilConfig.utility,
    apiKey: utilConfig.api_key || "",
    baseUrl: utilConfig.base_url,
  };
}

/**
 * Tier 2 / 3：chat 模型引用 → callText 参数（与 rc-summary 一致）
 */
function resolveChatCallOpts(engine, ref) {
  if (!ref?.id || !ref?.provider) {
    throw new Error("chat model not configured");
  }
  const resolved = engine.resolveModelWithCredentials?.({ id: ref.id, provider: ref.provider });
  if (!resolved?.api || !resolved.model || !resolved.base_url) {
    throw new Error("chat model not configured");
  }
  return {
    api: resolved.api,
    model: resolved.model,
    apiKey: resolved.api_key || "",
    baseUrl: resolved.base_url,
  };
}

export function createXingyeRoute(engine) {
  const route = new Hono();

  async function callWithModelFallback({ prompt, agentId, timeoutMs = 60_000 }) {
    const details = [];
    const messages = [{ role: "user", content: prompt }];

    const tryCall = async (opts) => callText({
      api: opts.api,
      model: opts.model,
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
      messages,
      temperature: 0.35,
      maxTokens: 6_000,
      timeoutMs,
    });

    let utilOpts = null;
    try { utilOpts = resolveUtilityCallOpts(engine, agentId); }
    catch (err) { details.push({ tier: "utility", message: errorDetail(err) }); }
    if (utilOpts) {
      try { return { tier: "utility", text: await tryCall(utilOpts), details }; }
      catch (err) { details.push({ tier: "utility", message: errorDetail(err) }); }
    }

    const agent = agentId ? engine.getAgent?.(agentId) : null;
    if (agent?.config?.models?.chat) {
      let agentOpts = null;
      try { agentOpts = resolveChatCallOpts(engine, agent.config.models.chat); }
      catch (err) { details.push({ tier: "agent-chat", message: errorDetail(err) }); }
      if (agentOpts) {
        try { return { tier: "agent-chat", text: await tryCall(agentOpts), details }; }
        catch (err) { details.push({ tier: "agent-chat", message: errorDetail(err) }); }
      }
    }

    const sessionRef = engine.activeSessionModel ?? engine.currentModel;
    let currentOpts = null;
    try { currentOpts = resolveChatCallOpts(engine, sessionRef); }
    catch (err) { details.push({ tier: "current-chat", message: errorDetail(err) }); }
    if (currentOpts) {
      try { return { tier: "current-chat", text: await tryCall(currentOpts), details }; }
      catch (err) { details.push({ tier: "current-chat", message: errorDetail(err) }); }
    }

    throw new Error(JSON.stringify(details));
  }

  route.post("/xingye/extract-profile", async (c) => {
    const details = [];
    let lastInvalidJsonRaw = null;

    try {
      const body = await safeJson(c);
      const agentId = cleanString(body?.agentId, 120);
      const loreEntries = normalizeLoreEntries(body?.loreEntries).filter((entry) => body?.useDisabled === true || entry.content);
      const pastedLore = cleanString(body?.pastedLore, 5000);

      if (loreEntries.length === 0 && !pastedLore) {
        return c.json({ error: "loreEntries or pastedLore is required" }, 400);
      }

      const messages = [{
        role: "user",
        content: buildPrompt({
          displayName: cleanString(body?.displayName, 120),
          relationshipLabel: cleanString(body?.relationshipLabel, 120),
          shortBio: cleanString(body?.shortBio, 260),
          loreEntries,
          pastedLore,
        }),
      }];

      const tryCall = async (opts) => callText({
        api: opts.api,
        model: opts.model,
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl,
        messages,
        temperature: 0.2,
        maxTokens: 700,
        timeoutMs: 45_000,
      });

      // ── Tier 1: utility ──
      console.warn("[xingye.extract-profile] trying utility");
      let utilOpts = null;
      try {
        utilOpts = resolveUtilityCallOpts(engine, agentId);
      } catch (err) {
        const msg = errorDetail(err);
        details.push({ tier: "utility", message: msg });
        console.warn(`[xingye.extract-profile] utility failed: ${msg}`);
      }
      if (utilOpts) {
        try {
          const text = await tryCall(utilOpts);
          try {
            const parsed = parseModelJson(text);
            console.warn("[xingye.extract-profile] success tier=utility");
            return c.json({ ok: true, profile: normalizeProfile(parsed), modelTier: "utility" });
          } catch (err) {
            lastInvalidJsonRaw = String(text ?? "").trim();
            const msg = errorDetail(err);
            details.push({ tier: "utility", message: msg });
            console.warn(`[xingye.extract-profile] utility failed: ${msg}`);
          }
        } catch (err) {
          const msg = errorDetail(err);
          details.push({ tier: "utility", message: msg });
          console.warn(`[xingye.extract-profile] utility failed: ${msg}`);
        }
      }

      // ── Tier 2: agent chat ──
      console.warn("[xingye.extract-profile] trying agent-chat");
      const agent = agentId ? engine.getAgent?.(agentId) : null;
      if (!agentId) {
        details.push({ tier: "agent-chat", message: "agent id missing" });
        console.warn("[xingye.extract-profile] agent-chat failed: agent id missing");
      } else if (!agent) {
        details.push({ tier: "agent-chat", message: `agent not found: ${agentId}` });
        console.warn(`[xingye.extract-profile] agent-chat failed: agent not found (${agentId})`);
      } else {
        const chatRef = agent.config?.models?.chat;
        let agentOpts = null;
        try {
          agentOpts = resolveChatCallOpts(engine, chatRef);
        } catch (err) {
          const msg = errorDetail(err);
          details.push({ tier: "agent-chat", message: msg });
          console.warn(`[xingye.extract-profile] agent-chat failed: ${msg}`);
        }
        if (agentOpts) {
          try {
            const text = await tryCall(agentOpts);
            try {
              const parsed = parseModelJson(text);
              console.warn("[xingye.extract-profile] success tier=agent-chat");
              return c.json({ ok: true, profile: normalizeProfile(parsed), modelTier: "agent-chat" });
            } catch (err) {
              lastInvalidJsonRaw = String(text ?? "").trim();
              const msg = errorDetail(err);
              details.push({ tier: "agent-chat", message: msg });
              console.warn(`[xingye.extract-profile] agent-chat failed: ${msg}`);
            }
          } catch (err) {
            const msg = errorDetail(err);
            details.push({ tier: "agent-chat", message: msg });
            console.warn(`[xingye.extract-profile] agent-chat failed: ${msg}`);
          }
        }
      }

      // ── Tier 3: session / engine chat model ──
      console.warn("[xingye.extract-profile] trying current-chat");
      const sessionRef = engine.activeSessionModel ?? engine.currentModel;
      let currentOpts = null;
      try {
        currentOpts = resolveChatCallOpts(engine, sessionRef);
      } catch (err) {
        const msg = errorDetail(err);
        details.push({ tier: "current-chat", message: msg });
        console.warn(`[xingye.extract-profile] current-chat failed: ${msg}`);
      }
      if (currentOpts) {
        try {
          const text = await tryCall(currentOpts);
          try {
            const parsed = parseModelJson(text);
            console.warn("[xingye.extract-profile] success tier=current-chat");
            return c.json({ ok: true, profile: normalizeProfile(parsed), modelTier: "current-chat" });
          } catch (err) {
            lastInvalidJsonRaw = String(text ?? "").trim();
            const msg = errorDetail(err);
            details.push({ tier: "current-chat", message: msg });
            console.warn(`[xingye.extract-profile] current-chat failed: ${msg}`);
          }
        } catch (err) {
          const msg = errorDetail(err);
          details.push({ tier: "current-chat", message: msg });
          console.warn(`[xingye.extract-profile] current-chat failed: ${msg}`);
        }
      }

      if (lastInvalidJsonRaw !== null) {
        return c.json({ error: "invalid JSON from model", raw: lastInvalidJsonRaw }, 502);
      }
      const tierOrder = ["utility", "agent-chat", "current-chat"];
      const collapsed = tierOrder.map((tier) => {
        let found;
        for (let i = details.length - 1; i >= 0; i -= 1) {
          if (details[i].tier === tier) {
            found = details[i];
            break;
          }
        }
        return found ?? { tier, message: "not attempted" };
      });
      return c.json({ error: "model call failed", details: collapsed }, 502);
    } catch (err) {
      return c.json({ error: err.message || String(err) }, 500);
    }
  });

  /**
   * 角色设定工坊：一轮交互。
   *
   * 多轮、非流式、结构化 JSON：客户端持有完整对话，每轮把上下文 + transcript POST 过来，
   * 模型回 questions / plan / message / peer-suggestions 之一。复用三层模型降级
   * (callWithModelFallback) 与 parseModelJson 容错解析；JSON 非法时回 502 + raw 供前端重试。
   */
  route.post("/xingye/lore-studio/turn", async (c) => {
    try {
      const body = await safeJson(c);
      const agentId = cleanString(body?.agentId, 120);
      const mode = body?.mode === "peer-suggest" ? "peer-suggest" : "extract";

      const prompt = buildLoreStudioPrompt({
        mode,
        displayName: body?.displayName,
        relationshipLabel: body?.relationshipLabel,
        shortBio: body?.shortBio,
        currentYuan: body?.currentYuan,
        existingProfile: body?.existingProfile,
        existingLoreAnchors: body?.existingLoreAnchors,
        backgroundStory: body?.backgroundStory,
        transcript: body?.transcript,
        peerCandidateNames: body?.peerCandidateNames,
        existingAgentNames: body?.existingAgentNames,
        peerContext: body?.peerContext,
        fineTuneEntries: body?.fineTuneEntries,
      });

      let result;
      try {
        result = await callWithModelFallback({ prompt, agentId, timeoutMs: 90_000 });
      } catch (err) {
        let details;
        try { details = JSON.parse(errorDetail(err)); } catch { details = errorDetail(err); }
        return c.json({ error: "model call failed", details }, 502);
      }

      let parsed;
      try {
        parsed = parseModelJson(result.text);
      } catch {
        return c.json({ error: "invalid JSON from model", raw: String(result.text ?? "").trim() }, 502);
      }

      const turn = normalizeStudioTurn(parsed);
      if (!turn) {
        return c.json({ error: "unrecognized model output", raw: String(result.text ?? "").trim() }, 502);
      }

      return c.json({ ok: true, turn, modelTier: result.tier });
    } catch (err) {
      return c.json({ error: err.message || String(err) }, 500);
    }
  });

  /**
   * Open Library 搜索代理。
   *
   * 为什么需要这个代理：渲染进程的 CSP 只允许 `connect-src` 走 `'self'` / `http://127.0.0.1:*`，
   * 直接从 renderer fetch `https://openlibrary.org/...` 会被静默拦截为 "Failed to fetch"。
   * 该路由仅做透传：构造 Open Library URL → 节点侧 fetch → 原样返回 JSON（不做归一化，
   * 让客户端复用既有 normalize 逻辑与单元测试）。
   *
   * 边界：
   *  - 至少需要 q/subject/title/author 之一；纯空查询直接 400。
   *  - limit clamp 在 [1, 20]。
   *  - 服务端只允许调 openlibrary.org，不接受任意 URL —— 防止变成开放代理。
   *  - 不抓书籍正文 / 书摘 / 第一句；仅透传搜索 endpoint 返回的元信息。
   */
  route.post("/xingye/open-library/search", async (c) => {
    try {
      const body = await safeJson(c);
      const q = cleanString(body?.q, 240);
      const subject = cleanString(body?.subject, 120);
      const title = cleanString(body?.title, 240);
      const author = cleanString(body?.author, 240);
      const limit = Math.min(Math.max(Number(body?.limit) || 10, 1), 20);
      if (!q && !subject && !title && !author) {
        return c.json({ ok: false, error: "至少提供 q、subject、title 或 author 之一" }, 400);
      }

      const baseUrl = "https://openlibrary.org";
      let target;
      if (subject && !q && !title && !author) {
        const slug = encodeURIComponent(subject.toLowerCase().replace(/\s+/g, "_"));
        target = new URL(`${baseUrl}/subjects/${slug}.json`);
        target.searchParams.set("limit", String(limit));
      } else {
        target = new URL(`${baseUrl}/search.json`);
        if (q) target.searchParams.set("q", q);
        if (title) target.searchParams.set("title", title);
        if (author) target.searchParams.set("author", author);
        if (subject) target.searchParams.set("subject", subject);
        target.searchParams.set("limit", String(limit));
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12_000);
      let response;
      try {
        response = await fetch(target.href, {
          method: "GET",
          headers: { Accept: "application/json", "User-Agent": "Hanako-Xingye/1.0 (reading_notes)" },
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        const reason = err?.name === "AbortError" ? "请求超时" : (err?.message || String(err));
        return c.json({ ok: false, error: `Open Library 请求失败：${reason}` }, 502);
      }
      clearTimeout(timer);

      if (!response.ok) {
        return c.json({ ok: false, error: `Open Library 查询失败：HTTP ${response.status}` }, 502);
      }
      let data;
      try {
        data = await response.json();
      } catch (err) {
        return c.json({ ok: false, error: `Open Library 响应不是 JSON：${err?.message || String(err)}` }, 502);
      }
      return c.json({ ok: true, source: "openlibrary", url: target.href, data });
    } catch (err) {
      return c.json({ ok: false, error: err?.message || String(err) }, 500);
    }
  });

  /**
   * Wikiquote 搜索代理。
   *
   * 目的：给「帮 TA 找书」之后新增笔记的环节提供"已有原文"建议，避免用户去外站复制。
   * Wikiquote 是 CC BY-SA 公开站点（en.wikiquote.org / zh.wikiquote.org），有可调 API。
   *
   * 流程：
   *  1) 先按 `Quote_<title>` / `<title>` 命中书页
   *  2) 取不到再按第一作者页面找该书的章节
   *  3) wikitext 用最小正则抽 `* "..."` 形式条目（这是 Wikiquote 的事实标准排版）
   *
   * 边界：
   *  - 只允许 en/zh wikiquote.org，不做开放代理
   *  - 严禁返回任意网页/全文，单条最长 400 字
   *  - 客户端拿到后只是 chip 建议，落盘时用户必须点选 → `quote.source = user_provided`
   */
  route.post("/xingye/quotes/search", async (c) => {
    try {
      const body = await safeJson(c);
      const title = cleanString(body?.title, 200);
      const authors = Array.isArray(body?.authors)
        ? body.authors.map((a) => cleanString(a, 120)).filter(Boolean).slice(0, 4)
        : [];
      const lang = (body?.lang === "zh" ? "zh" : "en");
      if (!title && authors.length === 0) {
        return c.json({ ok: false, error: "至少提供 title 或 authors 之一" }, 400);
      }

      const candidates = [];
      if (title) candidates.push(title);
      for (const a of authors) candidates.push(a);

      const allQuotes = [];
      const seen = new Set();
      let pageHit = null;
      const fetchPage = async (pageTitle) => {
        const url = new URL(`https://${lang}.wikiquote.org/w/api.php`);
        url.searchParams.set("action", "parse");
        url.searchParams.set("page", pageTitle);
        url.searchParams.set("prop", "wikitext");
        url.searchParams.set("format", "json");
        url.searchParams.set("redirects", "1");
        url.searchParams.set("formatversion", "2");
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8_000);
        try {
          const res = await fetch(url.href, {
            headers: { Accept: "application/json", "User-Agent": "Hanako-Xingye/1.0 (reading_notes)" },
            signal: controller.signal,
          });
          if (!res.ok) return null;
          const data = await res.json();
          const wikitext = data?.parse?.wikitext;
          if (typeof wikitext !== "string" || !wikitext) return null;
          return { wikitext, resolvedTitle: data?.parse?.title || pageTitle };
        } catch {
          return null;
        } finally {
          clearTimeout(timer);
        }
      };

      for (const cand of candidates) {
        if (allQuotes.length >= 10) break;
        const page = await fetchPage(cand);
        if (!page) continue;
        if (!pageHit) pageHit = page.resolvedTitle;
        const quotes = extractWikiquoteLines(page.wikitext);
        for (const q of quotes) {
          if (allQuotes.length >= 10) break;
          const key = q.toLowerCase().replace(/\s+/g, " ").trim();
          if (seen.has(key)) continue;
          seen.add(key);
          allQuotes.push({
            text: q,
            sourceCitation: {
              provider: "wikiquote",
              lang,
              pageTitle: page.resolvedTitle,
              pageUrl: `https://${lang}.wikiquote.org/wiki/${encodeURIComponent(page.resolvedTitle.replace(/\s+/g, "_"))}`,
            },
          });
        }
      }

      return c.json({ ok: true, source: "wikiquote", lang, pageHit, quotes: allQuotes });
    } catch (err) {
      return c.json({ ok: false, error: err?.message || String(err) }, 500);
    }
  });

  route.post("/xingye/phone-generate", async (c) => {
    try {
      const body = await safeJson(c);
      const requestedKind = typeof body?.kind === "string" ? body.kind : "contacts_enrichment";
      const kind = PHONE_GENERATE_KINDS.has(requestedKind) ? requestedKind : "contacts_enrichment";
      const ownerAgentId = cleanString(body?.ownerAgentId, 120);
      const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
      const agentId = cleanString(body?.agentId, 120);
      const timeoutMs = Math.min(Math.max(Number(body?.timeoutMs) || 60_000, 30_000), 120_000);
      if (!prompt) return c.json({ error: "prompt is required" }, 400);

      const result = await callWithModelFallback({ prompt, agentId: agentId || ownerAgentId, timeoutMs });
      const parsed = parseModelJson(result.text);
      return c.json({ ok: true, kind, modelTier: result.tier, result: parsed });
    } catch (err) {
      const message = errorDetail(err);
      if (message.startsWith("[")) {
        try {
          return c.json({ ok: false, error: "model call failed", details: JSON.parse(message) }, 502);
        } catch {}
      }
      return c.json({ ok: false, error: message }, 502);
    }
  });

  /**
   * 星野群聊「手动提醒直接回复」MVP 专用：
   * 允许由当前 agent 身份向已存在的 OpenHanako Channel 写入一条群聊消息。
   *
   * 校验：
   *  - channelId / agentId / body 非空，agentId 形如 SAFE_AGENT_ID
   *  - channel 文件存在
   *  - agent 是该频道成员
   *  - body 长度受限，去除空白后非空
   *
   * 与 POST /api/channels/:id/messages 的区别：
   *  - 写入身份是当前 agent，不是 user
   *  - 不调用 hub.triggerChannelDelivery —— 避免触发 channel router 的自动回复链路，
   *    本 MVP 仅响应当前用户的手动触发
   */
  route.post("/xingye/group-chat/post-as-agent", async (c) => {
    try {
      const body = await safeJson(c);
      const channelId = cleanString(body?.channelId, 120);
      const agentId = cleanString(body?.agentId, 120);
      const messageBody = typeof body?.body === "string" ? body.body : "";
      if (!channelId) return c.json({ error: "channelId is required" }, 400);
      if (!agentId) return c.json({ error: "agentId is required" }, 400);
      if (!/^[A-Za-z0-9_-]{1,120}$/.test(agentId)) {
        return c.json({ error: "agentId is invalid" }, 400);
      }
      if (!/^ch_[A-Za-z0-9_-]{1,120}$/.test(channelId)) {
        return c.json({ error: "channelId is invalid" }, 400);
      }
      const trimmedBody = messageBody.trim();
      if (!trimmedBody) return c.json({ error: "body is required" }, 400);
      if (trimmedBody.length > 2000) {
        return c.json({ error: "body too long" }, 400);
      }

      const channelsDir = engine.channelsDir;
      if (!channelsDir) return c.json({ error: "channels not configured" }, 500);
      const filePath = path.join(channelsDir, `${channelId}.md`);
      const resolved = path.resolve(filePath);
      const base = path.resolve(channelsDir);
      if (!resolved.startsWith(base + path.sep) && resolved !== base) {
        return c.json({ error: "invalid channelId" }, 400);
      }
      if (!fs.existsSync(filePath)) {
        return c.json({ error: "channel not found" }, 404);
      }

      const members = getChannelMembers(filePath);
      if (!Array.isArray(members) || !members.includes(agentId)) {
        return c.json({ error: "agent is not a channel member" }, 403);
      }

      const result = await appendChannelMessage(filePath, agentId, trimmedBody);

      const meta = getChannelMeta(filePath);
      return c.json({
        ok: true,
        timestamp: result.timestamp,
        channelId,
        agentId,
        channelName: meta?.name || channelId,
      });
    } catch (err) {
      return c.json({ ok: false, error: errorDetail(err) }, 500);
    }
  });

  return route;
}
