import { describe, expect, it } from 'vitest';
import { buildNewsDraftPrompt } from './xingye-news-prompts';
import { getNewsEraStyle } from './xingye-news-era-style';

const baseArgs = {
  agent: { id: 'ag-1', name: '林雾', yuan: 'lin' },
  userName: '小希',
  profile: {
    displayName: '林雾',
    shortBio: '一位边境医生',
    identitySummary: '',
    backgroundSummary: '',
    personalitySummary: '',
    relationshipLabel: '',
    speakingStyle: '',
    values: '',
    taboos: '',
    relationshipMode: '',
    behaviorLogic: '',
  } as any,
  issueDateIso: '2026-05-19T08:00:00.000Z',
  userIntent: '',
  recentSceneBlock: '（无）',
  stableLoreBlock: '（无）',
  keywordLoreBlock: '（无）',
  relationshipBlock: '（无）',
  heartbeatBlock: '（无）',
  continuityAnchorBlock: '',
};

describe('buildNewsDraftPrompt (era 分化)', () => {
  it('oriental_classical → prompt 含「民国小报闲笔体」专属指南、文言收句提示、闲号笔名样本', () => {
    const era = 'oriental_classical' as const;
    const prompt = buildNewsDraftPrompt({
      ...baseArgs,
      era,
      eraStyle: getNewsEraStyle(era),
    });
    // 笔调名出现
    expect(prompt).toContain('民国小报闲笔体');
    // 文言收句提示
    expect(prompt).toMatch(/[也矣焉哉]/);
    // 闲号笔名样本（至少出现一个）
    expect(prompt).toMatch(/灯下客|沪上散人|半亩居士|听雨翁|茶肆主人|南山居士/);
    // 报头仿名样本里有典型民国小报名
    expect(prompt).toMatch(/晶报|长安|街市闻|青衫闲笺|沪东新闻/);
    // 禁忌：明禁「微博 / 手机 / 网友 / 热搜」一类现代词
    expect(prompt).toMatch(/禁用现代物件|禁用.{0,8}手机|禁用.{0,8}微博|禁用.{0,12}网友/);
    // 必须没有混进现代狗仔的口吻指引
    expect(prompt).not.toMatch(/快门猎影|频段听众|狗仔小七/);
  });

  it('western_fantasy → prompt 含「译文体」专属指南、汉化外文称谓、broadsheet 风报头样本', () => {
    const era = 'western_fantasy' as const;
    const prompt = buildNewsDraftPrompt({
      ...baseArgs,
      era,
      eraStyle: getNewsEraStyle(era),
    });
    // 笔调名
    expect(prompt).toContain('早期西方八卦小报译文体');
    // 汉化称谓
    expect(prompt).toMatch(/爵士|夫人|主教|侯爵|绅士/);
    // 报头样本
    expect(prompt).toMatch(/王城邮报|圣安德烈公报|北方瞭望|齿轮纪闻|白塔时讯/);
    // byline 样本里有译文体笔名
    expect(prompt).toMatch(/Y\.Z\.|F\.A\.|不愿署名|宫廷外之旁观者|翁巴尔区/);
    // 禁忌：明禁现代狗仔口吻 / 现代物件
    expect(prompt).toMatch(/禁用.{0,12}(?:网友|热搜|微博|手机)/);
    // 不应混进民国闲笔体专属笔名
    expect(prompt).not.toMatch(/灯下客|沪上散人|半亩居士/);
  });

  it('modern_or_future → prompt 含「现代狗仔小报体」、网友 / 知情人指引、废土 / 赛博词汇替换', () => {
    const era = 'modern_or_future' as const;
    const prompt = buildNewsDraftPrompt({
      ...baseArgs,
      era,
      eraStyle: getNewsEraStyle(era),
    });
    expect(prompt).toContain('现代狗仔小报体');
    // 「网友 / 知情人 / 目击者」一类现代狗仔口吻必出现
    expect(prompt).toMatch(/网友|知情人|目击者|爆料|据.{0,8}透露/);
    // 废土 / 赛博朋克替换词指引必出现
    expect(prompt).toMatch(/频段|频道|通讯片|腕环|信号站|废土频道|夜城/);
    // 报头样本
    expect(prompt).toMatch(/城东周刊|热搜速递|夜城猎影|辐尘晚报|浮空电讯/);
    // 笔名样本（含「@」前缀或现代狗仔风名号）
    expect(prompt).toMatch(/镜头君|夜城狗仔|@.{0,12}|废墟猎影|轨道狗仔/);
    // 禁忌：明禁文言收句（防 era 互窜）
    expect(prompt).toMatch(/禁用.{0,12}(?:文言|也|矣|焉|哉)/);
    // 不应混进民国 / 译文体专属笔名
    expect(prompt).not.toMatch(/灯下客|沪上散人|半亩居士|不愿署名之绅士|宫廷外之旁观者/);
  });

  it('era label 写进 prompt（让模型自报家门），与 视角硬约束 节里的笔调引用一致', () => {
    const era = 'oriental_classical' as const;
    const prompt = buildNewsDraftPrompt({
      ...baseArgs,
      era,
      eraStyle: getNewsEraStyle(era),
    });
    expect(prompt).toContain('era（已由系统按 agent 设定识别）');
    expect(prompt).toContain('oriental_classical');
    expect(prompt).toContain('东方古典');
    // 视角硬约束节里也应引用同一 eraLabel
    expect(prompt).toMatch(/报道笔调贴合 TA 所在的世界观（东方古典/);
  });

  it('eraStyle 缺省时（强行传 null）按 era 兜底取一次，prompt 不空', () => {
    const prompt = buildNewsDraftPrompt({
      ...baseArgs,
      era: 'modern_or_future',
      // @ts-expect-error 模拟调用方失误，给 null
      eraStyle: null,
    });
    expect(prompt).toContain('现代狗仔小报体');
    expect(prompt).toMatch(/网友|目击者|爆料/);
  });

  it('不同 era 的 prompt 互相不应混入对方笔调名（避免 fallback bug 让 prompt 串调）', () => {
    const oriental = buildNewsDraftPrompt({
      ...baseArgs,
      era: 'oriental_classical',
      eraStyle: getNewsEraStyle('oriental_classical'),
    });
    const western = buildNewsDraftPrompt({
      ...baseArgs,
      era: 'western_fantasy',
      eraStyle: getNewsEraStyle('western_fantasy'),
    });
    const modern = buildNewsDraftPrompt({
      ...baseArgs,
      era: 'modern_or_future',
      eraStyle: getNewsEraStyle('modern_or_future'),
    });
    expect(oriental).not.toContain('早期西方八卦小报译文体');
    expect(oriental).not.toContain('现代狗仔小报体');
    expect(western).not.toContain('民国小报闲笔体');
    expect(western).not.toContain('现代狗仔小报体');
    expect(modern).not.toContain('民国小报闲笔体');
    expect(modern).not.toContain('早期西方八卦小报译文体');
  });
});
