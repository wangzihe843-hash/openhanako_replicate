/**
 * DmRouter — 私信路由
 *
 * 当 agent 通过 dm 工具发送私信后，DmRouter 负责：
 * 1. 用 phone session 让接收方读取聊天记录并回复
 * 2. 回复写回双方的 dm/ 文件
 * 3. 有轮次限制，防止无限对话
 *
 * 与 ChannelRouter 的区别：
 * - DM 是 1v1，不需要群聊送达循环（私信就是给你的）
 * - DM 的 Truth 是双方 dm/ 聊天记录，phone session 只是接收方的手机视角
 * - DM phone session 复用普通 Agent session 的系统提示词、yuan 与记忆加载策略，但自身不进记忆系统
 */

import fs from "fs";
import path from "path";
import {
  appendDmMessage,
  getRecentMessages,
  formatMessagesForLLM,
} from "../lib/channels/channel-store.ts";
import { runAgentPhoneSession } from "./agent-executor.ts";
import { buildXingyeAgentPhoneTurnContext } from "../shared/xingye-phone-context.js";
import { debugLog, createModuleLogger } from "../lib/debug-log.ts";
import { getLocale } from "../lib/i18n.ts";
import {
  getAgentPhoneProjectionPath,
  readAgentPhoneProjection,
  recordAgentPhoneActivity,
} from "../lib/conversations/agent-phone-projection.ts";
import {
  readAgentPhoneRuntime,
  resolveAgentPhoneRuntimeSessionPath,
} from "../lib/conversations/agent-phone-runtime.ts";
import { normalizeAgentPhoneToolMode } from "../lib/conversations/agent-phone-session.ts";
import {
  DEFAULT_AGENT_PHONE_SETTINGS,
  defaultAgentPhoneGuardLimit,
  formatAgentPhonePromptGuidance,
  normalizeAgentPhoneModelOverride,
  positiveIntegerOrDefault,
  positiveIntegerOrNull,
} from "../lib/conversations/agent-phone-prompt.ts";

const log = createModuleLogger("dm-router");

const MAX_ROUNDS = 3;
const COOLDOWN_MS = 10_000;
const PROCESSING_TIMEOUT_MS = 5 * 60 * 1000;

export class DmRouter {
  declare _hub: any;
  declare _cooldowns: Map<string, any>;
  declare _processing: Map<string, any>;

  constructor({ hub }) {
    this._hub = hub;
    this._cooldowns = new Map();
    this._processing = new Map(); // unordered agent pair → active worker
  }

  get _engine() { return this._hub.engine; }

  _isPhoneEnabled() {
    return this._engine.isChannelsEnabled?.() !== false;
  }

