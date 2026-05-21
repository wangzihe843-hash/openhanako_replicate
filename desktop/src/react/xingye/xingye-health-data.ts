/**
 * xingye-health-data.ts — 健康模块的数据层。
 *
 * 设计取舍（见 health-module-design 的 implementation_suggestion.md + 用户要求）：
 *  - 让 LLM 只返回「当天状态」(scenario) 与「建议模块」(advice)，不返回整套曲线数据。
 *  - 心率/步数/睡眠/压力四条曲线全部在本地用「按 isoDate 播种的伪随机数」生成，
 *    所以同一天反复读到的图形完全一致，不依赖任何真实健康 SDK。
 *  - 持久化的只有极小的 XingyeHealthDay（scenario + advice + 元信息）；
 *    曲线由 buildHealthDayData() 在内存里按需重算。
 */

export type HealthScenario = 'calm' | 'high_stress' | 'active';

export type HealthMetricKey = 'hr' | 'steps' | 'sleep' | 'stress';

export type SleepStage = 'awake' | 'rem' | 'light' | 'deep';

/** 一段睡眠分段，时间为「入睡起算的小时数」。 */
export interface SleepSegment {
  stage: SleepStage;
  start: number;
  end: number;
}

/** AI（或降级）产出的当日健康建议。 */
export interface HealthAdvice {
  title: string;
  /** 150–250 字的健康分析正文。 */
  body: string;
  /** 生成时刻，HH:mm（本地时区）。 */
  generatedAt: string;
}

/**
 * 落盘的「一天健康记录」。主键 isoDate。
 * 只存状态与建议——曲线不存，由 buildHealthDayData 按 isoDate 重算。
 */
export interface XingyeHealthDay {
  /** 本地日期 ISO 串（YYYY-MM-DD）。 */
  isoDate: string;
  scenario: HealthScenario;
  /** 当日健康建议；缺失时为 null（UI 优雅降级）。 */
  advice: HealthAdvice | null;
  /** 记录写入时刻（ISO）。 */
  generatedAt: string;
  /** 'ai' = 模型产出；'fallback' = 模型不可用时的本地降级。 */
  source: 'ai' | 'fallback';
}

export interface HealthHrSummary {
  avg: number;
  max: number;
  min: number;
  currentBpm: number;
  status: string;
}

export interface HealthStepsSummary {
  total: number;
  goal: number;
  pct: number;
}

export interface HealthSleepSummary {
  totalH: number;
  deepH: number;
  remH: number;
  wakeCount: number;
}

export interface HealthStressSummary {
  avg: number;
  current: number;
  peakHour: number;
  peakVal: number;
  low: number;
  mid: number;
  high: number;
  level: 'low' | 'mid' | 'high';
  levelLabel: string;
}

/** 内存里展开的「完整一天」——含四条曲线与摘要，由 buildHealthDayData 产出。 */
export interface HealthDayData {
  isoDate: string;
  scenario: HealthScenario;
  /** "5月21日" */
  date: string;
  /** "星期四" */
  weekday: string;
  /** "5月21日 星期四" */
  fullDate: string;
  /** 与今天相同则为 true。 */
  isToday: boolean;
  hr: number[];
  hrSummary: HealthHrSummary;
  steps: number[];
  stepsSummary: HealthStepsSummary;
  sleep: { stages: SleepSegment[]; totalHours: number };
  sleepSummary: HealthSleepSummary;
  stress: number[];
  stressSummary: HealthStressSummary;
  advice: HealthAdvice | null;
}

/** 阈值集中放，方便后续调参 / A-B。 */
export const HEALTH_THRESHOLDS = {
  stress: { low: 30, high: 40 },
  steps: { goal: 10_000 },
  sleep: { adequate: 7 },
} as const;

export const HEALTH_SCENARIO_LABELS: Record<HealthScenario, string> = {
  calm: '平稳',
  high_stress: '高压',
  active: '活跃',
};

// ─────────────────────────────────────────────────────────
// 播种伪随机
// ─────────────────────────────────────────────────────────
function seedRand(seed: number): () => number {
  let s = Math.abs(Math.floor(seed)) || 1;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

/** 把 isoDate 折成一个稳定正整数，作为当天所有曲线的播种基。 */
function daySeed(isoDate: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate.trim());
  if (!m) {
    let h = 0;
    for (let i = 0; i < isoDate.length; i += 1) h = (h * 31 + isoDate.charCodeAt(i)) % 8_000_000;
    return h || 1;
  }
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  return (y - 2000) * 372 + (mo - 1) * 31 + d + 1;
}

