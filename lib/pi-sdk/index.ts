/**
 * PI SDK Adapter — 所有 PI SDK 导入的唯一入口
 *
 * 稳定 API 直接 re-export，不稳定 API 通过适配函数封装。
 * 消费方不应直接 import "@earendil-works/..."，全部从这里导入。
 *
 * 纪律：
 *   - 不接受 engine / agent / config 参数
 *   - 不拼 session options（compaction、thinkingLevel 等）
 *   - 不做工具过滤 / plan mode 逻辑
 *   - 不持有任何状态
 */

import {
  createAgentSession as rawCreateAgentSession,
  ModelRegistry,
  resizeImage as rawResizeImage,
  formatDimensionNote as rawFormatDimensionNote,
  convertToLlm as rawConvertToLlm,
} from "@earendil-works/pi-coding-agent";
// 0.80.0 起 pi-ai 老全局 API 移到 /compat 子入口（根入口是 createModels 新 API）
import {
  getModel as rawGetPiModel,
  completeSimple as rawCompleteSimple,
} from "@earendil-works/pi-ai/compat";
import {
  normalizeCreateAgentSessionOptions,
  PI_BUILTIN_TOOL_NAMES,
} from "./session-options.ts";
import { installAssistantStreamGuard } from "./stream-guard.ts";
import {
  createFindTool,
  createGrepTool,
} from "./search-tools.ts";
// prepareCompaction 0.80.3 仍未从包根导出，深路径保留（升级时必查此文件是否存在）
import {
  prepareCompaction as rawPrepareCompaction,
} from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js";

