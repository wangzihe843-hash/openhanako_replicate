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
