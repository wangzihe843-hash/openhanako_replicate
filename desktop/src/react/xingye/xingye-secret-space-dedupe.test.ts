import { describe, expect, it } from 'vitest';
import {
  buildDreamContinuityAnchorBlock,
  buildDraftReplyContinuityAnchorBlock,
  buildSavedItemContinuityAnchorBlock,
  buildUnsentMomentContinuityAnchorBlock,
  buildSecretSpaceStateContinuityAnchorBlock,
  detectSecretSpaceDuplicate,
  SECRET_SPACE_ANCHOR_BUILDERS,
} from './xingye-secret-space-dedupe';
import type { SecretSpaceSampleRecord, SecretSpaceRecordKind } from './secret-space-record-types';

function rec(
  partial: Partial<SecretSpaceSampleRecord> & { title: string; kind: SecretSpaceRecordKind },
): SecretSpaceSampleRecord {
  const id = partial.recordId ?? `r-${Math.random().toString(36).slice(2, 8)}`;
  return {
    recordId: id,
    key: id,
    title: partial.title,
    body: partial.body ?? '',
    createdAt: partial.createdAt ?? '2026-05-27T00:00:00.000Z',
    kind: partial.kind,
    meta: partial.meta,
    source: partial.source,
    tags: partial.tags,
    updatedAt: partial.updatedAt,
    summary: partial.summary,
    metadata: partial.metadata,
  };
}

/* ------------------------------------------------------------------ *
 * Anchor block 构建（5 个子类型各 1 块）
 * ------------------------------------------------------------------ */

describe('buildDreamContinuityAnchorBlock', () => {
  it('空数组 → 空串', () => {
    expect(buildDreamContinuityAnchorBlock([])).toBe('');
  });

  it('抽 title + tags，并提示「请换不同主题/意象」', () => {
    const block = buildDreamContinuityAnchorBlock([
      rec({ title: '回不去的车', kind: 'dream', tags: ['车', '雨'] }),
      rec({ title: '听到歌的房间', kind: 'dream', tags: ['歌', '房间'] }),
    ]);
    expect(block).toContain('回不去的车');
    expect(block).toContain('听到歌的房间');
    expect(block).toContain('「车」');
    expect(block).toContain('「雨」');
    expect(block).toMatch(/不要重复|换.*主题|换.*象征/);
  });

  it('tags 去重（同一意象出现两次只列一次）', () => {
    const block = buildDreamContinuityAnchorBlock([
      rec({ title: '梦 A', kind: 'dream', tags: ['水', '镜子'] }),
      rec({ title: '梦 B', kind: 'dream', tags: ['水', '楼梯'] }),
    ]);
    expect((block.match(/「水」/g) ?? []).length).toBe(1);
  });
});

describe('buildDraftReplyContinuityAnchorBlock', () => {
  it('抽 meta（收件人） + 正文第一行', () => {
    const block = buildDraftReplyContinuityAnchorBlock([
      rec({
        title: '给你的话',
        kind: 'draft_reply',
        meta: '给 你',
        body: '我其实想说的是……',
      }),
    ]);
    expect(block).toContain('给 你');
    expect(block).toContain('我其实想说的是……');
  });

  it('全空 record 跳过', () => {
    const block = buildDraftReplyContinuityAnchorBlock([
      rec({ title: '', kind: 'draft_reply', body: '' }),
    ]);
    expect(block).toBe('');
  });
});

describe('buildSavedItemContinuityAnchorBlock', () => {
  it('抽 title + meta + source', () => {
    const block = buildSavedItemContinuityAnchorBlock([
      rec({
        title: '荒诞的诞生',
        kind: 'saved_item',
        meta: '句子',
        source: '—— Camus《西西弗神话》',
      }),
    ]);
    expect(block).toContain('荒诞的诞生');
    expect(block).toContain('[句子]');
    expect(block).toContain('Camus');
  });

  it('source 去重', () => {
    const block = buildSavedItemContinuityAnchorBlock([
      rec({ title: 'a', kind: 'saved_item', source: '—— Camus' }),
      rec({ title: 'b', kind: 'saved_item', source: '—— Camus' }),
    ]);
    expect((block.match(/Camus/g) ?? []).length).toBeLessThanOrEqual(2);
  });
});

