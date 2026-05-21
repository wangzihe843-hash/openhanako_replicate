import { describe, expect, it } from 'vitest';
import {
  buildHealthDayData,
  HEALTH_FALLBACK_ADVICE,
  healthDateLabel,
  healthWeekdayLabel,
  makeHealthDay,
  todayIsoDate,
  type HealthScenario,
  type XingyeHealthDay,
} from './xingye-health-data';

function day(isoDate: string, scenario: HealthScenario): XingyeHealthDay {
  return makeHealthDay({
    isoDate,
    scenario,
    advice: null,
    source: 'ai',
    now: new Date('2026-05-21T09:14:00.000Z'),
  });
}

describe('xingye-health-data: seeded generators', () => {
  it('produces the four curves with the expected lengths', () => {
    const d = buildHealthDayData(day('2026-05-21', 'calm'));
    expect(d.hr).toHaveLength(288);
    expect(d.steps).toHaveLength(24);
    expect(d.stress).toHaveLength(24);
    expect(d.sleep.stages.length).toBeGreaterThan(0);
    expect(d.sleep.totalHours).toBeGreaterThan(0);
  });

  it('is deterministic: same isoDate + scenario yields identical curves', () => {
    const a = buildHealthDayData(day('2026-05-21', 'calm'));
    const b = buildHealthDayData(day('2026-05-21', 'calm'));
    expect(b.hr).toEqual(a.hr);
    expect(b.steps).toEqual(a.steps);
    expect(b.stress).toEqual(a.stress);
  });

  it('varies the curves across different dates', () => {
    const a = buildHealthDayData(day('2026-05-21', 'calm'));
    const b = buildHealthDayData(day('2026-05-20', 'calm'));
    expect(b.hr).not.toEqual(a.hr);
    expect(b.stress).not.toEqual(a.stress);
  });

  it('keeps stress samples inside the 5–100 range', () => {
    const d = buildHealthDayData(day('2026-05-21', 'high_stress'));
    for (const v of d.stress) {
      expect(v).toBeGreaterThanOrEqual(5);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  it('reflects the scenario: high_stress is more stressed, active walks more', () => {
    const calm = buildHealthDayData(day('2026-05-21', 'calm'));
    const stressed = buildHealthDayData(day('2026-05-21', 'high_stress'));
    const active = buildHealthDayData(day('2026-05-21', 'active'));
    expect(stressed.stressSummary.avg).toBeGreaterThan(calm.stressSummary.avg);
    expect(active.stepsSummary.total).toBeGreaterThan(calm.stepsSummary.total);
  });

  it('classifies the stress level from the daily average', () => {
    // high_stress lands mid-or-high (the exact band depends on the per-day shift),
    // while calm never reaches the high band.
    expect(['mid', 'high']).toContain(buildHealthDayData(day('2026-05-21', 'high_stress')).stressSummary.level);
    expect(['low', 'mid']).toContain(buildHealthDayData(day('2026-05-21', 'calm')).stressSummary.level);
  });
});

describe('xingye-health-data: helpers', () => {
  it('formats date and weekday labels', () => {
    expect(healthDateLabel('2026-05-21')).toBe('5月21日');
    expect(healthWeekdayLabel('2026-05-21')).toBe('星期四');
  });

  it('marks isToday relative to the supplied clock', () => {
    const now = new Date(2026, 4, 21, 10, 0, 0);
    expect(buildHealthDayData(day('2026-05-21', 'calm'), now).isToday).toBe(true);
    expect(buildHealthDayData(day('2026-05-20', 'calm'), now).isToday).toBe(false);
  });

  it('todayIsoDate uses local calendar parts', () => {
    expect(todayIsoDate(new Date(2026, 4, 9, 23, 30))).toBe('2026-05-09');
  });

  it('ships fallback advice for every scenario', () => {
    for (const scenario of ['calm', 'high_stress', 'active'] as HealthScenario[]) {
      expect(HEALTH_FALLBACK_ADVICE[scenario].body.length).toBeGreaterThan(80);
    }
  });
});
