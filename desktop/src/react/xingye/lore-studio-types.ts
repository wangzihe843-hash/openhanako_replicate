/**
 * 「角色设定工坊」(Lore Studio) 的对话协议类型。
 *
 * 这是一个多轮、非流式、结构化 JSON 的交互流：用户粘贴一整段背景故事，模型每轮回
 * 四种结构之一（提问 / 方案 / 普通消息 / peer 升级建议），前端按类型渲染。最终
 * 用户确认后，方案里的 lore 条目 + 人设补丁会落盘。
 *
 * 设计要点（与后端 server/routes/xingye.js 的 lore-studio/turn 端点对齐）：
 * - 输入侧最小化：existingLoreAnchors 只喂标题/分类/注入方式，不喂正文（去重用）。
 * - 模型只回定性内容；id / 时间戳 / visibility 由客户端补（见 lore-studio-apply.ts）。
 */
import type { XingyeLoreCategory, XingyeLoreInsertionMode } from './xingye-lore-store';
import type { XingyeCorruptionTendency } from './xingye-profile-store';

/** profile 补丁里允许被模型改动的字段（与 server PROFILE_FIELDS 对齐）。 */
export const STUDIO_PROFILE_FIELDS = [
  'shortBio',
  'identitySummary',
  'backgroundSummary',
  'personalitySummary',
  'behaviorLogic',
  'values',
  'taboos',
  'relationshipMode',
  'speakingStyle',
] as const;

export type StudioProfileField = (typeof STUDIO_PROFILE_FIELDS)[number];

// ─────────────────────────────────────────── 模型每轮的返回 ───────────────────────────────────────────

export type StudioTurnResponse =
  | StudioQuestionsTurn
  | StudioPlanTurn
  | StudioMessageTurn
  | StudioPeerSuggestionsTurn;

export type StudioTurnType = StudioTurnResponse['type'];

export interface StudioQuestionOption {
  label: string;
  /** 选项的简短解释 / 后果，帮用户对比（可选）。 */
  detail?: string;
}

export interface StudioQuestion {
  id: string;
  prompt: string;
  /** 这条问题主要在澄清哪一类 lore（用于 UI 标注与 plan 归类）。 */
  category?: XingyeLoreCategory;
  /** true = 允许多选。 */
  multiSelect?: boolean;
  /** true = 允许用户自定义回答（默认按 true 处理，像 Claude Code 的「其他」）。 */
  allowCustom?: boolean;
  options: StudioQuestionOption[];
}

/** 模型在不确定时（绝大多数轮）给出带选项的提问。 */
export interface StudioQuestionsTurn {
  type: 'questions';
  intro?: string;
  questions: StudioQuestion[];
}

/** 方案里的一条 lore 草案（确认后写入设定库）。 */
export interface StudioPlanLoreEntry {
  /** UI 稳定 key + 编辑用，确认时不落盘。 */
  tempId?: string;
  title: string;
  content: string;
  category: XingyeLoreCategory;
  insertionMode: XingyeLoreInsertionMode;
  keywords: string[];
  /** 模型认为优先级过低、建议改为手动注入（默认不产 manual，只在这里提示）。 */
  manualSuggested?: boolean;
  manualReason?: string;
  /** 与既有同名条目重合 → 走「更新补丁」而非新增。 */
  isUpdate?: boolean;
}

/** 方案里的一条人设字段改动（before→after 由 UI 自行对比展示）。 */
export interface StudioPlanProfileField {
  field: StudioProfileField;
  value: string;
  rationale?: string;
}

/** 模型在足够确定时给出的「计划」(类似 plan 模式)。 */
export interface StudioPlanTurn {
  type: 'plan';
  summary?: string;
  loreEntries: StudioPlanLoreEntry[];
  profilePatch?: StudioPlanProfileField[];
  /** 阴暗面预设档位（走详情页既有的 corruptionSeed 待确认 UX）。 */
  corruptionTendency?: XingyeCorruptionTendency;
  corruptionSeed?: number;
  notes?: string;
}