  async _recordPhoneActivity(agentId, peerId, state, summary, details = {}) {
    try {
      const agent = this._engine.getAgent(agentId);
      const agentDir = agent?.agentDir || path.join(this._engine.agentsDir, agentId);
      const activity = {
        conversationId: `dm:${peerId}`,
        conversationType: "dm",
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
      debugLog()?.warn?.("dm-router", `phone activity record failed (${agentId}/dm:${peerId}): ${err.message}`);
    }
  }

  _resolvePhoneToolMode(agentId, peerId) {
    return this._resolvePhoneSettings(agentId, peerId).toolMode;
  }

  _resolvePhoneSettings(agentId, peerId) {
    try {
      const agent = this._engine.getAgent(agentId);
      const agentDir = agent?.agentDir || path.join(this._engine.agentsDir, agentId);
      const projection = readAgentPhoneProjection(getAgentPhoneProjectionPath(agentDir, `dm:${peerId}`));
      const meta = projection.meta as any;
      const override = normalizeAgentPhoneModelOverride({
        enabled: meta.modelOverrideEnabled,
        id: meta.modelOverrideId,
        provider: meta.modelOverrideProvider,
      });
      return {
        toolMode: normalizeAgentPhoneToolMode(meta.toolMode),
        replyMinChars: positiveIntegerOrNull(meta.replyMinChars),
        replyMaxChars: positiveIntegerOrNull(meta.replyMaxChars),
        proactiveEnabled: meta.proactiveEnabled === undefined
          ? DEFAULT_AGENT_PHONE_SETTINGS.proactiveEnabled
          : meta.proactiveEnabled === true || meta.proactiveEnabled === "true",
        reminderIntervalMinutes: positiveIntegerOrDefault(
          meta.reminderIntervalMinutes,
          DEFAULT_AGENT_PHONE_SETTINGS.reminderIntervalMinutes,
        ),
        guardLimit: positiveIntegerOrDefault(
          meta.guardLimit,
          defaultAgentPhoneGuardLimit(2),
        ),
        modelOverrideEnabled: override.enabled,
        modelOverrideModel: override.model,
      };
    } catch {
      return {
        ...DEFAULT_AGENT_PHONE_SETTINGS,
        guardLimit: defaultAgentPhoneGuardLimit(2),
      };
    }
  }

  _resolvePhoneSessionPath(agentId, peerId) {
    try {
      const agent = this._engine.getAgent(agentId);
      const agentDir = agent?.agentDir || path.join(this._engine.agentsDir, agentId);
      return resolveAgentPhoneRuntimeSessionPath(agentDir, readAgentPhoneRuntime(agentDir, `dm:${peerId}`));
    } catch {
      return null;
    }
  }

  /**
   * 处理新私信：让接收方回复
   * @param {string} fromId - 发送方 agent ID
   * @param {string} toId - 接收方 agent ID
   */
  async handleNewDm(fromId, toId) {
    if (!this._isPhoneEnabled()) return;

    const pairKey = JSON.stringify([fromId, toId].sort());
    const current = this._processing.get(pairKey);
    if (current && (current.closing || current.controller.signal.aborted)) {
      // An aborted SDK prompt can still be unwinding. Never reopen its session
      // until teardown finishes; a new notification may then start a fresh pair.
      await current.promise;
      return this.handleNewDm(fromId, toId);
    }

    const key = JSON.stringify([fromId, toId]);
    let revision;
    try {
      const stat = fs.statSync(path.join(this._engine.agentsDir, toId, "dm", `${fromId}.md`));
      revision = `${stat.size}:${stat.mtimeMs}`;
    } catch {
      return;
    }
    const now = Date.now();
    for (const [k, entry] of this._cooldowns) {
      if (now - entry.at >= COOLDOWN_MS) this._cooldowns.delete(k);
    }
    const previous = this._cooldowns.get(key);
    if (previous?.revision === revision) return current?.promise;
    // Deduplicate notifications for the same file revision, never a real new DM
    // that happens to arrive inside the old ten-second cooldown window.
    this._cooldowns.set(key, { at: now, revision });
    const request = { fromId, toId, forceReply: !!current };
    if (current) {
      // At most one pending delivery per direction; its prompt reads the latest
      // transcript, so a burst is handled together without losing either owner.
      current.pending.set(key, request);
      return current.promise;
    }

    const worker = {
      pending: new Map([[key, request]]),
      controller: new AbortController(),
      closing: false,
      promise: null,
    };
    this._processing.set(pairKey, worker);
    worker.promise = Promise.resolve()
      .then(() => this._drainPair(fromId, toId, worker))
      .catch((err) => { log.error(`${fromId}→${toId} failed: ${err.message}`); })
      .finally(() => {
        if (this._processing.get(pairKey) === worker) this._processing.delete(pairKey);
      });
    return worker.promise;
  }

  async _drainPair(fromId, toId, worker) {
    const unregister = [];
    const cancel = (reason = "dm-cancelled") => {
      worker.pending.clear();
      worker.controller.abort(reason);
    };
    // Timeout aborts the active session instead of deleting a live lock. The
    // worker remains the owner until its prompt and teardown actually settle.
    const timeout = setTimeout(() => cancel("dm-timeout"), PROCESSING_TIMEOUT_MS);
    timeout.unref?.();
    try {
      for (const [sender, recipient] of [[fromId, toId], [toId, fromId]]) {
        const release = this._engine.registerAgentPhoneAbortHandler?.(cancel, {
          agentId: recipient,
          conversationId: `dm:${sender}`,
          conversationType: "dm",
        });
        if (typeof release === "function") unregister.push(release);
      }
      while (worker.pending.size && !worker.controller.signal.aborted && this._isPhoneEnabled()) {
        const [key, request] = worker.pending.entries().next().value;
        worker.pending.delete(key);
        try {
          await this._processReply(request.fromId, request.toId, {
            signal: worker.controller.signal,
            pending: worker.pending,
            forceReply: request.forceReply,
          });
        } catch (err) {
          if (!worker.controller.signal.aborted) log.error(`${key} failed: ${err.message}`);
        }
      }
    } finally {
      // The promise's outer finally removes the map entry in a later microtask.
      // New notifications in that gap must wait and start a fresh worker.
      worker.closing = true;
      clearTimeout(timeout);
      worker.pending.clear();
      for (const release of unregister) {
        try { release(); } catch {}
      }
      if (worker.controller.signal.aborted || !this._isPhoneEnabled()) {
        this._cooldowns.delete(JSON.stringify([fromId, toId]));
        this._cooldowns.delete(JSON.stringify([toId, fromId]));
      }
    }
  }

  /**
   * 让 toId 读取聊天记录并回复，可能触发多轮
   */
  async _processReply(fromId, toId, { signal, pending, forceReply = false }: any = {}) {
    if (!this._isPhoneEnabled()) return;

    const engine = this._engine;
    const agentsDir = engine.agentsDir;

    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (signal?.aborted || !this._isPhoneEnabled()) break;
      // 读取 toId 视角的聊天记录
      const dmFile = path.join(agentsDir, toId, "dm", `${fromId}.md`);
      if (!fs.existsSync(dmFile)) break;

      const recentMsgs = getRecentMessages(dmFile, 20, undefined);
      if (recentMsgs.length === 0) break;

      // 最后一条不是对方发的，说明已经回复过了，不需要再回
      const lastMsg = recentMsgs[recentMsgs.length - 1];
      if (lastMsg.sender === toId && !(round === 0 && forceReply)) break;

      // Notifications already queued for this direction are included in this
      // read. A notification arriving after it remains pending for a fresh turn.
      pending?.delete(JSON.stringify([fromId, toId]));

      const msgText = formatMessagesForLLM(recentMsgs);
      const lastMsgTimestamp = lastMsg.timestamp || null;

      // 获取对方的显示名
      const fromAgent = engine.getAgent(fromId);
      const toAgent = engine.getAgent(toId);
      const fromName = fromAgent?.agentName || fromId;
      const toName = toAgent?.agentName || toId;
      const phoneSettings = this._resolvePhoneSettings(toId, fromId);

      // 每轮现读回复方自己的 profile、正文命中的 keyword lore，以及回复方对当前 peer 的
      // 定向关系 lore。通过 Phone 的 ephemeral turn context 注入：既绕开 30 分钟 prompt
      // snapshot，又不会把资料副本持久写进 DM session 历史。
      const phoneTurnContext = buildXingyeAgentPhoneTurnContext({
        agentId: toId,
        agentDir: toAgent?.agentDir || path.join(agentsDir, toId),
        hanakoHome: path.dirname(agentsDir),
        agentName: toName,
        locale: getLocale(),
        messageText: msgText,
        peerRefs: [{ id: fromId, name: fromName }],
      });

      debugLog()?.log("dm-router", `${toId} replying to ${fromId} (round ${round + 1}/${MAX_ROUNDS})${phoneTurnContext ? " [+dynamic-context]" : ""}`);

      // 用频道模式 prompt 让 toId 回复
      const isZh = getLocale().startsWith("zh");
      const promptGuidance = formatAgentPhonePromptGuidance({
        agentId: toId,
        agent: toAgent,
        agentsDir,
        settings: phoneSettings,
        isZh,
        zhConversationName: "私聊",
        enConversationName: "DM",
      });
      await this._recordPhoneActivity(
        toId,
        fromId,
        "viewed",
        isZh ? `已查看来自 ${fromName} 的私信` : `Viewed DM from ${fromName}`,
        { messageCount: recentMsgs.length, lastMessageTimestamp: lastMsgTimestamp },
      );
      await this._recordPhoneActivity(
        toId,
        fromId,
        "replying",
        isZh ? "正在回复私信" : "Replying to DM",
        { round: round + 1, maxRounds: MAX_ROUNDS },
      );
      let activeSessionPath = null;
      const replyText = await runAgentPhoneSession(
        toId,
        [
          {
            text: isZh
              ? `你的手机收到了来自「${fromName}」的私信。\n\n`
                + `（「${fromName}」是另一个 AI agent——你认识的人之一，见你系统提示里的「团队」名单，可以按 id 用 \`dm\` 回他；**不是用户本人**，别搞混。）\n\n`
                + `以下是你们最近的聊天记录：\n\n${msgText}\n\n`
                + `---\n\n`
                + `${promptGuidance}\n\n`
                + `请给出你的回复（第 ${round + 1}/${MAX_ROUNDS} 轮）。直接输出内容，不要加前缀。\n`
                + `如果你觉得对话可以结束了，在末尾加 <done/>。\n`
                + `如果你不想回复，输出 [NO_REPLY]。`
              : `You received a DM from "${fromName}".\n\n`
                + `("${fromName}" is another AI agent — one of the people you know, see the "Team" roster in your system prompt; you can \`dm\` them back by id. **This is NOT the user**, don't confuse them.)\n\n`
                + `Here is your recent chat history:\n\n${msgText}\n\n`
                + `---\n\n`
                + `${promptGuidance}\n\n`
                + `Give your reply (round ${round + 1}/${MAX_ROUNDS}). Output directly, no prefix.\n`
                + `If you think the conversation can end, append <done/>.\n`
                + `If you don't want to reply, output [NO_REPLY].`,
            capture: true,
            ...(phoneTurnContext ? {
              context: {
                system: phoneTurnContext,
                metadata: { source: "xingye_phone", surface: "dm", peerId: fromId },
              },
            } : {}),
          },
        ],
        {
          engine,
          signal,
          conversationId: `dm:${fromId}`,
          conversationType: "dm",
          toolMode: phoneSettings.toolMode,
          modelOverride: phoneSettings.modelOverrideEnabled ? phoneSettings.modelOverrideModel : null,
          emitEvents: true,
          onSessionReady: (sessionPath) => {
            activeSessionPath = sessionPath;
            return this._recordPhoneActivity(
              toId,
              fromId,
              "replying",
              isZh ? "正在回复私信" : "Replying to DM",
              { round: round + 1, maxRounds: MAX_ROUNDS, sessionPath },
            );
          },
          onActivity: (state, summary, details) =>
            this._recordPhoneActivity(
              toId,
              fromId,
              state,
              summary,
              {
                ...(details || {}),
                ...(activeSessionPath ? { sessionPath: activeSessionPath } : {}),
              },
            ),
        },
      );

      if (signal?.aborted || !this._isPhoneEnabled()) break;

      if (!replyText || (replyText as string).includes("[NO_REPLY]")) {
        debugLog()?.log("dm-router", `${toName} chose not to reply to ${fromName}`);
        await this._recordPhoneActivity(
          toId,
          fromId,
          "no_reply",
          isZh ? "选择不回复私信" : "Chose not to reply to DM",
          {
            round: round + 1,
            ...(this._resolvePhoneSessionPath(toId, fromId)
              ? { sessionPath: this._resolvePhoneSessionPath(toId, fromId) }
              : {}),
          },
        );
        break;
      }

      const isDone = /<done\s*\/?>/i.test(replyText as string);
      const cleanReply = (replyText as string).replace(/<done\s*\/?>/gi, "").trim();

      if (!cleanReply) break;

      // Replies and proactive sends share one mirrored write order.
      const written = await appendDmMessage({
        agentsDir, fromId: toId, toId: fromId, body: cleanReply,
        createMissing: false,
        canWrite: () => !signal?.aborted && this._isPhoneEnabled(),
      });
      if (!written) break;

      // 通知前端
      this._hub.eventBus.emit({
        type: "dm_new_message",
        from: toId,
        to: fromId,
      }, null);
      await this._recordPhoneActivity(
        toId,
        fromId,
        "idle",
        isZh ? "已回复私信" : "Replied to DM",
        {
          done: isDone,
          ...(this._resolvePhoneSessionPath(toId, fromId)
            ? { sessionPath: this._resolvePhoneSessionPath(toId, fromId) }
            : {}),
        },
      );

      debugLog()?.log("dm-router", `${toName} replied to ${fromName}: ${cleanReply.slice(0, 60)}...${isDone ? " [done]" : ""}`);

      if (isDone) break;

      // 交换角色，让对方也回复
      [fromId, toId] = [toId, fromId];
    }
  }
}
