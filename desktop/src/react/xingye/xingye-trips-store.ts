import { postXingyeStorage } from './xingye-storage-api';
import { createAgentXingyeStorageBackend } from './xingye-storage-backend';

/**
 * 「行程」模块的本地模拟存储。
 *
 * 行程 = TA **已经走过的路**（过去式），刻意和「日程」（未来的安排 / 约定）区分开：
 * 日程是「接下来要做的事」，行程是「已经发生、不会重来的一段路」。每条行程呈现成
 * 一张旧车票（硬板票），详情里是一段竖向路线图 + TA 对起讫两地的亲笔批注。
 *
 * 数据落在各 agent 的 `apps/trips/entries.jsonl`（经 /api/xingye/storage，与 profile.json
 * 同机制，按 agent scope 持久化）；首次打开 app 的初始化 marker 复用
 * `apps/trips/history-state.json`（见 xingye-app-history-state.ts 的 'trips'）。
 */

const backend = createAgentXingyeStorageBackend(postXingyeStorage);

/** 相对路径位于 HANA_HOME/agents/{agentId}/xingye/ 下 */
export const XINGYE_TRIPS_ENTRIES_JSONL = 'apps/trips/entries.jsonl';

/** 与 server/routes/xingye-storage.js SAFE_AGENT_ID_RE 一致 */
const SAFE_AGENT_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;

/**
 * 交通方式的「图标键」——开放枚举的**收敛层**。
 *
 * 设计稿强调 `mode` 是开放枚举（按世界观自由取值），但前端只有有限几个线稿图标。
 * 折中方案：模型同时给出
 *   - `mode`：从下面 8 个**图标键**里挑一个最接近的（决定票根 / 路线段画哪个图标）；
 *   - `modeLabel`：真正贴世界观的载具名（自由文本，如「御剑」「驮队」「网约车」「摆渡」）。
 * 这样图标稳定可控，文案仍然忠于世界观。取不到 / 不认识的键一律回退 `walk`。
 */
export const TRIP_MODE_KEYS = [
  'walk', // 徒步 / 步行
  'ride', // 骑乘：马 / 驴 / 骆驼 / 灵兽 / 坐骑
  'cart', // 车马：货车 / 马车 / 牛车 / 驮队 / 黄包车 / 板车
  'transit', // 车行：现代汽车 / 公交 / 出租 / 网约车
  'boat', // 行船：渡船 / 摆渡 / 轮船 / 法舟 / 漕船
  'rail', // 轨道：火车 / 地铁 / 电车 / 磁轨 / 缆车
  'fly', // 飞行：飞机 / 飞艇 / 飞行兽 / 御剑 / 穿梭舱 / 飞舟
  'mystic', // 术法：传送阵 / portal / 缩地成寸
] as const;

export type TripModeKey = (typeof TRIP_MODE_KEYS)[number];

export const TRIP_MODE_LABELS_ZH: Record<TripModeKey, string> = {
  walk: '徒步',
  ride: '骑乘',
  cart: '车马',
  transit: '车行',
  boat: '行船',
  rail: '轨道',
  fly: '飞行',
  mystic: '术法',
};

export function normalizeTripModeKey(value: unknown): TripModeKey {
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if ((TRIP_MODE_KEYS as readonly string[]).includes(v)) return v as TripModeKey;
  }
  return 'walk';
}

export type XingyeTripPlace = {
  /** 地名，例「北门诊所」「红盐码头」。 */
  name: string;
  /** 副标，例「后院 · 第三阶」「废弃灯塔」；可空。 */
  meta?: string;
};

/** 路线节点：真实地点（stop）或两地之间的方式（seg）。 */
export type XingyeTripRouteStop = {
  kind: 'stop';
  name: string;
  /** 起讫 / 换乘（实心大点，带 time/sub）。 */
  major?: boolean;
  /** 途经（小空心点）。 */
  via?: boolean;
  /** 时刻文本，按世界观自由格式（时辰 / 24h / 周期）。 */
  time?: string;
  /** 该点补充说明。 */
  sub?: string;
};

export type XingyeTripRouteSeg = {
  kind: 'seg';
  /** 该段交通方式（图标键）；walk 段在时间轴上画虚线轨道。 */
  mode: TripModeKey;
  /** 方式描述，例「驮队 · 山道」「搭运盐卡车」。 */
  label: string;
  /** 用时 / 距离补充。 */
  detail?: string;
};

export type XingyeTripRouteNode = XingyeTripRouteStop | XingyeTripRouteSeg;