// ─────────────────────────────────────────────────────────
// 单日曲线生成器（曲线形状 / 噪声 / scenario 加成照搬原型 data.jsx）
// ─────────────────────────────────────────────────────────
function genHeartRate(scenario: HealthScenario, seed: number): number[] {
  const rand = seedRand(17 * seed + scenario.length * 13);
  const dayBoost = (rand() - 0.5) * 4;
  const out: number[] = [];
  for (let i = 0; i < 288; i += 1) {
    const hour = i / 12;
    let base = 62 + 18 * Math.max(0, Math.sin(((hour - 6) / 24) * Math.PI * 2));
    if (hour >= 1 && hour <= 6) base = 56 + 4 * Math.sin(hour);
    if (scenario === 'high_stress') {
      if (hour >= 10 && hour <= 14) base += 18 + 8 * Math.sin((hour - 10) * 1.4);
      if (hour >= 15 && hour <= 17) base += 6;
    }
    if (scenario === 'active') {
      if (hour >= 7 && hour <= 8.5) base += 38;
      if (hour >= 18 && hour <= 19.5) base += 32;
    }
    out.push(Math.round((base + dayBoost + (rand() - 0.5) * 5) * 10) / 10);
  }
  return out;
}

function genSteps(scenario: HealthScenario, seed: number): number[] {
  const rand = seedRand(23 * seed + 7);
  const dayMult = 0.75 + rand() * 0.5;
  const out: number[] = [];
  for (let h = 0; h < 24; h += 1) {
    let v = 0;
    if (h <= 6) v = Math.floor(rand() * 30);
    else if (h <= 9) v = 400 + Math.floor(rand() * 800);
    else if (h <= 11) v = 200 + Math.floor(rand() * 400);
    else if (h === 12) v = 600 + Math.floor(rand() * 500);
    else if (h <= 17) v = 300 + Math.floor(rand() * 600);
    else if (h <= 19) v = 700 + Math.floor(rand() * 700);
    else if (h <= 22) v = 150 + Math.floor(rand() * 300);
    else v = Math.floor(rand() * 40);
    if (scenario === 'high_stress') v = Math.floor(v * 0.55);
    if (scenario === 'active') v = Math.floor(v * 1.85);
    out.push(Math.floor(v * dayMult));
  }
  return out;
}

function genSleep(scenario: HealthScenario, seed: number): { stages: SleepSegment[]; totalHours: number } {
  const rand = seedRand(41 * seed + 3);
  let segs: { stage: SleepStage; dur: number }[];
  if (scenario === 'high_stress') {
    segs = [
      { stage: 'awake', dur: 0.35 }, { stage: 'light', dur: 0.8 },
      { stage: 'deep', dur: 0.5 }, { stage: 'light', dur: 0.6 },
      { stage: 'awake', dur: 0.15 }, { stage: 'light', dur: 0.4 },
      { stage: 'rem', dur: 0.6 }, { stage: 'light', dur: 0.7 },
      { stage: 'deep', dur: 0.4 }, { stage: 'awake', dur: 0.2 },
      { stage: 'rem', dur: 0.5 }, { stage: 'light', dur: 1.0 },
      { stage: 'rem', dur: 0.5 }, { stage: 'awake', dur: 0.25 },
      { stage: 'light', dur: 0.8 }, { stage: 'rem', dur: 0.5 },
      { stage: 'awake', dur: 0.3 }, { stage: 'light', dur: 1.0 },
    ];
  } else if (scenario === 'active') {
    segs = [
      { stage: 'awake', dur: 0.2 }, { stage: 'light', dur: 0.5 },
      { stage: 'deep', dur: 1.4 }, { stage: 'rem', dur: 0.6 },
      { stage: 'light', dur: 0.5 }, { stage: 'deep', dur: 1.0 },
      { stage: 'light', dur: 0.4 }, { stage: 'rem', dur: 0.8 },
      { stage: 'light', dur: 0.7 }, { stage: 'deep', dur: 0.5 },
      { stage: 'rem', dur: 0.9 }, { stage: 'light', dur: 0.8 },
      { stage: 'rem', dur: 0.7 }, { stage: 'awake', dur: 0.05 },
    ];
  } else {
    segs = [
      { stage: 'awake', dur: 0.25 }, { stage: 'light', dur: 0.7 },
      { stage: 'deep', dur: 1.0 }, { stage: 'rem', dur: 0.5 },
      { stage: 'light', dur: 0.7 }, { stage: 'deep', dur: 0.7 },
      { stage: 'light', dur: 0.5 }, { stage: 'rem', dur: 0.8 },
      { stage: 'light', dur: 0.6 }, { stage: 'deep', dur: 0.5 },
      { stage: 'rem', dur: 0.6 }, { stage: 'light', dur: 0.7 },
      { stage: 'awake', dur: 0.15 }, { stage: 'light', dur: 0.6 },
      { stage: 'rem', dur: 0.5 }, { stage: 'light', dur: 0.4 },
    ];
  }
  const jittered = segs.map((s) => ({ stage: s.stage, dur: Math.max(0.05, s.dur * (0.85 + rand() * 0.3)) }));
  let t = 0;
  const stages: SleepSegment[] = jittered.map((s) => {
    const start = t;
    t += s.dur;
    return { stage: s.stage, start, end: t };
  });
  return { stages, totalHours: t };
}

