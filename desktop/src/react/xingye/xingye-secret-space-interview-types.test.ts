import { describe, expect, it } from 'vitest';
import {
  flattenSecretInterviewToContent,
  normalizeSecretInterviewMetadata,
  SECRET_INTERVIEW_DANMAKU_PER_QUESTION,
  SECRET_INTERVIEW_LIMITS,
  SECRET_INTERVIEW_PROP_LIMITS,
  SECRET_INTERVIEW_PROPS_PER_RECORD,
  SECRET_INTERVIEW_QUESTIONS_PER_RECORD,
} from './xingye-secret-space-interview-types';

function makeQuestion(qPrefix: string) {
  return {
    q: `${qPrefix} 你最近在忙什么？`,
    a: '我最近在边境医院值夜班，每天往返于急救室和病房之间，没什么时间想别的。' + 'A'.repeat(40),
    danmaku: [
      { text: '熟悉的眼神又来了', tag: 'audience' },
      { text: '姐姐永远是我心头朱砂痣', tag: 'fan' },
      { text: 'TA 看了一眼摄像机', tag: 'editor' },
      { text: '这一段我已经截图存好了', tag: 'fan' },
    ],
  };
}

function makeValidPayload(overrides?: Record<string, unknown>) {
  return {
    recordedAt: '2026-05-20T10:00:00.000Z',
    title: '专访 · 林雾：在边境医院的第七年',
    hostName: '本刊主笔 · 江默',
    hostIntro: '演播室的灯光打下来，'.repeat(10) + '主持人江默坐在沙发那头，朝 TA 抬了抬下巴。',
    questions: [
      makeQuestion('Q1'),
      makeQuestion('Q2'),
      makeQuestion('Q3'),
      makeQuestion('Q4'),
      makeQuestion('Q5'),
    ],
    backstage: '相机关了之后，TA 缓缓地把袖口又拉了拉。'.repeat(8) + '主持人没说话，只是把椅子推回了原位。',
    ...overrides,
  };
}

