/**
 * ChannelRouter — 频道调度（从 engine.js 搬出）
 *
 * 频道 = 内部 Channel，和 Telegram/飞书一样通过 Hub 路由。
 * 包装 channel-ticker（不改 ticker，只提供回调）。
 *
 * 搬出的方法：
 *   _getChannelAgentOrder  → getAgentOrder()
 *   _executeChannelCheck   → _executeCheck()
 *   _executeChannelReply   → _executeReply()
 *   _channelMemorySummarize → _memorySummarize()
 *   _setupChannelPostHandler → setupPostHandler()
 *   toggleChannels          → toggle()
 */

import fs from "fs";
import path from "path";
import { createChannelTicker } from "../lib/channels/channel-ticker.js";
import { Type } from "../lib/pi-sdk/index.js";
import { appendMessage, formatMessagesForLLM, getChannelMeta, getRecentMessages } from "../lib/channels/channel-store.js";
import { loadConfig } from "../lib/memory/config-loader.js";
import { callText } from "../core/llm-client.js";
import { runAgentPhoneSession } from "./agent-executor.js";
import { debugLog } from "../lib/debug-log.js";
import { getLocale } from "../server/i18n.js";
import {
  getAgentPhoneProjectionPath,
  readAgentPhoneProjection,
  recordAgentPhoneActivity,
} from "../lib/conversations/agent-phone-projection.js";
import { normalizeAgentPhoneToolMode } from "../lib/conversations/agent-phone-session.js";
import {
  DEFAULT_AGENT_PHONE_SETTINGS,
  formatAgentPhonePromptGuidance,
  normalizeAgentPhoneModelOverride,
  positiveIntegerOrDefault,
  positiveIntegerOrNull,
} from "../lib/conversations/agent-phone-prompt.js";

export class ChannelRouter {
  /**
   * @param {object} opts
   * @param {import('./index.js').Hub} opts.hub
   */
  static _AGENT_ORDER_TTL = 30_000; // 30 秒

  constructor({ hub }) {
    this._hub = hub;
    this._ticker = null;
    this._agentOrderCache = null; // { list: string[], ts: number }
  }

  /** @returns {import('../core/engine.js').HanaEngine} */
  get _engine() { return this._hub.engine; }

  _getAgentInstance(agentId) {
    return this._engine.getAgent?.(agentId)
      || this._engine.agents?.get?.(agentId)
      || null;
  }

  _resolveMemoryMasterEnabled(agentId, { agentInstance = null, cfg = null } = {}) {
    if (agentInstance) return agentInstance.memoryMasterEnabled !== false;
    const resolvedCfg = cfg || loadConfig(path.join(this._engine.agentsDir, agentId, "config.yaml"));
    return resolvedCfg?.memory?.enabled !== false;
  }

  async _recordPhoneActivity(agentId, channelName, state, summary, details = {}) {
    try {
      const agent = this._getAgentInstance(agentId);
      const agentDir = agent?.agentDir || path.join(this._engine.agentsDir, agentId);
      const activity = {
        conversationId: channelName,
        conversationType: "channel",
        agentId,
        state,
        summary,
        details,
      };
      this._hub.agentPhoneActivities?.record?.(activity);
      await recordAgentPhoneActivity({
        agentDir,
        ...activity,
      });
    } catch (err) {
      debugLog()?.warn?.("channel", `phone activity record failed (${agentId}/#${channelName}): ${err.message}`);
    }
  }

  _resolvePhoneToolMode(channelName) {
    try {
      const filePath = path.join(this._engine.channelsDir, `${channelName}.md`);
      if (!fs.existsSync(filePath)) return "read_only";
      return normalizeAgentPhoneToolMode(getChannelMeta(filePath).agentPhoneToolMode);
    } catch {
      return "read_only";
    }
  }

