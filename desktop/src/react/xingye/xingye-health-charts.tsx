/**
 * xingye-health-charts.tsx — 健康模块的纯 SVG 图表（不依赖任何 chart 库）。
 * 曲线形状 / 配色 / 标注方式取自设计稿 charts.jsx 与 health.jsx。
 */

import type { HealthStressSummary, SleepSegment } from './xingye-health-data';

const SLEEP_STAGE_COLORS: Record<SleepSegment['stage'], string> = {
  awake: '#E8DCC9',
  rem: '#C9B8A7',
  light: '#9D9A7C',
  deep: '#5D6B5B',
};

const STRESS_COLORS = {
  low: '#8FA888',
  mid: '#C9A66E',
  high: '#B5675B',
  track: '#EDE6DA',
};

/** Catmull-Rom → cubic bezier 平滑路径。 */
function smoothPath(pts: { x: number; y: number }[]): string {
  if (pts.length === 0) return '';
  let path = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    path += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
  }
  return path;
}

// ─────────────────────────────────────────────────────────
// 主页 hero 卡：心率 sparkline
// ─────────────────────────────────────────────────────────
export function HRSparkline({ data, color = '#C4736A' }: { data: number[]; color?: string }) {
  const w = 320;
  const h = 50;
  const yMin = 50;
  const yMax = 130;
  const stride = 4;
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < data.length; i += stride) {
    const x = (i / Math.max(1, data.length - 1)) * w;
    const y = (1 - (data[i] - yMin) / (yMax - yMin)) * h;
    pts.push({ x, y });
  }
  if (pts.length === 0) return null;
  const path = smoothPath(pts);
  const area = `${path} L ${w} ${h} L 0 ${h} Z`;
  return (
    <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ display: 'block' }}>
      <defs>
        <linearGradient id="xy-health-spark" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#xy-health-spark)" />
      <path d={path} fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ─────────────────────────────────────────────────────────
