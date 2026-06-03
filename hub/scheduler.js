/**
 * Scheduler — Heartbeat + Cron 调度（v2）
 *
 * Heartbeat：所有有 desk 的 agent 各自并行跑，不依赖焦点 agent
 * Cron：Studio 级任务列表统一调度，不随 active agent / workspace 切换而变化
 *
 * 通知策略：agent_session 由 agent 自行决定是否调用 notify 工具；
 * direct_action:notify 由 scheduler 走统一通知网关执行；
 * plugin_action 由 scheduler 到点调用指定插件工具。
 */

import fs from "fs";
import path from "path";
import { createHeartbeat } from "../lib/desk/heartbeat.js";
import { createCronScheduler } from "../lib/desk/cron-scheduler.js";
import {
  executeDirectAutomationAction,
  executePluginAutomationAction,
  getAutomationExecutor,
} from "../lib/desk/automation-executors.js";
import { getLocale } from "../server/i18n.js";
import { runXingyeHeartbeatConsumer } from "../lib/xingye/heartbeat-consumer.js";
import { resolveSocialThresholds } from "../lib/desk/social-awareness.js";
import { createFreshCompactDailyScheduler } from "../lib/fresh-compact/daily-scheduler.js";
import { FreshCompactMaintainer } from "./fresh-compact-maintainer.js";
import { createModuleLogger } from "../lib/debug-log.js";
import { WORKSPACE_OUTPUT_ROOT_DIRNAME } from "../shared/workspace-output.js";

const log = createModuleLogger("scheduler");
const freshCompactLog = createModuleLogger("fresh-compact");

function normalizeCronExecutionContext(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      kind: "missing",
      cwd: null,
      workspaceFolders: [],
      sourceSessionPath: null,
    };
  }
  return {
    kind: typeof value.kind === "string" && value.kind.trim() ? value.kind.trim() : "session_workspace",
    cwd: typeof value.cwd === "string" && value.cwd.trim() ? value.cwd : null,
    workspaceFolders: Array.isArray(value.workspaceFolders)
      ? value.workspaceFolders.filter(p => typeof p === "string" && p.trim())
      : [],
    sourceSessionPath: typeof value.sourceSessionPath === "string" && value.sourceSessionPath.trim()
      ? value.sourceSessionPath
      : null,
  };
}

export class Scheduler {
  /**
   * @param {object} opts
   * @param {import('./index.js').Hub} opts.hub
   */
  constructor({ hub }) {
    this._hub = hub;
    this._heartbeats = new Map(); // agentId → heartbeat instance
    this._cronScheduler = null; // Studio CronScheduler
    this._executingJobs = new Map(); // jobId → AbortController（per-job 锁 + abort 控制）
    this._freshCompactMaintainer = new FreshCompactMaintainer({ hub });
    this._freshCompactScheduler = createFreshCompactDailyScheduler({
      runDaily: (opts) => this._freshCompactMaintainer.runDaily(opts),
      warn: (msg) => freshCompactLog.warn(msg),
    });
  }

  /** @returns {import('../core/engine.js').HanaEngine} */
  get _engine() { return this._hub.engine; }

  /** 获取某个 agent 的 heartbeat 实例 */
  getHeartbeat(agentId) {
    if (!agentId) return null;
    return this._heartbeats.get(agentId) ?? null;
  }

  /** 暴露 Studio cronScheduler（agentId 参数仅为兼容旧调用方） */
  getCronScheduler(agentId) {
    return this._cronScheduler ?? null;
  }

  // ──────────── 生命周期 ────────────

  start() {
    this.startHeartbeat();
    this._startStudioCron();
    this._freshCompactScheduler.start();
  }

  async stop() {
    this._freshCompactScheduler.stop();
    await this.stopHeartbeat();
    if (this._cronScheduler) {
      await this._cronScheduler.stop();
      this._cronScheduler = null;
    }
  }

  /** 兼容旧 agent 生命周期调用：Studio cron 只有一个 scheduler */
  startAgentCron(agentId) { this._startStudioCron(); }

  /** 为指定 agent 启动 heartbeat（公共 API，供 createAgent 等场景使用） */
  startAgentHeartbeat(agentId, agent) {
    this._startAgentHeartbeat(agentId, agent);
  }

