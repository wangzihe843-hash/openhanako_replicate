import { describe, expect, it } from 'vitest';
import {
  FILES_DRAFT_EXISTING_ENTRIES_PROMPT_LIMIT,
  buildFilesDraftPrompt,
  type FilesDraftExistingEntry,
} from './xingye-files-prompts';

function basePromptArgs() {
  return {
    agent: { id: 'agent-x', name: 'Hoshino', yuan: '本时空' },
    userName: '用户',
    profile: null,
    userIntent: '',
    targetFolder: null,
    folderOptions: [
      { id: 'fold-1', name: '人际关系', description: 'TA 接触过的人' },
    ],
    recentSceneBlock: '',
    stableLoreBlock: '',
    keywordLoreBlock: '',
    relationshipBlock: '',
    heartbeatBlock: '',
  };
}

describe('buildFilesDraftPrompt · existingEntriesBlock', () => {
  it('空 entries 时显示 "暂无已归档条目"', () => {
    const prompt = buildFilesDraftPrompt({ ...basePromptArgs(), existingEntries: [] });
    expect(prompt).toContain('（资料柜里暂无已归档条目）');
  });

  it('缺省 existingEntries 视同空数组', () => {
    const prompt = buildFilesDraftPrompt(basePromptArgs());
    expect(prompt).toContain('（资料柜里暂无已归档条目）');
  });

  it('列出条目带 id / folderName / title / summary', () => {
    const entries: FilesDraftExistingEntry[] = [
      { id: 'e1', folderName: '人际关系', title: '师父的话', summary: '记录三句家训' },
      { id: 'e2', folderName: '世界观整理', title: '诊所那条街', summary: '街口便利店在装修' },
    ];
    const prompt = buildFilesDraftPrompt({ ...basePromptArgs(), existingEntries: entries });
    expect(prompt).toContain('- [e1] 人际关系 · 《师父的话》 — 记录三句家训');
    expect(prompt).toContain('- [e2] 世界观整理 · 《诊所那条街》');
  });

  it('summary 缺失时不带尾巴', () => {
    const entries: FilesDraftExistingEntry[] = [
      { id: 'e1', folderName: '线索与发现', title: '今天的报纸' },
    ];
    const prompt = buildFilesDraftPrompt({ ...basePromptArgs(), existingEntries: entries });
    expect(prompt).toContain('- [e1] 线索与发现 · 《今天的报纸》');
    expect(prompt).not.toMatch(/今天的报纸》 — /);
  });

  it('summary 超过 60 字会被截断', () => {
    const longSummary = '一二三四五六七八九十'.repeat(10); // 100 字
    const entries: FilesDraftExistingEntry[] = [
      { id: 'e1', folderName: '人际关系', title: 'T', summary: longSummary },
    ];
    const prompt = buildFilesDraftPrompt({ ...basePromptArgs(), existingEntries: entries });
    expect(prompt).toContain(longSummary.slice(0, 60));
    expect(prompt).not.toContain(longSummary);
  });

  it(`最多列出 ${FILES_DRAFT_EXISTING_ENTRIES_PROMPT_LIMIT} 条`, () => {
    const entries: FilesDraftExistingEntry[] = Array.from({ length: 50 }).map((_, i) => ({
      id: `e${i}`,
      folderName: '人际关系',
      title: `条目${i}`,
    }));
    const prompt = buildFilesDraftPrompt({ ...basePromptArgs(), existingEntries: entries });
    expect(prompt).toContain('[e0]');
    expect(prompt).toContain(`[e${FILES_DRAFT_EXISTING_ENTRIES_PROMPT_LIMIT - 1}]`);
    expect(prompt).not.toContain(`[e${FILES_DRAFT_EXISTING_ENTRIES_PROMPT_LIMIT}]`);
  });

  it('附带去重原则文案 + 跨夹散落防护', () => {
    const prompt = buildFilesDraftPrompt(basePromptArgs());
    expect(prompt).toContain('重要去重原则');
    expect(prompt).toContain('不要新建');
    expect(prompt).toContain('几乎同名');
    expect(prompt).toContain('只归进'); // FILES_FOLDER_SCATTER_GUARD
  });
});

describe('buildFilesDraftPrompt · 文件夹分工指南', () => {
  it('文件夹清单为已知夹附「放/不放/体例」', () => {
    const prompt = buildFilesDraftPrompt({
      ...basePromptArgs(),
      folderOptions: [{ id: 'f', name: '世界观整理', description: '关于 TA 所处世界的设定与规则。' }],
    });
    expect(prompt).toContain('· 放：');
    expect(prompt).toContain('· 体例：');
    expect(prompt).toMatch(/不要写成第一人称回忆或小说叙事/);
  });

  it('已知目标夹时把该夹体例顶到正文跟前', () => {
    const prompt = buildFilesDraftPrompt({
      ...basePromptArgs(),
      targetFolder: { id: 'f', name: '世界观整理', description: '关于 TA 所处世界的设定与规则。' },
    });
    expect(prompt).toContain('【这个文件夹专放什么 / 该怎么写】');
  });

  it('无目标夹（首页快捷入口）时不渲染目标夹体例块', () => {
    const prompt = buildFilesDraftPrompt(basePromptArgs());
    expect(prompt).not.toContain('【这个文件夹专放什么 / 该怎么写】');
  });
});

describe('buildFilesDraftPrompt · 通讯录候选池', () => {
  it('未传 virtualContacts 时不渲染通讯录块', () => {
    const prompt = buildFilesDraftPrompt(basePromptArgs());
    expect(prompt).not.toContain('通讯录里的人');
  });

  it('传入联系人时渲染候选池（昵称 + 印象）', () => {
    const prompt = buildFilesDraftPrompt({
      ...basePromptArgs(),
      virtualContacts: [
        { id: 'vc-1', displayName: '老周', kind: 'friend', impression: '话少但靠谱' },
      ],
    });
    expect(prompt).toContain('通讯录里的人');
    expect(prompt).toContain('老周');
    expect(prompt).toContain('印象：话少但靠谱');
  });

  it('联系人带 loreAliases 时注入「同一人对齐」去重指令', () => {
    const withAlias = buildFilesDraftPrompt({
      ...basePromptArgs(),
      virtualContacts: [{ id: 'vc-1', displayName: '老周', loreAliases: ['周律师'] }],
    });
    expect(withAlias).toContain('同一人对齐');
    expect(withAlias).toContain('《周律师》');

    // 没有任何对齐标注时，不插入这行说明（避免噪声指令）。
    const noAlias = buildFilesDraftPrompt({
      ...basePromptArgs(),
      virtualContacts: [{ id: 'vc-1', displayName: '老周' }],
    });
    expect(noAlias).not.toContain('同一人对齐');
  });
});
