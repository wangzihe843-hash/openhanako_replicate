import path from "node:path";
import { applyMarkdownCoverFromGeneratedFile } from "../lib/markdown-cover-service.js";
import { isBeautifyEnabledForAgentConfig } from "../lib/availability.js";

export const name = "apply-cover-candidate";
export const description = "把一个已有图片文件应用为 Markdown cover，并写回 frontmatter。";

export { isBeautifyEnabledForAgentConfig as isEnabledForAgentConfig };

export const parameters = {
  type: "object",
  properties: {
    targetFilePath: { type: "string", description: "Markdown 文件绝对路径。" },
    generatedFilePath: { type: "string", description: "已有图片的绝对路径，可以来自生图工具、内置头图或用户本地图片。" },
    pixelWidth: { type: "number", description: "图片像素宽，可选。" },
    pixelHeight: { type: "number", description: "图片像素高，可选。" },
  },
  required: ["targetFilePath", "generatedFilePath"],
};

export async function execute(input) {
  if (!input.targetFilePath || !path.isAbsolute(input.targetFilePath)) {
    return { content: [{ type: "text", text: "targetFilePath 必须是 Markdown 文件绝对路径。" }] };
  }
  if (!input.generatedFilePath || !path.isAbsolute(input.generatedFilePath)) {
    return { content: [{ type: "text", text: "generatedFilePath 必须是图片文件绝对路径。" }] };
  }

  try {
    const result = await applyMarkdownCoverFromGeneratedFile({
      markdownFilePath: input.targetFilePath,
      generatedFilePath: input.generatedFilePath,
      pixelWidth: input.pixelWidth,
      pixelHeight: input.pixelHeight,
    });
    return {
      content: [{ type: "text", text: "已应用 cover，并写入 Markdown frontmatter。" }],
      details: { beautifyCover: result },
    };
  } catch (err) {
    return { content: [{ type: "text", text: `应用 cover 失败：${err?.message || err}` }] };
  }
}
