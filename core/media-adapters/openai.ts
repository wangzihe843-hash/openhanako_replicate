// core/media-adapters/openai.ts
import fs from "fs";
import path from "path";
import { saveImage } from "../media/download.ts";
import { resolveModelId } from "./model-catalog.ts";
import {
  OPENAI_FLEXIBLE_IMAGE_RATIOS,
  OPENAI_FLEXIBLE_RESOLUTION_TIERS,
  OPENAI_STANDARD_IMAGE_RATIOS,
  OPENAI_STANDARD_RESOLUTION_TIERS,
  resolveOpenAiImageSize,
} from "./resolution-tiers.ts";
import { t } from "../../lib/i18n.ts";
import { redactLogText } from "../../lib/log-redactor.ts";

const SUNBURST_ID = "gpt-image-2.5-sunburst";

const FORMAT_TO_MIME = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

const DALL_E_3_SIZES = new Set(["1024x1024", "1792x1024", "1024x1792"]);
const DALL_E_3_SIZE_BY_RATIO = {
  "1:1": "1024x1024",
  "16:9": "1792x1024",
  "9:16": "1024x1792",
};

function assertOfficialImageModelAvailable(modelId, endpoint) {
  // https://developers.openai.com/api/docs/deprecations — keep proxy IDs usable.
  const retiredOn = modelId === "gpt-image-1" ? "2026-10-23"
    : modelId === "dall-e-3" ? "2026-05-12" : null;
  if (!retiredOn) return;
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return;
  }
  if (url.origin === "https://api.openai.com"
    && (url.pathname === "/v1/images/generations" || url.pathname === "/v1/images/edits")) {
    throw new Error(`OpenAI image model "${modelId}" was retired on ${retiredOn}; new image requests to the official API are no longer supported.`);
  }
}

function normalizeImages(image) {
  if (!image) return [];
  return (Array.isArray(image) ? image : [image]).filter((item) => typeof item === "string" && item.trim());
}

function isDallE3(modelId) {
  return String(modelId || "").toLowerCase() === "dall-e-3";
}

function normalizeDallE3SizeInput(value, ratio) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (DALL_E_3_SIZES.has(raw)) return raw;
  const normalized = raw.toLowerCase();
  if (normalized === "1k" || normalized === "auto") {
    return DALL_E_3_SIZE_BY_RATIO[ratio || "1:1"] || DALL_E_3_SIZE_BY_RATIO["1:1"];
  }
  throw new Error(`OpenAI DALL-E 3 size "${raw}" is unsupported`);
}

function resolveDallE3Size(params, providerDefaults: any = {}) {
  const ratio = params.aspect_ratio
    || params.aspectRatio
    || params.ratio
    || providerDefaults.aspect_ratio
    || providerDefaults.aspectRatio
    || providerDefaults.ratio;
  if (ratio && !DALL_E_3_SIZE_BY_RATIO[ratio]) {
    throw new Error(`OpenAI DALL-E 3 ratio "${ratio}" is unsupported`);
  }
  return normalizeDallE3SizeInput(params.size || params.resolution || providerDefaults.size || providerDefaults.resolution, ratio)
    || (ratio ? DALL_E_3_SIZE_BY_RATIO[ratio] : null);
}

function imageMime(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" }[ext] || "image/png";
}

