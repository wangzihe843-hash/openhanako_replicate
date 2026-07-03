import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const publicEntryPoints = [
  'README.md',
  'README_EN.md',
  'PLUGINS.md',
  'PLUGINS_EN.md',
  'PLUGIN_SDK.md',
  'skills2set/hana-plugin-creator/SKILL.md',
  'scripts/download-mingit.js',
  'lib/bridge/feishu-adapter.ts',
  'lib/bridge/telegram-adapter.ts',
  'lib/bridge/wechat-adapter.ts',
];
const markdownLinkSources = [
  'core/provider-compat/README.md',
  'docs/xingye-propose-draft.md',
];

describe('public documentation links', () => {
  it('does not point users or runtime metadata at the ignored private .docs tree', () => {
    for (const relative of publicEntryPoints) {
      const content = fs.readFileSync(path.join(root, relative), 'utf-8');
      expect(content, relative).not.toContain('.docs/');
    }
  });

  it('ships the Bridge media capability document referenced by public entrypoints', () => {
    expect(fs.existsSync(path.join(root, 'docs', 'BRIDGE-MEDIA-CAPABILITIES.md'))).toBe(true);
  });

  it('keeps repository-relative Markdown links pointed at existing files', () => {
    for (const relative of markdownLinkSources) {
      const sourcePath = path.join(root, relative);
      const content = fs.readFileSync(sourcePath, 'utf-8');
      for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        const target = match[1].trim().replace(/^<|>$/g, '');
        if (!target || target.startsWith('#') || /^[a-z][a-z\d+.-]*:/i.test(target)) continue;
        const fileTarget = decodeURIComponent(target.split(/[?#]/, 1)[0]);
        const resolved = path.resolve(path.dirname(sourcePath), fileTarget);
        expect(fs.existsSync(resolved), `${relative} -> ${target}`).toBe(true);
      }
    }
  });
});
