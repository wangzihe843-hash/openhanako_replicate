import { describe, expect, it } from 'vitest';
import {
  sanitizeDivinationReadingContent,
  summarizeDivinationContextSources,
  titleForDivinationEntry,
} from './phone-divination-narrative';

describe('phone-divination-narrative helpers (post-AI route)', () => {
  it('title uses agent question snippet', () => {
    expect(titleForDivinationEntry('field_oracle', '补给线还能撑多久')).toContain('补给线');
  });

  it('title truncates long questions', () => {
    const long = '补给线还能撑多久这件事我已经反复在心里推演了一整夜也没有答案';
    const title = titleForDivinationEntry('field_oracle', long);
    expect(title).toMatch(/…/);
    expect(title).toContain('【');
    expect(title).toContain('】');
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
