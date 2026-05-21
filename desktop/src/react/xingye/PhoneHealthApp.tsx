/**
 * PhoneHealthApp.tsx — 星野小手机「健康」App。
 *
 * 视觉与交互照搬 health-module-design 设计稿：
 *   主页：心率 hero 卡 + 步数/睡眠双格 + 压力宽卡 + 建议卡（页底）。
 *   详情页：大数值 + 摘要小格 + 24h 图表 + 左右翻历史（翻到头出 toast）。
 *
 * 数据来源：一键「AI 生成」——模型只回「当天状态 + 建议」，四条曲线在本地按
 * isoDate 播种随机生成。不接任何真实健康 SDK。
 */

import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import type { Agent } from '../types';
import styles from './XingyeShell.module.css';
import { generateHealthDayWithAI } from './xingye-health-ai';
import {
  HeartRateChart,
  HRSparkline,
  SleepChart,
  SleepLegend,
  SleepMini,
  StepsChart,
  StepsMini,
  StressChart,
  StressLegend,
} from './xingye-health-charts';
import {
  buildHealthDayData,
  healthDateLabel,
  healthWeekdayLabel,
  makeHealthDay,
  todayIsoDate,
  type HealthDayData,
  type HealthMetricKey,
  type XingyeHealthDay,
} from './xingye-health-data';
import { ModuleAdvice, ModuleHeart, ModuleSleep, ModuleSteps, ModuleStress } from './xingye-health-icons';
import { listHealthDays, upsertHealthDay } from './xingye-health-store';
import { useXingyeRoleProfile } from './xingye-profile-store';

export interface PhoneHealthAppProps {
  ownerAgent: Agent | null;
  displayName: string;
  onBack: () => void;
}

const ICON_SW = 2.2;
const PAGE_BG = '#f3efe8';

const fmtSteps = (n: number): string => n.toLocaleString('en-US');
function fmtHours(h: number): string {
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  return `${hh}h ${mm}m`;
}

const stressColorMap = {
  low: { bg: '#7E9A6C', soft: '#D7E0CB' },
  mid: { bg: '#C9A66E', soft: '#EEDFC4' },
  high: { bg: '#C77C5E', soft: '#F1D8C9' },
} as const;

