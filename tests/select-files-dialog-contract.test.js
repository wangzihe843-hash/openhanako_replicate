import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildSelectFilesDialogOptions } = require("../desktop/src/shared/select-files-dialog.cjs");

const root = process.cwd();

function selectFilesHandlerBody(source) {
  const match = source.match(/wrapIpcBestEffortHandler\("select-files",[\s\S]*?\n\}\);/);
  if (!match) throw new Error("select-files handler block not found");
  return match[0];
}

describe("select-files dialog contract", () => {
  it("delegates dialog options to buildSelectFilesDialogOptions (no inline openDirectory leak)", () => {
    const mainSource = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf-8");
    const handlerBody = selectFilesHandlerBody(mainSource);

    expect(handlerBody).toContain("buildSelectFilesDialogOptions");
    // 防御性回归:即便有人未来又在 handler 里手写 properties,也不许悄悄加 openDirectory。
    expect(handlerBody).not.toContain("openDirectory");
  });

  it("buildSelectFilesDialogOptions returns a Windows-safe dialog spec", () => {
    const opts = buildSelectFilesDialogOptions({ title: "Pick Files" });
    expect(opts.properties).toContain("openFile");
    expect(opts.properties).toContain("multiSelections");
    expect(opts.properties).not.toContain("openDirectory");
    expect(opts.title).toBe("Pick Files");
  });

  it("buildSelectFilesDialogOptions falls back to a default title", () => {
    const opts = buildSelectFilesDialogOptions();
    expect(opts.title).toBe("Select Files");
  });
});