function genStress(scenario: HealthScenario, seed: number): number[] {
  const rand = seedRand(71 * seed + 11);
  const dayShift = (rand() - 0.5) * 16;
  const out: number[] = [];
  for (let h = 0; h < 24; h += 1) {
    let v: number;
    if (h <= 6) v = 12 + rand() * 8;
    else if (h <= 9) v = 28 + rand() * 18;
    else if (h <= 14) v = scenario === 'high_stress' ? 60 + rand() * 22 : 35 + rand() * 18;
    else if (h <= 18) v = scenario === 'high_stress' ? 48 + rand() * 18 : 30 + rand() * 14;
    else if (h <= 22) v = 22 + rand() * 16;
    else v = 15 + rand() * 8;
    out.push(Math.max(5, Math.min(100, Math.round(v + dayShift))));
  }
  return out;
}

// ─────────────────────────────────────────────────────────
// 摘要工具
// ─────────────────────────────────────────────────────────
const avg = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const maxOf = (a: number[]): number => (a.length ? Math.max(...a) : 0);
const minOf = (a: number[]): number => (a.length ? Math.min(...a) : 0);

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

export function todayIsoDate(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function parseIsoDate(isoDate: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate.trim());
  if (!m) return new Date(NaN);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function healthDateLabel(isoDate: string): string {
  const d = parseIsoDate(isoDate);
  if (Number.isNaN(d.getTime())) return isoDate;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export function healthWeekdayLabel(isoDate: string): string {
  const d = parseIsoDate(isoDate);
  if (Number.isNaN(d.getTime())) return '';
  return `星期${WEEKDAYS[d.getDay()]}`;
}

/**
 * 同一 (isoDate, scenario) 反复展开时复用，避免重复算 ~350 个数。
 * 仅缓存曲线/摘要部分；advice / isToday 每次重新拼。
 */
const curveCache = new Map<string, Omit<HealthDayData, 'advice' | 'isToday'>>();

function buildCurves(isoDate: string, scenario: HealthScenario): Omit<HealthDayData, 'advice' | 'isToday'> {
  const cacheKey = `${isoDate}|${scenario}`;
  const cached = curveCache.get(cacheKey);
  if (cached) return cached;

  const seed = daySeed(isoDate);
  const hr = genHeartRate(scenario, seed);
  const steps = genSteps(scenario, seed);
  const sleep = genSleep(scenario, seed);
  const stress = genStress(scenario, seed);

  const totalSteps = steps.reduce((a, b) => a + b, 0);
  const stepsGoal = HEALTH_THRESHOLDS.steps.goal;

  const stageDur: Record<SleepStage, number> = { awake: 0, light: 0, deep: 0, rem: 0 };
  let wakeCount = 0;
  for (const s of sleep.stages) {
    stageDur[s.stage] += s.end - s.start;
    if (s.stage === 'awake' && s.start > 0.1) wakeCount += 1;
  }

  const stressAvg = Math.round(avg(stress));
  const stressMax = maxOf(stress);
  const peakStressHr = stress.indexOf(stressMax);
  const level: HealthStressSummary['level'] =
    stressAvg < HEALTH_THRESHOLDS.stress.low
      ? 'low'
      : stressAvg < HEALTH_THRESHOLDS.stress.high
        ? 'mid'
        : 'high';

  const result: Omit<HealthDayData, 'advice' | 'isToday'> = {
    isoDate,
    scenario,
    date: healthDateLabel(isoDate),
    weekday: healthWeekdayLabel(isoDate),
    fullDate: `${healthDateLabel(isoDate)} ${healthWeekdayLabel(isoDate)}`.trim(),
    hr,
    hrSummary: {
      avg: Math.round(avg(hr)),
      max: Math.round(maxOf(hr)),
      min: Math.round(minOf(hr)),
      currentBpm: Math.round(hr[hr.length - 6] ?? hr[hr.length - 1] ?? 0),
      status: scenario === 'active' ? '运动后恢复中' : scenario === 'high_stress' ? '偏快' : '正常',
    },
    steps,
    stepsSummary: {
      total: totalSteps,
      goal: stepsGoal,
      pct: Math.round((totalSteps / stepsGoal) * 100),
    },
    sleep,
    sleepSummary: {
      totalH: sleep.totalHours,
      deepH: stageDur.deep,
      remH: stageDur.rem,
      wakeCount,
    },
    stress,
    stressSummary: {
      avg: stressAvg,
      current: stress[14] ?? stressAvg,
      peakHour: peakStressHr < 0 ? 0 : peakStressHr,
      peakVal: stressMax,
      low: stress.filter((v) => v <= HEALTH_THRESHOLDS.stress.low).length,
      mid: stress.filter((v) => v > HEALTH_THRESHOLDS.stress.low && v <= 60).length,
      high: stress.filter((v) => v > 60).length,
      level,
      levelLabel: level === 'low' ? '轻松' : level === 'mid' ? '平稳' : '紧绷',
    },
  };
  curveCache.set(cacheKey, result);
  return result;
}

/**
 * 把落盘的 XingyeHealthDay 展开成内存里的完整一天（含曲线 + 摘要）。
 * 曲线确定性来自 isoDate + scenario，不受 advice 影响。
 */
export function buildHealthDayData(day: XingyeHealthDay, now: Date = new Date()): HealthDayData {
  const curves = buildCurves(day.isoDate, day.scenario);
  return {
    ...curves,
    isToday: day.isoDate === todayIsoDate(now),
    advice: day.advice,
  };
}

// ─────────────────────────────────────────────────────────
// 降级用：模型不可用 / 没返回 advice 时的固定文案
// 三段文案来源于设计稿 data.jsx，仅作占位降级，不与本地曲线精确对齐。
// ─────────────────────────────────────────────────────────
export const HEALTH_FALLBACK_ADVICE: Record<HealthScenario, { title: string; body: string }> = {
  high_stress: {
    title: '今日分析',
    body: '今日的状态偏紧绷：压力在白天的工作时段明显抬升，睡眠也较为破碎，深睡偏少、夜里有几次短暂清醒。心率整体仍在正常范围，但下午有轻微波动，值得留意。步数偏低，活动主要集中在上午。\n\n综合来看，建议在下一段高强度任务之前，先安排 15–20 分钟的低刺激休息，可以尝试缓慢呼吸或安静独处。把改善睡眠当作当前的优先项——尽量早些进入低响应状态，减少夜里的高负荷安排。若压力持续偏高，可考虑把任务分批处理，而不是一次全部扛下来。',
  },
  calm: {
    title: '今日分析',
    body: '今日各项指标整体平稳。心率全天波动温和，未见明显异常；压力大多维持在低位，仅在午后有一次短暂的中度上扬并很快回落。睡眠时长充足，深睡与 REM 都比较完整，节律良好。步数接近目标，活动分布在午后与傍晚两个时段。\n\n综合来看，今日状态接近近期的较好水平，不需要特别干预。建议继续维持当前的作息节律，可在傍晚加入一段轻度活动，例如散步或舒展，巩固这份平稳。',
  },
  active: {
    title: '今日分析',
    body: '今日呈现出明显的运动负荷特征：白天有两段高强度活动，心率峰值较高，运动后恢复曲线良好，回落迅速，说明体能储备充足。步数大幅超额完成目标。压力受运动影响有两次短暂尖峰，其余时段维持在低位。\n\n需要注意的是，连续高强度活动后，今晚应优先保障深睡，并在睡前补足水分。明日的安排可以适度降低体力消耗，给身体一个恢复窗口。若次日清晨静息心率明显高于平时，需要警惕过度消耗的早期信号。',
  },
};

/** 把 scenario + 可选 advice 收敛成一条可落盘的 XingyeHealthDay。 */
export function makeHealthDay(params: {
  isoDate: string;
  scenario: HealthScenario;
  advice: HealthAdvice | null;
  source: XingyeHealthDay['source'];
  now?: Date;
}): XingyeHealthDay {
  return {
    isoDate: params.isoDate,
    scenario: params.scenario,
    advice: params.advice,
    generatedAt: (params.now ?? new Date()).toISOString(),
    source: params.source,
  };
}