function imageJsonRef(image) {
  if (/^https?:\/\//i.test(image)) return { image_url: image };
  if (/^file-[A-Za-z0-9_-]+/.test(image)) return { file_id: image };
  return null;
}

function buildEditJsonBody(body, images) {
  const refs = images.map(imageJsonRef);
  if (refs.every(Boolean)) return { ...body, images: refs };
  return null;
}

function buildEditMultipartBody(body, images) {
  if (!images.every((img) => path.isAbsolute(img) && fs.existsSync(img))) return null;
  const form = new FormData();
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue;
    form.append(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  for (const image of images) {
    const buf = fs.readFileSync(image);
    form.append("image[]", new Blob([buf], { type: imageMime(image) }), path.basename(image));
  }
  return form;
}

// Only the new built-in declaration uses this bounded subset. Custom provider
// IDs and the older GPT Image 2 protocol keep their existing behavior.
function assertSunburstRequest(params, body, images) {
  const allowed = (key, value, values) => {
    if (value !== undefined && !values.includes(value)) {
      throw new Error(`OpenAI Sunburst ${key} is unsupported`);
    }
  };
  allowed("resolution", params.resolution, ["1K"]);
  allowed("quality", body.quality, ["auto", "low", "medium", "high"]);
  allowed("format", body.output_format, ["png", "jpeg", "webp"]);
  allowed("background", body.background, ["auto", "opaque", "transparent"]);
  allowed("moderation", body.moderation, ["auto", "low"]);
  allowed("mode", params.mode, ["text2image", "image2image"]);
  if (!Number.isInteger(body.n) || body.n < 1 || body.n > 10) {
    throw new Error("OpenAI Sunburst n must be an integer between 1 and 10");
  }
  if (body.background === "transparent" && body.output_format === "jpeg") {
    throw new Error("OpenAI Sunburst transparent background requires png or webp");
  }
  if (body.output_compression !== undefined && (body.output_format === "png"
    || !Number.isInteger(body.output_compression) || body.output_compression < 0 || body.output_compression > 100)) {
    throw new Error("OpenAI Sunburst output_compression requires jpeg/webp and an integer between 0 and 100");
  }
  const rawImages = params.image == null ? [] : Array.isArray(params.image) ? params.image : [params.image];
  if (rawImages.length !== images.length || images.length > 16) {
    throw new Error("OpenAI Sunburst reference images must contain 1 to 16 non-empty references");
  }
  if ((params.mode === "image2image" && images.length === 0)
    || (params.mode === "text2image" && images.length > 0)) {
    throw new Error("OpenAI Sunburst reference images do not match the requested mode");
  }
  for (const key of ["mask", "stream", "partial_images", "input_fidelity"]) {
    if (params[key] !== undefined) throw new Error(`OpenAI Sunburst ${key} is unsupported`);
  }
}

function sunburstImageBuffers(data) {
  if (!Array.isArray(data?.data) || data.data.length === 0) throw new Error("API returned no images");
  // Check every image before saving any file: malformed base64 must not become
  // an empty/partial successful task through Buffer.from's permissive decoder.
  return data.data.map(image => {
    const encoded = image?.b64_json;
    if (typeof encoded !== "string" || !encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
      throw new Error("API returned invalid image base64");
    }
    const buffer = Buffer.from(encoded, "base64");
    if (!buffer.length || buffer.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) {
      throw new Error("API returned invalid image base64");
    }
    return buffer;
  });
}

export const openaiImageAdapter = {
  id: "openai",
  protocolId: "openai-images",
  name: "OpenAI Image",
  types: ["image"],
  capabilities: {
    ratios: [...OPENAI_STANDARD_IMAGE_RATIOS],
    resolutions: [...OPENAI_STANDARD_RESOLUTION_TIERS],
  },

  async checkAuth(ctx) {
    try {
      const creds = await ctx.bus.request("provider:credentials", { providerId: "openai" });
      if (creds.error || !creds.apiKey) {
        return { ok: false, message: creds.error || t("plugin.imageGen.apiKeyNotConfigured") };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err.message || String(err) };
    }
  },

  async submit(params, ctx) {
    const sunburst = (params.providerId || "openai") === "openai"
      && (params.modelId || params.model || ctx.config?.get?.("defaultImageModel")?.id) === SUNBURST_ID;
    try {
      // 1. Fetch credentials
      const providerId = params.credentialProviderId || params.providerId || "openai";
      const creds = await ctx.bus.request("provider:credentials", { providerId });
      if (creds.error || !creds.apiKey) {
        throw new Error(t("plugin.imageGen.providerNoApiKey", { providerId }));
      }

      const { apiKey, baseUrl } = creds;

      // 2. Resolve model — catalog 按媒体 provider 查：内置 openai 解析短名别名，
      //    自定义 OpenAI 兼容 provider 没有 catalog，模型 id 原样透传（不允许改写成 catalog 默认值）
      const mediaProviderId = params.providerId || "openai";
      const rawModel = params.modelId || params.model || ctx.config?.get?.("defaultImageModel")?.id || "gpt-image-1.5";
      const modelId = resolveModelId(mediaProviderId, rawModel);

      // 3. Get provider defaults — 与设置页的存储键一致（按媒体 providerId）
      const allDefaults = ctx.config?.get?.("providerDefaults") || {};
      const providerDefaults = allDefaults[mediaProviderId] || {};

      // 4. Translate params → API body
      const images = normalizeImages(params.image);
      const base = baseUrl.replace(/\/+$/, "");
      const endpoint = images.length > 0
        ? `${base}/images/edits`
        : `${base}/images/generations`;
      assertOfficialImageModelAvailable(modelId, endpoint);
      const flexible = !sunburst && String(modelId).startsWith("gpt-image-2");
      const effectiveRatio = params.aspect_ratio || params.aspectRatio || params.ratio || providerDefaults?.aspect_ratio;
      const body: any = isDallE3(modelId)
        ? {
          model: modelId,
          prompt: params.prompt,
          n: params.n || 1,
          response_format: "b64_json",
        }
        : {
          model: modelId,
          prompt: params.prompt,
          n: sunburst ? (params.n ?? 1) : (params.n || 1),
          output_format: params.format || providerDefaults?.format || "jpeg",
        };

      const size = isDallE3(modelId)
        ? resolveDallE3Size({ ...params, ratio: effectiveRatio }, providerDefaults)
        : resolveOpenAiImageSize(
          { ...params, ratio: effectiveRatio },
          providerDefaults,
          {
            sourceName: "OpenAI image",
            flexible,
            supportedRatios: flexible
              ? OPENAI_FLEXIBLE_IMAGE_RATIOS
              : OPENAI_STANDARD_IMAGE_RATIOS,
            supportedResolutions: flexible
              ? OPENAI_FLEXIBLE_RESOLUTION_TIERS
              : OPENAI_STANDARD_RESOLUTION_TIERS,
            defaultRatio: "3:2",
            defaultResolution: flexible ? "2K" : "1K",
          },
        );
      if (size) body.size = size;

      const quality = params.quality || providerDefaults?.quality;
      if (quality) body.quality = quality;

      if (isDallE3(modelId)) {
        if (params.style || providerDefaults?.style) body.style = params.style || providerDefaults.style;
      } else {
        const background = params.background || providerDefaults?.background;
        if (background) body.background = background;
        if (params.output_compression !== undefined || providerDefaults?.output_compression !== undefined) {
          body.output_compression = params.output_compression ?? providerDefaults.output_compression;
        }
        if (params.moderation || providerDefaults?.moderation) {
          body.moderation = params.moderation || providerDefaults.moderation;
        }
      }

      if (isDallE3(modelId) && images.length > 0) {
        throw new Error("OpenAI DALL-E 3 does not support reference images");
      }

      if (sunburst) assertSunburstRequest(params, body, images);

      // 6. Call HTTP API — OpenAI gpt-image 用 /images/edits 做图生图
      const jsonEditBody = images.length > 0 ? buildEditJsonBody(body, images) : null;
      const multipartEditBody = images.length > 0 && !jsonEditBody ? buildEditMultipartBody(body, images) : null;
      if (images.length > 0 && !jsonEditBody && !multipartEditBody) {
        throw new Error("OpenAI image edit reference must be an HTTP(S) URL, file_id, or local image file path");
      }
      const requestBody = images.length > 0 ? (multipartEditBody || JSON.stringify(jsonEditBody)) : JSON.stringify(body);
      const headers = {
        "Authorization": `Bearer ${apiKey}`,
      };
      if (!multipartEditBody) headers["Content-Type"] = "application/json";

      const res = await fetch(endpoint, {
        method: "POST",
        headers,
        body: requestBody,
      });

      if (!res.ok) {
        let msg = `API error ${res.status}`;
        try {
          const err = await res.json();
          if (err.error?.message) msg = `${msg}: ${err.error.message}`;
        } catch {}
        throw new Error(msg);
      }

      const data = await res.json();
      const buffers = sunburst ? sunburstImageBuffers(data) : null;
      const responseImages = data.data || [];
      if (responseImages.length === 0) {
        throw new Error("API returned no images");
      }

      const mimeType = isDallE3(modelId)
        ? "image/png"
        : FORMAT_TO_MIME[body.output_format] || "image/png";

      // Note revised_prompt in log if present (not surfaced to caller)
      const revisedPrompt = responseImages[0]?.revised_prompt;
      if (revisedPrompt) {
        ctx.log?.info?.(`[openai-image] revised_prompt: ${sunburst ? redactLogText(revisedPrompt) : revisedPrompt}`);
      }

      // 7. Save files using saveImage() — it appends /generated/ internally, so pass ctx.dataDir
      const taskId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const files = [];
      for (let i = 0; i < responseImages.length; i++) {
        const buffer = buffers ? buffers[i] : Buffer.from(responseImages[i].b64_json, "base64");
        const customName = params.filename
          ? (responseImages.length > 1 ? `${params.filename}-${i + 1}` : params.filename)
          : null;
        const { filename } = await saveImage(buffer, mimeType, ctx.dataDir, customName);
        files.push(filename);
      }

      // 8. Return taskId + files
      return { taskId, files };
    } catch (err) {
      // The task runner persists message verbatim. Do not attach the raw cause.
      if (sunburst) throw new Error(redactLogText(err?.message || String(err)));
      throw err;
    }
  },
  // No query() needed — files returned in submit = fake-async
};
