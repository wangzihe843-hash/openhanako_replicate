/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../hooks/use-hana-fetch', () => ({ hanaFetch: vi.fn() }));
vi.mock('./xingye-storage-api', () => ({ postXingyeStorage: vi.fn() }));

// 只 stub listLoreEntries（控制 lore 目录），其余 lore-store 导出保留真实，避免打断 import 图。
vi.mock('./xingye-lore-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./xingye-lore-store')>();
  return { ...actual, listLoreEntries: vi.fn(() => []) };
});

// stub buildXingyeRecentChatExcerpts（注入最近聊天）+ resolveXingyeSpeakerUserName
// （否则真实实现首调会经 fetchConfig 触发一次 hanaFetch，污染 mock.calls 顺序）。
vi.mock('./xingye-speaker-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./xingye-speaker-context')>();
  return {
    ...actual,
    buildXingyeRecentChatExcerpts: vi.fn(() => []),
    resolveXingyeSpeakerUserName: vi.fn(async () => '用户'),
  };
});

// 只 stub 两个写入函数；resolveFolderIdFromHint / resolveTargetEntry / DuplicateFileEntryError 用真实。
vi.mock('./xingye-files-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./xingye-files-store')>();
  return { ...actual, appendFileEntry: vi.fn(), appendFileDraft: vi.fn() };
});

import { hanaFetch } from '../hooks/use-hana-fetch';
import { listLoreEntries, type XingyeLoreEntry } from './xingye-lore-store';
import { buildXingyeRecentChatExcerpts } from './xingye-speaker-context';
import { appendFileDraft, appendFileEntry, DuplicateFileEntryError, type XingyeFileFolder } from './xingye-files-store';
import {
  generateFilesInitEntryWithAI,
  normalizeFilesBatchPlan,
  normalizeFilesEntryResult,
  normalizeFilesEntryUpdateResult,
  normalizeFilesInitPlan,
  planFilesInitWithAI,
  runFilesBatchAdd,
  runFilesInit,
  type FilesLoreCatalogEntry,
} from './xingye-files-batch-ai';

const ISO = '2024-01-01T00:00:00.000Z';
const agent = { id: 'agent-x', name: 'Lin', yuan: 'y' } as never;

function mkResp(payload: unknown, ok = true): Response {
  return { ok, json: async () => payload } as unknown as Response;
}

function bodyOf(callIndex = 0): { kind?: string; prompt?: string } {
  const call = vi.mocked(hanaFetch).mock.calls[callIndex];
  return JSON.parse(String(call?.[1]?.body ?? '{}'));
}

function makeLore(id: string, title: string, content: string, keywords: string[] = []): XingyeLoreEntry {
  return {
    id,
    agentId: 'agent-x',
    title,
    content,
    category: 'background',
    keywords,
    enabled: true,
    priority: 50,
    insertionMode: 'manual',
    visibility: 'canonical',
    createdAt: ISO,
    updatedAt: ISO,
  };
}

const folders: XingyeFileFolder[] = [
  { id: 'f-world', agentId: 'agent-x', name: '世界观整理', description: '', order: 0, createdAt: ISO, updatedAt: ISO },
  { id: 'f-rel', agentId: 'agent-x', name: '人际关系', description: '', order: 1, createdAt: ISO, updatedAt: ISO },
];

const catalog: FilesLoreCatalogEntry[] = [
  { id: 'L1', title: '港口往事', categoryLabel: '背景', keywords: ['港口'], content: 'CONTENT_港口全文' },
  { id: 'L2', title: '师父', categoryLabel: '人物', keywords: [], content: 'CONTENT_师父全文' },
];

