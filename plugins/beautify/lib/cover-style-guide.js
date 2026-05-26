export const COVER_STYLE_GUIDE_VERSION = "2026-05-26";

export const COVER_STYLE_GUIDE = [
  "Hana Markdown cover 的默认审美规范：",
  "",
  "1. 画风：现代 Anime / 动画电影 key visual，不使用传统东方刻板符号作为默认风格。",
  "2. 材质：强纸张质感、印刷纹理、细腻颗粒、温润材料感；像被装帧进纸本里的画面。",
  "3. 叙事：有电影感、有故事感、有文学气息；优先通过真实场景、人物动作、光线、道具关系、环境痕迹表达主题。",
  "4. 内容：阅读文章后提炼意象主题，做文章气质的视觉化，不要把文章摘要逐字画出来。",
  "5. 幻想感：星空、幻想、文学意象可以出现，但必须由场景自然承载，有现实重量和情感理由。",
  "6. 克制：避免廉价 AI 感的漂浮符号堆砌；超现实元素只有在叙事上有必要时才出现。",
  "7. 主题：浅色主题使用柔和暖光、低对比、干净留白、纸面纤维清晰；深色主题使用低照度、克制高光、暗部保留材料层次。",
  "8. 输出：默认让生图工具按横向 3:2 生成；如果供应商不支持，允许接近的横向比例，但不能拉伸图片。",
].join("\n");

export function themeToneGuidance(themeTone) {
  return themeTone === "dark"
    ? "深色主题：低照度、克制高光、暗部仍保留纸张纤维和材料层次。"
    : "浅色主题：柔和暖光、低对比、干净留白、纸面纤维清晰。";
}

export function buildCoverStyleGuideForAgent({ themeTone = "light", userGuidance = "" } = {}) {
  return [
    COVER_STYLE_GUIDE,
    "",
    themeToneGuidance(themeTone),
    userGuidance ? `用户补充方向：${userGuidance}` : "",
  ].filter(Boolean).join("\n");
}