export type XingyeTripEntry = {
  id: string;
  /** 票面编号，等宽展示，风格随世界观（「北门 · 丙申 0003」）。 */
  serial: string;
  /** 票面时间戳（非现代历法亦可：旧历 / 事件 / 季节，「停电夜」）。 */
  when: string;
  /** 分组依据（时期 / 章节），列表按此聚合（「童年 · 北门」）。 */
  chapter: string;
  /** 主交通方式（图标键）。 */
  mode: TripModeKey;
  /** 票面方式描述（贴世界观的载具名，可含换乘）。 */
  modeLabel: string;
  /** 班次 / 类别小标（「徒步」「摆渡」「撤离」）。 */
  cls: string;
  from: XingyeTripPlace;
  to: XingyeTripPlace;
  /** 用时（时辰 / 分钟 / 周期，随世界观）。 */
  duration: string;
  /** 路程（「一里」「十里山道」）。 */
  distance: string;
  /** 第三枚元信息：通行凭证 / 票资 / 天气，按世界观，可为 "—"。 */
  pass: string;
  /** 印章字样（「到家」「已过哨」「不渡」）。 */
  stampText: string;
  /** TA 对【起点】的亲笔批注（手写体渲染）。 */
  noteFrom: string;
  /** TA 对【终点】的亲笔批注（手写体渲染）。 */
  noteTo: string;
  /** 整段随笔（衬线正文，区别于手写批注）。 */
  mood: string;
  /** 随笔标签。 */
  moodTags: string[];
  /** 竖向路线时间轴节点。 */
  route: XingyeTripRouteNode[];
  createdAt: string;
};

/** 去掉系统字段后的「可写入 / 可生成」草稿形状。 */
export type XingyeTripDraft = Omit<XingyeTripEntry, 'id' | 'createdAt'>;

