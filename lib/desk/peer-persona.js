/**
 * peer-persona.js — 读取「别的 agent 的对外人设」供花名册展示
 *
 * 背景：agent 之间原本只能看到对方的 id + name + description.md（一行干巴的岗位摘要），
 * 导致「X 是谁」答不上来、甚至把 peer 当成用户。每个 agent 其实有一份 public-ishiki.md
 * （对外意识，专为"给外人看"设计），这里把它紧凑化后塞进花名册，让 peer 之间能真正
 * 「对得上人设 / 对得上号」。
 *
 * 只读 peer 已落盘的 public-ishiki.md（agent 创建时从模板拷入、已按其 locale 解析）；
 * 文件缺失/为空 → 返回 ""，调用方回退到 description.md。
 */

import path from "path";
import { safeReadFile } from "../../shared/safe-fs.js";

/** 花名册里每个 peer 人设的截断长度（按字符；中文友好）。 */
export const PEER_PERSONA_MAX_CHARS = 240;

/** 在 maxChars 附近找句末/词边界截断，附加省略号。 */
function truncateAtBoundary(text, maxChars) {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  // 优先句末标点，其次空格；都没有就硬切
  const punct = Math.max(
    slice.lastIndexOf("。"), slice.lastIndexOf("！"), slice.lastIndexOf("？"),
    slice.lastIndexOf("."), slice.lastIndexOf("!"), slice.lastIndexOf("?"),
  );
  if (punct >= maxChars * 0.6) return slice.slice(0, punct + 1);
  const space = slice.lastIndexOf(" ");
  const cut = space >= maxChars * 0.6 ? slice.slice(0, space) : slice;
  return `${cut.trim()}…`;
}

/**
 * 读取并紧凑化一个 peer 的对外人设。
 *
 * @param {object} opts
 * @param {string} opts.agentsDir - agents 根目录
 * @param {string} opts.peerId    - 目标 agent id
 * @param {string} [opts.peerName] - 目标 agent 显示名（填充 {{agentName}}）
 * @param {string} [opts.userName] - 共享用户名（填充 {{userName}}；user 跨 agent 共享）
 * @param {number} [opts.maxChars]
 * @returns {string} 紧凑人设；文件缺失/为空 → ""
 */
export function readCompactPeerPersona({ agentsDir, peerId, peerName, userName, maxChars = PEER_PERSONA_MAX_CHARS } = {}) {
  if (!agentsDir || !peerId) return "";
  const raw = safeReadFile(path.join(agentsDir, peerId, "public-ishiki.md"), "");
  if (!raw || !raw.trim()) return "";
  const text = raw
    .replace(/\{\{userName\}\}/g, userName || "")
    .replace(/\{\{agentName\}\}/g, peerName || peerId)
    .replace(/\{\{agentId\}\}/g, peerId)
    .replace(/\{\{[^}]*\}\}/g, "")        // 剩余未知占位符
    .replace(/<!--[\s\S]*?-->/g, "")      // HTML 注释
    .replace(/^#{1,6}\s+.*$/gm, "")       // markdown 标题行（# 标题）
    .replace(/[*_`>]/g, "")               // 轻量去 markdown 强调/引用符号
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  return truncateAtBoundary(text, maxChars);
}