describe('normalizeFilesInitPlan', () => {
  it('filters loreIds to the catalog, drops empty / lore-less items, clamps maxItems', () => {
    const raw = {
      items: [
        { folderName: '世界观整理', title: 'A', focus: 'f', loreIds: ['L1', 'NOPE'] },
        { folderName: '', title: 'B', loreIds: ['L1'] }, // 空 folderName → 丢
        { folderName: '人际关系', title: 'C', loreIds: ['NOPE'] }, // 无有效 lore → 丢
        { folderName: '人际关系', title: 'D', loreIds: ['L2'] },
      ],
    };
    const out = normalizeFilesInitPlan(raw, catalog, 10);
    expect(out.items).toHaveLength(2);
    expect(out.truncated).toBe(0);
    expect(out.items[0]).toMatchObject({ folderName: '世界观整理', title: 'A', loreIds: ['L1'] });
    expect(out.items[1].loreIds).toEqual(['L2']);
  });

  it('accepts a bare array and reports truncated count past maxItems', () => {
    expect(normalizeFilesInitPlan([{ folderName: '人际关系', title: 'X', loreIds: ['L1'] }], catalog).items).toHaveLength(1);
    const many = {
      items: Array.from({ length: 20 }, (_, i) => ({ folderName: '人际关系', title: `t${i}`, loreIds: ['L1'] })),
    };
    const out = normalizeFilesInitPlan(many, catalog, 5);
    expect(out.items).toHaveLength(5);
    expect(out.truncated).toBe(15); // 20 合法 - 5 保留
  });
});

describe('normalizeFilesBatchPlan', () => {
  it('clamps chatRefs to [0,count), coerces action, requires a source', () => {
    const raw = {
      items: [
        { folderName: '人际关系', title: 'A', loreIds: [], chatRefs: [0, 2, 2, 9, -1], action: 'add' },
        { folderName: '人际关系', title: 'B', loreIds: [], chatRefs: [], action: 'add' }, // 无来源 → 丢
        { folderName: '人际关系', title: 'C', loreIds: ['L1'], chatRefs: [], action: 'weird' }, // lore 来源, action→add
        { folderName: '人际关系', title: 'D', loreIds: [], chatRefs: [1], action: 'update' }, // 无 targetTitle → add
        { folderName: '人际关系', title: 'E', loreIds: [], chatRefs: [1], action: 'update', targetTitle: '老条目' },
      ],
    };
    const out = normalizeFilesBatchPlan(raw, catalog, 3, 10); // count=3 → 合法 ref 0..2
    expect(out.items).toHaveLength(4);
    expect(out.truncated).toBe(0);
    expect(out.items[0]).toMatchObject({ title: 'A', chatRefs: [0, 2], action: 'add' });
    expect(out.items[1]).toMatchObject({ title: 'C', action: 'add' });
    expect(out.items[2]).toMatchObject({ title: 'D', action: 'add', targetTitle: undefined });
    expect(out.items[3]).toMatchObject({ title: 'E', action: 'update', targetTitle: '老条目' });
  });
});

describe('normalizeFilesEntryResult / normalizeFilesEntryUpdateResult', () => {
  it('add result requires title + body and clamps long body', () => {
    expect(normalizeFilesEntryResult({ title: 'T', body: 'B' })).toMatchObject({ title: 'T', body: 'B' });
    expect(normalizeFilesEntryResult({ title: '', body: 'B' })).toBeNull();
    expect(normalizeFilesEntryResult({ title: 'T', body: '' })).toBeNull();
    const r = normalizeFilesEntryResult({ title: 'T', body: '字'.repeat(2500), summary: 's', tags: ['a', 'b'] });
    expect(r?.body.length).toBeLessThanOrEqual(2000);
    expect(r?.body.endsWith('…')).toBe(true);
    expect(r?.tags).toEqual(['a', 'b']);
  });

  it('update result requires bodyAppend', () => {
    expect(normalizeFilesEntryUpdateResult({ bodyAppend: 'x' })).toMatchObject({ bodyAppend: 'x' });
    expect(normalizeFilesEntryUpdateResult({ bodyAppend: '' })).toBeNull();
    expect(normalizeFilesEntryUpdateResult({})).toBeNull();
  });
});

