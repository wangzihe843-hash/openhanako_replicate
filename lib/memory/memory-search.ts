/**
 * memory-search.js — search_memory 工具（v2 标签检索）
 *
 * 替代 v1 的 embedding KNN + 混合排序 + 链接展开。
 * v2 用标签匹配 + 日期过滤 + FTS5 全文搜索兜底。
 *
 * 标签由 LLM 在元事实拆分时生成，也由 LLM 在搜索时生成查询标签，
 * 两边的"语言习惯"天然接近，一致性有保障。
 */

import { Type } from "../pi-sdk/index.ts";
import { t } from "../i18n.ts";
import { createModuleLogger } from "../debug-log.ts";

const log = createModuleLogger("memory-search");

const TAG_LIMIT = 12;
const FTS_LIMIT = 8;
const RESULT_LIMIT = 15;
const OUTPUT_CHAR_LIMIT = 12000;
const FACT_EXCERPT_LIMIT = 450;

function factExcerpt(fact: string, query: string, source: string): string {
  if (fact.length <= FACT_EXCERPT_LIMIT) return fact;
  const needle = source === 'fts' ? query.trim().toLocaleLowerCase() : '';
  const hit = needle ? fact.toLocaleLowerCase().indexOf(needle) : -1;
  const start = hit > 100 ? hit - 100 : 0;
  const excerpt = fact.slice(start, start + FACT_EXCERPT_LIMIT);
  return `${start > 0 ? '…' : ''}${excerpt}${start + FACT_EXCERPT_LIMIT < fact.length ? '…' : ''}`;
}

/**
 * 创建 search_memory 工具定义
 * @param {import('./fact-store.ts').FactStore} factStore
 * @param {object} [opts]
 * @param {function} [opts.getMemoryMasterEnabled] - 返回 agent 级别记忆总开关状态
 * @param {{kind:"channel", channelId:string}} [opts.conversationScope]
 *   - 会话作用域。频道 phone 会话注入后，默认排除其它频道的事实；
 *     scoped 实例的 schema 额外暴露 cross_channel 参数供显式跨频道检索
 * @returns {import('../pi-sdk/index.ts').ToolDefinition}
 */
export function createMemorySearchTool(factStore, opts: any = {}) {
  const conversationScope = opts.conversationScope?.kind === "channel" && opts.conversationScope.channelId
    ? { kind: "channel" as const, channelId: String(opts.conversationScope.channelId) }
    : null;
  return {
    name: "search_memory",
    label: t("error.memorySearchLabel"),
    description: t("error.memorySearchDesc"),
    parameters: Type.Object({
      query: Type.String({ description: t("error.memorySearchQueryDesc") }),
      tags: Type.Optional(
        Type.Array(Type.String(), {
          description: t("error.memorySearchTagsDesc"),
        }),
      ),
      date_from: Type.Optional(
        Type.String({ description: t("error.memorySearchDateFromDesc") }),
      ),
      date_to: Type.Optional(
        Type.String({ description: t("error.memorySearchDateToDesc") }),
      ),
      ...(conversationScope ? {
        cross_channel: Type.Optional(
          Type.Boolean({ description: t("error.memorySearchCrossChannelDesc") }),
        ),
      } : {}),
    }),
    execute: async (_toolCallId, params) => {
      try {
        const t0 = performance.now();

        if (factStore.size === 0) {
          return {
            content: [{ type: "text", text: t("error.memorySearchEmpty") }],
            details: {},
          };
        }

        const dateRange: { from?: string; to?: string } = {};
        if (params.date_from) dateRange.from = params.date_from;
        if (params.date_to) dateRange.to = params.date_to + "T23:59";

        const results: Array<{ id: string | number; fact: string; tags: string[]; time?: string | null; source: 'tag' | 'fts' }> = [];
        const seenIds = new Set<string | number>();

        const searchScope = conversationScope && params.cross_channel !== true ? conversationScope : null;
        const searchDateRange = Object.keys(dateRange).length > 0 ? dateRange : undefined;

        // 策略 1：标签匹配（优先）
        if (params.tags && params.tags.length > 0) {
          const tagResults = factStore.searchByTags(
            params.tags,
            searchDateRange,
            TAG_LIMIT,
            searchScope,
          );
          for (const r of tagResults) {
            seenIds.add(r.id);
            results.push({ ...r, source: "tag" });
          }
        }

        // 即使宽泛标签已命中，仍为原查询保留 FTS 名额。
        if (params.query?.trim()) {
          const ftsResults = factStore.searchFullText(params.query, FTS_LIMIT, {
            scope: searchScope,
            dateRange: searchDateRange,
          });
          for (const r of ftsResults) {
            if (seenIds.has(r.id)) {
              const existing = results.find((row) => row.id === r.id);
              if (existing) existing.source = 'fts';
              continue;
            }
            seenIds.add(r.id);
            results.push({ ...r, source: "fts" });
          }
        }
        results.splice(RESULT_LIMIT);

        const elapsed = performance.now() - t0;
        log.log(
          `${elapsed.toFixed(0)}ms | ` +
          `hits: ${results.length} (tag: ${results.filter((r) => r.source === "tag").length}, ` +
          `fts: ${results.filter((r) => r.source === "fts").length})`,
        );

        if (results.length === 0) {
          return {
            content: [{ type: "text", text: t("error.memorySearchEmpty") }],
            details: {},
          };
        }

        // 格式化输出
        let remaining = OUTPUT_CHAR_LIMIT;
        const lines: string[] = [];
        for (const r of results) {
          const rawTags = r.tags.length > 0 ? r.tags.join(", ") : "";
          const tagsStr = rawTags ? ` (${rawTags.slice(0, 150)}${rawTags.length > 150 ? '…' : ''})` : "";
          const timeStr = r.time ? ` — ${String(r.time).slice(0, 50)}` : "";
          const line = `${lines.length + 1}. ${factExcerpt(String(r.fact), params.query || '', r.source)}${tagsStr}${timeStr}`;
          if (line.length > remaining) continue;
          lines.push(line);
          remaining -= line.length + 1;
        }

        if (lines.length === 0) {
          return { content: [{ type: 'text', text: t('error.memorySearchEmpty') }], details: { resultCount: 0 } };
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { resultCount: lines.length },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: t("error.memorySearchError", { msg: err.message }) }],
          details: {},
        };
      }
    },
  };
}
