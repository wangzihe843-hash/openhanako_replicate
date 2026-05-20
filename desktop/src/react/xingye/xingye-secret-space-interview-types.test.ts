import { describe, expect, it } from 'vitest';
import {
  flattenSecretInterviewToContent,
  normalizeSecretInterviewMetadata,
  SECRET_INTERVIEW_DANMAKU_PER_QUESTION,
  SECRET_INTERVIEW_LIMITS,
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