  /** 兼容旧 agent 生命周期调用：删除 agent 不停止 Studio cron scheduler */
  async removeAgentCron(agentId) {
    return undefined;
  }

  /** 重建 heartbeat（支持指定 agentId 或全量） */
  async reloadHeartbeat(agentId) {
    if (agentId) {
      await this.stopHeartbeat(agentId);
      const agent = this._engine.getAgent(agentId);
      if (agent) this._startAgentHeartbeat(agentId, agent);
      return;
    }
    await this.stopHeartbeat();
    this.startHeartbeat();
  }

  startHeartbeat() {
    for (const [agentId, agent] of this._engine.agents || []) {
      this._startAgentHeartbeat(agentId, agent);
    }
  }

  _startAgentHeartbeat(agentId, agent) {
    if (this._heartbeats.has(agentId)) return; // 幂等

    const engine = this._engine;
    const hbInterval = agent.config?.desk?.heartbeat_interval;
    const masterEnabled = engine.getHeartbeatMaster() !== false;
    const hbEnabled = masterEnabled && (agent.config?.desk?.heartbeat_enabled === true);
    // per-agent workspace（fallback: 主 agent → ~/Desktop）
    const getWorkspace = () => engine.getHomeCwd(agentId);
    const hb = createHeartbeat({
      getDeskFiles: async () => {
        try {
          const dir = getWorkspace();
          if (!dir) return [];
          let entries;
          try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
          catch { return []; }
          const items = await Promise.all(
            entries
              .filter(e => !e.name.startsWith(".") && e.name !== WORKSPACE_OUTPUT_ROOT_DIRNAME)
              .map(async (e) => {
                const fp = path.join(dir, e.name);
                let mtime = 0;
                try { mtime = (await fs.promises.stat(fp)).mtimeMs; } catch {}
                return { name: e.name, isDir: e.isDirectory(), mtime };
              })
          );
          return items;
        } catch { return []; }
      },
      getWorkspacePath: getWorkspace,
      getAgentName: () => agent.agentName,
      registryPath: path.join(agent.deskDir, "jian-registry.json"),
      overwatchPath: path.join(agent.deskDir, "overwatch.md"),
      // 巡检/笺巡检不传 withMemory：executeIsolated 默认走 agent.systemPrompt，
      // 而该 cache 始终按 master 开关构建，与 per-session 开关解耦。
      // 用户关 master 时自动不带记忆；只关某个 session 的开关不影响这里。
      //
      // consumer 走 getEventSummary：必须在 buildHeartbeatContext 之前跑完，让 summaryZh 进 prompt，
      // 这样 agent 能基于事件主动判断是否要 notify。heartbeat.js 会把消费结果合并进 payload，
      // desk 路由还是能拿到 summaryZh。
      getEventSummary: () => this._runXingyeHeartbeatConsumer(agentId, agent),
      onBeat: async (prompt, extra = {}) => {
        // extra.xingyeConsumed：consumer 结果（含 summaryZh / eventCount），挂到 activity_update 负载，
        // 让前端 activities store 拿到本次巡检的小手机事件聚合（手动 + 自动统一走这条）。
        await this._executeActivityForAgent(agentId, prompt, "heartbeat", null, {
          xingyeConsumed: extra?.xingyeConsumed || null,
        });
      },
      onJianBeat: (prompt, cwd, runTools = {}) => {
        const isZh = getLocale().startsWith("zh");
        this._executeActivityForAgent(agentId, prompt, "heartbeat", `${isZh ? "笺" : "jian"}:${path.basename(cwd)}`, {
          cwd,
          extraCustomTools: Array.isArray(runTools.customTools) ? runTools.customTools : [],
        });
      },
      intervalMinutes: hbInterval,
      emitDevLog: (text, level) => engine.emitDevLog(text, level),
      locale: agent.config?.locale,
      // 是否在巡检里硬指挥 xingye_propose_draft：必须镜像 executeIsolated 真正的两道过滤——
      // (a) tools.disabled 含该工具 → filterToolObjectsByAvailability 已把它从 customTools 删掉；
      // (b) desk.patrol_tools 是有限白名单（truthy 且非 '*'）且不含该工具 → patrol 过滤删掉。
      // 二者皆不命中才算可用。每个 beat 现读 agent.config（配置可能在两次 beat 之间变化），不要快照。
      getProposeDraftAvailable: () => {
        const cfg = agent.config || {};
        if (Array.isArray(cfg.tools?.disabled) && cfg.tools.disabled.includes("xingye_propose_draft")) return false;
        // 镜像 executeIsolated 的 `opts.toolFilter || patrol_tools || PATROL_TOOLS_DEFAULT('*')`
        // 这条 `||` 链（session-coordinator）：任何 falsy 值（undefined / '' / null）都短路落到
        // '*' → 放行全部，故守卫必须用真值判断 `patrol`（而非仅排除 undefined），否则 '' / null
        // 会被错喂给 new Set('')（空集）判成"不可用"，与真实会话分叉、静默吞掉巡检硬指令。
        // truthy 的值（数组 / 异常纯字符串如误配 'notify' / 空数组 []）才按 new Set(...) 判定——
        // 数组得名字集合、纯字符串被拆成字符集合，均能正确判出工具不在白名单；这也顺带避免
        // new Set(0)/new Set(false) 抛错（falsy 已先短路）。
        const patrol = cfg.desk?.patrol_tools;
        if (patrol && patrol !== "*" && !new Set(patrol).has("xingye_propose_draft")) return false;
        return true;
      },
    });
    this._heartbeats.set(agentId, hb);
    if (hbEnabled) hb.start();
  }