describe('normalizeSecretInterviewMetadata', () => {
  it('合法输入：5 题 + 必填字段齐全 → 返回 metadata', () => {
    const meta = normalizeSecretInterviewMetadata(makeValidPayload());
    expect(meta).not.toBeNull();
    expect(meta?.questions).toHaveLength(SECRET_INTERVIEW_QUESTIONS_PER_RECORD);
    expect(meta?.title).toContain('专访');
    expect(meta?.hostName).toContain('江默');
    expect(meta?.recordedAt).toBe('2026-05-20T10:00:00.000Z');
  });

  it('少于 5 题 → 返回 null（不接受残缺记录）', () => {
    const payload = makeValidPayload({ questions: [makeQuestion('Q1'), makeQuestion('Q2')] });
    expect(normalizeSecretInterviewMetadata(payload)).toBeNull();
  });

  it('多于 5 题 → 截到前 5 题（不报错）', () => {
    const extra = [makeQuestion('Q6'), makeQuestion('Q7')];
    const payload = makeValidPayload({
      questions: [
        makeQuestion('Q1'), makeQuestion('Q2'), makeQuestion('Q3'),
        makeQuestion('Q4'), makeQuestion('Q5'), ...extra,
      ],
    });
    const meta = normalizeSecretInterviewMetadata(payload);
    expect(meta?.questions).toHaveLength(SECRET_INTERVIEW_QUESTIONS_PER_RECORD);
  });

  it('缺 title / hostIntro / backstage 任一 → 返回 null', () => {
    expect(normalizeSecretInterviewMetadata(makeValidPayload({ title: '' }))).toBeNull();
    expect(normalizeSecretInterviewMetadata(makeValidPayload({ hostIntro: '' }))).toBeNull();
    expect(normalizeSecretInterviewMetadata(makeValidPayload({ backstage: '' }))).toBeNull();
  });

  it('hostName 缺失 → fallback 到「本刊记者」（不报错）', () => {
    const meta = normalizeSecretInterviewMetadata(makeValidPayload({ hostName: '' }));
    expect(meta?.hostName).toBe('本刊记者');
  });

  it('超长字段被截到 max 并加省略号', () => {
    const longA = 'A'.repeat(SECRET_INTERVIEW_LIMITS.answerMax + 80);
    const payload = makeValidPayload({
      questions: [
        { q: '问', a: longA, danmaku: [] },
        makeQuestion('Q2'), makeQuestion('Q3'),
        makeQuestion('Q4'), makeQuestion('Q5'),
      ],
    });
    const meta = normalizeSecretInterviewMetadata(payload);
    expect(meta?.questions[0].a).toHaveLength(SECRET_INTERVIEW_LIMITS.answerMax);
    expect(meta?.questions[0].a.endsWith('…')).toBe(true);
  });

  it('弹幕：非法 tag 回退到 audience；空文本被丢弃；超出 max 截掉尾部', () => {
    const tooMany = Array.from({ length: SECRET_INTERVIEW_DANMAKU_PER_QUESTION.max + 3 }, (_, i) => ({
      text: `弹幕${i}`,
      tag: i === 1 ? 'unknown_tag' : 'audience',
    }));
    const payload = makeValidPayload({
      questions: [
        { q: '问1', a: 'A'.repeat(80), danmaku: [{ text: '', tag: 'fan' }, ...tooMany] },
        makeQuestion('Q2'), makeQuestion('Q3'),
        makeQuestion('Q4'), makeQuestion('Q5'),
      ],
    });
    const meta = normalizeSecretInterviewMetadata(payload);
    const danmaku = meta?.questions[0].danmaku ?? [];
    expect(danmaku.length).toBeLessThanOrEqual(SECRET_INTERVIEW_DANMAKU_PER_QUESTION.max);
    expect(danmaku.every((d) => d.text.length > 0)).toBe(true);
    expect(danmaku.find((d) => d.text === '弹幕1')?.tag).toBe('audience');
  });

  it('userQuestionIndex：合法整数 0..4 保留；越界 / 非整数 / 负数 丢弃', () => {
    expect(normalizeSecretInterviewMetadata(makeValidPayload({ userQuestionIndex: 2 }))?.userQuestionIndex).toBe(2);
    expect(normalizeSecretInterviewMetadata(makeValidPayload({ userQuestionIndex: 5 }))?.userQuestionIndex).toBeUndefined();
    expect(normalizeSecretInterviewMetadata(makeValidPayload({ userQuestionIndex: -1 }))?.userQuestionIndex).toBeUndefined();
    expect(normalizeSecretInterviewMetadata(makeValidPayload({ userQuestionIndex: 2.5 }))?.userQuestionIndex).toBeUndefined();
  });

  it('非对象 / 数组 / null → 返回 null', () => {
    expect(normalizeSecretInterviewMetadata(null)).toBeNull();
    expect(normalizeSecretInterviewMetadata([])).toBeNull();
    expect(normalizeSecretInterviewMetadata('not an object')).toBeNull();
  });

  it('recordedAt 缺失或非字符串 → 用当前时间兜底（仍能产出 metadata）', () => {
    const meta = normalizeSecretInterviewMetadata(makeValidPayload({ recordedAt: undefined }));
    expect(meta).not.toBeNull();
    expect(Number.isNaN(Date.parse(meta!.recordedAt))).toBe(false);
  });
});

