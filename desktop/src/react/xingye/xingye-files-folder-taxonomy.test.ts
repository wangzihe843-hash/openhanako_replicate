import { describe, expect, it } from 'vitest';
import {
  FILES_FOLDER_SCATTER_GUARD,
  classifyXingyeFilesFolder,
  formatFilesFolderEntryGuide,
  formatFilesFolderGuideListing,
} from './xingye-files-folder-taxonomy';

describe('classifyXingyeFilesFolder', () => {
  it('把五个默认文件夹归到各自的分工', () => {
    expect(classifyXingyeFilesFolder('世界观整理')).toBe('worldview');
    expect(classifyXingyeFilesFolder('人际关系')).toBe('people');
    expect(classifyXingyeFilesFolder('关于 user')).toBe('aboutUser');
    expect(classifyXingyeFilesFolder('线索与发现')).toBe('clues');
    expect(classifyXingyeFilesFolder('待确认')).toBe('unverified');
  });

  it('「关于 user」先于「人际关系」判定（名字含 user 不应被 people 抢走）', () => {
    // 「关于用户」「关于 你」都该归 aboutUser，而非 people。
    expect(classifyXingyeFilesFolder('关于用户')).toBe('aboutUser');
    expect(classifyXingyeFilesFolder('关于 你')).toBe('aboutUser');
  });

  it('近义自定义名也能命中', () => {
    expect(classifyXingyeFilesFolder('世界设定')).toBe('worldview');
    expect(classifyXingyeFilesFolder('亲友名单')).toBe('people');
    expect(classifyXingyeFilesFolder('待核实')).toBe('unverified');
  });

  it('完全自定义 / 空名归 other', () => {
    expect(classifyXingyeFilesFolder('随手记')).toBe('other');
    expect(classifyXingyeFilesFolder('')).toBe('other');
    expect(classifyXingyeFilesFolder('   ')).toBe('other');
  });
});

describe('formatFilesFolderGuideListing', () => {
  it('已知夹附「放 / 不放 / 体例」三行', () => {
    const block = formatFilesFolderGuideListing([
      { name: '世界观整理', description: '关于 TA 所处世界的设定与规则。' },
    ]);
    expect(block).toContain('- 世界观整理：关于 TA 所处世界的设定与规则。');
    expect(block).toContain('· 放：');
    expect(block).toContain('· 不放：');
    expect(block).toContain('· 体例：');
    // 世界观体例的核心约束：归纳口吻、禁第一人称小说/回忆体。
    expect(block).toContain('归纳');
    expect(block).toMatch(/不要写成第一人称回忆或小说叙事/);
  });

  it('自定义夹只列名字+描述，不强加分工指南', () => {
    const block = formatFilesFolderGuideListing([{ name: '随手记', description: '杂七杂八' }]);
    expect(block).toContain('- 随手记：杂七杂八');
    expect(block).not.toContain('· 放：');
    expect(block).not.toContain('· 体例：');
  });

  it('空文件夹用默认兜底文案，可被覆盖', () => {
    expect(formatFilesFolderGuideListing([])).toBe('（资料柜里目前还没有文件夹）');
    expect(formatFilesFolderGuideListing([], '自定义兜底')).toBe('自定义兜底');
  });
});

describe('formatFilesFolderEntryGuide', () => {
  it('世界观夹返回归纳体例指南（禁小说/回忆体）', () => {
    const guide = formatFilesFolderEntryGuide('世界观整理');
    expect(guide).toContain('【这个文件夹专放什么 / 该怎么写】');
    expect(guide).toContain('- 体例：');
    expect(guide).toMatch(/不要写成第一人称回忆或小说叙事/);
  });

  it('自定义夹返回空串（不渲染）', () => {
    expect(formatFilesFolderEntryGuide('随手记')).toBe('');
    expect(formatFilesFolderEntryGuide('')).toBe('');
  });
});

describe('FILES_FOLDER_SCATTER_GUARD', () => {
  it('是一句非空的跨夹散落防护文案', () => {
    expect(FILES_FOLDER_SCATTER_GUARD).toContain('只归进');
    expect(FILES_FOLDER_SCATTER_GUARD.length).toBeGreaterThan(20);
  });
});