// ── Session 管理 ──
export { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

/**
 * Hana 侧保持稳定的 Tool[] 调用契约，适配层负责转换 Pi SDK 版本差异。
 *
 * Pi SDK 0.68+ 将 `tools` 改成 string[] allowlist；Hana 的沙盒工具仍然
 * 是 session 级对象，必须先注册为同名 customTools，再用名字启用。
 *
 * @param {object} options
 */
export async function createAgentSession(options) {
  const resourceLoaderAgentDir = options?.resourceLoader?.agentDir;
  const sessionOptions = !options?.agentDir && typeof resourceLoaderAgentDir === "string" && resourceLoaderAgentDir
    ? { ...options, agentDir: resourceLoaderAgentDir }
    : options;
  const result = await rawCreateAgentSession(normalizeCreateAgentSessionOptions(sessionOptions));
  installAssistantStreamGuard(result?.session);
  return result;
}

// ── 内置工具名常量 ──
export { PI_BUILTIN_TOOL_NAMES };

// ── 工具工厂（沙盒用）──
export {
  createReadTool, createWriteTool, createEditTool, createBashTool,
  createLsTool,
} from "@earendil-works/pi-coding-agent";
export { createGrepTool, createFindTool };

// ── 资源加载 ──
export { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

// ── Utilities ──
export { formatSkillsForPrompt, getLastAssistantUsage } from "@earendil-works/pi-coding-agent";
export { AuthStorage } from "@earendil-works/pi-coding-agent";

// ── Session/history utilities ──
export {
  estimateTokens, findCutPoint,
  serializeConversation, shouldCompact,
  parseSessionEntries, buildSessionContext,
} from "@earendil-works/pi-coding-agent";

// Diary material summarization only. Context compaction must go through core/session-compactor.js.
export { generateSummary } from "@earendil-works/pi-coding-agent";

export const completeSimple = rawCompleteSimple;
export const convertAgentMessagesToLlm = rawConvertToLlm;
export const prepareCompaction = rawPrepareCompaction;

// ── pi-ai（直接依赖，需保持与 pi-coding-agent 内部依赖同版本）──
export { StringEnum } from "@earendil-works/pi-ai";
// 注意：pi-coding-agent 因上游发布物携带 overrides 被 npm 子树隔离，
// 其下嵌套着第二份 pi-ai，模块级 oauth registry 与根实例互不可见。
// 此导出只作用于根 pi-ai 实例，pi session 内部的凭证解析（走嵌套实例）
// 看不到经由这里注册的 provider。当前生产零消费方；是否移除待用户决定。
export { registerOAuthProvider } from "@earendil-works/pi-ai/oauth";

export function getPiModel(provider, modelId) {
  return rawGetPiModel(provider, modelId);
}

// ── Schema 构造（typebox 的 Type 透过 adapter，避免工具直接依赖第三方包名）──
export { Type } from "typebox";

// ── 类型 re-export（供 JSDoc 引用）──
/** @typedef {import('@earendil-works/pi-coding-agent').ToolDefinition} ToolDefinition */

// ── Lifecycle helpers ──

/**
 * Emit `session_shutdown` event to the session's extension runner.
 *
 * 为什么在 adapter 层实现而不从 SDK 导出:
 *   SDK 的 emitSessionShutdownEvent 辅助函数只在 core/extensions/runner.js
 *   内部暴露, 顶级 index.js 未 re-export。直接 import 深层路径会违反
 *   adapter 纪律。实现本身仅 7 行, 自己实现更干净。
 *
 * 契约: AgentSession.dispose() 本身不 emit shutdown, 调用方必须在
 *   dispose 前显式 emit, 否则监听 session_shutdown 的扩展(如
 *   deferred-result-ext) 无法清理自身的 setInterval 和 store 订阅,
 *   导致长期运行进程的内存泄漏。
 *
 * @param {object} session - AgentSession 实例
 * @returns {Promise<boolean>} 事件是否被 emit (false = 无 handler)
 */
export async function emitSessionShutdown(session) {
  const runner = session?.extensionRunner;
  if (runner?.hasHandlers?.("session_shutdown")) {
    await runner.emit({ type: "session_shutdown" });
    return true;
  }
  return false;
}

// ── 不稳定 API 适配 ──

/**
 * 图片缩放适配。
 *
 * 0.80.3 起上游签名为 `resizeImage(inputBytes: Uint8Array, mimeType, options?)`
 * （0.70.x 是 `(img: ImageContent, options?)`），且内部吞错返回 null。
 * Hana 消费侧（core/model-image-preprocess.ts）契约保持不变：
 * 传 `{data: base64, mimeType}` 对象，本层负责解码与拆参。
 * 返回结构 `ResizedImage` 两版一致，null 仍表示"压不进 maxBytes / 解码失败"。
 *
 * @param {{type?: string, data: string, mimeType?: string}} image
 * @param {{maxWidth?: number, maxHeight?: number, maxBytes?: number, jpegQuality?: number}} options
 */
export async function resizeModelImageInput(image, options) {
  const inputBytes = Buffer.from(String(image?.data ?? ""), "base64");
  return rawResizeImage(inputBytes, image?.mimeType, options);
}

/**
 * @param {{wasResized?: boolean, originalWidth: number, originalHeight: number, width: number, height: number}} result
 */
export function formatModelImageDimensionNote(result) {
  return rawFormatDimensionNote(result);
}

/**
 * ModelRegistry 工厂。
 * 0.64.0 将构造函数私有化，必须用静态方法。
 * 下次 SDK 改工厂签名，只改这里。
 * @param {import('@earendil-works/pi-coding-agent').AuthStorage} authStorage
 * @param {string} [modelsJsonPath]
 * @returns {import('@earendil-works/pi-coding-agent').ModelRegistry}
 */
export function createModelRegistry(authStorage, modelsJsonPath) {
  return ModelRegistry.create(authStorage, modelsJsonPath);
}

/**
 * 强制 session 从 ModelRegistry 重新解析当前 model 对象。
 *
 * 为什么需要：Pi SDK 的 model 对象把 baseUrl 烤在字段里
 * （openai-completions.js 等 provider 直接读 model.baseUrl 构造 client），
 * session 持有的是创建时的对象引用。当 ModelRegistry.refresh() 重建模型
 * 表后，session 仍指向旧对象，导致改完 base_url / api 等字段后 active
 * session 用旧值发请求，必须重启或切换 session 才生效。
 *
 * SDK 内部有 _refreshCurrentModelFromRegistry()，但只在 extension
 * registerProvider/unregisterProvider 时被调用，没有公开包装。
 * 这里走 adapter 纪律统一桥接，下次 SDK 升级改名只改这里。
 *
 * @param {object} session - AgentSession 实例
 */
export function refreshSessionModelFromRegistry(session) {
  session?._refreshCurrentModelFromRegistry?.();
}