  _resolveChannelPhoneSettings(channelName) {
    try {
      const filePath = path.join(this._engine.channelsDir, `${channelName}.md`);
      if (!fs.existsSync(filePath)) {
        return DEFAULT_AGENT_PHONE_SETTINGS;
      }
      const meta = getChannelMeta(filePath);
      const override = normalizeAgentPhoneModelOverride({
        enabled: meta.agentPhoneModelOverrideEnabled,
        id: meta.agentPhoneModelOverrideId,
        provider: meta.agentPhoneModelOverrideProvider,
      });
      return {
        toolMode: normalizeAgentPhoneToolMode(meta.agentPhoneToolMode),
        replyMinChars: positiveIntegerOrNull(meta.agentPhoneReplyMinChars),
        replyMaxChars: positiveIntegerOrNull(meta.agentPhoneReplyMaxChars),
        reminderIntervalMinutes: positiveIntegerOrDefault(
          meta.agentPhoneReminderIntervalMinutes,
          DEFAULT_AGENT_PHONE_SETTINGS.reminderIntervalMinutes,
        ),
        modelOverrideEnabled: override.enabled,
        modelOverrideModel: override.model,
      };
    } catch {
      return DEFAULT_AGENT_PHONE_SETTINGS;
    }
  }

  _formatPhonePromptGuidance(agentId, settings, isZh) {
    return formatAgentPhonePromptGuidance({
      agentId,
      agent: this._getAgentInstance(agentId),
      agentsDir: this._engine.agentsDir,
      settings,
      isZh,
      zhConversationName: "群聊",
      enConversationName: "channel",
    });
  }

  _resolvePhoneSessionPath(agentId, channelName) {
    try {
      const agent = this._getAgentInstance(agentId);
      const agentDir = agent?.agentDir || path.join(this._engine.agentsDir, agentId);
      const projection = readAgentPhoneProjection(getAgentPhoneProjectionPath(agentDir, channelName));
      const stored = projection.meta.phoneSessionFile;
      if (!stored || typeof stored !== "string") return null;
      const resolved = path.resolve(agentDir, ...stored.split("/").filter(Boolean));
      const base = path.resolve(agentDir);
      if (!resolved.startsWith(base + path.sep) && resolved !== base) return null;
      return resolved;
    } catch {
      return null;
    }
  }