describe('buildUnsentMomentContinuityAnchorBlock', () => {
  it('抽正文第一句', () => {
    const block = buildUnsentMomentContinuityAnchorBlock([
      rec({ title: '', kind: 'unsent_moment', body: '今天的雨好像没完没了。\n第二行' }),
    ]);
    expect(block).toContain('今天的雨好像没完没了');
    expect(block).not.toContain('第二行');
  });

  it('无正文跳过', () => {
    const block = buildUnsentMomentContinuityAnchorBlock([
      rec({ title: '', kind: 'unsent_moment', body: '' }),
    ]);
    expect(block).toBe('');
  });
});

describe('buildSecretSpaceStateContinuityAnchorBlock', () => {
  it('抽 title + 正文开头', () => {
    const block = buildSecretSpaceStateContinuityAnchorBlock([
      rec({ title: '低气压', kind: 'state', body: '今天好像哪里不对。' }),
    ]);
    expect(block).toContain('低气压');
    expect(block).toContain('今天好像哪里不对');
  });
});

describe('SECRET_SPACE_ANCHOR_BUILDERS dispatch table', () => {
  it('5 个子类型都有 builder', () => {
    expect(typeof SECRET_SPACE_ANCHOR_BUILDERS.dream).toBe('function');
    expect(typeof SECRET_SPACE_ANCHOR_BUILDERS.draft_reply).toBe('function');
    expect(typeof SECRET_SPACE_ANCHOR_BUILDERS.saved_item).toBe('function');
    expect(typeof SECRET_SPACE_ANCHOR_BUILDERS.unsent_moment).toBe('function');
    expect(typeof SECRET_SPACE_ANCHOR_BUILDERS.state).toBe('function');
  });
});

/* ------------------------------------------------------------------ *
 * detectSecretSpaceDuplicate（每个子类型至少 1 个 case）
 * ------------------------------------------------------------------ */

describe('detectSecretSpaceDuplicate · dream', () => {
  it('完全相同 title → exact_dup（这是用户痛点的主线 case）', () => {
    const existing = [rec({ title: '回不去的车', kind: 'dream' })];
    const result = detectSecretSpaceDuplicate({ title: '回不去的车' }, existing, 'dream');
    expect(result.kind).toBe('exact_dup');
  });

  it('编辑距离 1（改 1 字） → similar(via=edit)', () => {
    const existing = [rec({ title: '回不去的车', kind: 'dream' })];
    const result = detectSecretSpaceDuplicate({ title: '回不去的家' }, existing, 'dream');
    expect(result.kind).toBe('similar');
    if (result.kind === 'similar') expect(result.via).toBe('edit');
  });

  it('完全不同主题 → unique', () => {
    const existing = [rec({ title: '回不去的车', kind: 'dream' })];
    const result = detectSecretSpaceDuplicate({ title: '海边的旧灯塔' }, existing, 'dream');
    expect(result.kind).toBe('unique');
  });
});

describe('detectSecretSpaceDuplicate · draft_reply', () => {
  it('完全相同 title → exact_dup', () => {
    const existing = [rec({ title: '给你的那封回复', kind: 'draft_reply' })];
    expect(
      detectSecretSpaceDuplicate({ title: '给你的那封回复' }, existing, 'draft_reply').kind,
    ).toBe('exact_dup');
  });

  it('编辑距离 1 → similar', () => {
    const existing = [rec({ title: '给你的那封回复', kind: 'draft_reply' })];
    expect(
      detectSecretSpaceDuplicate({ title: '给你的那段回复' }, existing, 'draft_reply').kind,
    ).toBe('similar');
  });

  it('不同主旨 → unique', () => {
    const existing = [rec({ title: '给你的那封回复', kind: 'draft_reply' })];
    expect(
      detectSecretSpaceDuplicate({ title: '关于这次旅行的想法' }, existing, 'draft_reply').kind,
    ).toBe('unique');
  });
});

