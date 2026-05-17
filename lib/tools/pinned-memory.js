/**
 * pinned-memory.js — pin_memory / unpin_memory 自定义工具
 *
 * 让 agent 通过工具调用来管理置顶记忆，替代之前在 yuan.md 中
 * 指导 agent 手动 read→append→write pinned.md 的方式。
 */

import { Type } from "../pi-sdk/index.js";
import { t } from "../../server/i18n.js";
import fs from "node:fs";
import path from "node:path";
import { scrubPII } from "../pii-guard.js";
import { atomicWriteSync } from "../../shared/safe-fs.js";
import { appendXingyeEvent } from "../xingye/events.js";

/**
 * 创建 pin_memory + unpin_memory 工具
 * @param {string} agentDir - agent 数据目录（pinned.md 在这里）
 * @param {string} [agentId] - agent id（用于写 xingye event log；未提供时不打事件）
 * @returns {[import('../pi-sdk/index.js').ToolDefinition, import('../pi-sdk/index.js').ToolDefinition]}
 */
export function createPinnedMemoryTools(agentDir, agentId) {
  const pinnedPath = path.join(agentDir, "pinned.md");

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
      console.warn(`[pin_memory] event log append failed: ${err?.message || err}`);
    }
  };

  const countPins = (raw) => raw.split("\n").filter((line) => line.trim().length > 0).length;

  const readPinned = () => {
    try { return fs.readFileSync(pinnedPath, "utf-8"); } catch { return ""; }
  };

  // 把 pinned.md 解析成 [{ raw, content }] —— content 是去掉 "- " 前缀和首尾空格后的内容，
  // 用于精确匹配；raw 用于写回时尽量保留原行（包括空行）。
  const parsePins = (raw) => raw.split("\n").map((line) => ({
    raw: line,
    content: line.replace(/^-\s*/, "").trim(),
  }));

  const writePinned = (content) => {
    atomicWriteSync(pinnedPath, content);
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
        console.warn(`[pin_memory] PII detected (${detected.join(", ")}), redacted before storage`);
      }

      const existing = readPinned();
      const content = cleaned;
      const newLine = `- ${content}`;

      // 按行精确比对，避免子串误判（pin "foo" 不应被 "foobar" 阻断）。
      const existingContents = parsePins(existing)
        .map((p) => p.content)
        .filter(Boolean);
      if (existingContents.includes(content)) {
        return {
          content: [{ type: "text", text: t("error.pinnedAlreadyExists") }],
          details: {},
        };
      }

      const updated = existing.trimEnd()
        ? existing.trimEnd() + "\n" + newLine + "\n"
        : newLine + "\n";
      writePinned(updated);

      await emitPinnedChanged({
        action: "pin",
        pinsCount: countPins(updated),
        addedBullet: content,
      });

      return {
        content: [{ type: "text", text: t("error.pinnedAdded", { content }) }],
        details: {},
      };
    },
  };

  const unpinTool = {
    name: "unpin_memory",
    label: t("toolDef.pinnedMemory.unpinLabel"),
    description: t("toolDef.pinnedMemory.unpinDescription"),
    parameters: Type.Object({
      keyword: Type.String({ description: t("toolDef.pinnedMemory.unpinKeywordDesc") }),
    }),
    execute: async (_toolCallId, params) => {
      const existing = readPinned();
      if (!existing.trim()) {
        return {
          content: [{ type: "text", text: t("error.pinnedEmpty") }],
          details: {},
        };
      }

      const keyword = params.keyword;
      const keywordTrim = keyword.trim();
      const keywordLower = keyword.toLowerCase();
      const parsed = parsePins(existing);

      // 优先精确匹配：用户输入恰好等于某条 pin 的 content 时只删那条，
      // 避免「pin 了 foo 和 foobar，unpin foo 把两条都删掉」的过度删除。
      // 找不到精确匹配再回退到 i18n 描述里承诺的「模糊匹配」（子串、不区分大小写）。
      const exactHits = parsed.some((p) => p.content && p.content === keywordTrim);

      const remaining = [];
      const removed = [];
      for (const entry of parsed) {
        const matches = entry.content && (
          exactHits
            ? entry.content === keywordTrim
            : entry.content.toLowerCase().includes(keywordLower)
        );
        if (matches) {
          removed.push(entry.content);
        } else {
          remaining.push(entry.raw);
        }
      }

      if (removed.length === 0) {
        return {
          content: [{ type: "text", text: t("error.pinnedNotFound", { keyword }) }],
          details: {},
        };
      }

      const nextRaw = remaining.join("\n");
      writePinned(nextRaw);

      await emitPinnedChanged({
        action: "unpin",
        pinsCount: countPins(nextRaw),
        removedCount: removed.length,
        keyword: params.keyword,
      });

      return {
        content: [{ type: "text", text: t("error.pinnedRemoved", { count: removed.length, items: removed.join(", ") }) }],
        details: { removedCount: removed.length },
      };
    },
  };

  return [pinTool, unpinTool];
}