  async stopHeartbeat(agentId) {
    if (agentId) {
      const hb = this._heartbeats.get(agentId);
      if (hb) { await hb.stop(); this._heartbeats.delete(agentId); }
      return;
    }
    // 并行停止所有 heartbeat，减少总关闭时间
    await Promise.all([...this._heartbeats.values()].map(hb => hb.stop()));
    this._heartbeats.clear();
  }

  // ──────────── Studio Cron ────────────

  _startStudioCron() {
    if (this._cronScheduler) return;
    const engine = this._engine;
    const cronStore = engine.getStudioCronStore?.();
    if (!cronStore) return;

    const sched = createCronScheduler({
      cronStore,
      executeJob: (job) => this._executeCronJob(job),
      abortJob: (jobId) => {
        const ac = this._executingJobs.get(jobId);
        if (ac) { ac.abort(); log.log(`cron abort ${jobId} (timeout)`); }
      },
      onJobDone: (job, result) => {
        this._hub.eventBus.emit(
          {
            type: "cron_job_done",
            jobId: job.id,
            label: job.label,
            agentId: job.actorAgentId,
            actorAgentId: job.actorAgentId,
            result,
          },
          null,
        );
      },
    });
    this._cronScheduler = sched;
    sched.start();
    log.log("Studio cron 已启动");
  }

  // ──────────── 执行 ────────────

  async _executeCronJob(job) {
    const executor = getAutomationExecutor(job);
    if (executor.kind === "direct_action") {
      return executeDirectAutomationAction(job, {
        deliverNotification: (payload, opts) => this._engine.deliverNotification(payload, opts),
      });
    }
    if (executor.kind === "plugin_action") {
      return executePluginAutomationAction(job, {
        invokePluginAction: (request, runtimeContext) => this._invokePluginAutomationAction(request, runtimeContext),
      });
    }
    if (executor.kind !== "agent_session") {
      throw new Error(`unsupported automation executor: ${executor.kind}`);
    }
    const actorAgentId = executor.agentId || job.actorAgentId || job.legacyRef?.agentId || null;
    if (!actorAgentId) {
      throw new Error(`cron job ${job.id} missing actorAgentId`);
    }
    await this._executeCronJobForAgent(actorAgentId, job, executor);
    return { executorKind: "agent_session" };
  }

