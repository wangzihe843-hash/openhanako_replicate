/**
 * @vitest-environment jsdom
 */

import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __setMermaidLoaderForTests,
  renderMermaidDiagrams,
} from '../../utils/mermaid-renderer';

function renderedSvg(container: ParentNode) {
  return container.querySelector('.mermaid-svg')?.shadowRoot?.querySelector('svg');
}

describe('renderMermaidDiagrams', () => {
  const initialize = vi.fn();
  const render = vi.fn(async (id: string, source: string) => ({
    svg: `<svg data-id="${id}"><text>${source}</text></svg>`,
  }));

  beforeEach(() => {
    document.body.innerHTML = '';
    initialize.mockClear();
    render.mockClear();
    __setMermaidLoaderForTests(async () => ({
      initialize,
      render: async (id, source) => {
        const result = await render(id, source);
        const bytes = new TextEncoder().encode(result.svg);
        return { ...result, svg: `<iframe sandbox="" src="data:text/html;charset=UTF-8;base64,${btoa(String.fromCharCode(...bytes))}"></iframe>` };
      },
    }));
  });

  afterEach(() => {
    __setMermaidLoaderForTests(null);
  });

  it('renders mermaid placeholders into SVG once per source', async () => {
    const container = document.createElement('div');
    container.innerHTML = [
      '<div class="mermaid-diagram">',
      '<pre class="mermaid-source"><code>graph TD\nA-->B</code></pre>',
      '<div class="mermaid-rendered"></div>',
      '</div>',
    ].join('');

    await renderMermaidDiagrams(container);

    expect(initialize).toHaveBeenCalledWith(expect.objectContaining({
      startOnLoad: false,
      securityLevel: 'sandbox',
      suppressErrorRendering: true,
    }));
    expect(render).toHaveBeenCalledTimes(1);
    expect(renderedSvg(container)).toBeInstanceOf(SVGElement);
    expect(container.querySelector('.mermaid-rendered svg')).toBeNull();
    expect(container.querySelector('.mermaid-source')).toHaveAttribute('hidden');
    expect(container.querySelector('.mermaid-source-toggle')).toBeInstanceOf(HTMLButtonElement);
    expect(container.querySelector('.mermaid-source-copy')).toBeInstanceOf(HTMLButtonElement);

    await renderMermaidDiagrams(container);

    expect(render).toHaveBeenCalledTimes(1);
  });

  it('keeps the source toolbar stable when rendering the same source again', async () => {
    const container = document.createElement('div');
    container.innerHTML = [
      '<div class="mermaid-diagram">',
      '<pre class="mermaid-source"><code>graph TD\nA-->B</code></pre>',
      '<div class="mermaid-rendered"></div>',
      '</div>',
    ].join('');

    await renderMermaidDiagrams(container);
    const toolbar = container.querySelector('.mermaid-source-toolbar');
    await renderMermaidDiagrams(container);

    expect(container.querySelector('.mermaid-source-toolbar')).toBe(toolbar);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('lets rendered Mermaid diagrams reveal and copy their source', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const container = document.createElement('div');
    container.innerHTML = [
      '<div class="mermaid-diagram">',
      '<pre class="mermaid-source"><code>graph TD\nA-->B</code></pre>',
      '<div class="mermaid-rendered"></div>',
      '</div>',
    ].join('');

    await renderMermaidDiagrams(container);

    const source = container.querySelector('.mermaid-source');
    const toggle = container.querySelector<HTMLButtonElement>('.mermaid-source-toggle')!;
    const copy = container.querySelector<HTMLButtonElement>('.mermaid-source-copy')!;
    expect(source).toHaveAttribute('hidden');

    toggle.click();
    expect(source).not.toHaveAttribute('hidden');
    toggle.click();
    expect(source).toHaveAttribute('hidden');
    copy.click();

    expect(writeText).toHaveBeenCalledWith('graph TD\nA-->B');
  });

  it('rerenders a restored diagram when the SVG is missing for the same source', async () => {
    const container = document.createElement('div');
    container.innerHTML = [
      '<div class="mermaid-diagram" data-mermaid-status="rendered" data-mermaid-source="graph TD\nA-->B">',
      '<pre class="mermaid-source" hidden><code>graph TD\nA-->B</code></pre>',
      '<div class="mermaid-rendered"></div>',
      '</div>',
    ].join('');

    await renderMermaidDiagrams(container);

    expect(render).toHaveBeenCalledTimes(1);
    expect(renderedSvg(container)).toBeInstanceOf(SVGElement);
  });

  it('rerenders when the source changes even if a previous SVG exists', async () => {
    const container = document.createElement('div');
    container.innerHTML = [
      '<div class="mermaid-diagram" data-mermaid-status="rendered" data-mermaid-source="graph TD\nA-->B">',
      '<pre class="mermaid-source" hidden><code>graph TD\nA-->C</code></pre>',
      '<div class="mermaid-rendered"><svg><text>old</text></svg></div>',
      '</div>',
    ].join('');

    await renderMermaidDiagrams(container);

    expect(render).toHaveBeenCalledTimes(1);
    expect(renderedSvg(container)?.querySelector('text')?.textContent).toContain('A-->C');
  });

  it('does not let an older async render overwrite a newer source', async () => {
    let resolveFirst!: (value: { svg: string }) => void;
    render
      .mockImplementationOnce((_id: string, _source: string) => new Promise<{ svg: string }>((resolve) => {
        resolveFirst = resolve;
      }))
      .mockImplementationOnce(async (_id: string, source: string) => ({
        svg: `<svg><text>${source}</text></svg>`,
      }));
    const container = document.createElement('div');
    container.innerHTML = [
      '<div class="mermaid-diagram">',
      '<pre class="mermaid-source"><code>graph TD\nA-->B</code></pre>',
      '<div class="mermaid-rendered"></div>',
      '</div>',
    ].join('');

    const first = renderMermaidDiagrams(container);
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(1));
    container.querySelector('.mermaid-source code')!.textContent = 'graph TD\nA-->C';
    await renderMermaidDiagrams(container);
    resolveFirst({ svg: '<svg><text>graph TD\nA-->B</text></svg>' });
    await first;

    expect(render).toHaveBeenCalledTimes(2);
    expect(renderedSvg(container)?.querySelector('text')?.textContent).toContain('A-->C');
  });

  it('copies the latest source after rerendering a changed diagram', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const container = document.createElement('div');
    container.innerHTML = [
      '<div class="mermaid-diagram">',
      '<pre class="mermaid-source"><code>graph TD\nA-->B</code></pre>',
      '<div class="mermaid-rendered"></div>',
      '</div>',
    ].join('');

    await renderMermaidDiagrams(container);
    container.querySelector('.mermaid-source code')!.textContent = 'graph TD\nA-->C';
    await renderMermaidDiagrams(container);
    container.querySelector<HTMLButtonElement>('.mermaid-source-copy')!.click();

    expect(writeText).toHaveBeenCalledWith('graph TD\nA-->C');
  });

  it('keeps source visible and shows an error when mermaid rendering fails', async () => {
    render.mockRejectedValueOnce(new Error('bad diagram'));
    const container = document.createElement('div');
    container.innerHTML = [
      '<div class="mermaid-diagram">',
      '<pre class="mermaid-source"><code>graph Nope</code></pre>',
      '<div class="mermaid-rendered"></div>',
      '</div>',
    ].join('');

    await renderMermaidDiagrams(container);

    expect(container.querySelector('.mermaid-source')).not.toHaveAttribute('hidden');
    expect(container.querySelector('.mermaid-rendered')?.textContent).toContain('bad diagram');
  });

  it('does not retry an unchanged failed diagram on observer-triggered rerenders', async () => {
    const container = document.createElement('div');
    container.innerHTML = [
      '<div class="mermaid-diagram" data-mermaid-status="error" data-mermaid-source="graph TD\nA-->B">',
      '<pre class="mermaid-source"><code>graph TD\nA-->B</code></pre>',
      '<div class="mermaid-rendered">Mermaid diagram failed to render: bad diagram</div>',
      '</div>',
    ].join('');

    await renderMermaidDiagrams(container);

    expect(render).not.toHaveBeenCalled();
  });

  it('sanitizes decoded SVG while preserving ordinary text and HTML labels', async () => {
    render.mockResolvedValueOnce({
      svg: '<svg xmlns="http://www.w3.org/2000/svg" onload="void 0"><text>安全</text><script>void 0</script><a href="javascript:void(0)">bad</a><foreignObject><div xmlns="http://www.w3.org/1999/xhtml" onclick="void 0"><b>Label</b></div></foreignObject></svg>',
    });
    const container = document.createElement('div');
    container.innerHTML = '<div class="mermaid-diagram"><pre class="mermaid-source"><code>flowchart LR\nA-->B</code></pre></div>';
    await renderMermaidDiagrams(container);
    const svg = renderedSvg(container)!;
    expect(svg.querySelector('text')?.textContent).toBe('安全');
    expect(svg.querySelector('foreignObject b')?.textContent).toBe('Label');
    expect(svg.querySelector('script, [onload], [onclick], [href^="javascript:"]')).toBeNull();
    expect(svg.hasAttribute('onload')).toBe(false);
    expect(container.querySelector('iframe, svg')).toBeNull();
  });

  it('rejects a result that did not come from the sandbox envelope', async () => {
    __setMermaidLoaderForTests(async () => ({
      initialize,
      render: async () => ({ svg: '<svg><text>Unisolated result</text></svg>' }),
    }));
    const container = document.createElement('div');
    container.innerHTML = '<div class="mermaid-diagram"><pre class="mermaid-source"><code>flowchart LR\nA-->B</code></pre></div>';
    await renderMermaidDiagrams(container);
    expect(container.querySelector('.mermaid-diagram')).toHaveAttribute('data-mermaid-status', 'error');
    expect(container.querySelector('.mermaid-source')).not.toHaveAttribute('hidden');
    expect(renderedSvg(container)).toBeUndefined();
    expect(container.textContent).toContain('unexpected sandbox result');
  });

  it('rejects decoded content without one SVG root', async () => {
    render.mockResolvedValueOnce({ svg: '<div>Unexpected HTML</div>' });
    const container = document.createElement('div');
    container.innerHTML = '<div class="mermaid-diagram"><pre class="mermaid-source"><code>flowchart LR\nA-->B</code></pre></div>';
    await renderMermaidDiagrams(container);
    expect(container.querySelector('.mermaid-diagram')).toHaveAttribute('data-mermaid-status', 'error');
    expect(container.querySelector('.mermaid-source')).not.toHaveAttribute('hidden');
    expect(renderedSvg(container)).toBeUndefined();
    expect(container.textContent).toContain('invalid SVG');
  });
});
