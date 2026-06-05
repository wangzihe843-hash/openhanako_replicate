/**
 * pinned-memory.js — pin_memory / unpin_memory 自定义工具
 *
 * 让 agent 通过工具调用来管理置顶记忆，替代之前在 yuan.md 中
 * 指导 agent 手动 read→append→write pinned.md 的方式。
 */

import { Type } from "../pi-sdk/index.js";
import { t } from "../i18n.js";
import { scrubPII } from "../pii-guard.js";
import { appendXingyeEvent } from "../xingye/events.js";
import { createModuleLogger } from "../debug-log.js";
import {
  addPinnedMemoryItem,
  readPinnedMemoryItems,
  removePinnedMemoryItems,
} from "../memory/pinned-memory-store.js";

const log = createModuleLogger("pin_memory");

/**
 * 创建 pin_memory + unpin_memory 工具
 * @param {string} agentDir - agent 数据目录（pinned.md 在这里）
 * @param {string} [agentId] - agent id（用于写 xingye event log；未提供时不打事件）
 * @returns {[import('../pi-sdk/index.js').ToolDefinition, import('../pi-sdk/index.js').ToolDefinition]}
 */
export function createPinnedMemoryTools(agentDir, agentId) {
  const emitPinnedChanged = async (payload) => {
    if (!agentId) return;
    try {
      await appendXingyeEvent({
        agentDir,
        agentId,
        input: {
          type: "pinned_memory.changed",
          source: "pinned-memory-tool",
          payload,
        },
      });
    } catch (err) {
      log.warn(`event log append failed: ${err?.message || err}`);
    }
  };

  const pinTool = {
    name: "pin_memory",
    label: t("toolDef.pinnedMemory.pinLabel"),
    description: t("toolDef.pinnedMemory.pinDescription"),
    parameters: Type.Object({
      content: Type.String({ description: t("toolDef.pinnedMemory.pinContentDesc") }),
    }),
    execute: async (_toolCallId, params) => {
      const { cleaned, detected } = scrubPII(params.content);
      if (detected.length > 0) {
        log.warn(`PII detected (${detected.join(", ")}), redacted before storage`);
      }

      const content = cleaned;
      const result = addPinnedMemoryItem(agentDir, content);
      if (result.alreadyExists) {
        return {
          content: [{ type: "text", text: t("error.pinnedAlreadyExists") }],
          details: {},
        };
      }

      await emitPinnedChanged({
        action: "pin",
        pinsCount: result.items.length,
        addedBullet: content,
      });

      return {
        content: [{ type: "text", text: t("error.pinnedAdded", { content }) }],
        details: { item: result.item },
      };
    },
  };

  const unpinTool = {
    name: "unpin_memory",
    label: t("toolDef.pinnedMemory.unpinLabel"),
    description: t("toolDef.pinnedMemory.unpinDescription"),
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Pinned memory entity id returned by pin_memory" })),
      keyword: Type.Optional(Type.String({ description: t("toolDef.pinnedMemory.unpinKeywordDesc") })),
    }),
    execute: async (_toolCallId, params) => {
      const existing = readPinnedMemoryItems(agentDir);
      if (existing.length === 0) {
        return {
          content: [{ type: "text", text: t("error.pinnedEmpty") }],
          details: {},
        };
      }

      const result = removePinnedMemoryItems(agentDir, params);
      const removed = result.removed;

      if (removed.length === 0) {
        const keyword = params.keyword || params.id || "";
        return {
          content: [{ type: "text", text: t("error.pinnedNotFound", { keyword }) }],
          details: {},
        };
      }

      await emitPinnedChanged({
        action: "unpin",
        pinsCount: result.items.length,
        removedCount: removed.length,
        keyword: params.keyword,
      });

      return {
        content: [{ type: "text", text: t("error.pinnedRemoved", { count: removed.length, items: removed.map(item => item.content).join(", ") }) }],
        details: { removedCount: removed.length, removedItems: removed },
      };
    },
  };

  return [pinTool, unpinTool];
}
