import { describe, expect, it } from 'vitest';
import type { XingyeDivinationAgentLike } from './xingye-divination-method-resolver';
import {
  buildDivinationReadingContent,
  pickAgentDivinationQuestion,
  sanitizeDivinationReadingContent,
  summarizeDivinationContextSources,
  titleForDivinationEntry,
} from './phone-divination-narrative';

describe('phone-divination-narrative (agent-owned divination)', () => {
  const PERSPECTIVE_POLLUTION_RE =
    /用户|如果用户|林雾会|她会|TA 会|该角色|这个角色|角色设定|根据人设|根据背景|从设定来看|性格分析|建议用户/;

  it('builds only displayable divination prose without prompt/context leakage', () => {
    const text = buildDivinationReadingContent({
      displayName: '林雾',
      methodId: 'field_oracle',
      methodLabel: '战地直觉',
      agentQuestion: '我想确认补给线还能不能撑过下一轮。',
      userProvidedTheme: '某人是否可信',
      symbols: ['☰', '☱', '☲'],
      contextSummary: 'xingye.profile.json；xingye.lore.entries.json:长背景',
    });
    expect(text).toMatch(/我/);
    expect(text).toMatch(/牌面|签文|卦象|梦象|预感|符号|风声/);
    expect(text).toContain('某人是否可信');
    expect(text).not.toMatch(/xingye\.profile\.json|xingye\.lore\.entries\.json|上下文摘要|上下文线索/);
    expect(text).not.toMatch(/你是当前角色本人|不是别人替你发问|根据你的背景、近期状态/);
    expect(text).not.toMatch(/\b(prompt|context|system|developer|instruction|source|debug)\b/i);
    expect(text).not.toMatch(PERSPECTIVE_POLLUTION_RE);
    expect(text).toMatch(/【标题】/);
    expect(text).toMatch(/【(?:牌面|签象|卦象|行动签象)】/);
    expect(text).toMatch(/【正文】/);
    expect(text).toMatch(/【行动签】/);
  });

  it('without user theme, narrative does not claim user asked a question', () => {
    const text = buildDivinationReadingContent({
      displayName: 'TA',
      methodId: 'oracle_generic',
      methodLabel: '通用神谕',
      agentQuestion: '我心里那句主话还没成形。',
      symbols: ['※'],
      contextSummary: '',
    });
    expect(text).toMatch(/我/);
    expect(text).not.toContain('写下想问');
    expect(text).not.toContain('用户');
    expect(text).not.toContain('对方没有替你');
  });

  it('turns keyword lore into first-person divination images, not lore/source analysis', () => {
    const text = buildDivinationReadingContent({
      displayName: '林雾',
      methodId: 'field_oracle',
      methodLabel: '战地直觉 / 风险预判 / 行动签',
      agentQuestion: '我想确认这阵预感是不是又在提醒我回头。',
      symbols: ['☰', '☲'],
      contextSummary: '',
      agentContext: {
        displayName: '林雾',
        extraCorpus: '童年战乱经历。红盐码头、蓝线风铃事件。',
      },
    });
    expect(text).toMatch(/红盐码头|蓝线风铃/);
    expect(text).not.toMatch(/根据 lore|lore|设定|背景说明|来源|xingye/i);
    expect(text).not.toMatch(PERSPECTIVE_POLLUTION_RE);
  });

  it('field_oracle 林雾式语料：选题来自战地/医疗池，而非用户主题', () => {
    const agent: XingyeDivinationAgentLike = {
      displayName: '林雾',
      shortBio: '边境医生',
      backgroundSummary: '战乱中救治伤患，资源不足。',
    };
    const q = pickAgentDivinationQuestion('field_oracle', agent);
    expect(q.length).toBeGreaterThan(8);
    expect(/伤员|补给|撤离|感染|边境|哨卡|资源|止血/i.test(q)).toBe(true);
  });

  it('title uses agent question snippet', () => {
    expect(titleForDivinationEntry('field_oracle', '补给线还能撑多久')).toContain('补给线');
  });

  it('summarizeDivinationContextSources filters notices', () => {
    const s = summarizeDivinationContextSources([
      'xingye.profile.json',
      '[notice]未读取到纳入占法上下文的 enabled lore，仅使用 profile 摘要',
      '(build_failed)',
    ]);
    expect(s).toBe('');
    expect(s).not.toContain('[notice]');
    expect(s).not.toContain('xingye.profile.json');
  });

  it('sanitizer strips leaked prompt/context/source lines and keeps divination body', () => {
    const text = sanitizeDivinationReadingContent(`你是当前角色本人：不是别人替你发问。
根据你的背景、近期状态生成。
上下文摘要：
xingye.profile.json
xingye.lore.entries.json:红盐码头
debug context source instruction
牌面像一盏被风压低的灯。
我现在最该注意的是别把旧影子当作路标。
source: xingye-divination-method-resolver`);
    expect(text).toBe('牌面像一盏被风压低的灯。\n我现在最该注意的是别把旧影子当作路标。');
  });

  it('sanitizer removes third-person character-analysis perspective pollution', () => {
    const text = sanitizeDivinationReadingContent(`林雾会在这种情况下优先止血。
她会把风险拆成三步处理。
该角色的性格分析是冷静克制。
【正文】
我把牌面压在掌心，听见药柜里有一声很轻的回响。
【行动签】
先确认风向，再决定要不要开门。`);
    expect(text).toMatch(/我把牌面压在掌心/);
    expect(text).not.toMatch(/林雾会|她会|该角色|性格分析/);
  });

  it('sanitizer falls back for user-advice dominated text', () => {
    const text = sanitizeDivinationReadingContent(`如果用户继续追问，角色会以温柔但克制的方式回应用户。
建议用户不要逼迫她。
从设定来看，她对用户仍有戒心。`);
    expect(text).toMatch(/我/);
    expect(text).toMatch(/牌面|占卜|结果|风/);
    expect(text).not.toMatch(/用户|如果用户|建议用户|从设定来看|她对用户/);
  });

  it('sanitizer keeps normal first-person divination text', () => {
    const raw = `【正文】
我把牌面合上，听见蓝线风铃在很远的地方响了一下。
这不是命令，只是一点冷光，提醒我先别把空白填满。
【行动签】
先确认风从哪边来。`;
    expect(sanitizeDivinationReadingContent(raw)).toBe(raw);
  });

  it('sanitizer returns safe fallback when cleaned output is too short', () => {
    const text = sanitizeDivinationReadingContent(`你是当前角色本人。
xingye.profile.json
context debug source prompt system developer instruction`);
    expect(text.length).toBeGreaterThan(20);
    expect(text).toMatch(/我/);
    expect(text).not.toMatch(/xingye\.profile\.json|prompt|context|system|developer|instruction|source|debug/i);
  });
});