  _createChannelPhoneTools(agentId, channelName, { setDecision } = {}) {
    const engine = this._engine;
    const isZh = getLocale().startsWith("zh");
    const channelFile = path.join(engine.channelsDir || "", `${channelName}.md`);
    let decided = false;

    const markDecision = (decision) => {
      if (decided) return false;
      decided = true;
      setDecision?.(decision);
      return true;
    };

    return [
      {
        name: "channel_read_context",
        label: isZh ? "读取频道上下文" : "Read channel context",
        description: isZh
          ? "读取当前手机群聊频道的最近消息。数据源是频道聊天记录 Truth，不是你的 phone session。"
          : "Read recent messages from the current phone channel. The source is the channel transcript Truth, not your phone session.",
        parameters: Type.Object({
          count: Type.Optional(Type.Number({
            description: isZh ? "要读取的最近消息数量，默认 20，最多 50。" : "Number of recent messages to read, defaults to 20, max 50.",
          })),
        }),
        execute: async (_toolCallId, params = {}) => {
          if (!fs.existsSync(channelFile)) {
            return {
              content: [{ type: "text", text: isZh ? "频道不存在。" : "Channel not found." }],
              details: { action: "read_context", error: "channel not found" },
            };
          }
          const count = Math.max(1, Math.min(50, Number(params.count) || 20));
          const messages = getRecentMessages(channelFile, count);
          return {
            content: [{
              type: "text",
              text: messages.length > 0 ? formatMessagesForLLM(messages) : (isZh ? "频道暂无消息。" : "No channel messages."),
            }],
            details: { action: "read_context", channel: channelName, messageCount: messages.length },
          };
        },
      },
      {
        name: "channel_reply",
        label: isZh ? "发送频道消息" : "Send channel message",
        description: isZh
          ? "把本轮回复发送到当前频道。只有这个工具的 content 会写入群聊；普通生成文本只会留在你的手机动态里。"
          : "Send this turn's reply to the current channel. Only this tool's content is posted; ordinary generated text stays in your phone activity.",
        parameters: Type.Object({
          content: Type.String({
            description: isZh ? "要发送到频道的正文。不要包含 mood、解释或工具调用说明。" : "Message body to post. Do not include mood, explanations, or tool-call notes.",
          }),
          mood: Type.Optional(Type.String({
            description: isZh ? "可选：本次发言前的内省摘要，只记录在工具详情中，不发送到频道。" : "Optional private mood summary. Stored in tool details, not posted.",
          })),
        }),
        execute: async (_toolCallId, params = {}) => {
          const content = String(params.content || "").trim();
          if (!content) {
            return {
              content: [{ type: "text", text: isZh ? "发送失败：content 为空。" : "Send failed: content is empty." }],
              details: { action: "reply", error: "empty content" },
            };
          }
          if (decided) {
            return {
              content: [{ type: "text", text: isZh ? "本轮已经完成过频道决定。" : "This phone turn already made a channel decision." }],
              details: { action: "reply", error: "already decided" },
            };
          }
          if (engine.isChannelsEnabled && !engine.isChannelsEnabled()) {
            return {
              content: [{ type: "text", text: isZh ? "发送失败：频道功能已关闭。" : "Send failed: channels are disabled." }],
              details: { action: "reply", error: "channels disabled" },
            };
          }
          if (!fs.existsSync(channelFile)) {
            return {
              content: [{ type: "text", text: isZh ? "发送失败：频道不存在。" : "Send failed: channel not found." }],
              details: { action: "reply", error: "channel not found" },
            };
          }

          const { timestamp } = await appendMessage(channelFile, agentId, content);
          const decision = {
            type: "reply",
            replied: true,
            replyContent: content,
            timestamp,
            mood: typeof params.mood === "string" ? params.mood : null,
          };
          markDecision(decision);

          this._hub.eventBus.emit({
            type: "channel_new_message",
            channelName,
            sender: agentId,
            message: { sender: agentId, timestamp, body: content },
          }, null);

          return {
            content: [{ type: "text", text: isZh ? `已发送到 #${channelName}` : `Posted to #${channelName}` }],
            details: { action: "reply", channel: channelName, timestamp, mood: decision.mood },
          };
        },
      },
      {
        name: "channel_pass",
        label: isZh ? "本轮不发言" : "Pass this turn",
        description: isZh
          ? "表示你已经看过这批手机群聊消息，但本轮选择不在频道发言。"
          : "Mark these phone channel messages as seen while choosing not to post this turn.",
        parameters: Type.Object({
          reason: Type.Optional(Type.String({
            description: isZh ? "简短说明为什么本轮不发言。" : "Brief reason for not posting this turn.",
          })),
          mood: Type.Optional(Type.String({
            description: isZh ? "可选：本次判断的内省摘要。" : "Optional private mood summary for this decision.",
          })),
        }),
        execute: async (_toolCallId, params = {}) => {
          if (decided) {
            return {
              content: [{ type: "text", text: isZh ? "本轮已经完成过频道决定。" : "This phone turn already made a channel decision." }],
              details: { action: "pass", error: "already decided" },
            };
          }
          const decision = {
            type: "pass",
            replied: false,
            passed: true,
            reason: typeof params.reason === "string" ? params.reason : "",
            mood: typeof params.mood === "string" ? params.mood : null,
          };
          markDecision(decision);
          return {
            content: [{ type: "text", text: isZh ? "已标记为本轮不发言。" : "Marked as pass for this turn." }],
            details: { action: "pass", channel: channelName, reason: decision.reason, mood: decision.mood },
          };
        },
      },
    ];
  }

  // ──────────── 生命周期 ────────────

  start() {
    const engine = this._engine;
    if (!engine.channelsDir) return;
    if (this._ticker) return;

    this._ticker = createChannelTicker({
      channelsDir: engine.channelsDir,
      agentsDir: engine.agentsDir,
      getAgentOrder: () => this.getAgentOrder(),
      executeCheck: (agentId, channelName, newMessages, allUpdates, opts) =>
        this._executeCheck(agentId, channelName, newMessages, allUpdates, opts),
      onMemorySummarize: (agentId, channelName, contextText) =>
        this._memorySummarize(agentId, channelName, contextText),
      onEvent: (event, data) => {
        this._hub.eventBus.emit({ type: event, ...data }, null);
      },
    });
    this._ticker.start();
  }