// 主页步数格：mini 柱
// ─────────────────────────────────────────────────────────
export function StepsMini({ data, color = '#8FA888' }: { data: number[]; color?: string }) {
  const maxV = Math.max(...data, 100);
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 36, marginTop: 8 }}>
      {data.map((v, i) => (
        <div
          key={i}
          style={{
            flex: 1,
            height: `${Math.max(6, (v / maxV) * 100)}%`,
            background: color,
            borderRadius: 1.5,
            opacity: v < maxV * 0.25 ? 0.35 : 0.85,
          }}
        />
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// 主页睡眠格：mini ribbon
// ─────────────────────────────────────────────────────────
export function SleepMini({ stages, totalHours }: { stages: SleepSegment[]; totalHours: number }) {
  const total = totalHours > 0 ? totalHours : 1;
  return (
    <div style={{ display: 'flex', height: 24, borderRadius: 5, overflow: 'hidden', marginTop: 10 }}>
      {stages.map((s, i) => (
        <div
          key={i}
          style={{ width: `${((s.end - s.start) / total) * 100}%`, background: SLEEP_STAGE_COLORS[s.stage] }}
        />
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// 详情页图例
// ─────────────────────────────────────────────────────────
export function SleepLegend() {
  const items: { stage: SleepSegment['stage']; label: string }[] = [
    { stage: 'awake', label: '清醒' },
    { stage: 'rem', label: 'REM' },
    { stage: 'light', label: '浅睡' },
    { stage: 'deep', label: '深睡' },
  ];
  return (
    <div style={{ display: 'flex', gap: 14, padding: '8px 6px 0', flexWrap: 'wrap' }}>
      {items.map((it) => (
        <div key={it.stage} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ width: 10, height: 10, borderRadius: 3, background: SLEEP_STAGE_COLORS[it.stage] }} />
          <div style={{ fontSize: 11, color: '#84736a', letterSpacing: 0.3 }}>{it.label}</div>
        </div>
      ))}
    </div>
  );
}

export function StressLegend({ summary }: { summary: HealthStressSummary }) {
  const items = [
    { label: '低压', color: STRESS_COLORS.low, h: summary.low },
    { label: '中压', color: STRESS_COLORS.mid, h: summary.mid },
    { label: '高压', color: STRESS_COLORS.high, h: summary.high },
  ];
  return (
    <div style={{ display: 'flex', gap: 8, padding: '8px 4px 0' }}>
      {items.map((it) => (
        <div
          key={it.label}
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            background: '#faf4ea',
            borderRadius: 8,
            padding: '6px 10px',
          }}
        >
          <div style={{ width: 8, height: 8, borderRadius: 4, background: it.color }} />
          <div style={{ fontSize: 11, color: '#84736a', flex: 1 }}>{it.label}</div>
          <div style={{ fontSize: 12, color: '#2b211a', fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>
            {it.h}h
          </div>
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// 详情页：心率 24h 平滑折线 + 渐变填充
// ─────────────────────────────────────────────────────────
export function HeartRateChart({ data }: { data: number[] }) {
  const w = 340;
  const h = 150;
  const pad = { l: 32, r: 8, t: 12, b: 22 };
  const innerW = w - pad.l - pad.r;
  const innerH = h - pad.t - pad.b;
  const yMin = 45;
  const yMax = 130;
  const xFor = (i: number) => pad.l + (i / Math.max(1, data.length - 1)) * innerW;
  const yFor = (v: number) => pad.t + (1 - (v - yMin) / (yMax - yMin)) * innerH;

  const stride = 3;
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < data.length; i += stride) pts.push({ x: xFor(i), y: yFor(data[i]) });
  if (pts.length === 0) return null;
  const path = smoothPath(pts);
  const area = `${path} L ${pts[pts.length - 1].x} ${pad.t + innerH} L ${pts[0].x} ${pad.t + innerH} Z`;
  const xTicks = [0, 4, 8, 12, 16, 20];
  const yTicks = [60, 90, 120];

  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{ display: 'block' }}>
      <defs>
        <linearGradient id="xy-health-hr" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#C4736A" stopOpacity="0.22" />
          <stop offset="100%" stopColor="#C4736A" stopOpacity="0" />
        </linearGradient>
      </defs>
      {yTicks.map((v) => (
        <g key={v}>
          <line
            x1={pad.l}
            x2={w - pad.r}
            y1={yFor(v)}
            y2={yFor(v)}
            stroke="#e7ddcd"
            strokeWidth="0.8"
            strokeDasharray="2 3"
          />
          <text
            x={pad.l - 6}
            y={yFor(v) + 3}
            textAnchor="end"
            fontSize="9"
            fill="#a89e90"
            fontFamily="ui-monospace, 'JetBrains Mono', monospace"
          >
            {v}
          </text>
        </g>
      ))}
      <path d={area} fill="url(#xy-health-hr)" />
      <path d={path} fill="none" stroke="#C4736A" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      {xTicks.map((hr) => (
        <text
          key={hr}
          x={pad.l + (hr / 23.92) * innerW}
          y={pad.t + innerH + 14}
          textAnchor="middle"
          fontSize="9"
          fill="#a89e90"
          fontFamily="ui-monospace, 'JetBrains Mono', monospace"
        >
          {hr.toString().padStart(2, '0')}:00
        </text>
      ))}
    </svg>
  );
}

// ─────────────────────────────────────────────────────────
// 详情页：步数 24 根圆角竖柱
// ─────────────────────────────────────────────────────────
export function StepsChart({ data }: { data: number[] }) {
  const w = 340;
  const h = 150;
  const pad = { l: 32, r: 8, t: 12, b: 22 };
  const innerW = w - pad.l - pad.r;
  const innerH = h - pad.t - pad.b;
  const maxV = Math.max(...data, 100);
  const gap = innerW / 24;
  const barW = gap * 0.7;
  const peakThresh = maxV * 0.6;
  const xTicks = [0, 6, 12, 18, 23];
  const yTickVals = [0, Math.round(maxV / 2 / 100) * 100, Math.round(maxV / 100) * 100];

  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{ display: 'block' }}>
      {yTickVals.map((v, i) => {
        const y = pad.t + (1 - v / maxV) * innerH;
        return (
          <g key={i}>
            <line x1={pad.l} x2={w - pad.r} y1={y} y2={y} stroke="#e7ddcd" strokeWidth="0.8" strokeDasharray="2 3" />
            <text
              x={pad.l - 6}
              y={y + 3}
              textAnchor="end"
              fontSize="9"
              fill="#a89e90"
              fontFamily="ui-monospace, 'JetBrains Mono', monospace"
            >
              {v}
            </text>
          </g>
        );
      })}
      {data.map((v, i) => {
        const x = pad.l + i * gap + (gap - barW) / 2;
        const barH = Math.max(2, (v / maxV) * innerH);
        const y = pad.t + innerH - barH;
        return (
          <rect
            key={i}
            x={x}
            y={y}
            width={barW}
            height={barH}
            rx={Math.min(barW / 2, 3)}
            fill={v >= peakThresh ? '#6F8C6E' : '#8FA888'}
          />
        );
      })}
      {xTicks.map((hr) => (
        <text
          key={hr}
          x={pad.l + (hr + 0.5) * gap}
          y={pad.t + innerH + 14}
          textAnchor="middle"
          fontSize="9"
          fill="#a89e90"
          fontFamily="ui-monospace, 'JetBrains Mono', monospace"
        >
          {hr}时
        </text>
      ))}
    </svg>
  );
}

// ─────────────────────────────────────────────────────────
// 详情页：睡眠 4 行横向分段甘特
// ─────────────────────────────────────────────────────────
export function SleepChart({ stages, totalHours }: { stages: SleepSegment[]; totalHours: number }) {
  const w = 340;
  const h = 150;
  const pad = { l: 44, r: 8, t: 12, b: 22 };
  const innerW = w - pad.l - pad.r;
  const innerH = h - pad.t - pad.b;
  const rowH = innerH / 4;
  const order: SleepSegment['stage'][] = ['awake', 'rem', 'light', 'deep'];
  const labelText: Record<SleepSegment['stage'], string> = {
    awake: '清醒',
    rem: 'REM',
    light: '浅睡',
    deep: '深睡',
  };
  const total = totalHours > 0 ? totalHours : 1;
  const xFor = (hr: number) => pad.l + (hr / total) * innerW;

  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{ display: 'block' }}>
      {order.map((stage, i) => {
        const y = pad.t + i * rowH + rowH / 2;
        return (
          <g key={stage}>
            <text
              x={pad.l - 8}
              y={y + 3}
              textAnchor="end"
              fontSize="9.5"
              fill="#7e7165"
              fontFamily="-apple-system, system-ui"
            >
              {labelText[stage]}
            </text>
            <line x1={pad.l} x2={w - pad.r} y1={y} y2={y} stroke="#efe6d4" strokeWidth="0.7" />
          </g>
        );
      })}
      {stages.map((s, i) => {
        const rowIdx = order.indexOf(s.stage);
        const y = pad.t + rowIdx * rowH + rowH / 2 - 6;
        return (
          <rect
            key={i}
            x={xFor(s.start)}
            y={y}
            width={Math.max(2, xFor(s.end) - xFor(s.start))}
            height={12}
            rx={3}
            fill={SLEEP_STAGE_COLORS[s.stage]}
          />
        );
      })}
      {[0, 2, 4, 6, 8, 10].map((hr) => {
        if (hr > total) return null;
        const clockH = (22 + hr) % 24;
        return (
          <text
            key={hr}
            x={xFor(hr)}
            y={pad.t + innerH + 14}
            textAnchor="middle"
            fontSize="9"
            fill="#a89e90"
            fontFamily="ui-monospace, 'JetBrains Mono', monospace"
          >
            {clockH.toString().padStart(2, '0')}:00
          </text>
        );
      })}
    </svg>
  );
}

// ─────────────────────────────────────────────────────────
// 详情页：压力 24 行横向柱（按值分段配色）
// ─────────────────────────────────────────────────────────
export function StressChart({ data }: { data: number[] }) {
  const w = 340;
  const rowH = 9;
  const gap = 1.5;
  const labelW = 28;
  const pad = { l: 6, r: 10, t: 6, b: 6 };
  const innerW = w - pad.l - pad.r - labelW;
  const h = pad.t + pad.b + 24 * (rowH + gap) - gap;
  const colorFor = (v: number) => (v <= 30 ? STRESS_COLORS.low : v <= 60 ? STRESS_COLORS.mid : STRESS_COLORS.high);

  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{ display: 'block' }}>
      {data.map((v, i) => {
        const y = pad.t + i * (rowH + gap);
        const barW = (v / 100) * innerW;
        return (
          <g key={i}>
            {i % 4 === 0 && (
              <text
                x={pad.l + labelW - 4}
                y={y + rowH - 1}
                textAnchor="end"
                fontSize="8.5"
                fill="#a89e90"
                fontFamily="ui-monospace, 'JetBrains Mono', monospace"
              >
                {i.toString().padStart(2, '0')}时
              </text>
            )}
            <rect x={pad.l + labelW} y={y} width={innerW} height={rowH} rx={rowH / 2} fill={STRESS_COLORS.track} />
            <rect
              x={pad.l + labelW}
              y={y}
              width={Math.max(2, barW)}
              height={rowH}
              rx={rowH / 2}
              fill={colorFor(v)}
            />
          </g>
        );
      })}
    </svg>
  );
}