describe('planFilesInitWithAI', () => {
  beforeEach(() => vi.mocked(hanaFetch).mockReset());

  it('posts files_init_plan; prompt carries catalog titles but NOT lore content (minimization)', async () => {
    vi.mocked(hanaFetch).mockResolvedValue(
      mkResp({ ok: true, result: { items: [{ folderName: '世界观整理', title: 'A', focus: 'f', loreIds: ['L1'] }] } }),
    );
    const out = await planFilesInitWithAI({
      agent,
      ownerProfile: null,
      catalog,
      folderOptions: [{ name: '世界观整理' }, { name: '人际关系' }],
      existingEntries: [],
    });
    expect(out.items).toHaveLength(1);
    expect(out.truncated).toBe(0);
    const body = bodyOf(0);
    expect(body.kind).toBe('files_init_plan');
    expect(body.prompt).toContain('港口往事'); // 目录标题
    expect(body.prompt).not.toContain('CONTENT_港口全文'); // 不外发 content
    expect(body.prompt).toContain('世界观整理');
  });
});

describe('generateFilesInitEntryWithAI', () => {
  beforeEach(() => vi.mocked(hanaFetch).mockReset());

  it('posts files_init_entry; prompt carries the selected lore full content', async () => {
    vi.mocked(hanaFetch).mockResolvedValue(mkResp({ ok: true, result: { title: 't', body: 'b' } }));
    const r = await generateFilesInitEntryWithAI({
      agent,
      ownerProfile: null,
      folderName: '世界观整理',
      focus: 'f',
      selectedLore: [{ title: '港口往事', categoryLabel: '背景', content: 'PORT_FULL_CONTENT' }],
      sameFolderExistingTitles: ['旧条目'],
    });
    expect(r).toMatchObject({ title: 't', body: 'b' });
    const body = bodyOf(0);
    expect(body.kind).toBe('files_init_entry');
    expect(body.prompt).toContain('PORT_FULL_CONTENT');
  });
});

