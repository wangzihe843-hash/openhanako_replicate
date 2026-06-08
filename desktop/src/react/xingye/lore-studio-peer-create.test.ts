import { describe, expect, it } from 'vitest';
import { copyWorldviewToAgent, writePeerRelationshipLore } from './lore-studio-peer-create';
import { createLoreEntry, listLoreEntries } from './xingye-lore-store';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function makeStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
  };
}

describe('copyWorldviewToAgent', () => {
  it('copies worldview entries to target agent with fresh ids and target ownership', () => {
    const storage = makeStorage();
    const src = createLoreEntry(
      'agent-A',
      { title: '两族秩序', content: '北境与林族世代盟约。', category: 'worldview', insertionMode: 'keyword', keywords: ['北境', '林族'] },
      storage,
    );

    const created = copyWorldviewToAgent(
      'agent-B',
      listLoreEntries('agent-A', storage),
      storage,
    );

    expect(created).toHaveLength(1);
    const onB = listLoreEntries('agent-B', storage);
    expect(onB).toHaveLength(1);
    expect(onB[0].agentId).toBe('agent-B');
    expect(onB[0].id).not.toBe(src.id);
    expect(onB[0].category).toBe('worldview');
    expect(onB[0].insertionMode).toBe('keyword');
    expect(onB[0].keywords).toEqual(['北境', '林族']);
    // 源不受影响
    expect(listLoreEntries('agent-A', storage)).toHaveLength(1);
  });
});

describe('writePeerRelationshipLore', () => {
  it('源角色无既有条目时：源侧写实质内容（非空模板）、新侧用模版脚手架', () => {
    const storage = makeStorage();
    writePeerRelationshipLore(
      {
        sourceAgentId: 'agent-A',
        sourceName: '林雾',
        newAgentId: 'agent-B',
        newName: '寒鸦',
        userName: '阿白',
        note: '旧日同袍，因故疏远。',
      },
      storage,
    );

    const onA = listLoreEntries('agent-A', storage);
    expect(onA).toHaveLength(1);
    expect(onA[0].category).toBe('relationship');
    expect(onA[0].title).toBe('与「寒鸦」的关系');
    expect(onA[0].keywords).toEqual(['寒鸦']);
    // 源侧不再是空模板：含 peer 链接（对方现在是独立 agent + agent id 供 dm）+ 关系起点
    expect(onA[0].content).toContain('现在是独立角色');
    expect(onA[0].content).toContain('agent-B');
    expect(onA[0].content).toContain('旧日同袍，因故疏远。');

    // 新角色侧是白纸 → 模版脚手架（含实体区分 + 源角色 id）
    const onB = listLoreEntries('agent-B', storage);
    expect(onB).toHaveLength(1);
    expect(onB[0].title).toBe('与「林雾」的关系');
    expect(onB[0].content).toContain('另一个 AI agent');
    expect(onB[0].content).toContain('agent-A');
  });

  it('批量：两个名字子串包含的候选（无 Phase1 条目）各写各的源侧条目，不被对方刚建的占位条目串味', () => {
    const storage = makeStorage();
    // 同批先建「寒鸦影」，再建「寒鸦」（后者是前者的子串）——旧逻辑下「寒鸦」会模糊命中「寒鸦影」刚建的占位条目。
    writePeerRelationshipLore(
      { sourceAgentId: 'agent-A', sourceName: '林雾', newAgentId: 'agent-X', newName: '寒鸦影', userName: '阿白' },
      storage,
    );
    writePeerRelationshipLore(
      { sourceAgentId: 'agent-A', sourceName: '林雾', newAgentId: 'agent-Y', newName: '寒鸦', userName: '阿白' },
      storage,
    );

    const onA = listLoreEntries('agent-A', storage).filter(
      (e) => e.category === 'relationship' || e.category === 'character',
    );
    expect(onA).toHaveLength(2); // 各自独立，没有串到同一条
    const forX = onA.find((e) => e.title.includes('寒鸦影'))!;
    const forY = onA.find((e) => e.title === '与「寒鸦」的关系')!;
    expect(forX).toBeTruthy();
    expect(forY).toBeTruthy();
    // 「寒鸦影」条目只链接 agent-X、「寒鸦」条目只链接 agent-Y，互不混入对方 id
    expect(forX.content).toContain('agent-X');
    expect(forX.content).not.toContain('agent-Y');
    expect(forY.content).toContain('agent-Y');
    expect(forY.content).not.toContain('agent-X');
  });

  it('幂等：对同一 newAgentId 重复 writePeerRelationshipLore 不重复堆叠链接段', () => {
    const storage = makeStorage();
    createLoreEntry(
      'agent-A',
      { title: '军师 寒鸦', content: '与你并肩多年的军师，沉默可靠。', category: 'character', keywords: ['寒鸦'] },
      storage,
    );
    const names = {
      sourceAgentId: 'agent-A',
      sourceName: '林雾',
      newAgentId: 'agent-B',
      newName: '寒鸦',
      userName: '阿白',
      note: '生死之交。',
    };
    writePeerRelationshipLore(names, storage);
    writePeerRelationshipLore(names, storage); // 重跑（或同批多次命中）

    const onA = listLoreEntries('agent-A', storage).filter((e) => e.title === '军师 寒鸦');
    expect(onA).toHaveLength(1);
    // 链接段只追加一次，不重复堆叠
    const occurrences = onA[0].content.split('现在是独立角色').length - 1;
    expect(occurrences).toBe(1);
    expect(onA[0].content).toContain('与你并肩多年的军师'); // 原 Phase1 内容仍在
  });

  it('源角色已有该人的 Phase 1 关系/人物 lore → 在原条目上追加 peer 链接，不新增空模板', () => {
    const storage = makeStorage();
    const existing = createLoreEntry(
      'agent-A',
      { title: '军师 寒鸦', content: '与你并肩多年的军师，沉默可靠。', category: 'character', keywords: ['寒鸦'] },
      storage,
    );

    writePeerRelationshipLore(
      { sourceAgentId: 'agent-A', sourceName: '林雾', newAgentId: 'agent-B', newName: '寒鸦', userName: '阿白', note: '生死之交。' },
      storage,
    );

    const onA = listLoreEntries('agent-A', storage);
    expect(onA).toHaveLength(1); // 复用原条目，没有新增空模板
    expect(onA[0].id).toBe(existing.id);
    expect(onA[0].content).toContain('与你并肩多年的军师'); // 原 Phase 1 内容保留
    expect(onA[0].content).toContain('现在是独立角色'); // 追加了 peer 链接
    expect(onA[0].content).toContain('agent-B'); // 对方 agent id（供 dm）
    expect(onA[0].content).toContain('生死之交。');
    expect(onA[0].keywords).toContain('寒鸦');

    // 新角色侧仍正常写一条
    expect(listLoreEntries('agent-B', storage)).toHaveLength(1);
  });
});