function newTripId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `t-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function clampStr(value: unknown, max: number, fallback = ''): string {
  if (typeof value !== 'string') return fallback;
  const t = value.trim();
  if (!t) return fallback;
  return t.length <= max ? t : t.slice(0, max);
}

function normalizeTripPlace(raw: unknown): XingyeTripPlace | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const name = clampStr(r.name, 60);
  if (!name) return null;
  const meta = clampStr(r.meta, 60);
  const place: XingyeTripPlace = { name };
  if (meta) place.meta = meta;
  return place;
}

function normalizeRouteNode(raw: unknown): XingyeTripRouteNode | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.kind === 'seg') {
    const label = clampStr(r.label, 60);
    if (!label) return null;
    const seg: XingyeTripRouteSeg = { kind: 'seg', mode: normalizeTripModeKey(r.mode), label };
    const detail = clampStr(r.detail, 60);
    if (detail) seg.detail = detail;
    return seg;
  }
  const name = clampStr(r.name, 60);
  if (!name) return null;
  const stop: XingyeTripRouteStop = { kind: 'stop', name };
  if (r.major === true) stop.major = true;
  if (r.via === true) stop.via = true;
  const time = clampStr(r.time, 24);
  if (time) stop.time = time;
  const sub = clampStr(r.sub, 40);
  if (sub) stop.sub = sub;
  return stop;
}

function buildFallbackRoute(
  from: XingyeTripPlace,
  to: XingyeTripPlace,
  mode: TripModeKey,
  modeLabel: string,
): XingyeTripRouteNode[] {
  const start: XingyeTripRouteStop = { kind: 'stop', name: from.name, major: true };
  if (from.meta) start.sub = from.meta;
  const end: XingyeTripRouteStop = { kind: 'stop', name: to.name, major: true };
  if (to.meta) end.sub = to.meta;
  return [start, { kind: 'seg', mode, label: modeLabel || TRIP_MODE_LABELS_ZH[mode] }, end];
}

/**
 * 规范化路线：过滤非法节点；保证至少两个 stop（否则用 from/to 兜底一段）；
 * 首尾 stop 强制 major=true（亲笔批注挂在它们上，视觉也用实心大点）。
 */
function normalizeRouteList(
  raw: unknown,
  from: XingyeTripPlace,
  to: XingyeTripPlace,
  mode: TripModeKey,
  modeLabel: string,
): XingyeTripRouteNode[] {
  const nodes = Array.isArray(raw)
    ? raw.map(normalizeRouteNode).filter((n): n is XingyeTripRouteNode => Boolean(n)).slice(0, 24)
    : [];
  const stopIdx = nodes.map((n, i) => (n.kind === 'stop' ? i : -1)).filter((i) => i >= 0);
  if (stopIdx.length < 2) return buildFallbackRoute(from, to, mode, modeLabel);
  (nodes[stopIdx[0]!] as XingyeTripRouteStop).major = true;
  (nodes[stopIdx[stopIdx.length - 1]!] as XingyeTripRouteStop).major = true;
  return nodes;
}

/**
 * 把任意（模型 / 历史磁盘）原始对象规范成 XingyeTripDraft；起点或终点缺名 → null。
 * 同时被 listTripEntries（读盘）与 xingye-trips-ai（解析模型输出）复用。
 */
export function normalizeTripDraft(raw: unknown): XingyeTripDraft | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const from = normalizeTripPlace(r.from);
  const to = normalizeTripPlace(r.to);
  if (!from || !to) return null;
  const mode = normalizeTripModeKey(r.mode);
  const modeLabel = clampStr(r.modeLabel, 60) || TRIP_MODE_LABELS_ZH[mode];
  const moodTags = Array.isArray(r.moodTags)
    ? r.moodTags.map((t) => clampStr(t, 24)).filter(Boolean).slice(0, 8)
    : [];
  return {
    serial: clampStr(r.serial, 60),
    when: clampStr(r.when, 40),
    chapter: clampStr(r.chapter, 40, '行程'),
    mode,
    modeLabel,
    cls: clampStr(r.cls, 24),
    from,
    to,
    duration: clampStr(r.duration, 40),
    distance: clampStr(r.distance, 40),
    pass: clampStr(r.pass, 40, '—'),
    stampText: clampStr(r.stampText, 12),
    noteFrom: clampStr(r.noteFrom, 200),
    noteTo: clampStr(r.noteTo, 200),
    mood: clampStr(r.mood, 2000),
    moodTags,
    route: normalizeRouteList(r.route, from, to, mode, modeLabel),
  };
}

function normalizeRow(value: unknown): XingyeTripEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  const id = clampStr(r.id, 120);
  if (!id) return null;
  const draft = normalizeTripDraft(value);
  if (!draft) return null;
  const createdAt = typeof r.createdAt === 'string' && r.createdAt ? r.createdAt : new Date(0).toISOString();
  return { id, ...draft, createdAt };
}

/**
 * 读取行程列表。**保持磁盘（append）顺序**——不做时间排序：
 * 列表按 chapter 聚合且按「首次出现」顺序展示，所以写入顺序就是叙事顺序。
 */
export async function listTripEntries(agentId: string): Promise<XingyeTripEntry[]> {
  const aid = agentId.trim();
  if (!aid) return [];
  try {
    const rows = await backend.listJsonl<unknown>(aid, XINGYE_TRIPS_ENTRIES_JSONL);
    return rows.map(normalizeRow).filter((e): e is XingyeTripEntry => Boolean(e));
  } catch {
    return [];
  }
}

export async function appendTripEntry(
  agentId: string,
  input: XingyeTripDraft & { id?: string; createdAt?: string },
): Promise<XingyeTripEntry> {
  const aid = agentId.trim();
  if (!aid) {
    throw new Error('保存失败：缺少 agentId。');
  }
  if (!SAFE_AGENT_ID_RE.test(aid)) {
    throw new Error('保存失败：agentId 格式无效（仅允许字母、数字、下划线与短横线，长度 1–120）。');
  }
  const draft = normalizeTripDraft(input);
  if (!draft) {
    throw new Error('保存失败：行程缺少起点或终点。');
  }
  const id = typeof input.id === 'string' && input.id.trim() ? input.id.trim() : newTripId();
  const overrideRaw = typeof input.createdAt === 'string' ? input.createdAt.trim() : '';
  const overrideParsed = overrideRaw ? Date.parse(overrideRaw) : NaN;
  const createdAt = Number.isFinite(overrideParsed) ? new Date(overrideParsed).toISOString() : new Date().toISOString();
  const row: XingyeTripEntry & { key: string } = { id, key: id, ...draft, createdAt };
  await backend.appendJsonl(aid, XINGYE_TRIPS_ENTRIES_JSONL, row);
  return { id, ...draft, createdAt };
}

export async function deleteTripEntry(agentId: string, entryId: string): Promise<boolean> {
  const aid = agentId.trim();
  const eid = entryId.trim();
  if (!aid) {
    throw new Error('删除失败：缺少 agentId。');
  }
  if (!SAFE_AGENT_ID_RE.test(aid)) {
    throw new Error('删除失败：agentId 格式无效（仅允许字母、数字、下划线与短横线，长度 1–120）。');
  }
  if (!eid) {
    throw new Error('删除失败：缺少行程 id。');
  }
  return backend.deleteJsonlRecord(aid, XINGYE_TRIPS_ENTRIES_JSONL, eid);
}
