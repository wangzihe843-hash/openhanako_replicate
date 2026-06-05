/**
 * @vitest-environment jsdom
 *
 * 健康 AI 的确定性归一化核心 normalizeHealthDayResult：模型返回 → {scenario, advice}。
 * （generateHealthDayWithAI 的整条编排链由 PhoneHealthApp.test.tsx 在集成层覆盖；
 * 这里专测解析 / 降级 / 截断逻辑，不打网络。）
 */
import { describe, expect, it } from 'vitest';
import { normalizeHealthDayResult } from './xingye-health-ai';
import { HEALTH_FALLBACK_ADVICE } from './xingye-health-data';

const FIXED = new Date(2026, 5, 5, 9, 14); // 本地 09:14 → generatedAt 期望 '09:14'

describe('normalizeHealthDayResult', () => {
  it('正常对象：保留 scenario / title / body，generatedAt 取 now 的 HH:mm', () => {
    const out = normalizeHealthDayResult(
      { scenario: 'active', advice: { title: '活力满满', body: '今天步数不错。' } },
      FIXED,
    );
    expect(out).toEqual({
      scenario: 'active',
      advice: { title: '活力满满', body: '今天步数不错。', generatedAt: '09:14' },
    });
  });

  it('非法 / 缺失 scenario → 回落 calm', () => {
    expect(normalizeHealthDayResult({ scenario: 'foo', advice: { body: 'x' } }, FIXED).scenario).toBe('calm');
    expect(normalizeHealthDayResult({ advice: { body: 'x' } }, FIXED).scenario).toBe('calm');
  });

  it('advice 为字符串 → 当作 body，title 用默认「今日分析」', () => {
    const out = normalizeHealthDayResult({ scenario: 'calm', advice: '直接一段话' }, FIXED);
    expect(out.advice.body).toBe('直接一段话');
    expect(out.advice.title).toBe('今日分析');
  });

  it('缺 body → 用 scenario 对应的固定降级文案', () => {
    const out = normalizeHealthDayResult({ scenario: 'high_stress' }, FIXED);
    const fb = HEALTH_FALLBACK_ADVICE.high_stress;
    expect(out).toEqual({
      scenario: 'high_stress',
      advice: { title: fb.title, body: fb.body, generatedAt: '09:14' },
    });
  });

  it('title 截断到 60 字、body 截断到 1200 字', () => {
    const out = normalizeHealthDayResult(
      { scenario: 'calm', advice: { title: 'A'.repeat(80), body: 'B'.repeat(1500) } },
      FIXED,
    );
    expect(out.advice.title).toHaveLength(60);
    expect(out.advice.body).toHaveLength(1200);
  });

  it('raw 非对象（null / undefined / 字符串 / 数组 / 数字）→ calm + 降级', () => {
    for (const bad of [null, undefined, 'str', [1, 2], 42]) {
      const out = normalizeHealthDayResult(bad, FIXED);
      expect(out.scenario).toBe('calm');
      expect(out.advice.body).toBe(HEALTH_FALLBACK_ADVICE.calm.body);
    }
  });
});
