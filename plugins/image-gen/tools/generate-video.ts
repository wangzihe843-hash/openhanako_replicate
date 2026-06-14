/**
 * plugins/image-gen/tools/generate-video.js
 *
 * Non-blocking video generation. Delegates to the universal media manager,
 * which owns adapter selection, task metadata, deferred notifications, and
 * polling.
 */
import { t } from "../../../lib/i18n.ts";

export const name = "generate-video";
export const description = t("toolDef.generateVideo.description");

export const parameters = {
  type: "object",
  properties: {
    prompt:   { type: "string", description: t("toolDef.generateVideo.promptDesc") },
    image:    { type: "string", description: t("toolDef.generateVideo.imageDesc") },
    duration: { type: "number", description: t("toolDef.generateVideo.durationDesc") },
    ratio:    { type: "string", description: t("toolDef.generateVideo.ratioDesc") },
    resolution: { type: "string", description: "Optional video resolution or provider-specific resolution tier." },
    mode:     { type: "string", description: "Optional provider mode such as text2video or image2video." },
    model:    { type: "string", description: t("toolDef.generateVideo.modelDesc") },
    provider: { type: "string", description: t("toolDef.generateVideo.providerDesc") },
    options: {
      type: "object",
      description: "Provider-specific optional generation parameters. Use media option discovery before filling uncommon keys.",
      additionalProperties: true,
    },
  },
  required: ["prompt"],
};

export async function execute(input, ctx) {
  if (typeof ctx?.bus?.request !== "function") {
    return { content: [{ type: "text", text: t("toolDef.generateVideo.notInitialized") }] };
  }

  const videoInput = {
    prompt: input.prompt,
    ...(input.image && { image: input.image }),
    ...(input.duration && { duration: input.duration }),
    ...(input.ratio && { ratio: input.ratio }),
    ...(input.resolution && { resolution: input.resolution }),
    ...(input.mode && { mode: input.mode }),
    ...(input.model && { model: input.model }),
    ...(input.provider && { provider: input.provider }),
    ...(input.options && typeof input.options === "object" && !Array.isArray(input.options) ? { options: input.options } : {}),
  };

  let result;
  try {
    result = await ctx.bus.request("media:generate-video", {
      sessionPath: ctx.sessionPath,
      input: videoInput,
      ...(ctx.bridgeContext ? { bridgeContext: ctx.bridgeContext } : {}),
      ...(ctx.pluginId ? { pluginId: ctx.pluginId } : {}),
    });
  } catch (err) {
    return {
      content: [{ type: "text", text: t("toolDef.generateVideo.submitFailed", { error: err?.message || t("plugin.imageGen.unknownError") }) }],
    };
  }

  const tasks = Array.isArray(result?.tasks)
    ? result.tasks.filter(task => task && typeof task.taskId === "string" && task.taskId)
    : [];
  if (!result?.ok || tasks.length === 0) {
    return {
      content: [{ type: "text", text: t("toolDef.generateVideo.submitFailedUnknown") }],
    };
  }

  return {
    content: [{ type: "text", text: t("toolDef.generateVideo.submitted") }],
    details: {
      mediaGeneration: {
        kind: "video",
        batchId: result.batchId,
        prompt: result.prompt || input.prompt,
        delivery: result.delivery,
        tasks,
      },
    },
  };
}
