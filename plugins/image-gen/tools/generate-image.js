/**
 * plugins/image-gen/tools/generate-image.js
 *
 * Non-blocking image generation. Registers a local task immediately, then
 * submits to the provider in the background. Completion is delivered through
 * Poller + DeferredResultStore.
 */
import { submitImageGeneration } from "../lib/submit-image.js";

export const name = "generate-image";
export const description =
  "根据文字描述生成图片。非阻塞：提交后立即返回，完成后自动显示。";

export const parameters = {
  type: "object",
  properties: {
    prompt:     { type: "string", description: "图片描述（中英文均可）" },
    count:      { type: "number", description: "并发生成张数，默认 1，最大 9" },
    image:      { type: "string", description: "参考图路径（图生图）" },
    ratio:      { type: "string", description: "长宽比：1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 21:9" },
    resolution: { type: "string", description: "分辨率：2k, 4k（默认 2k）" },
    model:      { type: "string", description: "模型 ID 或简称（如 5.0、dall-e-3）。省略时使用已配置的默认模型" },
    provider:   { type: "string", description: "指定 provider（可选）" },
  },
  required: ["prompt"],
};

export async function execute(input, ctx) {
  let result;
  try {
    result = await submitImageGeneration({ input, ctx });
  } catch (err) {
    return { content: [{ type: "text", text: err?.message || String(err) }] };
  }

  const text = `已提交 ${result.tasks.length} 张图片生成，完成后会自动显示在下方卡片中。`;

  return {
    content: [{ type: "text", text }],
    details: {
      mediaGeneration: {
        kind: "image",
        batchId: result.batchId,
        prompt: input.prompt,
        tasks: result.tasks,
      },
    },
  };
}
