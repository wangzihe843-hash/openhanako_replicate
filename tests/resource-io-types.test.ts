import { describe, expect, it } from "vitest";
import { normalizeResourceRef, resourceKeyForRef } from "../lib/resource-io/resource-refs.ts";

describe("ResourceIO ResourceRef normalization", () => {
  it("normalizes path aliases to local-file refs", () => {
    expect(normalizeResourceRef({ file_path: "notes/a.md" })).toEqual({
      kind: "local-file",
      path: "notes/a.md",
    });
    expect(normalizeResourceRef({ filePath: "notes/b.md" })).toEqual({
      kind: "local-file",
      path: "notes/b.md",
    });
  });

  it("normalizes explicit session file, mount, resource, and URL refs", () => {
    expect(normalizeResourceRef({ fileId: "sf_123" })).toEqual({
      kind: "session-file",
      fileId: "sf_123",
    });
    expect(normalizeResourceRef({ mountId: "m1", path: "docs/a.md" })).toEqual({
      kind: "mount",
      mountId: "m1",
      path: "docs/a.md",
    });
    expect(normalizeResourceRef({ resourceId: "res_1" })).toEqual({
      kind: "resource",
      resourceId: "res_1",
    });
    expect(normalizeResourceRef({ url: "https://example.com/a.txt" })).toEqual({
      kind: "url",
      url: "https://example.com/a.txt",
    });
  });

  it("creates stable resource keys", () => {
    expect(resourceKeyForRef({ kind: "mount", mountId: "m1", path: "docs/a.md" })).toBe("mount:m1:docs/a.md");
    expect(resourceKeyForRef({ kind: "session-file", fileId: "sf_123" })).toBe("session_file:sf_123");
  });
});
