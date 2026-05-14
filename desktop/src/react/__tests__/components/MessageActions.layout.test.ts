import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('MessageActions layout', () => {
  it('anchors the select checkbox group to the lower right of the message block', () => {
    const css = fs.readFileSync(
      path.join(process.cwd(), 'desktop/src/react/components/chat/Chat.module.css'),
      'utf8',
    );
    const block = css.match(/\.msgActions\s*\{(?<body>[^}]*)\}/)?.groups?.body || '';

    expect(block).toMatch(/bottom:\s*4px/);
    expect(block).toMatch(/right:\s*4px/);
    expect(block).not.toMatch(/top:\s*4px/);
  });
});
