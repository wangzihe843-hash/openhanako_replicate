import fs from "fs";
import path from "path";
import { Hono } from "hono";
import { safeJson } from "../hono-helpers.js";
import { callText } from "../../core/llm-client.js";
import { isLocalBaseUrl } from "../../shared/net-utils.js";
import {
  appendMessage as appendChannelMessage,
  getChannelMembers,
  getChannelMeta,
} from "../../lib/channels/channel-store.js";

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

const ALLOWED_LORE_CATEGORIES = new Set([
  "background",
  "worldview",
  "relationship",
  "event",
  "character",
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
  "mm_chat",
  "divination_reading",
  "moments",
  "reading_topics",
  "reading_annotation",
  "shopping_draft",
  "shopping_polish",
  "secondhand_draft",
  "secondhand_polish",
  "secondhand_buyer_chat",
  "accounting_draft",
  "news_draft",
  "news_comment",
  "news_historical_draft",
  "news_timeline_extract",
  "secret_interview_draft",
  "health_day",
  "files_secret_seed",
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
    `- 不要输出这些工程词：${FORBIDDEN_TERMS.join("、")}。`,
    "",
    "返回 JSON schema：",
    JSON.stringify(Object.fromEntries(PROFILE_FIELDS.map((field) => [field, "string"])), null, 2),
    "",
    "输入：",
    JSON.stringify(context, null, 2),
  ].join("\n");
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