  ensureStarted() {
    if (this._ticker) return true;
    if (!this._engine.isChannelsEnabled?.()) return false;
    this.start();
    this.setupPostHandler();
    return !!this._ticker;
  }

  async stop() {
    if (this._ticker) {
      await this._ticker.stop();
      this._ticker = null;
    }
  }

  async toggle(enabled) {
    if (enabled) {
      if (this._ticker) return;
      this.start();
      this.setupPostHandler();
    } else {
      await this.stop();
    }
  }

  triggerImmediate(channelName, opts) {
    this.ensureStarted();
    return this._ticker?.triggerImmediate(channelName, opts) || Promise.resolve();
  }

  /**
   * 注入频道 post 回调到当前 agent
   * agent 用 channel tool 发消息后，触发其他 agent 的手机送达
   */
  setupPostHandler() {
    for (const [, agent] of this._engine.agents || []) {
      agent.setChannelPostHandler((channelName, senderId, message) => {
        debugLog()?.log("channel", `agent ${senderId} posted to #${channelName}, triggering phone delivery`);
        if (message) {
          this._hub.eventBus.emit({
            type: "channel_new_message",
            channelName,
            sender: senderId,
            message,
          }, null);
        }
        this.triggerImmediate(channelName)?.catch(err =>
          console.error(`[channel] agent post delivery 失败: ${err.message}`)
        );
      });
    }
  }

  // ──────────── 频道 Agent 顺序 ────────────

  /** 获取频道轮转候选 agent 列表；具体频道 membership 由 channel frontmatter 决定 */
  getAgentOrder() {
    const now = Date.now();
    if (this._agentOrderCache && now - this._agentOrderCache.ts < ChannelRouter._AGENT_ORDER_TTL) {
      return this._agentOrderCache.list;
    }
    try {
      const entries = fs.readdirSync(this._engine.agentsDir, { withFileTypes: true });
      const list = entries
        .filter(e => e.isDirectory())
        .filter(e => {
          const configPath = path.join(this._engine.agentsDir, e.name, "config.yaml");
          return fs.existsSync(configPath);
        })
        .map(e => e.name);
      this._agentOrderCache = { list, ts: now };
      return list;
    } catch {
      return [];
    }
  }

  // ──────────── Phone Delivery + Reply ────────────

  /**
   * 频道检查回调：未读消息送达 → Agent Phone Session → 频道工具写入或 pass
   * 从 engine._executeChannelCheck 搬入
   */
  async _executeCheck(agentId, channelName, newMessages, _allChannelUpdates, { signal, proactive = false } = {}) {
    const engine = this._engine;
    const msgText = formatMessagesForLLM(newMessages);
    const isZh = getLocale().startsWith("zh");
    const lastNewMessage = newMessages[newMessages.length - 1] || null;
    await this._recordPhoneActivity(
      agentId,
      channelName,
      "viewed",
      isZh ? `已查看 ${newMessages.length} 条新消息` : `Viewed ${newMessages.length} new message(s)`,
      {
        messageCount: newMessages.length,
        lastMessageTimestamp: lastNewMessage?.timestamp || null,
      },
    );

    // ── 手机送达：不做 utility 预判，Agent 必须用频道专属工具完成本轮 ──
    try {
      await this._recordPhoneActivity(
        agentId,
        channelName,
        "replying",
        proactive
          ? (isZh ? "收到频道提醒，正在看群聊" : "Received channel reminder and is reading")
          : (isZh ? "正在查看手机群聊" : "Reading phone channel messages"),
        { messageCount: newMessages.length, proactive },
      );
      const decision = await this._executeReply(agentId, channelName, msgText, {
        signal,
        messageCount: newMessages.length,
        proactive,
      });

      if (decision?.replied) {
        console.log(`\x1b[90m[channel] ${agentId} replied #${channelName} (${decision.replyContent.length} chars)\x1b[0m`);
        debugLog()?.log("channel", `${agentId} replied #${channelName} (${decision.replyContent.length} chars)`);
        await this._recordPhoneActivity(
          agentId,
          channelName,
          "idle",
          isZh ? "已回复" : "Replied",
          {
            replyTimestamp: decision.timestamp,
            ...(decision.mood ? { mood: decision.mood } : {}),
            ...(this._resolvePhoneSessionPath(agentId, channelName)
              ? { sessionPath: this._resolvePhoneSessionPath(agentId, channelName) }
              : {}),
          },
        );
        return { replied: true, replyContent: decision.replyContent };
      }

      if (decision?.passed) {
        await this._recordPhoneActivity(
          agentId,
          channelName,
          "no_reply",
          isZh ? "已查看，选择不发言" : "Viewed and chose not to post",
          {
            messageCount: newMessages.length,
            ...(decision.reason ? { reason: decision.reason } : {}),
            ...(decision.mood ? { mood: decision.mood } : {}),
            ...(this._resolvePhoneSessionPath(agentId, channelName)
              ? { sessionPath: this._resolvePhoneSessionPath(agentId, channelName) }
              : {}),
          },
        );
        return { replied: false, passed: true };
      }

      await this._recordPhoneActivity(
        agentId,
        channelName,
        "error",
        isZh ? "没有调用频道回复工具" : "Did not call a channel decision tool",
        {
          messageCount: newMessages.length,
          ...(this._resolvePhoneSessionPath(agentId, channelName)
            ? { sessionPath: this._resolvePhoneSessionPath(agentId, channelName) }
            : {}),
        },
      );
      return { replied: false, missingDecision: true };
    } catch (err) {
      console.error(`[channel] 回复失败 (${agentId}/#${channelName}): ${err.message}`);
      debugLog()?.error("channel", `回复失败 (${agentId}/#${channelName}): ${err.message}`);
      await this._recordPhoneActivity(
        agentId,
        channelName,
        "error",
        isZh ? "处理消息失败" : "Failed to process message",
        { error: err.message },
      );
      return { replied: false };
    }
  }