describe('detectSecretSpaceDuplicate · saved_item', () => {
  it('完全相同（含书名号归一化）→ exact_dup', () => {
    const existing = [rec({ title: '《西西弗神话》摘句', kind: 'saved_item' })];
    expect(
      detectSecretSpaceDuplicate({ title: '西西弗神话摘句' }, existing, 'saved_item').kind,
    ).toBe('exact_dup');
  });

  it('编辑距离 1 → similar', () => {
    const existing = [rec({ title: '西西弗神话摘句', kind: 'saved_item' })];
    expect(
      detectSecretSpaceDuplicate({ title: '西西弗神话语句' }, existing, 'saved_item').kind,
    ).toBe('similar');
  });

  it('不同条目 → unique', () => {
    const existing = [rec({ title: '西西弗神话摘句', kind: 'saved_item' })];
    expect(
      detectSecretSpaceDuplicate({ title: '局外人开篇' }, existing, 'saved_item').kind,
    ).toBe('unique');
  });
});

describe('detectSecretSpaceDuplicate · unsent_moment', () => {
  it('完全相同 → exact_dup', () => {
    const existing = [rec({ title: '今晚的雨', kind: 'unsent_moment' })];
    expect(
      detectSecretSpaceDuplicate({ title: '今晚的雨' }, existing, 'unsent_moment').kind,
    ).toBe('exact_dup');
  });

  it('编辑距离 1 → similar', () => {
    const existing = [rec({ title: '今晚的雨', kind: 'unsent_moment' })];
    expect(
      detectSecretSpaceDuplicate({ title: '今早的雨' }, existing, 'unsent_moment').kind,
    ).toBe('similar');
  });

  it('完全不同 → unique', () => {
    const existing = [rec({ title: '今晚的雨', kind: 'unsent_moment' })];
    expect(
      detectSecretSpaceDuplicate({ title: '咖啡馆的猫' }, existing, 'unsent_moment').kind,
    ).toBe('unique');
  });
});

describe('detectSecretSpaceDuplicate · state', () => {
  it('完全相同 → exact_dup', () => {
    const existing = [rec({ title: '低气压的一天', kind: 'state' })];
    expect(
      detectSecretSpaceDuplicate({ title: '低气压的一天' }, existing, 'state').kind,
    ).toBe('exact_dup');
  });

  it('编辑距离 1 → similar', () => {
    const existing = [rec({ title: '低气压的一天', kind: 'state' })];
    expect(
      detectSecretSpaceDuplicate({ title: '低气压的午后' }, existing, 'state').kind,
    ).toBe('similar');
  });

  it('完全不同 → unique', () => {
    const existing = [rec({ title: '低气压的一天', kind: 'state' })];
    expect(
      detectSecretSpaceDuplicate({ title: '少见的好天气' }, existing, 'state').kind,
    ).toBe('unique');
  });
});

describe('detectSecretSpaceDuplicate · 边界', () => {
  it('空 title → unique', () => {
    const existing = [rec({ title: '回不去的车', kind: 'dream' })];
    expect(detectSecretSpaceDuplicate({ title: '   ' }, existing, 'dream').kind).toBe('unique');
  });

  it('空 existing → unique', () => {
    expect(detectSecretSpaceDuplicate({ title: '回不去的车' }, [], 'dream').kind).toBe('unique');
  });

  it('多条命中：exact_dup 短路优先于 similar', () => {
    const existing = [
      rec({ recordId: 'a', title: '回不去的家', kind: 'dream' }),
      rec({ recordId: 'b', title: '回不去的车', kind: 'dream' }),
    ];
    const result = detectSecretSpaceDuplicate({ title: '回不去的车' }, existing, 'dream');
    expect(result.kind).toBe('exact_dup');
    if (result.kind === 'exact_dup') expect(result.record.recordId).toBe('b');
  });
});
