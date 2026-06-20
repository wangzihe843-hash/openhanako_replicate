// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChapterRail } from '../../components/preview/MarkdownChrome';

function readMarkdownChromeCss(): string {
  return fs.readFileSync(
    path.join(process.cwd(), 'desktop/src/react/components/preview/MarkdownChrome.module.css'),
    'utf8',
  );
}

function cssBlock(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`))?.groups?.body || '';
}

describe('MarkdownChrome chapter rail layout', () => {
  afterEach(() => cleanup());

  it('renders one hover chapter list instead of duplicating a fixed dock', () => {
    render(
      <ChapterRail
        headings={[{ id: 'intro', level: 1, text: 'Intro', line: 0, offset: 0 }]}
        activeHeadingId={null}
        onJump={vi.fn()}
      />,
    );

    expect(screen.getAllByText('Intro')).toHaveLength(1);
  });

  it('keeps a generous hover target while drawing only a vertical line', () => {
    const css = readMarkdownChromeCss();
    const trigger = cssBlock(css, '.chapterTrigger');
    const line = cssBlock(css, '.chapterTrigger span');

    expect(trigger).toMatch(/width:\s*34px/);
    expect(trigger).toMatch(/height:\s*132px/);
    expect(trigger).toMatch(/border:\s*0/);
    expect(trigger).toMatch(/background:\s*transparent/);
    expect(line).toMatch(/width:\s*4px/);
    expect(line).toMatch(/height:\s*96px/);
    expect(line).toMatch(/box-shadow:\s*0 0 0 1px var\(--bg-card/);
  });
});
