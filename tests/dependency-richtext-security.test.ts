// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { Editor, mergeAttributes } from "@tiptap/core";
import { DOMSerializer, Schema, type Slice } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";
import { createInputEditorExtensions } from "../desktop/src/react/components/input/input-editor-extensions.ts";

afterEach(() => { document.body.replaceChildren(); });

describe("rich text dependency security", () => {
  it("does not turn JSON prototype keys into executable inherited DOM attributes", () => {
    const attrs = mergeAttributes(JSON.parse('{"__proto__":{"onerror":"void 0","data-inherited-canary":"present"}}'), { class: "file-badge" });
    expect(Object.getPrototypeOf(attrs)).toBe(Object.prototype);
    const { dom } = DOMSerializer.renderSpec(document, ["span", attrs]);
    expect((dom as Element).hasAttribute("onerror")).toBe(false);
    expect((dom as Element).hasAttribute("data-inherited-canary")).toBe(false);
    expect((dom as Element).getAttribute("class")).toBe("file-badge");
  });

  it.each([{ value: {} }, { value: ["img", { onerror: "void 0" }] }])("validates clipboard slice context attributes ($value)", ({ value }) => {
    const schema = new Schema({ nodes: {
      doc: { content: "block+" }, text: { group: "inline" },
      paragraph: { content: "inline*", group: "block", toDOM: () => ["p", 0], parseDOM: [{ tag: "p" }] },
      quote: { content: "block+", group: "block", attrs: { label: { default: "safe", validate: "string" } }, toDOM: node => ["blockquote", { "data-label": node.attrs.label }, 0] },
    } });
    let pasted: Slice | undefined;
    const view = new EditorView(document.body, { state: EditorState.create({ schema }), handlePaste: (_view, _event, slice) => { pasted = slice; return true; } });
    const paste = (label: unknown) => {
      const p = document.createElement("p");
      p.textContent = "clipboard text";
      p.setAttribute("data-pm-slice", `0 0 ${JSON.stringify(["quote", { label }])}`);
      expect(view.pasteHTML(p.outerHTML, new Event("paste") as ClipboardEvent)).toBe(true);
      return pasted!;
    };
    try {
      const valid = paste("allowed");
      expect(valid.content.firstChild?.type.name).toBe("quote");
      expect(valid.content.firstChild?.attrs.label).toBe("allowed");
      const invalid = paste(value);
      expect(invalid.content.firstChild?.type.name).toBe("paragraph");
      expect(invalid.content.textBetween(0, invalid.content.size)).toBe("clipboard text");
    } finally { view.destroy(); }
  });

  it("preserves normal rich-text paste with the application's actual extensions", () => {
    const editor = new Editor({ element: document.body.appendChild(document.createElement("div")), extensions: createInputEditorExtensions("") });
    try {
      expect(editor.view.pasteHTML("<p><strong>Bold</strong> and <em>italic</em></p><ul><li><p>Item</p></li></ul>", new Event("paste") as ClipboardEvent)).toBe(true);
      expect(editor.getHTML()).toContain("<strong>Bold</strong>");
      expect(editor.getHTML()).toContain("<em>italic</em>");
      expect(editor.getHTML()).toContain("<li><p>Item</p></li>");
    } finally { editor.destroy(); }
  });
});
