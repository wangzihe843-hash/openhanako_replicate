import { describe, expect, it } from 'vitest';
import {
  buildAnnotationContinuityAnchorBlock,
  detectAnnotationDuplicate,
  ANNOTATION_ANCHOR_SAMPLE_LIMIT,
  type AnnotationLike,
} from './xingye-reading-annotation-dedupe';

function ann(partial: Partial<AnnotationLike> & { bookId: string; title: string; annotation: string }): AnnotationLike {
  return { ...partial };
}

describe('buildAnnotationContinuityAnchorBlock', () => {
  it('空列表 → 空串', () => {
    expect(buildAnnotationContinuityAnchorBlock([], 'book-1')).toBe('');
  });

  it('bookId 为空 → 空串', () => {
    expect(buildAnnotationContinuityAnchorBlock([ann({ bookId: 'b1', title: 't', annotation: 'a' })], '')).toBe('');
  });

  it('只列同 bookId 的批注', () => {
    const out = buildAnnotationContinuityAnchorBlock(
      [
        ann({ bookId: 'b1', title: '关于第二章的疑问', annotation: '这一段让我想起母亲。她那时候也是这样欲言又止。' }),
        ann({ bookId: 'b2', title: '不该出现', annotation: '这本书我也读了。' }),
      ],
      'b1',
    );
    expect(out).toContain('你在这本书上已经写过的批注');
    expect(out).toContain('关于第二章的疑问');
    expect(out).toContain('这一段让我想起母亲');
    expect(out).not.toContain('不该出现');
  });

  it('最多抽 12 条', () => {
    const list: AnnotationLike[] = [];
    for (let i = 0; i < 20; i += 1) {
      list.push(ann({ bookId: 'b1', title: `批注${i}`, annotation: `内容${i}` }));
    }
    const out = buildAnnotationContinuityAnchorBlock(list, 'b1');
    expect(out).toContain('批注0');
    expect(out).toContain(`批注${ANNOTATION_ANCHOR_SAMPLE_LIMIT - 1}`);
    expect(out).not.toContain(`批注${ANNOTATION_ANCHOR_SAMPLE_LIMIT}`);
  });

  it('同本书没有任何批注 → 空串', () => {
    const out = buildAnnotationContinuityAnchorBlock(
      [ann({ bookId: 'b2', title: 't', annotation: 'a' })],
      'b1',
    );
    expect(out).toBe('');
  });
});

describe('detectAnnotationDuplicate', () => {
  it('candidate bookId 为空 → unique', () => {
    const existing = [ann({ bookId: 'b1', title: '一些感想', annotation: '这段让我难过。' })];
    expect(
      detectAnnotationDuplicate({ bookId: '', title: '一些感想', annotation: '这段让我难过。' }, existing).kind,
    ).toBe('unique');
  });

  it('existing 为空 → unique', () => {
    expect(detectAnnotationDuplicate({ bookId: 'b1', title: 'x', annotation: 'y' }, []).kind).toBe('unique');
  });

  it('完全相同标题 + 同 bookId → exact_dup(via=title)', () => {
    const existing = [ann({ bookId: 'b1', title: '关于"等待"', annotation: '这段让我想到那时候。' })];
    const result = detectAnnotationDuplicate(
      { bookId: 'b1', title: '关于"等待"', annotation: '别的开头' },
      existing,
    );
    expect(result.kind).toBe('exact_dup');
    if (result.kind === 'exact_dup') {
      expect(result.via).toBe('title');
    }
  });

  it('开头完全相同 + 同 bookId → exact_dup(via=opening)', () => {
    const existing = [
      ann({
        bookId: 'b1',
        title: '不同标题A',
        annotation: '这一段让我想起母亲那年冬天的沉默。她总是这样。',
      }),
    ];
    const result = detectAnnotationDuplicate(
      {
        bookId: 'b1',
        title: '不同标题B',
        annotation: '这一段让我想起母亲那年冬天的沉默。但今天我有别的感受。',
      },
      existing,
    );
    expect(result.kind).toBe('exact_dup');
    if (result.kind === 'exact_dup') {
      expect(result.via).toBe('opening');
    }
  });

  it('开头高度相似（jaccard 命中）→ similar(via=opening)', () => {
    const existing = [
      ann({
        bookId: 'b1',
        title: '别的标题',
        annotation: '我感觉这一段写出了所有未说出口的疲倦和小心翼翼。',
      }),
    ];
    const result = detectAnnotationDuplicate(
      {
        bookId: 'b1',
        title: '完全不同的标题',
        annotation: '我感觉这一段写出了所有未说出口的疲倦和小心翼翼啊。',
      },
      existing,
    );
    expect(result.kind === 'similar' || result.kind === 'exact_dup').toBe(true);
  });

  it('跨 bookId 的同样批注 → unique（同一句话在两本书里被引用是合理的）', () => {
    const existing = [
      ann({
        bookId: 'b1',
        title: '完全相同的标题',
        annotation: '我感觉这一段写出了所有未说出口的疲倦。',
      }),
    ];
    const result = detectAnnotationDuplicate(
      {
        bookId: 'b2', // 不同书！
        title: '完全相同的标题',
        annotation: '我感觉这一段写出了所有未说出口的疲倦。',
      },
      existing,
    );
    expect(result.kind).toBe('unique');
  });

  it('同 bookId 但内容完全不同 → unique', () => {
    const existing = [
      ann({
        bookId: 'b1',
        title: '关于第三章',
        annotation: '这里写的是父亲的口吻。',
      }),
    ];
    const result = detectAnnotationDuplicate(
      {
        bookId: 'b1',
        title: '另一个完全不同的话题',
        annotation: '今天读到第五页，觉得作者的笔触特别清冷。',
      },
      existing,
    );
    expect(result.kind).toBe('unique');
  });

  it('标题相似 + 开头相似都命中时，标题层优先', () => {
    const existing = [
      ann({
        bookId: 'b1',
        title: '关于"等待"的笔记',
        annotation: '我感觉这一段写出了所有未说出口的疲倦。',
      }),
    ];
    const result = detectAnnotationDuplicate(
      {
        bookId: 'b1',
        title: '关于"等待"的笔记', // 标题命中 exact_dup
        annotation: '我感觉这一段写出了所有未说出口的疲倦。',
      },
      existing,
    );
    expect(result.kind).toBe('exact_dup');
    if (result.kind === 'exact_dup') {
      expect(result.via).toBe('title');
    }
  });
});
