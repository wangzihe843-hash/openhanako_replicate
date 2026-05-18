import { describe, expect, it } from 'vitest';
import { buildDivinationReadingPrompt, getDivinationActionLabel, getDivinationSignLabel } from './xingye-divination-prompts';

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

  it('getDivinationActionLabel maps method ids—not all methods share the "行动签" label', () => {
    /** 「行动签」是 field_oracle 本体概念；其他占法用各自专属 label。 */
    expect(getDivinationActionLabel('field_oracle')).toBe('行动签');
    expect(getDivinationActionLabel('iching_liuyao')).toBe('卦辞');
    expect(getDivinationActionLabel('tarot')).toBe('牌意指引');
    expect(getDivinationActionLabel('crystal_ball')).toBe('影像提示');
    expect(getDivinationActionLabel('runes')).toBe('符意建议');
    expect(getDivinationActionLabel('astrology')).toBe('星象建议');
    expect(getDivinationActionLabel('oracle_generic')).toBe('心象提示');
  });

  it('prompt switches 【action label】 by method (iching → 【卦辞】, tarot → 【牌意指引】, etc.)', () => {
    const ichingPrompt = buildDivinationReadingPrompt({
      agent, agentLike, methodId: 'iching_liuyao', methodLabel: '六爻', symbols: ['☰'],
    });
    expect(ichingPrompt).toContain('【卦辞】');
    expect(ichingPrompt).not.toContain('【行动签】');

    const tarotPrompt = buildDivinationReadingPrompt({
      agent, agentLike, methodId: 'tarot', methodLabel: '塔罗', symbols: ['◇'],
    });
    expect(tarotPrompt).toContain('【牌意指引】');
    expect(tarotPrompt).not.toContain('【行动签】');

    /** field_oracle 仍然用「行动签」——这是它本体概念。 */
    const fieldPrompt = buildDivinationReadingPrompt({
      agent, agentLike, methodId: 'field_oracle', methodLabel: '战地直觉', symbols: ['※'],
    });
    expect(fieldPrompt).toContain('【行动签】');
  });

  it('prompt includes fortuneScore / omens / luckyDirection / luckyColor in JSON schema', () => {
    const prompt = buildDivinationReadingPrompt({
      agent, agentLike, methodId: 'tarot', methodLabel: '塔罗', symbols: ['◇'],
    });
    expect(prompt).toContain('fortuneScore');
    expect(prompt).toContain('"overall"');
    expect(prompt).toContain('"career"');
    expect(prompt).toContain('"love"');
    expect(prompt).toContain('"wealth"');
    expect(prompt).toContain('omens');
    expect(prompt).toContain('"good"');
    expect(prompt).toContain('"bad"');
    expect(prompt).toContain('luckyDirection');
    expect(prompt).toContain('luckyColor');
  });

  it('luckyColor prompt requires descriptive Chinese phrase and forbids CSS color codes', () => {
    const prompt = buildDivinationReadingPrompt({
      agent, agentLike, methodId: 'tarot', methodLabel: '塔罗', symbols: ['◇'],
    });
    expect(prompt).toMatch(/<形容>的<颜色>色/);
    expect(prompt).toMatch(/古书纸的赭石色|晨雾的灰蓝色/);
    expect(prompt).toMatch(/禁止输出 #RRGGBB/);
  });

  it('fortune labels are method-specific (iching → 综合卦象 / field_oracle → 综合形势 + 可行/不可行)', () => {
    const ichingPrompt = buildDivinationReadingPrompt({
      agent, agentLike, methodId: 'iching_liuyao', methodLabel: '六爻', symbols: ['☰'],
    });
    expect(ichingPrompt).toContain('综合卦象');
    expect(ichingPrompt).toContain('吉位');
    expect(ichingPrompt).toContain('吉色');

    const fieldPrompt = buildDivinationReadingPrompt({
      agent, agentLike, methodId: 'field_oracle', methodLabel: '战地直觉', symbols: ['※'],
    });
    expect(fieldPrompt).toContain('综合形势');
    /** field_oracle 用「可行 / 不可行」+「朝向 / 标识色」。 */
    expect(fieldPrompt).toContain('可行');
    expect(fieldPrompt).toContain('不可行');
    expect(fieldPrompt).toContain('朝向');
    expect(fieldPrompt).toContain('标识色');
  });

  it('injects seedNarrative block when provided; omits it otherwise', () => {
    const without = buildDivinationReadingPrompt({
      agent, agentLike, methodId: 'oracle_generic', methodLabel: '通用神谕', symbols: ['※'],
    });
    expect(without).not.toContain('正式加工种子');

    const withSeed = buildDivinationReadingPrompt({
      agent, agentLike, methodId: 'oracle_generic', methodLabel: '通用神谕', symbols: ['※'],
      seedNarrative: {
        agentQuestion: '我是不是该听那阵风？',
        content: '风从北边来，桅杆轻轻晃。',
      },
    });
    expect(withSeed).toContain('正式加工种子');
    expect(withSeed).toContain('我是不是该听那阵风？');
    expect(withSeed).toContain('风从北边来');
    expect(withSeed).toMatch(/优先承接草稿/);
  });
});
