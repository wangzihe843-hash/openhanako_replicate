import { describe, expect, it } from 'vitest';
import {
  buildMailContinuityAnchorBlock,
  detectMailDuplicate,
  filterMailDraftsByDuplicates,
  MAIL_ANCHOR_PER_SENDER_LIMIT,
  MAIL_ANCHOR_SAMPLE_LIMIT,
} from './xingye-mail-dedupe';
import type { XingyeMailMessage } from './xingye-mail-store';

function mail(partial: Partial<XingyeMailMessage> & {
  id?: string;
  fromAddress: string;
  subject: string;
}): XingyeMailMessage {
  const id = partial.id ?? `m_${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    key: id,
    agentId: 'a',
    mailbox: 'inbox',
    from: {
      name: partial.from?.name ?? partial.fromAddress.split('@')[0],
      address: partial.fromAddress,
      kind: partial.from?.kind ?? 'virtual_contact',
    },
    to: [],
    subject: partial.subject,
    body: partial.body ?? '',
    isRead: false,
    isStarred: false,
    labels: [],
    createdAt: partial.createdAt ?? '2026-05-27T12:00:00.000Z',
    updatedAt: partial.createdAt ?? '2026-05-27T12:00:00.000Z',
  };
}

describe('buildMailContinuityAnchorBlock', () => {
  it('空列表 → 空串', () => {
    expect(buildMailContinuityAnchorBlock([])).toBe('');
  });

  it('按发件人聚合，同一发件人最多 2 条', () => {
    const threads: XingyeMailMessage[] = [];
    for (let i = 0; i < 5; i += 1) {
      threads.push(mail({
        id: `s${i}`,
        fromAddress: 'newsletter@promo.demo',
        subject: `促销主题${i}`,
        createdAt: `2026-05-${String(27 - i).padStart(2, '0')}T00:00:00.000Z`,
      }));
    }
    const out = buildMailContinuityAnchorBlock(threads);
    const occurrences = (out.match(/newsletter@promo\.demo/g) ?? []).length;
    expect(occurrences).toBe(MAIL_ANCHOR_PER_SENDER_LIMIT);
  });

  it('总条数上限 8', () => {
    const threads: XingyeMailMessage[] = [];
    // 10 个不同发件人，各 1 条
    for (let i = 0; i < 10; i += 1) {
      threads.push(mail({
        id: `s${i}`,
        fromAddress: `sender${i}@demo`,
        subject: `主题${i}`,
        createdAt: `2026-05-${String(27 - i).padStart(2, '0')}T00:00:00.000Z`,
      }));
    }
    const out = buildMailContinuityAnchorBlock(threads);
    const lines = out.split('\n').filter((l) => l.startsWith('  · '));
    expect(lines.length).toBe(MAIL_ANCHOR_SAMPLE_LIMIT);
  });

  it('每条样本包含 发件人 / 地址 / 主题 / 开头', () => {
    const threads = [
      mail({
        id: 's1',
        fromAddress: 'alice@hana.mail',
        from: { name: '爱丽丝', address: 'alice@hana.mail', kind: 'virtual_contact' },
        subject: '关于周末的安排',
        body: '想问你周末有没有空一起喝茶。',
      }),
    ];
    const out = buildMailContinuityAnchorBlock(threads);
    expect(out).toContain('爱丽丝');
    expect(out).toContain('alice@hana.mail');
    expect(out).toContain('关于周末的安排');
    expect(out).toContain('想问你周末有没有空');
  });
});

describe('detectMailDuplicate', () => {
  it('空 existing → unique', () => {
    const result = detectMailDuplicate(
      { from: { address: 'a@b' }, subject: '随便' },
      [],
    );
    expect(result.kind).toBe('unique');
  });

  it('candidate.fromAddress 空 → unique', () => {
    const existing = [mail({ fromAddress: 'a@b', subject: '主题' })];
    const result = detectMailDuplicate({ from: { address: '' }, subject: '主题' }, existing);
    expect(result.kind).toBe('unique');
  });

  it('同发件人 + 同主题（normalize 后） → exact_dup', () => {
    const existing = [mail({ fromAddress: 'newsletter@promo', subject: '本周精选 · 慢生活专题' })];
    const result = detectMailDuplicate(
      { from: { address: 'newsletter@promo' }, subject: '本周精选 · 慢生活专题' },
      existing,
    );
    expect(result.kind).toBe('exact_dup');
  });

  it('同发件人 + 主题编辑距离 1 → similar(method=edit)', () => {
    const existing = [mail({ fromAddress: 'newsletter@promo', subject: '本周精选慢生活专题' })];
    const result = detectMailDuplicate(
      { from: { address: 'newsletter@promo' }, subject: '本周精选快生活专题' },
      existing,
    );
    expect(result.kind).toBe('similar');
    if (result.kind === 'similar') expect(result.method).toBe('edit');
  });

  it('同发件人 + bigram 高重叠（换序）→ similar(method=jaccard)', () => {
    const existing = [
      mail({ fromAddress: 'alice@hana.mail', subject: '关于诊所那条街的笔记' }),
    ];
    const result = detectMailDuplicate(
      { from: { address: 'alice@hana.mail' }, subject: '关于诊所那条街的备注' },
      existing,
    );
    expect(result.kind).toBe('similar');
  });

  it('跨发件人 + 同主题 → unique（不同发件人不算重复）', () => {
    const existing = [mail({ fromAddress: 'a@x', subject: '本周精选' })];
    const result = detectMailDuplicate(
      { from: { address: 'b@y' }, subject: '本周精选' },
      existing,
    );
    expect(result.kind).toBe('unique');
  });

  it('发件人地址大小写不敏感', () => {
    const existing = [mail({ fromAddress: 'Alice@Hana.Mail', subject: '周末安排' })];
    const result = detectMailDuplicate(
      { from: { address: 'alice@hana.mail' }, subject: '周末安排' },
      existing,
    );
    expect(result.kind).toBe('exact_dup');
  });

  it('同发件人 + 主题完全不同 → unique', () => {
    const existing = [mail({ fromAddress: 'alice@hana.mail', subject: '周末喝茶' })];
    const result = detectMailDuplicate(
      { from: { address: 'alice@hana.mail' }, subject: '关于项目进度' },
      existing,
    );
    expect(result.kind).toBe('unique');
  });
});

describe('filterMailDraftsByDuplicates', () => {
  it('丢掉 exact_dup，保留 unique 与 similar', () => {
    const existing = [
      mail({ fromAddress: 'newsletter@promo', subject: '本周精选 · 慢生活专题' }),
      mail({ fromAddress: 'alice@hana.mail', subject: '关于诊所那条街的笔记' }),
    ];
    const drafts = [
      { from: { address: 'newsletter@promo' }, subject: '本周精选 · 慢生活专题' }, // exact_dup
      { from: { address: 'newsletter@promo' }, subject: '完全不同的促销主题' }, // unique
      { from: { address: 'alice@hana.mail' }, subject: '关于诊所那条街的备注' }, // similar (保留)
    ];
    const { kept, dropped } = filterMailDraftsByDuplicates(drafts, existing);
    expect(kept.length).toBe(2);
    expect(dropped.length).toBe(1);
    expect(dropped[0].draft.subject).toBe('本周精选 · 慢生活专题');
  });

  it('批内自重复也被拦截（先 keep 的算"已存在"）', () => {
    const drafts = [
      { from: { address: 'a@b' }, subject: '相同主题' },
      { from: { address: 'a@b' }, subject: '相同主题' },
    ];
    const { kept, dropped } = filterMailDraftsByDuplicates(drafts, []);
    expect(kept.length).toBe(1);
    expect(dropped.length).toBe(1);
  });

  it('空 drafts → kept/dropped 都为空', () => {
    const out = filterMailDraftsByDuplicates([], []);
    expect(out.kept).toEqual([]);
    expect(out.dropped).toEqual([]);
  });
});
