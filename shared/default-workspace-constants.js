export const DEFAULT_WORKSPACE_DIRNAME = "OH-WorkSpace";
export const DEFAULT_HEARTBEAT_INTERVAL_MINUTES = 31;

/**
 * 社交 staleness 阈值（单位：用户对话条数）。放在 shared 里是为了前端 WorkTab 和
 * 后端 social-awareness 取同一份默认值/边界，避免两边漂移。
 *
 * - GLOBAL：距上次主动私信「任何人」≥ 这么多条对话 → 心跳追加「该社交了」软提示
 * - PER_PEER：距上次私信「某个人」≥ 这么多条对话 → 把那个人列为「很久没联系」（兜底）
 * - MIN/MAX：UI 输入框边界 + 后端读 config 时的 clamp 防护（防手改 config.yaml 填垃圾值）
 */
export const DEFAULT_SOCIAL_GLOBAL_THRESHOLD = 80;
export const DEFAULT_SOCIAL_PER_PEER_THRESHOLD = 200;
export const SOCIAL_THRESHOLD_MIN = 10;
export const SOCIAL_THRESHOLD_MAX = 5000;
