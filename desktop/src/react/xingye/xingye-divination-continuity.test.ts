/**
 * @vitest-environment jsdom
 *
 * 占卜跨次连续性 anchor 的单元测试。
 *
 * mock 掉 loadDivinationEntries（默认 singleton 绑定的 backend 通过 hanaFetch
 * 走 /api/xingye/storage，jsdom 环境下没法跑通）。直接喂假 entries，验证：
 *   1. 无历史 → 空字符串
 *   2. 有历史 → 包含 agentQuestion / symbols / methodLabel 样本
 *   3. method 过滤：传 tarot 时只看塔罗历史，易经历史不被列入
 *   4. 分层：最近 5 条进硬避免段，后 3 条进软避免段
 *   5. 同题去重：相同 agentQuestion 不重复列出
 *   6. createdAt 倒序：anchor 抽样按时间排
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { DivinationEntry } from './xingye-app-entry-store';

vi.mock('./xingye-app-entry-store', async () => {
  const actual = await vi.importActual<typeof import('./xingye-app-entry-store')>('./xingye-app-entry-store');
  return {
    ...actual,
    loadDivinationEntries: vi.fn(async () => [] as DivinationEntry[]),
  };
});

import { loadDivinationEntries } from './xingye-app-entry-store';
import { buildDivinationContinuityAnchorBlock } from './xingye-divination-ai';

function makeEntry(opts: {
  id: string;
  createdAt: string;
  method: string;
  methodLabel?: string;
  symbols?: unknown[];
  agentQuestion?: string;
  content?: string;
}): DivinationEntry {
  return {
    id: opts.id,
    agentId: 'ag-d',
    appId: 'divination',
    title: opts.agentQuestion?.slice(0, 24) ?? opts.id,
    content: opts.content ?? '【正文】\n这是 entry 内容。\n【行动签】\n小提醒。',
    metadata: {
      method: opts.method,
      methodLabel: opts.methodLabel ?? opts.method,
      question: opts.agentQuestion ?? '我想确认一件事',
      agentQuestion: opts.agentQuestion ?? '我想确认一件事',
      symbols: opts.symbols ?? [],
      autoSelected: true,
      resolverReason: '',
    },
    source: 'divination',
    createdAt: opts.createdAt,
    updatedAt: opts.createdAt,
  };
}

describe('buildDivinationContinuityAnchorBlock', () => {
  beforeEach(() => {
    vi.mocked(loadDivinationEntries).mockReset();
  });

  it('无历史 → 返回空字符串（prompt 端会渲染「第一次占卜」占位）', async () => {
    vi.mocked(loadDivinationEntries).mockResolvedValueOnce([]);
    const block = await buildDivinationContinuityAnchorBlock('ag-d');
    expect(block).toBe('');
  });

  it('agentId 为空 → 空字符串（防御性）', async () => {
    const block = await buildDivinationContinuityAnchorBlock('');
    expect(block).toBe('');
    // 不应触发 store 读取
    expect(vi.mocked(loadDivinationEntries)).not.toHaveBeenCalled();
  });

  it('有历史 → block 含 method label / symbols / agentQuestion 样本', async () => {
    vi.mocked(loadDivinationEntries).mockResolvedValueOnce([
      makeEntry({
        id: 'e1',
        createdAt: '2026-05-20T10:00:00.000Z',
        method: 'tarot',
        methodLabel: '塔罗',
        symbols: ['恋人', '愚者'],
        agentQuestion: '我是否应该把那封信寄出去？',
      }),
    ]);
    const block = await buildDivinationContinuityAnchorBlock('ag-d', { method: 'tarot' });
    expect(block).toContain('塔罗');
    expect(block).toContain('恋人');
    expect(block).toContain('愚者');
    expect(block).toContain('我是否应该把那封信寄出去？');
    expect(block).toMatch(/最近抽过这几次/);
  });

  it('有历史 → block 同时给出「可轻度回扣」口子与「严禁照搬」边界', async () => {
    vi.mocked(loadDivinationEntries).mockResolvedValueOnce([
      makeEntry({
        id: 'e1',
        createdAt: '2026-05-20T10:00:00.000Z',
        method: 'tarot',
        methodLabel: '塔罗',
        symbols: ['倒吊人正位'],
        agentQuestion: '我是否该再等一等？',
      }),
    ]);
    const block = await buildDivinationContinuityAnchorBlock('ag-d', { method: 'tarot' });
    // 回扣口子：允许「上次……这次……」作对照
    expect(block).toMatch(/可轻度回扣/);
    expect(block).toMatch(/上次……是因为……，这次……/);
    // 非强制
    expect(block).toMatch(/非必须/);
    // 不照搬边界：点名旧符号 OK，但这次仍要换牌、不得照搬整句/整组符号
    expect(block).toMatch(/这次仍要换牌\/换卦/);
    expect(block).toMatch(/严禁照搬/);
    expect(block).toMatch(/字面雷同/);
  });

  it('无历史 → 不出现「可轻度回扣」提示（空字符串里没有回扣文案）', async () => {
    vi.mocked(loadDivinationEntries).mockResolvedValueOnce([]);
    const block = await buildDivinationContinuityAnchorBlock('ag-d', { method: 'tarot' });
    expect(block).toBe('');
    expect(block).not.toMatch(/可轻度回扣/);
  });

  it('method 过滤：method=tarot 时只 anchor 塔罗历史，易经条目被排除', async () => {
    vi.mocked(loadDivinationEntries).mockResolvedValueOnce([
      makeEntry({
        id: 't1',
        createdAt: '2026-05-20T10:00:00.000Z',
        method: 'tarot',
        methodLabel: '塔罗',
        symbols: ['恋人'],
        agentQuestion: '塔罗问题 X',
      }),
      makeEntry({
        id: 'i1',
        createdAt: '2026-05-19T10:00:00.000Z',
        method: 'iching_liuyao',
        methodLabel: '六爻',
        symbols: ['☰', '☲'],
        agentQuestion: '易经问题 Y',
      }),
    ]);
    const block = await buildDivinationContinuityAnchorBlock('ag-d', { method: 'tarot' });
    expect(block).toContain('塔罗问题 X');
    expect(block).not.toContain('易经问题 Y');
    expect(block).not.toContain('六爻');
    // 注释里也说"仅列出同占法"
    expect(block).toMatch(/仅列出同占法/);
  });

  it('method 未指定 → 跨 method 全量 anchor（兜底路径）', async () => {
    vi.mocked(loadDivinationEntries).mockResolvedValueOnce([
      makeEntry({
        id: 't1',
        createdAt: '2026-05-20T10:00:00.000Z',
        method: 'tarot',
        methodLabel: '塔罗',
        agentQuestion: '塔罗问题 X',
      }),
      makeEntry({
        id: 'i1',
        createdAt: '2026-05-19T10:00:00.000Z',
        method: 'iching_liuyao',
        methodLabel: '六爻',
        agentQuestion: '易经问题 Y',
      }),
    ]);
    const block = await buildDivinationContinuityAnchorBlock('ag-d');
    expect(block).toContain('塔罗问题 X');
    expect(block).toContain('易经问题 Y');
    // 跨 method 路径下不附加"仅列出同占法"的注释
    expect(block).not.toMatch(/仅列出同占法/);
  });

  it('分层：最近 5 条 → 硬避免段；其后 3 条 → 软避免段', async () => {
    // 造 8 条同 method（tarot）历史，时间从新到旧依次写
    const entries: DivinationEntry[] = [];
    for (let i = 1; i <= 8; i += 1) {
      // 越靠前 i 越小 → createdAt 越新
      const day = 30 - i;
      entries.push(
        makeEntry({
          id: `t${i}`,
          createdAt: `2026-05-${String(day).padStart(2, '0')}T10:00:00.000Z`,
          method: 'tarot',
          methodLabel: '塔罗',
          symbols: [`卡${i}`],
          agentQuestion: `问题 ${i}`,
        }),
      );
    }
    vi.mocked(loadDivinationEntries).mockResolvedValueOnce(entries);
    const block = await buildDivinationContinuityAnchorBlock('ag-d', { method: 'tarot' });

    // 硬避免段 + 软避免段都出现
    expect(block).toMatch(/最近抽过这几次/);
    expect(block).toMatch(/再之前几次/);

    // 把硬段切下来
    const hardIdx = block.indexOf('最近抽过这几次');
    const softIdx = block.indexOf('再之前几次');
    expect(hardIdx).toBeGreaterThanOrEqual(0);
    expect(softIdx).toBeGreaterThan(hardIdx);
    const hardSeg = block.slice(hardIdx, softIdx);
    const softSeg = block.slice(softIdx);

    // 最新 5 条（问题 1-5）应在硬段；问题 6-8 应在软段
    for (let i = 1; i <= 5; i += 1) {
      expect(hardSeg).toContain(`问题 ${i}`);
    }
    for (let i = 6; i <= 8; i += 1) {
      expect(softSeg).toContain(`问题 ${i}`);
    }
  });

  it('同题去重：同一 agentQuestion 只列一次（连续重抽同题不刷屏）', async () => {
    vi.mocked(loadDivinationEntries).mockResolvedValueOnce([
      makeEntry({
        id: 'e1',
        createdAt: '2026-05-20T12:00:00.000Z',
        method: 'tarot',
        methodLabel: '塔罗',
        agentQuestion: '我是否要寄出那封信',
      }),
      makeEntry({
        id: 'e2',
        createdAt: '2026-05-20T11:00:00.000Z',
        method: 'tarot',
        methodLabel: '塔罗',
        agentQuestion: '我是否要寄出那封信',
      }),
      makeEntry({
        id: 'e3',
        createdAt: '2026-05-20T10:00:00.000Z',
        method: 'tarot',
        methodLabel: '塔罗',
        agentQuestion: '另一个完全不同的问题',
      }),
    ]);
    const block = await buildDivinationContinuityAnchorBlock('ag-d', { method: 'tarot' });
    // 相同 agentQuestion 应该只出现一次
    const matches = block.match(/我是否要寄出那封信/g) ?? [];
    expect(matches).toHaveLength(1);
    // 第三条不同题应当也出现
    expect(block).toContain('另一个完全不同的问题');
  });

  it('createdAt 倒序：新条目排在硬段前部，旧的退到软段', async () => {
    // 故意乱序喂入 7 条；buildBlock 应按 createdAt desc 排
    vi.mocked(loadDivinationEntries).mockResolvedValueOnce([
      makeEntry({
        id: 'old',
        createdAt: '2026-05-01T10:00:00.000Z',
        method: 'tarot',
        methodLabel: '塔罗',
        agentQuestion: '旧问题',
      }),
      makeEntry({
        id: 'newest',
        createdAt: '2026-05-26T10:00:00.000Z',
        method: 'tarot',
        methodLabel: '塔罗',
        agentQuestion: '最新问题',
      }),
      makeEntry({
        id: 'mid',
        createdAt: '2026-05-15T10:00:00.000Z',
        method: 'tarot',
        methodLabel: '塔罗',
        agentQuestion: '中间问题',
      }),
    ]);
    const block = await buildDivinationContinuityAnchorBlock('ag-d', { method: 'tarot' });
    const idxNewest = block.indexOf('最新问题');
    const idxMid = block.indexOf('中间问题');
    const idxOld = block.indexOf('旧问题');
    expect(idxNewest).toBeGreaterThanOrEqual(0);
    expect(idxMid).toBeGreaterThan(idxNewest);
    expect(idxOld).toBeGreaterThan(idxMid);
  });

  it('store 抛错 → 不抛，回退到空字符串（不阻塞生成主流程）', async () => {
    vi.mocked(loadDivinationEntries).mockRejectedValueOnce(new Error('storage down'));
    const block = await buildDivinationContinuityAnchorBlock('ag-d');
    expect(block).toBe('');
  });
});