  async _invokePluginAutomationAction({ pluginId, actionId, params }, runtimeContext = {}) {
    const pluginManager = this._engine.pluginManager;
    if (!pluginManager) throw new Error("plugin manager unavailable");
    const entry = typeof pluginManager.getPlugin === "function"
      ? pluginManager.getPlugin(pluginId)
      : null;
    if (!entry) throw new Error(`plugin not found: ${pluginId}`);
    if (entry.status !== "loaded") {
      throw new Error(`plugin is not loaded: ${pluginId}`);
    }
    if (typeof pluginManager.getPluginTool !== "function"
      || typeof pluginManager.executePluginTool !== "function") {
      throw new Error("plugin manager tool invocation unavailable");
    }
    const tool = pluginManager.getPluginTool(pluginId, actionId, { entry });
    if (!tool) throw new Error(`plugin action not found: ${pluginId}/${actionId}`);

    const cwd = typeof runtimeContext.cwd === "string" && runtimeContext.cwd.trim()
      ? runtimeContext.cwd
      : null;
    const executionBoundary = cwd && this._engine.runtimeContext
      ? this._engine.createExecutionBoundary({ workbenchRoot: cwd })
      : null;
    return pluginManager.executePluginTool(tool, {
      toolCallId: `automation-${runtimeContext.jobId || Date.now()}`,
      input: params,
      runtimeCtx: {
        automation: {
          jobId: runtimeContext.jobId || null,
          label: runtimeContext.label || "",
        },
        agentId: runtimeContext.actorAgentId || null,
        ...(runtimeContext.sessionPath ? {
          sessionPath: runtimeContext.sessionPath,
          sessionManager: {
            getSessionFile: () => runtimeContext.sessionPath,
            getCwd: () => cwd,
          },
        } : {}),
        ...(executionBoundary ? {
          serverNodeId: executionBoundary.serverNodeId,
          executionBoundary,
        } : {}),
      },
    });
  }

  /**
   * 执行某个 agent 的 cron 任务（active 或非 active 均可）
   * 同一 agent 同时只运行一个 cron，防止并发写冲突
   */
  async _executeCronJobForAgent(agentId, job, executor = getAutomationExecutor(job)) {
    // per-job 锁：同一 job 不并发，但同一 agent 的不同 job 可以并行
    if (this._executingJobs.has(job.id)) {
      log.log(`cron 跳过 ${job.id}：上一次仍在执行`);
      const err = new Error(`cron job ${job.id} 仍在执行，跳过`);
      err.skipped = true;
      throw err;
    }
    const ac = new AbortController();
    this._executingJobs.set(job.id, ac);
    try {
      const isZh = getLocale().startsWith("zh");
      const promptBody = executor.prompt || job.prompt || "";
      const model = executor.model || job.model || undefined;
      const prompt = isZh
        ? [
            `[定时任务 ${job.id}: ${job.label}]`,
            "",
            "**注意：这是系统自动触发的定时任务，不是用户发来的。**",
            "**不要在执行过程中创建新的定时任务。**",
            "",
            promptBody,
          ].join("\n")
        : [
            `[Cron job ${job.id}: ${job.label}]`,
            "",
            "**Note: This is an automated cron job, NOT a user message.**",
            "**Do not create new cron jobs during execution.**",
            "",
            promptBody,
          ].join("\n");
      await this._executeActivityForAgent(agentId, prompt, "cron", job.label, {
        model,
        signal: ac.signal,
        ...this._cronExecutionOptions(job, executor),
      });
    } finally {
      this._executingJobs.delete(job.id);
    }
  }

  _cronExecutionOptions(job, executor = getAutomationExecutor(job)) {
    const ctx = normalizeCronExecutionContext(executor.executionContext || job.executionContext);
    const opts = {};
    if (ctx.cwd) opts.cwd = ctx.cwd;
    opts.workspaceFolders = ctx.workspaceFolders;
    if (ctx.sourceSessionPath) opts.parentSessionPath = ctx.sourceSessionPath;
    return opts;
  }

