import { describe, expect, it } from 'vitest';
import { buildDivinationReadingPrompt, getDivinationSignLabel } from './xingye-divination-prompts';

describe('buildDivinationReadingPrompt', () => {
  const agent = { id: 'ag-1', name: '林雾', yuan: 'lin' };
  const agentLike = {
    displayName: '林雾',
    shortBio: '边境医生',
    backgroundSummary: '战乱中救治伤患，资源不足。',
    extraCorpus: '红盐码头、蓝线风铃、药柜与缝合线。',
  };

  it('includes method, sign label, JSON schema, and forbids user/third-person framings', () => {
    const prompt = buildDivinationReadingPrompt({
      agent,
      agentLike,
      methodId: 'field_oracle',
      methodLabel: '战地直觉/风险预判/行动签',
      symbols: ['☰', '☲', '※'],
    });
    expect(prompt).toContain('field_oracle');
    expect(prompt).toContain('战地直觉');
    expect(prompt).toContain('【行动签象】');
    expect(prompt).toMatch(/title/);
    expect(prompt).toMatch(/agentQuestion/);
    expect(prompt).toMatch(/content/);
    expect(prompt).toMatch(/严格 JSON/);
    expect(prompt).toMatch(/第一人称/);
    expect(prompt).toMatch(/禁止任何用户视角/);
    expect(prompt).toMatch(/禁止第三人称剖析角色/);
  });

  it('embeds extraCorpus and profile fields without exposing field names directly in narrative', () => {
    const prompt = buildDivinationReadingPrompt({
      agent,
      agentLike,
      methodId: 'tarot',
      methodLabel: '塔罗',
      symbols: ['◇', '◈'],
    });
    expect(prompt).toContain('边境医生');
    expect(prompt).toContain('红盐码头');
    expect(prompt).toMatch(/不要逐字引用/);
  });

  it('marks user theme as optional footer, not as the question', () => {
    const prompt = buildDivinationReadingPrompt({
      agent,
      agentLike,
      methodId: 'oracle_generic',
      methodLabel: '通用神谕',
      symbols: ['※'],
      userProvidedTheme: '某人是否可信',
    });
    expect(prompt).toMatch(/可选关注方向/);
    expect(prompt).toContain('某人是否可信');
    expect(prompt).toMatch(/不要让 agentQuestion 与该方向字面雷同/);
  });

  it('uses （无） placeholder for missing optional context blocks', () => {
    const prompt = buildDivinationReadingPrompt({
      agent,
      agentLike: { displayName: '林雾' },
      methodId: 'oracle_generic',
      methodLabel: '通用神谕',
      symbols: [],
    });
    expect(prompt).toMatch(/【最近场景[^】]*】[\s\S]*?（无）/);
    expect(prompt).toMatch(/【对 user 的关系状态摘要[^】]*】[\s\S]*?（无）/);
    expect(prompt).toMatch(/【最近一次手机首页巡检[^】]*】[\s\S]*?（无）/);
  });

  it('getDivinationSignLabel maps method ids', () => {
    expect(getDivinationSignLabel('iching_liuyao')).toBe('卦象');
    expect(getDivinationSignLabel('tarot')).toBe('牌面');
    expect(getDivinationSignLabel('field_oracle')).toBe('行动签象');
    expect(getDivinationSignLabel('oracle_generic')).toBe('签象');
  });
});
