import {
  COVER_STYLE_GUIDE_VERSION,
  buildCoverStyleGuideForAgent,
} from "../lib/cover-style-guide.js";
import { isBeautifyEnabledForAgentConfig } from "../lib/availability.js";

export const name = "get-cover-style-guide";
export const description =
  "当用户想为 Markdown 文档生成、替换、优化封面/头图/cover 时，先调用本工具读取 Hana 的封面审美规范；再根据文章内容写生图 prompt 或选择图片。";

export { isBeautifyEnabledForAgentConfig as isEnabledForAgentConfig };

export const parameters = {
  type: "object",
  properties: {
    themeTone: {
      type: "string",
      enum: ["light", "dark"],
      description: "当前 UI 主题明暗倾向；不确定时传 light。",
    },
    userGuidance: {
      type: "string",
      description: "用户额外给出的风格方向，可选。",
    },
  },
};

export async function execute(input = {}) {
  const themeTone = input.themeTone === "dark" ? "dark" : "light";
  const userGuidance = typeof input.userGuidance === "string" ? input.userGuidance.trim() : "";
  return {
    content: [{
      type: "text",
      text: buildCoverStyleGuideForAgent({ themeTone, userGuidance }),
    }],
    details: {
      version: COVER_STYLE_GUIDE_VERSION,
      themeTone,
      workflow: [
        "确认目标 Markdown 路径",
        "调用 beautify_get-cover-style-guide",
        "阅读文章并按 style guide 写生图 prompt 或选择图片",
        "准备已有图片",
        "调用 beautify_create-cover 应用图片",
      ],
    },
  };
}
