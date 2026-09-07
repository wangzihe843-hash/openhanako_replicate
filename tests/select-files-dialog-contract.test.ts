import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildSelectFilesDialogOptions } = require("../desktop/src/shared/select-files-dialog.cjs");
const root = process.cwd();

function selectFilesHandlerBody(source: string) {
  const match = source.match(/wrapIpcBestEffortHandler\("select-files",[\s\S]*?\n\}\);/);
  if (!match) throw new Error("select-files handler block not found");
  return match[0];
}

describe("select-files dialog contract", () => {
  it("forwards selection options across the preload IPC bridge", () => {
    const preloadSource = fs.readFileSync(path.join(root, "desktop", "preload.cjs"), "utf-8");
    expect(preloadSource).toContain('selectFiles: (options) => ipcRenderer.invoke("select-files", options)');
  });

  it.each([
    [undefined, ["openFile", "multiSelections"]],
    [{ multiple: true }, ["openFile", "multiSelections"]],
    [{ multiple: false }, ["openFile"]],
  ])("uses the shared Windows-safe dialog options for %j", async (options, expectedProperties) => {
    const mainSource = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf-8");
    let handler: ((event: unknown, options: unknown) => Promise<string[]>) | undefined;
    let dialogOptions: { title: string; properties: string[] } | undefined;
    vm.runInNewContext(selectFilesHandlerBody(mainSource), {
      wrapIpcBestEffortHandler: (_name: string, callback: typeof handler) => { handler = callback; },
      BrowserWindow: { fromWebContents: () => ({}) },
      mainWindow: null,
      dialog: { showOpenDialog: async (_window: unknown, value: typeof dialogOptions) => {
        dialogOptions = value;
        return { canceled: false, filePaths: ["selected.txt"] };
      } },
      buildSelectFilesDialogOptions,
      mt: (_key: string, _args: unknown, fallback: string) => fallback,
    });
    expect(handler).toBeTypeOf("function");
    expect(await handler?.({ sender: {} }, options)).toEqual(["selected.txt"]);
    expect(dialogOptions?.properties).toEqual(expectedProperties);
    expect(dialogOptions?.properties).not.toContain("openDirectory");
    expect(dialogOptions?.title).toBe("Select Files");
  });

  it("uses the default title when the helper receives no options", () => {
    expect(buildSelectFilesDialogOptions().title).toBe("Select Files");
    expect(buildSelectFilesDialogOptions({ title: "Pick Files" }).title).toBe("Pick Files");
  });
});
