import { describe, expect, it } from 'vitest';
import { NEWS_ERA_STYLES, getNewsEraStyle } from './xingye-news-era-style';

describe('xingye-news-era-style (descriptors)', () => {
  it('三个 era 都有非空描述符（toneName / writingStyleGuide / mastheadStyleGuide / bylineStyleGuide / taboos）', () => {
    for (const era of ['oriental_classical', 'western_fantasy', 'modern_or_future'] as const) {
      const s = NEWS_ERA_STYLES[era];
      expect(s.toneName.length).toBeGreaterThan(0);
      expect(s.toneSummary.length).toBeGreaterThan(0);
      expect(s.writingStyleGuide.length).toBeGreaterThan(2);
      expect(s.headlineStyleGuide.length).toBeGreaterThan(0);
      expect(s.mastheadStyleGuide.length).toBeGreaterThan(0);
      expect(s.exampleMastheads.length).toBeGreaterThan(2);
      expect(s.bylineStyleGuide.length).toBeGreaterThan(0);
      expect(s.exampleBylines.length).toBeGreaterThan(2);
      expect(s.taboos.length).toBeGreaterThan(2);
    }
  });

  it('oriental_classical = 民国小报闲笔体（带文白夹杂 / 闲笔 / 笔名样本）', () => {
    const s = NEWS_ERA_STYLES.oriental_classical;
    expect(s.toneName).toMatch(/民国|小报|闲笔/);
    expect(s.toneSummary).toMatch(/文白|民国|闲笔/);
    // 写作守则里要看得到「也 / 矣 / 焉」之类的文言收句指引
    expect(s.writingStyleGuide.join('\n')).toMatch(/也|矣|焉|哉/);
    // 报头仿名样本里要有典型民国小报名
    expect(s.exampleMastheads.join(' ')).toMatch(/晶报|长安|沪|街市/);
    // 笔名样本里要看到「客 / 散人 / 居士 / 翁」类闲号
    expect(s.exampleBylines.join(' ')).toMatch(/客|散人|居士|翁|主人/);
    // 必须明禁现代物件
    expect(s.taboos.join('\n')).toMatch(/手机|微博|热搜|网友|抖音|app/);
  });

  it('western_fantasy = 早期西方八卦小报译文体（带翻译质感 / 汉化称谓 / 报名样本）', () => {
    const s = NEWS_ERA_STYLES.western_fantasy;
    expect(s.toneName).toMatch(/译文|西方|小报/);
    expect(s.toneSummary).toMatch(/译|broadsheet|gossip|17|18|19/i);
    // 写作守则里要看到长定语 / 从句 / 汉化称谓的指引
    expect(s.writingStyleGuide.join('\n')).toMatch(/定语|从句|爵士|夫人|主教|侯爵|绅士/);
    // 报头样本要有「邮报 / 公报 / 时讯 / 信使」之类
    expect(s.exampleMastheads.join(' ')).toMatch(/邮报|公报|时讯|信使|瞭望|纪闻/);
    // 笔名样本要看到「先生 / 旁观者 / 居士」译文笔调
    expect(s.exampleBylines.join(' ')).toMatch(/先生|旁观者|居士|笔者|Y\.Z\.|F\.A\./);
    // 必须明禁现代狗仔口吻
    expect(s.taboos.join('\n')).toMatch(/狗仔|网友|热搜|微博|手机/);
  });

  it('modern_or_future = 现代狗仔小报体（带网友 / 知情人 / 频段类替换词）', () => {
    const s = NEWS_ERA_STYLES.modern_or_future;
    expect(s.toneName).toMatch(/狗仔|小报|爆料/);
    expect(s.toneSummary).toMatch(/狗仔|小报|微博|爆料/);
    // 写作守则里要看到「网友 / 知情人 / 目击者 / 据……透露」之类的现代口吻指引
    expect(s.writingStyleGuide.join('\n')).toMatch(/网友|知情人|目击者|爆料|透露/);
    // 废土 / 赛博朋克替换词应当被列出
    expect(s.writingStyleGuide.join('\n')).toMatch(/频段|频道|通讯片|神经接驳|腕环|信号站/);
    // 报头样本里要看到现代 / 废土 / 太空风格的报名
    expect(s.exampleMastheads.join(' ')).toMatch(/日报|周刊|速递|晚报|猎影|辐尘|浮空|电讯|榜/);
    // 笔名样本里要看到「@ / 君 / 猎影 / 狗仔」类
    expect(s.exampleBylines.join(' ')).toMatch(/@|君|猎影|狗仔|观察/);
    // 必须明禁文言收句（防混进民国体）
    expect(s.taboos.join('\n')).toMatch(/也|矣|焉|哉|文言/);
  });

  it('getNewsEraStyle 对非法 era → fallback 到 modern_or_future（与 resolver 一致）', () => {
    // @ts-expect-error 故意传 null
    expect(getNewsEraStyle(null)).toBe(NEWS_ERA_STYLES.modern_or_future);
    // @ts-expect-error 故意传 undefined
    expect(getNewsEraStyle(undefined)).toBe(NEWS_ERA_STYLES.modern_or_future);
    // @ts-expect-error 故意传非法字符串
    expect(getNewsEraStyle('not_an_era')).toBe(NEWS_ERA_STYLES.modern_or_future);
  });

  it('三个 era 的笔名 / 报头样本互不重叠（防止 era 撞车）', () => {
    const oriental = new Set(NEWS_ERA_STYLES.oriental_classical.exampleMastheads);
    const western = new Set(NEWS_ERA_STYLES.western_fantasy.exampleMastheads);
    const modern = new Set(NEWS_ERA_STYLES.modern_or_future.exampleMastheads);
    for (const m of oriental) {
      expect(western.has(m)).toBe(false);
      expect(modern.has(m)).toBe(false);
    }
    for (const m of western) {
      expect(modern.has(m)).toBe(false);
    }
  });
});
