import { describe, expect, it } from 'vitest';
import {
  buildMailContinuityAnchorBlock,
  bulkMailThemeKey,
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

describe('detectMailDuplicate · crossSender（推广/垃圾跨发件人）', () => {
  it('crossSender=true：不同发件人 + 同主题 → exact_dup', () => {
    const existing = [mail({ fromAddress: 'a@x', subject: '本周精选' })];
    const result = detectMailDuplicate(
      { from: { address: 'b@y' }, subject: '本周精选' },
      existing,
      { crossSender: true },
    );
    expect(result.kind).toBe('exact_dup');
  });

  it('crossSender=true：candidate 没有发件地址也照常比主题', () => {
    const existing = [mail({ fromAddress: 'a@x', subject: '限时优惠' })];
    const result = detectMailDuplicate(
      { from: { address: '' }, subject: '限时优惠' },
      existing,
      { crossSender: true },
    );
    expect(result.kind).toBe('exact_dup');
  });

  it('默认（不传 crossSender）行为不变：跨发件人同主题 → unique', () => {
    const existing = [mail({ fromAddress: 'a@x', subject: '本周精选' })];
    const result = detectMailDuplicate(
      { from: { address: 'b@y' }, subject: '本周精选' },
      existing,
    );
    expect(result.kind).toBe('unique');
  });
});

describe('bulkMailThemeKey', () => {
  it('中奖类 → lottery', () => {
    expect(bulkMailThemeKey('恭喜您被抽中本月幸运大奖')).toBe('lottery');
    expect(bulkMailThemeKey('您有一份待领取的奖品')).toBe('lottery');
  });

  it('账户钓鱼类 → account-phish', () => {
    expect(bulkMailThemeKey('您的账户出现异地登录，请立即验证')).toBe('account-phish');
  });

  it('折扣促销类 → sale', () => {
    expect(bulkMailThemeKey('限时五折，全场清仓')).toBe('sale');
  });

  it('归不出套路 → null', () => {
    expect(bulkMailThemeKey('一封普通的私人问候')).toBeNull();
    expect(bulkMailThemeKey('')).toBeNull();
  });
});

describe('filterMailDraftsByDuplicates · 推广/垃圾选项', () => {
  it('crossSender + dropSimilar：跨发件人近似主题被丢', () => {
    const existing = [mail({ fromAddress: 'win@a.junk', subject: '恭喜中奖啦' })];
    const drafts = [
      { from: { address: 'prize@b.junk' }, subject: '恭喜中奖了' }, // 跨发件人 + 近似 → 丢
      { from: { address: 'shop@c.demo' }, subject: '春季新品上市预告' }, // 全新 → 留
    ];
    const { kept, dropped } = filterMailDraftsByDuplicates(drafts, existing, {
      crossSender: true,
      dropSimilar: true,
      useThemeSignature: true,
    });
    expect(kept.length).toBe(1);
    expect(kept[0].subject).toBe('春季新品上市预告');
    expect(dropped.length).toBe(1);
  });

  it('useThemeSignature：同套路但主题用词不同也判重（中奖 vs 待领奖金）', () => {
    const existing = [mail({ fromAddress: 'win@a.junk', subject: '恭喜中奖啦' })];
    const drafts = [
      // 与已有主题 bigram 重叠低，但同属 lottery 套路 → 被主题签名拦下
      { from: { address: 'gift@d.junk' }, subject: '您有一笔待领取的幸运奖品' },
    ];
    const { kept, dropped } = filterMailDraftsByDuplicates(drafts, existing, {
      crossSender: true,
      dropSimilar: true,
      useThemeSignature: true,
    });
    expect(kept.length).toBe(0);
    expect(dropped.length).toBe(1);
  });

  it('批内同套路自重复：两封 lottery 只留一封', () => {
    const drafts = [
      { from: { address: 'a@junk' }, subject: '恭喜抽中头等奖' },
      { from: { address: 'b@junk' }, subject: '您被随机抽中赢取大奖' },
    ];
    const { kept } = filterMailDraftsByDuplicates(drafts, [], {
      crossSender: true,
      dropSimilar: true,
      useThemeSignature: true,
    });
    expect(kept.length).toBe(1);
  });

  it('不同套路不互相误杀（lottery + sale 都保留）', () => {
    const drafts = [
      { from: { address: 'a@junk' }, subject: '恭喜中奖' },
      { from: { address: 'b@demo' }, subject: '全场限时五折' },
    ];
    const { kept } = filterMailDraftsByDuplicates(drafts, [], {
      crossSender: true,
      dropSimilar: true,
      useThemeSignature: true,
    });
    expect(kept.length).toBe(2);
  });
});
