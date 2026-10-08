// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import createDOMPurify from "dompurify";
import { renderMermaidDiagrams } from "../desktop/src/react/utils/mermaid-renderer.ts";

// jsdom has no layout engine. Only geometry is supplied; parser, sanitizer,
// configuration handling and application rendering all use the real packages.
beforeAll(() => {
  function supplyGeometry(prototype: SVGElement) {
    Object.defineProperty(prototype, "getBBox", { configurable: true, value: () => ({ x: 0, y: 0, width: 100, height: 20 }) });
    Object.defineProperty(prototype, "getComputedTextLength", { configurable: true, value: () => 100 });
  }
  supplyGeometry(SVGElement.prototype);
  const getter = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "contentDocument")!.get!;
  vi.spyOn(HTMLIFrameElement.prototype, "contentDocument", "get").mockImplementation(function (this: HTMLIFrameElement) {
    const doc = getter.call(this) as Document | null;
    // Sandboxed measurements use a separate jsdom realm with its own prototypes.
    const view = doc?.defaultView as (Window & typeof globalThis) | null;
    if (view) supplyGeometry(view.SVGElement.prototype);
    return doc;
  });
});
afterAll(() => { vi.restoreAllMocks(); });
afterEach(() => { document.body.replaceChildren(); });

async function render(source: string) {
  const diagram = document.createElement("div");
  diagram.className = "mermaid-diagram";
  const pre = document.createElement("pre");
  pre.className = "mermaid-source";
  const code = pre.appendChild(document.createElement("code"));
  code.textContent = source;
  diagram.appendChild(pre);
  document.body.appendChild(diagram);
  await renderMermaidDiagrams(document.body);
  expect(diagram.dataset.mermaidStatus, diagram.textContent || "").toBe("rendered");
  const svg = diagram.querySelector(".mermaid-svg")?.shadowRoot?.querySelector("svg");
  expect(svg).not.toBeNull();
  return svg!;
}

describe("real Mermaid and DOMPurify integration", () => {
  it.each([
    "flowchart LR\nA[Start] --> B[Done]",
    "stateDiagram-v2\n[*] --> Ready\nReady --> Done",
    "gantt\ndateFormat YYYY-MM-DD\nsection Local\nTask :a1, 2026-10-01, 2d",
  ])("renders a legitimate diagram: %s", async source => { await render(source); });

  it("does not emit CSS selectors escaping the diagram scope from init configuration", async () => {
    const svg = await render('%%{init: {"fontFamily": "x;a{b} :not(&){outline:123px solid red} c{d}"}}%%\nflowchart LR\nA-->B');
    // The upstream fix scopes CSS, including custom declarations, to the SVG.
    // Assert that the attack's emitted selectors cannot select sibling content.
    const sibling = document.body.appendChild(document.createElement("aside"));
    const style = document.createElement("style");
    style.textContent = svg.querySelector("style")?.textContent || "";
    document.head.appendChild(style);
    try {
      const rules = Array.from(style.sheet!.cssRules).filter((rule): rule is CSSStyleRule => "selectorText" in rule);
      const attackRules = rules.filter(rule => rule.cssText.includes("123px"));
      expect(attackRules.length).toBeGreaterThan(0);
      for (const rule of attackRules) {
        expect(rule.selectorText.startsWith(`#${svg.id} `)).toBe(true);
        expect(sibling.matches(rule.selectorText)).toBe(false);
        expect(document.body.matches(rule.selectorText)).toBe(false);
      }
    } finally { style.remove(); }
  });

  it("removes event handlers and executable links while retaining ordinary SVG", () => {
    const purify = createDOMPurify(window);
    const clean = purify.sanitize('<svg><g onload="void 0"><text>Safe</text><a href="javascript:void(0)">bad</a></g></svg>');
    const container = document.createElement("div"); container.innerHTML = clean;
    expect(container.querySelector("text")?.textContent).toBe("Safe");
    expect(container.querySelector("[onload], [href^='javascript:']")).toBeNull();
  });
});
