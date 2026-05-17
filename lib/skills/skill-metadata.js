import yaml from "js-yaml";

const MAX_DESCRIPTION_LENGTH = 1024;
const MAX_DISPLAY_NAME_LENGTH = 60;

/**
 * 允许在 SKILL.md frontmatter 里写 `display-name-{lang}` 给该 skill 指定一个固定的
 * 本地化显示名，绕过自动翻译（避免「xingye-journal-draft」被翻译模型按拼音误读为
 * 「兴业草稿」之类的项目术语冲突）。
 *
 * 支持的语言键：与 desktop/src/locales/*.json 的文件名对齐。值会被 trim + 截到
 * MAX_DISPLAY_NAME_LENGTH 个字符；任何非字符串值会被忽略，回退到自动翻译。
 */
const DISPLAY_NAME_LANG_KEYS = ["zh", "zh-TW", "ja", "ko", "en"];

function normalizeName(value, fallbackName) {
  if (typeof value !== "string") return fallbackName;
  const trimmed = value.trim();
  return trimmed || fallbackName;
}

function normalizeDescription(value) {
  if (typeof value !== "string") return "";
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  return collapsed.length > MAX_DESCRIPTION_LENGTH
    ? collapsed.slice(0, MAX_DESCRIPTION_LENGTH)
    : collapsed;
}

function frontmatterMetadata(parsed) {
  if (!parsed || typeof parsed.metadata !== "object" || Array.isArray(parsed.metadata)) {
    return {};
  }
  return parsed.metadata;
}

/**
 * 收集 `display-name-{lang}` 形式的语言覆盖。同时支持顶层（`display-name-zh: …`）和
 * 嵌套在 `metadata:` 块下（`metadata.display-name-zh: …`）。两处都给，metadata 块覆盖顶层。
 * 返回 `{ lang: displayName }`；无字符串值或 trim 后空字符串的语言被丢掉，回退到自动翻译。
 */
function normalizeDisplayNames(parsed) {
  const metadata = frontmatterMetadata(parsed);
  const out = {};
  for (const lang of DISPLAY_NAME_LANG_KEYS) {
    const key = `display-name-${lang}`;
    const value = metadata[key] ?? parsed?.[key];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    out[lang] = trimmed.slice(0, MAX_DISPLAY_NAME_LENGTH);
  }
  return out;
}

function normalizeDefaultEnabled(parsed) {
  const metadata = frontmatterMetadata(parsed);
  return !(
    parsed?.["default-enabled"] === false
    || parsed?.defaultEnabled === false
    || metadata["default-enabled"] === false
    || metadata.defaultEnabled === false
  );
}

/**
 * Parse SKILL.md frontmatter using the same trust boundary as the upstream spec:
 * only YAML frontmatter contributes metadata, never arbitrary body content.
 */
export function parseSkillMetadata(content, fallbackName = "") {
  const meta = {
    name: fallbackName,
    description: "",
    disableModelInvocation: false,
    defaultEnabled: true,
    displayNames: {},
  };

  if (typeof content !== "string" || !content.startsWith("---")) return meta;
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return meta;

  try {
    const parsed = yaml.load(match[1]);
    if (!parsed || typeof parsed !== "object") return meta;
    return {
      name: normalizeName(parsed.name, fallbackName),
      description: normalizeDescription(parsed.description),
      disableModelInvocation: parsed["disable-model-invocation"] === true,
      defaultEnabled: normalizeDefaultEnabled(parsed),
      displayNames: normalizeDisplayNames(parsed),
    };
  } catch {
    return meta;
  }
}