  /**
   * 执行活动（任意 agent，统一走 executeIsolated）
   */
  async _executeActivityForAgent(agentId, prompt, type, label, opts = {}) {
    const engine = this._engine;
    await engine.ensureAgentRuntime?.(agentId, {
      priority: "background",
      reason: type,
    });
    const agentDir = path.join(engine.agentsDir, agentId);
    const activityDir = path.join(agentDir, "activity");
    const startedAt = Date.now();
    const id = `${type === "heartbeat" ? "hb" : "cron"}_${startedAt}`;

    // 所有 agent 统一走 executeIsolated（支持 agentId + signal 参数）
    // xingyeConsumed 只用于给 activity_update 负载挂 summaryZh，不能透传给 executeIsolated。
    const { signal, xingyeConsumed, ...restOpts } = opts;
    const result = await engine.executeIsolated(prompt, {
      agentId,
      persist: activityDir,
      signal,
      activityType: type,
      ...restOpts,
    });
    const { sessionPath, error } = result;

    const finishedAt = Date.now();
    const failed = !!error;

    // 取 agentName（从长驻实例获取，fallback agentId）
    const ag = engine.getAgent(agentId);
    const agentName = ag?.agentName || agentId;

    // 生成摘要
    let summary = null;
    if (typeof sessionPath === "string" && sessionPath) {
      try {
        summary = await engine.summarizeActivity(sessionPath, undefined, { agentId });
      } catch {}
    }

    const entry = {
      id,
      type,
      label: label || null,
      agentId,
      agentName,
      startedAt,
      finishedAt,
      summary: (() => {
        const isZhS = getLocale().startsWith("zh");
        const hbLabel = isZhS ? "日常巡检" : "routine patrol";
        const cronLabel = isZhS ? "定时任务" : "cron job";
        const failSuffix = isZhS ? "执行失败" : "execution failed";
        if (failed) return `${label || (type === "heartbeat" ? hbLabel : cronLabel)} ${failSuffix}`;
        return summary || (type === "heartbeat" ? hbLabel : (label || cronLabel));
      })(),
      sessionFile: typeof sessionPath === "string" ? path.basename(sessionPath) : null,
      status: failed ? "error" : "done",
      error: error || null,
    };

    // 小手机事件聚合：把 consumer 的 summaryZh / eventCount 挂到 activity_update 负载，
    // 让前端（PhoneHome）订阅 activities store 即可拿到本次巡检消费了哪些事件。
    // 仅主巡检（onBeat 传了 xingyeConsumed）带；笺子巡检 / cron 不带。
    if (xingyeConsumed?.result) {
      const r = xingyeConsumed.result;
      if (typeof r.summaryZh === "string" && r.summaryZh) entry.summaryZh = r.summaryZh;
      if (typeof r.eventCount === "number") entry.consumedCount = r.eventCount;
    }

    // 写入对应 agent 的 ActivityStore
    engine.getActivityStore(agentId).add(entry);

    // WS 广播
    this._hub.eventBus.emit({ type: "activity_update", activity: entry }, null);

    if (failed) {
      const isZhR = getLocale().startsWith("zh");
      const reason = error || (isZhR ? "后台任务未生成 session" : "background task produced no session");
      engine.emitDevLog(`[${type}] ${label || "后台任务"} 失败: ${reason}`, "error");
      throw new Error(reason);
    }

    engine.emitDevLog(`活动记录: ${entry.summary}`, "heartbeat");
  }

  /**
   * @returns {Promise<{consumed:number, result?:object} | null>}
   *   返回 runXingyeHeartbeatConsumer 的结构化结果，给 onBeat 回传上去。失败 / 异常返回 null。
   */
  async _runXingyeHeartbeatConsumer(agentId, agent) {
    try {
      const agentDir = agent?.agentDir || path.join(this._engine.agentsDir, agentId);
      // peers：当前可联系的其它 agent（已排除自己），供 social staleness 算 per-peer
      // 候选。取不到（旧 agent / 无 channels）就给 []，consumer 内部 shouldSocialize 恒 false。
      let peers = [];
      try { peers = agent?.listPeerAgents?.() || []; } catch {}
      // 社交阈值现读 agent config（每拍都读 → 用户在设置里改完，下一拍即生效，无需 reload）。
      const socialThresholds = resolveSocialThresholds(agent?.config?.desk);
      const result = await runXingyeHeartbeatConsumer({ agentId, agentDir, peers, socialThresholds });
      return result || null;
    } catch (err) {
      log.error(`[xingye] heartbeat consumer failed (${agentId}): ${err.message}`);
      this._engine.emitDevLog?.(`[xingye] heartbeat consumer failed: ${err.message}`, "error");
      return null;
    }
  }

}