describe('normalizeSecretInterviewMetadata · backstageProps', () => {
  it('缺 backstageProps → metadata 仍有效，字段缺省（向后兼容）', () => {
    const meta = normalizeSecretInterviewMetadata(makeValidPayload());
    expect(meta).not.toBeNull();
    expect(meta?.backstageProps).toBeUndefined();
  });

  it('合法 1-3 件物件 → 全部保留', () => {
    const meta = normalizeSecretInterviewMetadata(makeValidPayload({
      backstageProps: [
        { id: 'button', label: '黄铜纽扣', icon: 'button', x: 72, y: 42, snippet: '岑姨给的。' },
        { id: 'cup', label: '没动过的水', icon: 'cup', x: 20, y: 64, snippet: '一口没喝。' },
      ],
    }));
    expect(meta?.backstageProps).toHaveLength(2);
    expect(meta?.backstageProps?.[0].id).toBe('button');
  });

  it('超出 max 件 → 截到前 max 件', () => {
    const overshoot = SECRET_INTERVIEW_PROPS_PER_RECORD.max + 2;
    const props = Array.from({ length: overshoot }, (_, i) => ({
      id: `prop_${i}`,
      label: `物件 ${i}`,
      icon: 'note',
      x: 30,
      y: 30,
      snippet: `这是第 ${i} 件注脚。`,
    }));
    const meta = normalizeSecretInterviewMetadata(makeValidPayload({ backstageProps: props }));
    expect(meta?.backstageProps).toHaveLength(SECRET_INTERVIEW_PROPS_PER_RECORD.max);
  });

  it('单件含坏数据 → 该件被丢弃，其它件保留；其它字段不受影响', () => {
    const meta = normalizeSecretInterviewMetadata(makeValidPayload({
      backstageProps: [
        { id: 'good', label: '好物件', icon: 'cup', x: 30, y: 30, snippet: '能用。' },
        // 缺 label → 丢弃
        { id: 'bad_no_label', icon: 'cup', x: 30, y: 30, snippet: '没标签。' },
        // 缺 snippet → 丢弃
        { id: 'bad_no_snippet', label: '没注脚', icon: 'cup', x: 30, y: 30 },
        // id 含非法字符 → 仅剩合法字符
        { id: '中文/!@#button', label: 'X', icon: 'button', x: 50, y: 50, snippet: 'ok' },
      ],
    }));
    expect(meta).not.toBeNull();
    expect(meta?.title).toContain('专访'); // 其它字段不受影响
    const props = meta?.backstageProps ?? [];
    expect(props.map((p) => p.id)).toContain('good');
    expect(props.find((p) => p.id === 'bad_no_label')).toBeUndefined();
    expect(props.find((p) => p.id === 'bad_no_snippet')).toBeUndefined();
    // 中文被去掉，剩 'button'
    expect(props.find((p) => p.id === 'button')).toBeDefined();
  });

  it('全部 props 都坏 → backstageProps 字段省略（不写空数组）', () => {
    const meta = normalizeSecretInterviewMetadata(makeValidPayload({
      backstageProps: [
        { id: '', label: '', icon: 'foo', x: 'no', y: NaN, snippet: '' },
        'not an object',
        null,
      ],
    }));
    expect(meta?.backstageProps).toBeUndefined();
  });

  it('未知 icon → fallback 到 note', () => {
    const meta = normalizeSecretInterviewMetadata(makeValidPayload({
      backstageProps: [{ id: 'a', label: '物', icon: 'unknown_kind', x: 50, y: 50, snippet: '注。' }],
    }));
    expect(meta?.backstageProps?.[0].icon).toBe('note');
  });

  it('x/y 越界 → clamp 到 [8, 92]', () => {
    const meta = normalizeSecretInterviewMetadata(makeValidPayload({
      backstageProps: [
        { id: 'a', label: '物 A', icon: 'cup', x: -50, y: 200, snippet: '注。' },
        { id: 'b', label: '物 B', icon: 'cup', x: 'bad', y: undefined, snippet: '注。' },
      ],
    }));
    expect(meta?.backstageProps?.[0].x).toBe(8);
    expect(meta?.backstageProps?.[0].y).toBe(92);
    expect(meta?.backstageProps?.[1].x).toBe(50); // clampPropPct fallback
    expect(meta?.backstageProps?.[1].y).toBe(50);
  });

  it('label / snippet 超长 → 截断 + 省略号', () => {
    const longLabel = '黄'.repeat(SECRET_INTERVIEW_PROP_LIMITS.labelMax + 8);
    const longSnippet = '注'.repeat(SECRET_INTERVIEW_PROP_LIMITS.snippetMax + 12);
    const meta = normalizeSecretInterviewMetadata(makeValidPayload({
      backstageProps: [{ id: 'p1', label: longLabel, icon: 'cup', x: 50, y: 50, snippet: longSnippet }],
    }));
    const p = meta?.backstageProps?.[0];
    expect(p?.label).toHaveLength(SECRET_INTERVIEW_PROP_LIMITS.labelMax);
    expect(p?.label.endsWith('…')).toBe(true);
    expect(p?.snippet).toHaveLength(SECRET_INTERVIEW_PROP_LIMITS.snippetMax);
    expect(p?.snippet.endsWith('…')).toBe(true);
  });

  it('id 重复 → 只保留第一件', () => {
    const meta = normalizeSecretInterviewMetadata(makeValidPayload({
      backstageProps: [
        { id: 'dup', label: '第一件', icon: 'cup', x: 30, y: 30, snippet: '一。' },
        { id: 'dup', label: '第二件', icon: 'cup', x: 50, y: 50, snippet: '二。' },
      ],
    }));
    expect(meta?.backstageProps).toHaveLength(1);
    expect(meta?.backstageProps?.[0].label).toBe('第一件');
  });
});

describe('flattenSecretInterviewToContent', () => {
  it('把 metadata 拍平后包含 title / hostName / 各 Q / backstage 标记', () => {
    const meta = normalizeSecretInterviewMetadata(makeValidPayload())!;
    const text = flattenSecretInterviewToContent(meta);
    expect(text).toContain(meta.title);
    expect(text).toContain(`主持 / ${meta.hostName}`);
    for (let i = 0; i < SECRET_INTERVIEW_QUESTIONS_PER_RECORD; i++) {
      expect(text).toContain(`Q${i + 1}.`);
    }
    expect(text).toContain('【相机关了之后】');
  });
});
