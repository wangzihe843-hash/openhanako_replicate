import { describe, expect, it } from 'vitest';
import { formatQuotedSelectionForPrompt, getQuotedSourceHint } from '../../utils/quoted-selection';
import { parseUserAttachments } from '../../utils/message-parser';

describe('formatQuotedSelectionForPrompt', () => {
  it('includes source metadata and the selected original text in the model prompt', () => {
    const result = formatQuotedSelectionForPrompt({
      text: 'ChatGPT 2022 年底刚出来的时候，大家最先玩的是什么？角色扮演。',
      sourceTitle: '脚本-Kimi多智能体.md',
      sourceKind: 'preview',
      sourceFilePath: '/Users/test/脚本-Kimi多智能体.md',
      lineStart: 17,
      lineEnd: 17,
      charCount: 34,
    });

    expect(result).toBe([
      '[引用片段] 脚本-Kimi多智能体.md（第17-17行，共34字）路径: /Users/test/脚本-Kimi多智能体.md',
      '[引用原文]',
      'ChatGPT 2022 年底刚出来的时候，大家最先玩的是什么？角色扮演。',
      '[/引用原文]',
    ].join('\n'));
  });

  it('keeps quoted original text out of the displayed user message when restoring history', () => {
    const input = [
      '有点啰嗦',
      '',
      '[引用片段] 脚本-Kimi多智能体.md（第17-17行，共34字）路径: /Users/test/脚本-Kimi多智能体.md',
      '[引用原文]',
      'ChatGPT 2022 年底刚出来的时候，大家最先玩的是什么？角色扮演。',
      '[/引用原文]',
    ].join('\n');

    const result = parseUserAttachments(input);

    expect(result.text).toBe('有点啰嗦');
    expect(result.quotedText).toBe('ChatGPT 2022 年底刚出来的时候，大家最先玩的是什么？角色扮演。');
  });

  describe('app-share quotes carry an explicit [来源] hint', () => {
    it('accounting share frames the ledger as TA-owned and wraps multi-line body in [引用原文]', () => {
      const result = formatQuotedSelectionForPrompt({
        text: '2026-05-27 · TA 的账本（2 笔）\n— 支出\n  ¥ 32 · 早饭 · 食物',
        sourceTitle: '记账 · 本月',
        sourceKind: 'accounting',
        charCount: 42,
      });

      expect(result).toBe([
        '[引用片段] 记账 · 本月（共42字）',
        '[来源] "记账"模块 — 你自己的多币种收支账本。引用是按日/周/月聚合的账目片段，账本归你所有，用户是在翻看你的账本。',
        '[引用原文]',
        '2026-05-27 · TA 的账本（2 笔）',
        '— 支出',
        '  ¥ 32 · 早饭 · 食物',
        '[/引用原文]',
      ].join('\n'));
    });

    it('news share marks the body as third-party reporting, not authored by TA', () => {
      const hint = getQuotedSourceHint('news');
      expect(hint).toContain('"报纸"模块');
      expect(hint).toContain('第三方');
      expect(hint).toContain('不是你写的');
      expect(hint).toContain('TA 的批注');
      // 显式断言"批注"是 TA 本人留下的，避免日后改文案时再把人称写反。
      expect(hint).toContain('你本人');
    });

    it('secret-space share marks the records as TA-owned private drafts the user just peeked', () => {
      const hint = getQuotedSourceHint('secret-space');
      expect(hint).toContain('你的私密');
      expect(hint).toContain('原本不打算给用户看');
      expect(hint).toContain('翻到');
    });

    it('files share marks cabinet records as TA-owned notes the user is browsing', () => {
      const hint = getQuotedSourceHint('files');
      expect(hint).toContain('"资料柜"模块');
      expect(hint).toContain('笔记归你所有');
      expect(hint).toContain('用户是在翻');
    });

    it('secret-drawer share is distinct from secret-space — frames the entry as 底牌-level, unlocked-only', () => {
      const hint = getQuotedSourceHint('secret-drawer');
      expect(hint).toContain('抽屉最底层');
      expect(hint).toContain('底牌');
      expect(hint).toContain('解锁');
      // 必须和 secret-space 不同：抽屉独有的"动摇人设/安全感"语义
      expect(hint).toContain('动摇你的人设');
      expect(hint).not.toBe(getQuotedSourceHint('secret-space'));
    });

    it('shopping and secondhand share quotes are owned by TA, not by the user', () => {
      expect(getQuotedSourceHint('shopping')).toContain('你自己的购物记录');
      expect(getQuotedSourceHint('secondhand')).toContain('你出掉旧物');
    });

    it('preview and chat kinds emit no [来源] line', () => {
      expect(getQuotedSourceHint('preview')).toBeNull();
      expect(getQuotedSourceHint('chat')).toBeNull();
    });
  });

  it('round-trips through parseUserAttachments: app-share quotes survive history replay', () => {
    const formatted = formatQuotedSelectionForPrompt({
      text: '商品：旧iPad\n状态：已售\n买家：小李',
      sourceTitle: '二手 · 旧iPad',
      sourceKind: 'secondhand',
      charCount: 20,
    });
    const input = `帮我看看这条\n\n${formatted}`;

    const result = parseUserAttachments(input);

    expect(result.text).toBe('帮我看看这条');
    expect(result.quotedText).toBe('商品：旧iPad\n状态：已售\n买家：小李');
  });
});