describe('runFilesInit', () => {
  beforeEach(() => {
    vi.mocked(hanaFetch).mockReset();
    vi.mocked(listLoreEntries).mockReset();
    vi.mocked(appendFileEntry).mockReset();
  });

  const echoEntry = async (_aid: string, input: { folderId: string; title: string; body: string }) =>
    ({ id: `e-${input.title}`, key: `e-${input.title}`, agentId: 'agent-x', folderId: input.folderId, title: input.title, body: input.body, createdAt: ISO }) as never;

  it('happy path: one direct-write entry per plan item, with progress', async () => {
    vi.mocked(listLoreEntries).mockReturnValue([makeLore('L1', '港口', 'c1'), makeLore('L2', '师父', 'c2')]);
    vi.mocked(hanaFetch).mockImplementation(async (_url, opts) => {
      const body = JSON.parse(String((opts as { body?: string })?.body ?? '{}'));
      if (body.kind === 'files_init_plan') {
        return mkResp({
          ok: true,
          result: {
            items: [
              { folderName: '世界观整理', title: 'A', focus: 'f', loreIds: ['L1'] },
              { folderName: '人际关系', title: 'B', focus: 'f', loreIds: ['L2'] },
            ],
          },
        });
      }
      // 两条放在不同文件夹，给**各自不同**的 title/body——否则会被新加的跨文件夹查重
      // 正确判为重复而跳过。靠 prompt 里携带的选中 lore content（c1 / c2）区分是哪一条。
      return body.prompt?.includes('c1')
        ? mkResp({ ok: true, result: { title: '港口往事', body: '红盐码头是个走私港，当地七月不出海，外来者会被盯紧。' } })
        : mkResp({ ok: true, result: { title: '师父箴言', body: '师父说信任要靠时间，行动比言语可靠，不轻易承诺。' } });
    });
    vi.mocked(appendFileEntry).mockImplementation(echoEntry);
    const onProgress = vi.fn();
    const { summary, createdEntries } = await runFilesInit({
      agent,
      ownerAgentId: 'agent-x',
      ownerProfile: null,
      folders,
      existingEntries: [],
      onProgress,
    });
    expect(summary).toEqual({ created: 2, skipped: 0, failed: 0, truncated: 0 });
    expect(createdEntries).toHaveLength(2);
    expect(vi.mocked(appendFileEntry)).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenCalledWith(2, 2);
  });

  it('clamps to maxItems and reports the truncated tail (re-run continues)', async () => {
    vi.mocked(listLoreEntries).mockReturnValue([makeLore('L1', 'a', 'c'), makeLore('L2', 'b', 'c'), makeLore('L3', 'c', 'c')]);
    vi.mocked(hanaFetch).mockImplementation(async (_url, opts) => {
      const body = JSON.parse(String((opts as { body?: string })?.body ?? '{}'));
      if (body.kind === 'files_init_plan') {
        return mkResp({
          ok: true,
          result: {
            items: [
              { folderName: '人际关系', title: 'A', loreIds: ['L1'] },
              { folderName: '人际关系', title: 'B', loreIds: ['L2'] },
              { folderName: '人际关系', title: 'C', loreIds: ['L3'] },
            ],
          },
        });
      }
      return mkResp({ ok: true, result: { title: 'g', body: 'b' } });
    });
    vi.mocked(appendFileEntry).mockImplementation(echoEntry);
    const { summary } = await runFilesInit({
      agent,
      ownerAgentId: 'agent-x',
      ownerProfile: null,
      folders,
      existingEntries: [],
      maxItems: 2,
    });
    expect(summary.created).toBe(2); // 只生成 / 写入了上限内的 2 条
    expect(summary.truncated).toBe(1); // 第 3 条被截断、未执行（非静默：会上报）
    expect(vi.mocked(appendFileEntry)).toHaveBeenCalledTimes(2);
  });

  it('empty catalog short-circuits with no LLM call', async () => {
    vi.mocked(listLoreEntries).mockReturnValue([]);
    const { summary } = await runFilesInit({ agent, ownerAgentId: 'agent-x', ownerProfile: null, folders, existingEntries: [] });
    expect(summary).toEqual({ created: 0, skipped: 0, failed: 0, truncated: 0 });
    expect(vi.mocked(hanaFetch)).not.toHaveBeenCalled();
  });

  it('empty plan: only the plan call, no entry writes', async () => {
    vi.mocked(listLoreEntries).mockReturnValue([makeLore('L1', '港口', 'c1')]);
    vi.mocked(hanaFetch).mockResolvedValue(mkResp({ ok: true, result: { items: [] } }));
    const { summary } = await runFilesInit({ agent, ownerAgentId: 'agent-x', ownerProfile: null, folders, existingEntries: [] });
    expect(summary.created).toBe(0);
    expect(vi.mocked(hanaFetch)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(appendFileEntry)).not.toHaveBeenCalled();
  });

  it('one entry-generation failure does not abort the batch', async () => {
    vi.mocked(listLoreEntries).mockReturnValue([makeLore('L1', 'a', 'c'), makeLore('L2', 'b', 'c'), makeLore('L3', 'c', 'c')]);
    let entryCalls = 0;
    vi.mocked(hanaFetch).mockImplementation(async (_url, opts) => {
      const body = JSON.parse(String((opts as { body?: string })?.body ?? '{}'));
      if (body.kind === 'files_init_plan') {
        return mkResp({
          ok: true,
          result: {
            items: [
              { folderName: '人际关系', title: 'A', loreIds: ['L1'] },
              { folderName: '人际关系', title: 'B', loreIds: ['L2'] },
              { folderName: '人际关系', title: 'C', loreIds: ['L3'] },
            ],
          },
        });
      }
      entryCalls += 1;
      if (entryCalls === 2) throw new Error('boom');
      return mkResp({ ok: true, result: { title: 'g', body: 'b' } });
    });
    vi.mocked(appendFileEntry).mockImplementation(echoEntry);
    const { summary } = await runFilesInit({ agent, ownerAgentId: 'agent-x', ownerProfile: null, folders, existingEntries: [] });
    expect(summary.created).toBe(2);
    expect(summary.failed).toBe(1);
  });

  it('duplicate write is counted as skipped, not failed', async () => {
    vi.mocked(listLoreEntries).mockReturnValue([makeLore('L1', 'a', 'c'), makeLore('L2', 'b', 'c')]);
    vi.mocked(hanaFetch).mockImplementation(async (_url, opts) => {
      const body = JSON.parse(String((opts as { body?: string })?.body ?? '{}'));
      if (body.kind === 'files_init_plan') {
        return mkResp({
          ok: true,
          result: {
            items: [
              { folderName: '人际关系', title: 'A', loreIds: ['L1'] },
              { folderName: '人际关系', title: 'B', loreIds: ['L2'] },
            ],
          },
        });
      }
      return mkResp({ ok: true, result: { title: 'g', body: 'b' } });
    });
    let writes = 0;
    vi.mocked(appendFileEntry).mockImplementation((async (_aid: string, input: { folderId: string; title: string; body: string }) => {
      writes += 1;
      if (writes === 1) {
        throw new DuplicateFileEntryError({
          kind: 'exact_dup',
          entry: { id: 'x', key: 'x', agentId: 'agent-x', folderId: 'f-rel', title: 'A', body: '', createdAt: ISO },
        } as never);
      }
      return echoEntry(_aid, input);
    }) as never);
    const { summary } = await runFilesInit({ agent, ownerAgentId: 'agent-x', ownerProfile: null, folders, existingEntries: [] });
    expect(summary).toEqual({ created: 1, skipped: 1, failed: 0, truncated: 0 });
  });

  it('cross-folder near-duplicate is skipped before write (different folder, same body)', async () => {
    const sharedBody = '今天莉莉丝主动跟我说，以后受伤不会瞒着我。她讲这话时语气很认真，没有躲闪。';
    vi.mocked(listLoreEntries).mockReturnValue([makeLore('L1', 'a', 'c')]);
    vi.mocked(hanaFetch).mockImplementation(async (_url, opts) => {
      const body = JSON.parse(String((opts as { body?: string })?.body ?? '{}'));
      if (body.kind === 'files_init_plan') {
        return mkResp({
          ok: true,
          // 计划放进「人际关系」(f-rel)，但内容与「世界观整理」(f-world) 里已有条目几乎一样。
          result: { items: [{ folderName: '人际关系', title: '莉莉丝答应不瞒伤', focus: 'f', loreIds: ['L1'] }] },
        });
      }
      return mkResp({ ok: true, result: { title: '莉莉丝答应不瞒伤', body: sharedBody } });
    });
    vi.mocked(appendFileEntry).mockImplementation(echoEntry);
    const existingEntries = [
      { id: 'ent-x', key: 'ent-x', agentId: 'agent-x', folderId: 'f-world', title: '莉莉丝承诺不再瞒伤', body: sharedBody, createdAt: ISO },
    ] as never;
    const { summary } = await runFilesInit({ agent, ownerAgentId: 'agent-x', ownerProfile: null, folders, existingEntries });
    expect(summary).toEqual({ created: 0, skipped: 1, failed: 0, truncated: 0 });
    expect(vi.mocked(appendFileEntry)).not.toHaveBeenCalled();
  });
});