  /**
   * 将未读群聊消息送入 Agent Phone session。频道写入只能由 channel_reply 工具完成。
   */
  async _executeReply(agentId, channelName, msgText, { signal, messageCount = null, proactive = false } = {}) {
    const isZh = getLocale().startsWith("zh");
    const phoneSettings = this._resolveChannelPhoneSettings(channelName);
    const promptGuidance = this._formatPhonePromptGuidance(agentId, phoneSettings, isZh);
    const zhIntro = proactive
      ? `你的手机收到了 #${channelName} 的频道提醒。\n\n`
        + `以下是最近的频道内容，来源是频道聊天记录 Truth，不是用户单独发给你的请求，也不一定是新消息：\n\n`
      : `你的手机收到了 #${channelName} 的新群聊消息。\n\n`
        + `这些是这部手机尚未处理的新消息，来源是频道聊天记录 Truth，不是用户单独发给你的请求：\n\n`;
    const enIntro = proactive
      ? `Your phone received a channel reminder for #${channelName}.\n\n`
        + `Here is recent channel content. The source is the channel transcript Truth, not a direct user request, and it may not be new:\n\n`
      : `Your phone received new messages in #${channelName}.\n\n`
        + `These are the new messages this phone has not processed yet. The source is the channel transcript Truth, not a direct user request:\n\n`;
    let activeSessionPath = null;
    let decision = null;
    await runAgentPhoneSession(
      agentId,
      [
        {
          text: isZh
            ? zhIntro
              + `${msgText || "（没有新消息）"}\n\n`
              + `请像群聊成员一样阅读并行动：\n`
              + `- 你可以因为被问到、被提到、想补充、想推动话题、表达情绪、主动开启话题或觉得有价值而发言\n`
              + `- 不需要只在事情与你直接相关时才发言\n`
              + `- 需要旧上下文时，用 channel_read_context 读取频道 Truth；需要事实和长期背景时，用 search_memory\n`
              + `${promptGuidance}\n`
              + `- 本轮最后必须调用 channel_reply 或 channel_pass 之一完成动作\n`
              + `- 不要把最终群聊回复写在普通文本里；只有 channel_reply.content 会进入群聊`
            : enIntro
              + `${msgText || "(No new messages)"}\n\n`
              + `Read and act like a group chat member:\n`
              + `- You may post because you were asked, mentioned, have something useful to add, want to move the topic, want to start a topic, or feel it is worth saying\n`
              + `- You do not need the topic to be directly about you\n`
              + `- Use channel_read_context for older channel Truth; use search_memory for facts and long-term background\n`
              + `${promptGuidance}\n`
              + `- End this turn by calling exactly one of channel_reply or channel_pass\n`
              + `- Do not write the final channel reply as ordinary text; only channel_reply.content enters the channel`,
          capture: true,
        },
      ],
      {
        engine: this._engine,
        signal,
        conversationId: channelName,
        conversationType: "channel",
        toolMode: phoneSettings.toolMode,
        modelOverride: phoneSettings.modelOverrideEnabled ? phoneSettings.modelOverrideModel : null,
        emitEvents: true,
        extraCustomTools: this._createChannelPhoneTools(agentId, channelName, {
          setDecision: (next) => { if (!decision) decision = next; },
        }),
        onSessionReady: (sessionPath) => {
          activeSessionPath = sessionPath;
          return this._recordPhoneActivity(
            agentId,
            channelName,
            "replying",
            isZh ? "正在查看手机群聊" : "Reading phone channel messages",
            {
              ...(messageCount != null ? { messageCount } : {}),
              sessionPath,
            },
          );
        },
        onActivity: (state, summary, details) =>
          this._recordPhoneActivity(
            agentId,
            channelName,
            state,
            summary,
            {
              ...(details || {}),
              ...(activeSessionPath ? { sessionPath: activeSessionPath } : {}),
            },
        ),
      },
    );

    return decision || { replied: false, missingDecision: true };
  }

