import type { MermaidConfig } from 'mermaid';
import DOMPurify from 'dompurify';

interface MermaidRenderResult {
  svg: string;
  bindFunctions?: (element: Element) => void;
}

interface MermaidApi {
  initialize(config: MermaidConfig): void;
  render(id: string, source: string): Promise<MermaidRenderResult>;
}

type MermaidLoader = () => Promise<MermaidApi>;

const MERMAID_CONFIG: MermaidConfig = {
  startOnLoad: false,
  // Mermaid inserts styles while measuring the diagram, before returning SVG.
  // Isolate that temporary document as well as the final displayed diagram.
  securityLevel: 'sandbox',
  suppressErrorRendering: true,
};

let mermaidPromise: Promise<MermaidApi> | null = null;
let testLoader: MermaidLoader | null = null;
let idSeq = 0;
let renderSeq = 0;

async function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = (async () => {
      const mermaid = testLoader
        ? await testLoader()
        : (await import('mermaid')).default;
      mermaid.initialize(MERMAID_CONFIG);
      return mermaid;
    })();
  }
  return mermaidPromise;
}

function nextMermaidId(): string {
  idSeq += 1;
  return `hana-mermaid-${idSeq}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readSource(diagram: Element): string {
  return diagram.querySelector<HTMLElement>('.mermaid-source code')?.textContent || '';
}

function t(key: string): string {
  return (typeof window !== 'undefined' && typeof window.t === 'function')
    ? window.t(key)
    : key;
}

function ensureSourceToolbar(diagram: HTMLElement, sourceBlock: HTMLElement, source: string): void {
  const existing = diagram.querySelector<HTMLElement>('.mermaid-source-toolbar');
  if (existing?.dataset.source === source) return;
  existing?.remove();
  const toolbar = document.createElement('div');
  toolbar.className = 'mermaid-source-toolbar';
  toolbar.dataset.source = source;

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'mermaid-source-toggle';
  toggle.textContent = t('mermaid.viewSource');
  toggle.setAttribute('aria-expanded', sourceBlock.hasAttribute('hidden') ? 'false' : 'true');
  toggle.addEventListener('click', () => {
    const hidden = sourceBlock.hasAttribute('hidden');
    if (hidden) {
      sourceBlock.removeAttribute('hidden');
      toggle.setAttribute('aria-expanded', 'true');
      toggle.textContent = t('mermaid.hideSource');
    } else {
      sourceBlock.setAttribute('hidden', '');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.textContent = t('mermaid.viewSource');
    }
  });

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'mermaid-source-copy';
  copy.textContent = t('mermaid.copySource');
  copy.addEventListener('click', () => {
    void navigator.clipboard?.writeText?.(source);
  });

  toolbar.append(toggle, copy);
  diagram.insertBefore(toolbar, sourceBlock);
}

function ensureRenderedElement(diagram: Element): HTMLElement {
  const existing = diagram.querySelector<HTMLElement>('.mermaid-rendered');
  if (existing) return existing;

  const rendered = document.createElement('div');
  rendered.className = 'mermaid-rendered';
  diagram.appendChild(rendered);
  return rendered;
}

function hasRenderedSvg(rendered: HTMLElement): boolean {
  return !!rendered.querySelector('.mermaid-svg')?.shadowRoot?.querySelector('svg');
}

function insertSandboxedSvg(rendered: HTMLElement, result: string): HTMLElement {
  // Read Mermaid's sandbox result without ever loading its returned data URL.
  const template = document.createElement('template');
  template.innerHTML = result;
  const frame = template.content.firstElementChild;
  const prefix = 'data:text/html;charset=UTF-8;base64,';
  const src = frame?.getAttribute('src') || '';
  if (template.content.childElementCount !== 1 || frame?.localName !== 'iframe'
      || !frame.hasAttribute('sandbox') || !src.startsWith(prefix)) {
    throw new Error('Mermaid returned an unexpected sandbox result');
  }
  const decoded = new TextDecoder().decode(Uint8Array.from(atob(src.slice(prefix.length)), byte => byte.charCodeAt(0)));
  // Sandbox mode skips Mermaid's final sanitizer. Apply the same SVG policy
  // as its strict mode before bringing the result into the application DOM.
  const fragment = DOMPurify.sanitize(decoded, {
    ADD_TAGS: ['foreignobject'],
    ADD_ATTR: ['dominant-baseline'],
    HTML_INTEGRATION_POINTS: { foreignobject: true },
    RETURN_DOM_FRAGMENT: true,
  });
  const svg = fragment.firstElementChild;
  if (fragment.childElementCount !== 1 || svg?.localName !== 'svg'
      || svg.namespaceURI !== 'http://www.w3.org/2000/svg') {
    throw new Error('Mermaid returned an invalid SVG');
  }

  const host = document.createElement('div');
  host.className = 'mermaid-svg';
  const shadow = host.attachShadow({ mode: 'open' });
  // Existing page selectors cannot cross this boundary. Keep their SVG sizing
  // here; source controls and composed editor events remain in the outer DOM.
  const style = document.createElement('style');
  style.textContent = 'svg { display: block; max-width: 100%; height: auto; margin: 0 auto; }';
  const container = document.createElement('div');
  container.appendChild(svg);
  shadow.append(style, container);
  rendered.replaceChildren(host);
  return container;
}

async function renderMermaidDiagram(diagram: HTMLElement): Promise<void> {
  const source = readSource(diagram);
  const rendered = ensureRenderedElement(diagram);
  const sourceBlock = diagram.querySelector<HTMLElement>('.mermaid-source');
  const status = diagram.dataset.mermaidStatus;

  if (!source.trim()) return;
  if (status === 'loading' && diagram.dataset.mermaidSource === source) {
    return;
  }
  if (status === 'rendered'
      && diagram.dataset.mermaidSource === source
      && hasRenderedSvg(rendered)) {
    if (sourceBlock) ensureSourceToolbar(diagram, sourceBlock, source);
    return;
  }
  if (status === 'error' && diagram.dataset.mermaidSource === source && rendered.textContent) {
    return;
  }

  diagram.dataset.mermaidStatus = 'loading';
  diagram.dataset.mermaidSource = source;
  const currentRenderSeq = String(++renderSeq);
  diagram.dataset.mermaidRenderSeq = currentRenderSeq;
  diagram.classList.remove('is-rendered', 'is-error');
  rendered.textContent = '';

  try {
    const mermaid = await loadMermaid();
    const { svg, bindFunctions } = await mermaid.render(nextMermaidId(), source);
    if (diagram.dataset.mermaidRenderSeq !== currentRenderSeq || readSource(diagram) !== source) return;
    const container = insertSandboxedSvg(rendered, svg);
    bindFunctions?.(container);
    sourceBlock?.setAttribute('hidden', '');
    if (sourceBlock) ensureSourceToolbar(diagram, sourceBlock, source);
    diagram.dataset.mermaidStatus = 'rendered';
    diagram.classList.add('is-rendered');
  } catch (err) {
    if (diagram.dataset.mermaidRenderSeq !== currentRenderSeq || readSource(diagram) !== source) return;
    sourceBlock?.removeAttribute('hidden');
    rendered.textContent = `Mermaid diagram failed to render: ${errorMessage(err)}`;
    diagram.dataset.mermaidStatus = 'error';
    diagram.classList.add('is-error');
  }
}

export async function renderMermaidDiagrams(root: ParentNode | null): Promise<void> {
  if (!root) return;
  const diagrams = Array.from(root.querySelectorAll<HTMLElement>('.mermaid-diagram'));
  await Promise.all(diagrams.map(renderMermaidDiagram));
}

export function __setMermaidLoaderForTests(loader: MermaidLoader | null): void {
  testLoader = loader;
  mermaidPromise = null;
  idSeq = 0;
}
