import { Hono } from "hono";
import { safeJson } from "../hono-helpers.js";
import { callText } from "../../core/llm-client.js";
import { isLocalBaseUrl } from "../../shared/net-utils.js";

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

  return route;
}