// ─────────────────────────────────────────────────────────
// 通用：按压缩放反馈
// ─────────────────────────────────────────────────────────
function TilePressable({
  onClick,
  children,
  style,
  testId,
}: {
  onClick: () => void;
  children: ReactNode;
  style?: CSSProperties;
  testId?: string;
}) {
  const [pressed, setPressed] = useState(false);
  return (
    <div
      role="button"
      tabIndex={0}
      data-testid={testId}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      onPointerDown={() => setPressed(true)}
      onPointerUp={() => setPressed(false)}
      onPointerLeave={() => setPressed(false)}
      style={{
        cursor: 'pointer',
        transform: pressed ? 'scale(0.985)' : 'scale(1)',
        transition: 'transform 0.15s ease',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function RoundIconButton({
  onClick,
  ariaLabel,
  children,
}: {
  onClick: () => void;
  ariaLabel: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={onClick}
      style={{
        width: 36,
        height: 36,
        borderRadius: 18,
        background: 'rgba(255,255,255,0.7)',
        border: '0.5px solid rgba(0,0,0,0.08)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        padding: 0,
        flexShrink: 0,
      }}
    >
      {children}
    </button>
  );
}

const BackChevron = (
  <svg width="11" height="18" viewBox="0 0 11 18" aria-hidden="true">
    <path d="M9 1L2 9l7 8" fill="none" stroke="#6e5e4f" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const RightChevron = (
  <svg width="10" height="16" viewBox="0 0 10 16" aria-hidden="true" style={{ flexShrink: 0 }}>
    <path d="M2 1l6 7-6 7" fill="none" stroke="#b9a995" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// ─────────────────────────────────────────────────────────
// 主页 hero：心率
// ─────────────────────────────────────────────────────────
function HeroHR({ day, onOpen }: { day: HealthDayData; onOpen: () => void }) {
  return (
    <TilePressable onClick={onOpen} style={{ margin: '0 16px 12px' }} testId="phone-health-hero-hr">
      <div
        style={{
          background: '#fbf7ef',
          borderRadius: 22,
          padding: '18px 18px 6px',
          border: '0.5px solid rgba(0,0,0,0.04)',
          overflow: 'hidden',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div
            style={{
              width: 38,
              height: 38,
              borderRadius: 12,
              background: '#C4736A',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <ModuleHeart size={22} sw={ICON_SW} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, color: '#84736a', letterSpacing: 0.5 }}>心率</div>
            <div
              style={{
                fontSize: 11,
                color: '#C4736A',
                marginTop: 2,
                padding: '2px 9px',
                background: '#F1DDD8',
                borderRadius: 999,
                display: 'inline-block',
                fontWeight: 500,
                letterSpacing: 0.3,
              }}
            >
              {day.hrSummary.status}
            </div>
          </div>
          {RightChevron}
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 8 }}>
          <div
            style={{
              fontSize: 44,
              fontWeight: 300,
              color: '#2b211a',
              letterSpacing: -1.2,
              lineHeight: 1.05,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {day.hrSummary.avg}
          </div>
          <div style={{ fontSize: 14, color: '#a59585' }}>bpm 平均</div>
          <div style={{ flex: 1 }} />
          <div style={{ fontSize: 11, color: '#a59585', fontVariantNumeric: 'tabular-nums' }}>
            <span style={{ color: '#2b211a', fontWeight: 500 }}>{day.hrSummary.min}</span> –{' '}
            <span style={{ color: '#2b211a', fontWeight: 500 }}>{day.hrSummary.max}</span>
          </div>
        </div>
        <div style={{ marginTop: 6, marginLeft: -4, marginRight: -4 }}>
          <HRSparkline data={day.hr} />
        </div>
      </div>
    </TilePressable>
  );
}

function MetricTileShell({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        background: '#fbf7ef',
        borderRadius: 18,
        padding: '14px 14px 12px',
        border: '0.5px solid rgba(0,0,0,0.04)',
        height: '100%',
      }}
    >
      {children}
    </div>
  );
}

function StepsTile({ day, onOpen }: { day: HealthDayData; onOpen: () => void }) {
  const pct = day.stepsSummary.pct;
  return (
    <TilePressable onClick={onOpen} testId="phone-health-tile-steps">
      <MetricTileShell>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div
            style={{
              width: 30,
              height: 30,
              borderRadius: 10,
              background: '#8FA888',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <ModuleSteps size={18} sw={ICON_SW} />
          </div>
          <div style={{ fontSize: 12, color: '#84736a', letterSpacing: 0.4 }}>步数</div>
        </div>
        <div
          style={{
            fontSize: 24,
            fontWeight: 500,
            color: '#2b211a',
            letterSpacing: -0.4,
            marginTop: 8,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {fmtSteps(day.stepsSummary.total)}
        </div>
        <div style={{ fontSize: 11, color: '#a59585', marginTop: 1, fontVariantNumeric: 'tabular-nums' }}>
          目标 {fmtSteps(day.stepsSummary.goal)} · {pct}%
        </div>
        <div style={{ marginTop: 8, height: 4, borderRadius: 2, background: '#ece4d4', overflow: 'hidden' }}>
          <div
            style={{ width: `${Math.min(100, pct)}%`, height: '100%', background: '#8FA888', borderRadius: 2 }}
          />
        </div>
        <StepsMini data={day.steps} />
      </MetricTileShell>
    </TilePressable>
  );
}

function SleepTile({ day, onOpen }: { day: HealthDayData; onOpen: () => void }) {
  return (
    <TilePressable onClick={onOpen} testId="phone-health-tile-sleep">
      <MetricTileShell>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div
            style={{
              width: 30,
              height: 30,
              borderRadius: 10,
              background: '#8B7CA0',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <ModuleSleep size={18} sw={ICON_SW} />
          </div>
          <div style={{ fontSize: 12, color: '#84736a', letterSpacing: 0.4 }}>睡眠</div>
        </div>
        <div
          style={{
            fontSize: 24,
            fontWeight: 500,
            color: '#2b211a',
            letterSpacing: -0.4,
            marginTop: 8,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {fmtHours(day.sleepSummary.totalH)}
        </div>
        <div style={{ fontSize: 11, color: '#a59585', marginTop: 1 }}>
          深睡{' '}
          <span style={{ color: '#2b211a', fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>
            {fmtHours(day.sleepSummary.deepH)}
          </span>
        </div>
        <SleepMini stages={day.sleep.stages} totalHours={day.sleep.totalHours} />
      </MetricTileShell>
    </TilePressable>
  );
}

function StressTile({ day, onOpen }: { day: HealthDayData; onOpen: () => void }) {
  const lvl = day.stressSummary.level;
  const c = stressColorMap[lvl];
  const moodText = lvl === 'low' ? '今日整体轻松' : lvl === 'high' ? '今日压力偏高' : '今日情绪平稳';
  return (
    <TilePressable onClick={onOpen} style={{ margin: '0 16px 12px' }} testId="phone-health-tile-stress">
      <div
        style={{
          background: '#fbf7ef',
          borderRadius: 22,
          padding: '16px 18px',
          border: '0.5px solid rgba(0,0,0,0.04)',
          display: 'flex',
          alignItems: 'center',
          gap: 16,
        }}
      >
        <div
          style={{
            width: 64,
            height: 64,
            borderRadius: 20,
            background: c.bg,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <ModuleStress size={42} sw={2.1} level={lvl} color="#fff" />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, color: '#84736a', letterSpacing: 0.4, marginBottom: 3 }}>压力</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
            <div
              style={{
                fontSize: 32,
                fontWeight: 400,
                color: '#2b211a',
                letterSpacing: -0.8,
                lineHeight: 1,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {day.stressSummary.avg}
            </div>
            <div style={{ fontSize: 12, color: '#a59585' }}>分</div>
            <div
              style={{
                fontSize: 11,
                color: c.bg,
                fontWeight: 500,
                padding: '3px 10px',
                borderRadius: 999,
                background: c.soft,
                marginLeft: 4,
                letterSpacing: 0.3,
              }}
            >
              {day.stressSummary.levelLabel}
            </div>
          </div>
          <div style={{ fontSize: 11, color: '#a59585', marginTop: 5 }}>{moodText}</div>
        </div>
        {RightChevron}
      </div>
    </TilePressable>
  );
}

function AdviceCard({ day }: { day: HealthDayData }) {
  const advice = day.advice;
  return (
    <div
      style={{
        margin: '4px 16px 14px',
        background: '#f8f0e8',
        borderRadius: 22,
        padding: '18px 18px 20px',
        border: '0.5px solid rgba(181, 134, 122, 0.18)',
      }}
      data-testid="phone-health-advice"
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: 10,
            background: '#B5867A',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <ModuleAdvice size={20} sw={ICON_SW} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, color: '#3a2e25', fontWeight: 600, letterSpacing: 0.3 }}>
            {advice?.title || '今日分析'}
          </div>
          <div style={{ fontSize: 11, color: '#a59585', marginTop: 1, fontVariantNumeric: 'tabular-nums' }}>
            由小手机健康分析生成{advice?.generatedAt ? ` · ${advice.generatedAt}` : ''}
          </div>
        </div>
        <div
          style={{
            fontSize: 11,
            color: '#B5867A',
            fontWeight: 500,
            padding: '3px 9px',
            borderRadius: 999,
            background: 'rgba(181, 134, 122, 0.15)',
            letterSpacing: 0.4,
          }}
        >
          AI
        </div>
      </div>
      {advice ? (
        <div
          style={{
            fontSize: 13.2,
            lineHeight: 1.75,
            color: '#43352b',
            letterSpacing: 0.1,
            whiteSpace: 'pre-line',
          }}
        >
          {advice.body}
        </div>
      ) : (
        <div style={{ fontSize: 12.5, lineHeight: 1.7, color: '#a59585' }}>
          这一天没有生成健康分析。点上方「AI 生成」可以根据 TA 最近的状态补一份。
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// 详情页
// ─────────────────────────────────────────────────────────
interface MetricTheme {
  title: string;
  accent: string;
  soft: string;
}

const METRIC_THEME: Record<HealthMetricKey, MetricTheme> = {
  hr: { title: '心率', accent: '#C4736A', soft: '#F1DDD8' },
  steps: { title: '步数', accent: '#8FA888', soft: '#DCE4D6' },
  sleep: { title: '睡眠', accent: '#8B7CA0', soft: '#DED7E6' },
  stress: { title: '压力', accent: '#C9A66E', soft: '#EEDFC4' },
};

function metricIcon(metric: HealthMetricKey, day: HealthDayData): ReactNode {
  if (metric === 'hr') return <ModuleHeart size={26} sw={ICON_SW} />;
  if (metric === 'steps') return <ModuleSteps size={26} sw={ICON_SW} />;
  if (metric === 'sleep') return <ModuleSleep size={26} sw={ICON_SW} />;
  return <ModuleStress size={26} sw={ICON_SW} level={day.stressSummary.level} color="#fff" />;
}

function metricPrimary(metric: HealthMetricKey, day: HealthDayData): { value: string; unit: string } {
  if (metric === 'hr') return { value: String(day.hrSummary.avg), unit: 'bpm' };
  if (metric === 'steps') return { value: fmtSteps(day.stepsSummary.total), unit: '步' };
  if (metric === 'sleep') return { value: fmtHours(day.sleepSummary.totalH), unit: '' };
  return { value: String(day.stressSummary.avg), unit: '分' };
}

function metricStatus(metric: HealthMetricKey, day: HealthDayData): string {
  if (metric === 'hr') return day.hrSummary.status;
  if (metric === 'steps') return `${day.stepsSummary.pct}% 已达成`;
  if (metric === 'sleep') return day.sleepSummary.totalH >= 7 ? '充足' : '偏少';
  return day.stressSummary.levelLabel;
}

function metricSummary(metric: HealthMetricKey, day: HealthDayData): { label: string; value: string; unit?: string }[] {
  if (metric === 'hr') {
    return [
      { label: '平均', value: String(day.hrSummary.avg), unit: 'bpm' },
      { label: '最高', value: String(day.hrSummary.max), unit: 'bpm' },
      { label: '最低', value: String(day.hrSummary.min), unit: 'bpm' },
    ];
  }
  if (metric === 'steps') {
    return [
      { label: '总步数', value: fmtSteps(day.stepsSummary.total) },
      { label: '目标', value: fmtSteps(day.stepsSummary.goal) },
      { label: '完成度', value: String(day.stepsSummary.pct), unit: '%' },
    ];
  }
  if (metric === 'sleep') {
    return [
      { label: '深睡', value: fmtHours(day.sleepSummary.deepH) },
      { label: 'REM', value: fmtHours(day.sleepSummary.remH) },
      { label: '清醒', value: String(day.sleepSummary.wakeCount), unit: '次' },
    ];
  }
  return [
    { label: '平均', value: String(day.stressSummary.avg), unit: '分' },
    { label: '峰值', value: String(day.stressSummary.peakVal), unit: '分' },
    { label: '峰值时段', value: `${day.stressSummary.peakHour}:00` },
  ];
}

function metricChart(metric: HealthMetricKey, day: HealthDayData): ReactNode {
  if (metric === 'hr') return <HeartRateChart data={day.hr} />;
  if (metric === 'steps') return <StepsChart data={day.steps} />;
  if (metric === 'sleep') {
    return (
      <>
        <SleepChart stages={day.sleep.stages} totalHours={day.sleep.totalHours} />
        <SleepLegend />
      </>
    );
  }
  return (
    <>
      <StressChart data={day.stress} />
      <StressLegend summary={day.stressSummary} />
    </>
  );
}

function DayHeader({ day }: { day: HealthDayData }) {
  const isYesterday = !day.isToday && (() => {
    const y = new Date();
    y.setDate(y.getDate() - 1);
    return day.isoDate === todayIsoDate(y);
  })();
  const label = day.isToday ? '今天' : isYesterday ? '昨天' : day.date;
  const sub = day.isToday || isYesterday ? day.fullDate : day.weekday;
  return (
    <div style={{ textAlign: 'center' }}>
      <div
        style={{ fontSize: 11, color: '#a59585', letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 2 }}
      >
        {sub}
      </div>
      <div style={{ fontSize: 18, color: '#2b211a', fontWeight: 500, letterSpacing: 1 }}>{label}</div>
    </div>
  );
}

function EdgeToast({ message }: { message: string | null }) {
  return (
    <div
      role="status"
      style={{
        position: 'absolute',
        top: 78,
        left: '50%',
        transform: `translateX(-50%) translateY(${message ? 0 : -8}px)`,
        opacity: message ? 1 : 0,
        transition: 'all 0.3s ease',
        background: 'rgba(43,33,26,0.85)',
        color: '#f3efe8',
        padding: '9px 16px',
        borderRadius: 999,
        fontSize: 12,
        letterSpacing: 0.4,
        pointerEvents: 'none',
        zIndex: 30,
        whiteSpace: 'nowrap',
      }}
    >
      {message ?? ''}
    </div>
  );
}

function HealthDetailView({
  metric,
  day,
  onBack,
  onPrev,
  onNext,
  toast,
}: {
  metric: HealthMetricKey;
  day: HealthDayData;
  onBack: () => void;
  onPrev: () => void;
  onNext: () => void;
  toast: string | null;
}) {
  const theme = METRIC_THEME[metric];
  const accent =
    metric === 'stress'
      ? stressColorMap[day.stressSummary.level].bg
      : theme.accent;
  const soft =
    metric === 'stress'
      ? stressColorMap[day.stressSummary.level].soft
      : theme.soft;
  const primary = metricPrimary(metric, day);

  return (
    <div style={{ position: 'relative', minHeight: '100%', background: PAGE_BG, paddingBottom: 36 }}>
      <div style={{ paddingTop: 14, paddingBottom: 10 }}>
        <div
          style={{
            padding: '0 14px',
            display: 'grid',
            gridTemplateColumns: '36px 1fr 36px 36px',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <RoundIconButton onClick={onBack} ariaLabel="返回健康主页">
            {BackChevron}
          </RoundIconButton>
          <DayHeader day={day} />
          <RoundIconButton onClick={onPrev} ariaLabel="上一天">
            {BackChevron}
          </RoundIconButton>
          <RoundIconButton onClick={onNext} ariaLabel="下一天">
            <span style={{ display: 'flex', transform: 'rotate(180deg)' }}>{BackChevron}</span>
          </RoundIconButton>
        </div>
      </div>

      <EdgeToast message={toast} />

      <div style={{ padding: '8px 22px 22px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 13,
              background: accent,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {metricIcon(metric, day)}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, color: '#84736a', letterSpacing: 0.5 }}>{theme.title}</div>
            <div
              style={{
                fontSize: 11,
                marginTop: 2,
                padding: '2px 8px',
                background: soft,
                borderRadius: 999,
                display: 'inline-block',
                color: accent,
                fontWeight: 500,
                letterSpacing: 0.3,
              }}
            >
              {metricStatus(metric, day)}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <div
            style={{
              fontSize: 56,
              fontWeight: 300,
              color: '#2b211a',
              letterSpacing: -1.5,
              lineHeight: 1,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {primary.value}
          </div>
          {primary.unit ? (
            <div style={{ fontSize: 16, color: '#a59585', letterSpacing: 0.3, marginBottom: 4 }}>{primary.unit}</div>
          ) : null}
        </div>
      </div>

      <div
        style={{
          margin: '0 16px 14px',
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 8,
        }}
      >
        {metricSummary(metric, day).map((s) => (
          <div
            key={s.label}
            style={{
              background: '#fbf7ef',
              borderRadius: 14,
              padding: '12px 12px 14px',
              border: '0.5px solid rgba(0,0,0,0.04)',
            }}
          >
            <div style={{ fontSize: 11, color: '#a59585', letterSpacing: 0.4, marginBottom: 6 }}>{s.label}</div>
            <div
              style={{
                fontSize: 19,
                color: '#2b211a',
                fontWeight: 500,
                fontVariantNumeric: 'tabular-nums',
                letterSpacing: -0.3,
              }}
            >
              {s.value}
              {s.unit ? (
                <span style={{ fontSize: 11, color: '#a59585', marginLeft: 2, fontWeight: 400 }}>{s.unit}</span>
              ) : null}
            </div>
          </div>
        ))}
      </div>

      <div
        style={{
          margin: '0 16px',
          background: '#fbf7ef',
          borderRadius: 18,
          padding: '14px 12px 12px',
          border: '0.5px solid rgba(0,0,0,0.04)',
        }}
      >
        <div style={{ fontSize: 12, color: '#84736a', letterSpacing: 0.6, padding: '0 6px 10px', fontWeight: 500 }}>
          24 小时趋势
        </div>
        {metricChart(metric, day)}
      </div>

      <div
        style={{
          textAlign: 'center',
          fontSize: 10.5,
          color: '#bcaf9d',
          letterSpacing: 0.6,
          padding: '24px 0 8px',
        }}
      >
        ‹ 左右切换日期 ›
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// 顶栏 + 标题
// ─────────────────────────────────────────────────────────
function HealthTopBar({
  onBack,
  onGenerate,
  aiBusy,
  generateLabel,
}: {
  onBack: () => void;
  onGenerate: () => void;
  aiBusy: boolean;
  generateLabel: string;
}) {
  return (
    <div style={{ paddingTop: 14, paddingBottom: 8 }}>
      <div
        style={{
          padding: '0 16px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
        }}
      >
        <RoundIconButton onClick={onBack} ariaLabel="返回手机主页">
          {BackChevron}
        </RoundIconButton>
        <button
          type="button"
          onClick={onGenerate}
          disabled={aiBusy}
          data-testid="phone-health-generate"
          style={{
            border: '0.5px solid rgba(181,134,122,0.35)',
            background: aiBusy ? 'rgba(181,134,122,0.18)' : '#B5867A',
            color: aiBusy ? '#8a6f63' : '#fff',
            borderRadius: 999,
            padding: '7px 14px',
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: 0.4,
            cursor: aiBusy ? 'default' : 'pointer',
          }}
        >
          {aiBusy ? '生成中…' : generateLabel}
        </button>
      </div>
    </div>
  );
}

function PageHeader({ dateLine }: { dateLine: string }) {
  return (
    <div style={{ padding: '4px 22px 18px' }}>
      <div
        style={{
          fontSize: 11,
          color: '#a59585',
          letterSpacing: 1.4,
          textTransform: 'uppercase',
          fontWeight: 500,
        }}
      >
        {dateLine}
      </div>
      <div
        style={{
          fontFamily: '"Noto Serif SC", "Songti SC", "Source Han Serif", serif',
          fontSize: 40,
          fontWeight: 500,
          color: '#2b211a',
          letterSpacing: 6,
          marginTop: 6,
          lineHeight: 1,
        }}
      >
        健 康
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// 根组件
// ─────────────────────────────────────────────────────────
export function PhoneHealthApp({ ownerAgent, displayName, onBack }: PhoneHealthAppProps) {
  const ownerAgentId = ownerAgent?.id ?? '';
  const ownerProfile = useXingyeRoleProfile(ownerAgentId);

  const [days, setDays] = useState<XingyeHealthDay[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ metric: HealthMetricKey; isoDate: string } | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!ownerAgentId) {
      setDays([]);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      setDays(await listHealthDays(ownerAgentId));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [ownerAgentId]);

  // 切换角色：重置详情页 + 错误并重新加载（避免 stale state）。
  useEffect(() => {
    setDetail(null);
    setToast(null);
    setAiError(null);
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!toast) return undefined;
    const id = window.setTimeout(() => setToast(null), 1400);
    return () => window.clearTimeout(id);
  }, [toast]);

  const today = todayIsoDate();
  const sortedIsoDates = useMemo(() => days.map((d) => d.isoDate), [days]);
  const latestStored = days[0] ?? null;
  const isTodayGenerated = days.some((d) => d.isoDate === today);

  // 主页展示「最近一条」记录。
  const mainDay = useMemo<HealthDayData | null>(
    () => (latestStored ? buildHealthDayData(latestStored) : null),
    [latestStored],
  );

  const detailDay = useMemo<HealthDayData | null>(() => {
    if (!detail) return null;
    const stored = days.find((d) => d.isoDate === detail.isoDate);
    return stored ? buildHealthDayData(stored) : null;
  }, [detail, days]);

  const handleGenerate = useCallback(async () => {
    if (!ownerAgent || aiBusy) return;
    setAiBusy(true);
    setAiError(null);
    try {
      const { scenario, advice } = await generateHealthDayWithAI({ agent: ownerAgent, ownerProfile });
      const day = makeHealthDay({ isoDate: today, scenario, advice, source: 'ai' });
      const next = await upsertHealthDay(ownerAgent.id, day);
      setDays(next);
      // 若正停在某指标详情页，刷新到「今天」那一格，让用户直接看到新数据。
      setDetail((d) => (d ? { ...d, isoDate: today } : d));
    } catch (e) {
      setAiError(e instanceof Error ? e.message : String(e));
    } finally {
      setAiBusy(false);
    }
  }, [ownerAgent, ownerProfile, aiBusy, today]);

  const openMetric = (metric: HealthMetricKey) => {
    if (!mainDay) return;
    setToast(null);
    setDetail({ metric, isoDate: mainDay.isoDate });
  };

  const stepDay = (dir: 'prev' | 'next') => {
    if (!detail) return;
    const idx = sortedIsoDates.indexOf(detail.isoDate);
    if (idx < 0) return;
    // sortedIsoDates 为新→旧：prev(更早)=idx+1，next(更新)=idx-1。
    const targetIdx = dir === 'prev' ? idx + 1 : idx - 1;
    if (targetIdx < 0) {
      setToast('已是最新数据');
      return;
    }
    if (targetIdx >= sortedIsoDates.length) {
      setToast('已是最早数据');
      return;
    }
    setToast(null);
    setDetail({ ...detail, isoDate: sortedIsoDates[targetIdx] });
  };

  // ── 无角色：不可用
  if (!ownerAgentId || !ownerAgent) {
    return (
      <div className={styles.phoneShell} aria-label="健康">
        <div className={styles.phoneStatusBar}>
          <button type="button" className={styles.phoneBackButton} onClick={onBack}>
            返回首页
          </button>
          <span>健康</span>
        </div>
        <div className={styles.phoneBody}>
          <section className={styles.phoneAppCard}>
            <h3 className={styles.phoneAppTitle}>健康不可用</h3>
            <p className={styles.phoneAppHint}>
              未选择角色 / 小手机不可用。健康数据写入当前角色在 HANA_HOME 下的星野目录，不能使用隐式角色回退。
            </p>
            <p className={styles.phoneAppHint}>请返回星野角色页，选择有效角色后再打开健康。</p>
          </section>
        </div>
      </div>
    );
  }

  // ── 详情页
  if (detail && detailDay) {
    return (
      <div className={styles.phoneShell} aria-label="健康详情">
        <HealthDetailView
          metric={detail.metric}
          day={detailDay}
          onBack={() => {
            setToast(null);
            setDetail(null);
          }}
          onPrev={() => stepDay('prev')}
          onNext={() => stepDay('next')}
          toast={toast}
        />
      </div>
    );
  }

  // ── 主页
  const ta = displayName || ownerAgent.name || 'TA';
  const dateLine = mainDay
    ? mainDay.isToday
      ? `${mainDay.fullDate} · ${ta}`
      : `${mainDay.fullDate} · 历史记录`
    : `${healthDateLabel(today)} ${healthWeekdayLabel(today)} · ${ta}`;

  return (
    <div className={styles.phoneShell} aria-label="健康">
      <div style={{ background: PAGE_BG, minHeight: 520, paddingBottom: 28, fontFamily: '-apple-system, "PingFang SC", system-ui' }}>
        <HealthTopBar
          onBack={onBack}
          onGenerate={() => void handleGenerate()}
          aiBusy={aiBusy}
          generateLabel={isTodayGenerated ? '重新生成' : 'AI 生成'}
        />
        <PageHeader dateLine={dateLine} />

        {aiError ? (
          <p
            role="alert"
            style={{ margin: '0 22px 12px', fontSize: 12, color: '#b5675b', lineHeight: 1.6 }}
          >
            生成失败：{aiError}
          </p>
        ) : null}
        {loadError ? (
          <p role="alert" style={{ margin: '0 22px 12px', fontSize: 12, color: '#b5675b' }}>
            加载失败：{loadError}
          </p>
        ) : null}

        {mainDay ? (
          <>
            {!mainDay.isToday ? (
              <div
                style={{
                  margin: '0 16px 12px',
                  padding: '9px 14px',
                  background: 'rgba(181,134,122,0.1)',
                  border: '0.5px solid rgba(181,134,122,0.2)',
                  borderRadius: 12,
                  fontSize: 11.5,
                  color: '#8a6f63',
                  lineHeight: 1.6,
                }}
              >
                今日还没有生成健康数据，当前显示最近一次记录（{mainDay.date}）。点右上角「AI 生成」更新。
              </div>
            ) : null}
            <HeroHR day={mainDay} onOpen={() => openMetric('hr')} />
            <div
              style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, margin: '0 16px 12px' }}
            >
              <StepsTile day={mainDay} onOpen={() => openMetric('steps')} />
              <SleepTile day={mainDay} onOpen={() => openMetric('sleep')} />
            </div>
            <StressTile day={mainDay} onOpen={() => openMetric('stress')} />
            <AdviceCard day={mainDay} />
          </>
        ) : (
          <div
            data-testid="phone-health-empty"
            style={{
              margin: '8px 16px',
              padding: '28px 22px',
              background: '#fbf7ef',
              borderRadius: 22,
              border: '0.5px solid rgba(0,0,0,0.04)',
              textAlign: 'center',
            }}
          >
            <div
              style={{
                width: 56,
                height: 56,
                borderRadius: 18,
                background: '#C4736A',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: '0 auto 14px',
              }}
            >
              <ModuleHeart size={32} sw={2} />
            </div>
            <div style={{ fontSize: 15, color: '#2b211a', fontWeight: 600, marginBottom: 6 }}>
              还没有健康数据
            </div>
            <p style={{ fontSize: 12.5, color: '#84736a', lineHeight: 1.7, margin: '0 0 16px' }}>
              {loading
                ? '加载中…'
                : '点下面的按钮，根据 TA 最近的聊天与状态生成今天的健康记录。心率、步数、睡眠、压力四项会在本地模拟，不接入任何真实健康设备。'}
            </p>
            <button
              type="button"
              onClick={() => void handleGenerate()}
              disabled={aiBusy}
              style={{
                border: 'none',
                background: aiBusy ? 'rgba(181,134,122,0.3)' : '#B5867A',
                color: '#fff',
                borderRadius: 999,
                padding: '11px 26px',
                fontSize: 13.5,
                fontWeight: 600,
                letterSpacing: 0.5,
                cursor: aiBusy ? 'default' : 'pointer',
              }}
            >
              {aiBusy ? '生成中…' : 'AI 生成今日健康'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