describe('runFilesBatchAdd', () => {
  beforeEach(() => {
    vi.mocked(hanaFetch).mockReset();
    vi.mocked(listLoreEntries).mockReset();
    vi.mocked(appendFileDraft).mockReset();
    vi.mocked(buildXingyeRecentChatExcerpts).mockReset();
  });

  it('empty recent chat short-circuits with no LLM call', async () => {
    vi.mocked(buildXingyeRecentChatExcerpts).mockReturnValue([]);
    const { summary } = await runFilesBatchAdd({ agent, ownerAgentId: 'agent-x', ownerProfile: null, folders, existingEntries: [] });
    expect(summary).toEqual({ created: 0, skipped: 0, failed: 0, truncated: 0 });
    expect(vi.mocked(hanaFetch)).not.toHaveBeenCalled();
  });

  it('routes add → add draft, resolvable update → update patch draft, unresolvable update → skip', async () => {
    vi.mocked(buildXingyeRecentChatExcerpts).mockReturnValue([
      { speaker: 'user', speakerLabel: '用户 X', text: 'hi' },
      { speaker: 'currentAgent', speakerLabel: '当前角色 Lin', text: 'yo' },
    ] as never);
    vi.mocked(listLoreEntries).mockReturnValue([makeLore('L1', '港口', 'c1')]);
    const existingEntries = [
      { id: 'ent-old', key: 'ent-old', agentId: 'agent-x', folderId: 'f-rel', title: '老条目', body: 'old body', createdAt: ISO },
    ] as never;
    vi.mocked(hanaFetch).mockImplementation(async (_url, opts) => {
      const body = JSON.parse(String((opts as { body?: string })?.body ?? '{}'));
      if (body.kind === 'files_batch_plan') {
        return mkResp({
          ok: true,
          result: {
            items: [
              { folderName: '人际关系', title: '新增条目', focus: 'f', loreIds: ['L1'], chatRefs: [0], action: 'add' },
              { folderName: '人际关系', title: '补充', focus: 'f', loreIds: [], chatRefs: [1], action: 'update', targetTitle: '老条目' },
              { folderName: '人际关系', title: '无解', focus: 'f', loreIds: [], chatRefs: [1], action: 'update', targetTitle: '不存在的标题' },
            ],
          },
        });
      }
      // 逐条生成：同时给 title/body 与 bodyAppend，让 add / update 两个 normalizer 都能过。
      return mkResp({ ok: true, result: { title: 'gen', body: 'genbody', bodyAppend: 'append-seg' } });
    });
    vi.mocked(appendFileDraft).mockImplementation((async (_aid: string, input: Record<string, unknown>) =>
      ({ id: `d-${String(input.title ?? input.action)}`, ...input, createdAt: ISO })) as never);

    const { summary } = await runFilesBatchAdd({ agent, ownerAgentId: 'agent-x', ownerProfile: null, folders, existingEntries });
    expect(summary.created).toBe(2);
    expect(summary.skipped).toBe(1);

    const calls = vi.mocked(appendFileDraft).mock.calls.map((c) => c[1] as Record<string, unknown>);
    expect(calls.filter((c) => c.action === 'add')).toHaveLength(1);
    const updateCall = calls.find((c) => c.action === 'update');
    expect(updateCall).toBeTruthy();
    expect((updateCall?.patch as Record<string, unknown>)?.bodyAppend).toBe('append-seg');
    expect(updateCall?.targetEntryId).toBe('ent-old');
  });

  it('cross-folder near-duplicate add draft is skipped (not proposed)', async () => {
    const sharedBody = '今天莉莉丝主动跟我说，以后受伤不会瞒着我。她讲这话时语气很认真，没有躲闪。';
    vi.mocked(buildXingyeRecentChatExcerpts).mockReturnValue([
      { speaker: 'user', speakerLabel: '用户 X', text: '莉莉丝说不瞒伤了' },
    ] as never);
    vi.mocked(listLoreEntries).mockReturnValue([makeLore('L1', '港口', 'c1')]);
    // 已有条目在「世界观整理」(f-world)；计划的 add 放进「人际关系」(f-rel)，内容几乎一样。
    const existingEntries = [
      { id: 'ent-x', key: 'ent-x', agentId: 'agent-x', folderId: 'f-world', title: '莉莉丝承诺不再瞒伤', body: sharedBody, createdAt: ISO },
    ] as never;
    vi.mocked(hanaFetch).mockImplementation(async (_url, opts) => {
      const body = JSON.parse(String((opts as { body?: string })?.body ?? '{}'));
      if (body.kind === 'files_batch_plan') {
        return mkResp({
          ok: true,
          result: {
            items: [
              { folderName: '人际关系', title: '莉莉丝答应不瞒伤', focus: 'f', loreIds: ['L1'], chatRefs: [0], action: 'add' },
            ],
          },
        });
      }
      return mkResp({ ok: true, result: { title: '莉莉丝答应不瞒伤', body: sharedBody } });
    });
    vi.mocked(appendFileDraft).mockImplementation((async (_aid: string, input: Record<string, unknown>) =>
      ({ id: `d-${String(input.title ?? input.action)}`, ...input, createdAt: ISO })) as never);

    const { summary } = await runFilesBatchAdd({ agent, ownerAgentId: 'agent-x', ownerProfile: null, folders, existingEntries });
    expect(summary.created).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(vi.mocked(appendFileDraft)).not.toHaveBeenCalled();
  });
});