/** 自由文本回答（解释 / 闲聊 / 无法结构化时）。 */
export interface StudioMessageTurn {
  type: 'message';
  text: string;
}

/** Phase 2：建议把某个非 user 关系升级为独立 agent。 */
export interface StudioPeerCandidate {
  name: string;
  roleInWorld?: string;
  whyUpgrade?: string;
  suggestedRelationshipToCurrent?: string;
  worldviewTweaks?: string;
}

export interface StudioPeerSuggestionsTurn {
  type: 'peer-suggestions';
  intro?: string;
  candidates: StudioPeerCandidate[];
}

// ─────────────────────────────────────────── 请求 / 传输 ───────────────────────────────────────────

/** 喂给模型做去重的既有条目锚点（只标题/分类/注入方式，不含正文）。 */
export interface StudioLoreAnchor {
  title: string;
  category: XingyeLoreCategory;
  insertionMode: XingyeLoreInsertionMode;
}

/** 传给服务端的对话历史（紧凑：assistant 轮序列化为 JSON 字符串）。 */
export interface StudioWireMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** 该角色是刚从某源角色分出来的 peer 时的上下文。 */
export interface StudioPeerContext {
  sourceAgentId: string;
  sourceName: string;
}

/** peer 微调：已带来的世界观/关系条目（带正文）喂给模型供其据新背景改写。 */
export interface StudioFineTuneEntry {
  title: string;
  content: string;
  category: XingyeLoreCategory;
  insertionMode: XingyeLoreInsertionMode;
}

export interface StudioTurnRequest {
  agentId: string;
  displayName?: string;
  relationshipLabel?: string;
  shortBio?: string;
  existingProfile?: Record<string, unknown>;
  existingLoreAnchors?: StudioLoreAnchor[];
  backgroundStory?: string;
  transcript: StudioWireMessage[];
  /** 'extract'（默认，Phase 1）| 'peer-suggest'（Phase 2）。 */
  mode?: 'extract' | 'peer-suggest';
  /** peer-suggest 模式：客户端已名字匹配出的、尚无对应 agent 的候选实体名。 */
  peerCandidateNames?: string[];
  /** 新角色刚从某源角色分出来时的上下文 + 已带来条目正文，驱动「微调已带来的世界观/关系」。 */
  peerContext?: StudioPeerContext;
  fineTuneEntries?: StudioFineTuneEntry[];
}

export interface StudioTurnResult {
  ok: true;
  turn: StudioTurnResponse;
  modelTier?: string;
}

// ─────────────────────────────────────────── 本地会话状态 ───────────────────────────────────────────

export type StudioPhase = 'intro' | 'questioning' | 'planning' | 'done';

export type StudioMessage =
  | { id: string; role: 'user'; text: string; createdAt: string }
  | { id: string; role: 'assistant'; turn: StudioTurnResponse; createdAt: string };

/** 持久化到每个 agent 的 xingye/lore-studio/session.json（切 agent 不丢记录）。 */
export interface StudioSession {
  version: 1;
  agentId: string;
  backgroundStory: string;
  phase: StudioPhase;
  messages: StudioMessage[];
  /** 最近一份（含用户编辑的）方案快照，供「确认写入」用。 */
  draftPlan?: StudioPlanTurn | null;
  /** 该角色刚从某源角色分出来时的上下文；首次确认后清空。 */
  peerContext?: StudioPeerContext;
  updatedAt: string;
}

export const STUDIO_SESSION_RELATIVE_PATH = 'lore-studio/session.json';

/**
 * 「确认写入」后抽屉回传给 RoleDetailPanel 的结果：lore 已直接落盘（给出条数），
 * 人设补丁 + corruption 提案回填到面板表单（corruptionSeed 走面板既有待确认 UX）。
 */
export interface StudioAppliedResult {
  loreCreated: number;
  loreUpdated: number;
  profilePatch: Partial<Record<StudioProfileField, string>>;
  corruptionTendency?: XingyeCorruptionTendency;
  corruptionSeed?: number;
}