  /**
   * 频道记忆摘要
   * 从 engine._channelMemorySummarize 搬入
   */
  async _memorySummarize(agentId, channelName, contextText) {
    const engine = this._engine;
    try {
      // 记忆 master 关闭时不写入新记忆（频道摘要是写侧操作）
      const agentInstance = this._getAgentInstance(agentId);
      const memoryMasterOn = this._resolveMemoryMasterEnabled(agentId, { agentInstance });
      if (!memoryMasterOn) {
        console.log(`\x1b[90m[channel] ${agentId} memory master 已关闭，跳过频道记忆摘要\x1b[0m`);
        return;
      }

      const utilCfg = engine.resolveUtilityConfig({ agentId }) || {};
      const { utility: model, api_key, base_url, api } = utilCfg;
      if (!api_key || !base_url || !api) {
        console.log(`\x1b[90m[channel] ${agentId} 无 API 配置，跳过记忆摘要\x1b[0m`);
        return;
      }

      const isZhMem = getLocale().startsWith("zh");
      const summaryText = await callText({
        api, model,
        apiKey: api_key,
        baseUrl: base_url,
        systemPrompt: isZhMem
          ? "将频道对话摘要为一条简短的记忆（一两句话），记录关键信息和结论。直接输出摘要，不要前缀。"
          : "Summarize the channel conversation into a brief memory (one or two sentences), capturing key information and conclusions. Output the summary directly, no prefix.",
        messages: [{ role: "user", content: isZhMem ? `频道 #${channelName}：\n${contextText.slice(0, 2000)}` : `Channel #${channelName}:\n${contextText.slice(0, 2000)}` }],
        temperature: 0.3,
        maxTokens: 200,
      });

      // 写入 agent 的 fact store
      let factStore = null;
      let needClose = false;

      if (agentInstance?.factStore) {
        factStore = agentInstance.factStore;
      } else {
        const { FactStore } = await import("../lib/memory/fact-store.js");
        const dbPath = path.join(engine.agentsDir, agentId, "memory", "facts.db");
        factStore = new FactStore(dbPath);
        needClose = true;
      }

      const now = new Date();
      try {
        factStore.add({
          fact: `[#${channelName}] ${summaryText}`,
          tags: [isZhMem ? "频道" : "channel", channelName],
          time: now.toISOString().slice(0, 16),
          session_id: `channel-${channelName}`,
        });
      } finally {
        if (needClose) factStore.close();
      }

      console.log(`\x1b[90m[channel] ${agentId} memory saved (#${channelName}, ${summaryText.length} chars)\x1b[0m`);
    } catch (err) {
      console.error(`[channel] 记忆摘要失败 (${agentId}/#${channelName}): ${err.message}`);
    }
  }
}
