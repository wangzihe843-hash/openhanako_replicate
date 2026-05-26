export const name = "list-capabilities";
export const description = "列出 Beautify 工具目前支持的审美增强能力。";

export { isBeautifyEnabledForAgentConfig as isEnabledForAgentConfig } from "../lib/availability.js";

export const parameters = {
  type: "object",
  properties: {},
};

export async function execute() {
  return {
    content: [{
      type: "text",
      text: "Beautify 当前支持 Markdown cover 工作流：先读取封面风格说明，再准备一张图片，可以来自生图工具、未来的内置头图库或用户本地图片，最后把图片复制到附件文件夹并写入 cover frontmatter。",
    }],
    details: {
      capabilities: [{
        id: "markdown-cover",
        target: "markdown",
        tools: ["beautify_get-cover-style-guide", "beautify_create-cover", "beautify_apply-cover-candidate"],
        imageRatio: "3:2",
        responsibility: "apply-existing-image",
      }],
    },
  };
}
