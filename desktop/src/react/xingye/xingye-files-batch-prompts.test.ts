import { describe, expect, it } from 'vitest';
import {
  buildFilesBatchAddEntryPrompt,
  buildFilesBatchPlanPrompt,
  buildFilesInitEntryPrompt,
  buildFilesInitPlanPrompt,
} from './xingye-files-batch-prompts';
import {
  formatContactLoreSection,
  type XingyeContactLoreHint,
} from './xingye-contact-lore-link';

const AGENT = { id: 'agent-x', name: 'Hoshino', yuan: '本时空' } as const;

const CONTACTS: XingyeContactLoreHint[] = [
  { id: 'vc-1', displayName: '老周', kind: 'friend', impression: '话少但靠谱', loreAliases: ['周律师'] },
  { id: 'vc-2', displayName: '阿姨', kind: 'family', relationshipHint: '楼下邻居' },
];

const CONTACTS_BLOCK = formatContactLoreSection(CONTACTS);

function initPlanArgs(contactsBlock?: string) {
  return {
    agent: AGENT,
    userName: '用户',
    profile: null,
    loreCatalogBlock: '- [l1] 《周律师》（人物）',
    folderOptions: [{ name: '人际关系', description: 'TA 接触过的人' }],
    existingEntries: [],
    maxItems: 10,
    relationshipBlock: '',
    contactsBlock,
  };
}

function batchPlanArgs(contactsBlock?: string) {
  return {
    ...initPlanArgs(contactsBlock),
    recentChatBlock: '[#0] [用户] 今天见了老周',
    recentChatCount: 1,
  };
}

describe('Phase 1 规划 prompt · 文件夹分工 + 跨夹散落防护', () => {
  function planWithFolders() {
    return {
      ...initPlanArgs(),
      folderOptions: [
        { name: '世界观整理', description: '关于 TA 所处世界的设定与规则。' },
        { name: '人际关系', description: 'TA 接触过的人' },
        { name: '随手记', description: '杂七杂八' },
      ],
    };
  }

  it('init 规划：文件夹清单带「放/不放/体例」+ 世界观禁小说体 + 跨夹散落防护', () => {
    const prompt = buildFilesInitPlanPrompt(planWithFolders());
    expect(prompt).toContain('· 放：');
    expect(prompt).toContain('· 体例：');
    expect(prompt).toMatch(/不要写成第一人称回忆或小说叙事/);
    expect(prompt).toContain('只归进'); // FILES_FOLDER_SCATTER_GUARD
    // 自定义夹只列名字，不强加分工
    expect(prompt).toContain('- 随手记：杂七杂八');
  });

  it('batch 规划：同样带文件夹分工 + 跨夹散落防护', () => {
    const prompt = buildFilesBatchPlanPrompt({
      ...planWithFolders(),
      recentChatBlock: '[#0] [用户] 今天聊了红盐码头',
      recentChatCount: 1,
    });
    expect(prompt).toContain('· 体例：');
    expect(prompt).toContain('只归进');
  });
});

describe('Phase 1 规划 prompt · 通讯录注入', () => {
  it('init 规划：传通讯录时渲染候选块 + 规划去重规则 + 同一人对齐指令', () => {
    const prompt = buildFilesInitPlanPrompt(initPlanArgs(CONTACTS_BLOCK));
    expect(prompt).toContain('【TA 的通讯录');
    expect(prompt).toContain('老周');
    expect(prompt).toContain('印象：话少但靠谱');
    expect(prompt).toContain('只排一条'); // 规划阶段去重规则
    expect(prompt).toContain('同一人对齐'); // CONTACT_LORE_DEDUPE_INSTRUCTION
    expect(prompt).toContain('《周律师》');
  });

  it('init 规划：无通讯录（缺省 / （无））时完全不渲染候选块与规则', () => {
    const omitted = buildFilesInitPlanPrompt(initPlanArgs());
    const none = buildFilesInitPlanPrompt(initPlanArgs('（无）'));
    for (const prompt of [omitted, none]) {
      expect(prompt).not.toContain('【TA 的通讯录');
      expect(prompt).not.toContain('只排一条');
      expect(prompt).not.toContain('同一人对齐');
    }
  });

  it('batch 规划：传通讯录时渲染候选块 + 「聊天里聊到的人对上联系人」规则', () => {
    const prompt = buildFilesBatchPlanPrompt(batchPlanArgs(CONTACTS_BLOCK));
    expect(prompt).toContain('【TA 的通讯录');
    expect(prompt).toContain('聊天里聊到的人');
    expect(prompt).toContain('老周');
  });
});

describe('Phase 2 逐条生成 prompt · 通讯录注入', () => {
  function initEntryArgs(contactsBlock?: string) {
    return {
      agent: AGENT,
      userName: '用户',
      profile: null,
      folderName: '人际关系',
      focus: '整理和老周的来往',
      selectedLoreBlock: '《周律师》（人物）\n老周是 TA 的法律顾问',
      sameFolderExistingTitles: [],
      contactsBlock,
    };
  }

  it('init 正文：人际类文件夹传通讯录时渲染候选块', () => {
    const prompt = buildFilesInitEntryPrompt(initEntryArgs(CONTACTS_BLOCK));
    expect(prompt).toContain('【可参考的通讯录联系人');
    expect(prompt).toContain('老周');
    expect(prompt).toContain('同一个人别和设定库分开写成两份');
  });

  it('init 正文：不传通讯录（非人际类文件夹）时不渲染候选块', () => {
    const prompt = buildFilesInitEntryPrompt(initEntryArgs());
    expect(prompt).not.toContain('【可参考的通讯录联系人');
  });

  it('init 正文：世界观夹注入「该怎么写」体例指南（归纳口吻、禁小说体）', () => {
    const prompt = buildFilesInitEntryPrompt({
      agent: AGENT,
      userName: '用户',
      profile: null,
      folderName: '世界观整理',
      focus: '整理红盐码头的规矩',
      selectedLoreBlock: '《红盐码头》（地点）\n走私港，七月不出海',
      sameFolderExistingTitles: [],
    });
    expect(prompt).toContain('【这个文件夹专放什么 / 该怎么写】');
    expect(prompt).toMatch(/不要写成第一人称回忆或小说叙事/);
  });

  it('init 正文：自定义夹不注入体例指南', () => {
    const prompt = buildFilesInitEntryPrompt({
      ...initEntryArgs(),
      folderName: '随手记',
    });
    expect(prompt).not.toContain('【这个文件夹专放什么 / 该怎么写】');
  });

  it('batch add 正文：人际类文件夹传通讯录时渲染候选块', () => {
    const prompt = buildFilesBatchAddEntryPrompt({
      agent: AGENT,
      userName: '用户',
      profile: null,
      folderName: '人际关系',
      focus: '整理和老周的来往',
      selectedLoreBlock: '（无）',
      selectedChatBlock: '- [用户] 今天见了老周',
      sameFolderExistingTitles: [],
      contactsBlock: CONTACTS_BLOCK,
    });
    expect(prompt).toContain('【可参考的通讯录联系人');
    expect(prompt).toContain('老周');
  });
});
