import fs from "fs";
import os from "os";
import path from "path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { downloadMedia, resolveAllowedLocalPath, setMediaLocalRoots } from "../lib/bridge/media-utils.ts";
import { canonicalFilesystemPathSync } from "../shared/link-aware-fs.ts";

describe("bridge local media URLs", () => {
  const tempRoot = os.tmpdir();
  let fixture: string;
  let allowedRoot: string;

  beforeEach(() => {
    fixture = fs.mkdtempSync(path.join(tempRoot, "hana-media-url-"));
    allowedRoot = path.join(fixture, "allowed");
    fs.mkdirSync(allowedRoot);
    setMediaLocalRoots([allowedRoot]);
  });

  afterEach(() => {
    setMediaLocalRoots([]);
    const resolved = path.resolve(fixture);
    if (path.dirname(resolved) !== path.resolve(tempRoot)
      || !path.basename(resolved).startsWith("hana-media-url-")) {
      throw new Error("Refusing to remove an unowned bridge media fixture");
    }
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3 });
  });

  it.each(["photo with spaces.png", "角色图片.png", "photo#100%25.png"])("reads an encoded file URL for %s", async (name) => {
    const filePath = path.join(allowedRoot, name);
    const contents = Buffer.from("synthetic media fixture");
    fs.writeFileSync(filePath, contents);
    const url = pathToFileURL(filePath).href;

    expect(resolveAllowedLocalPath(url)).toBe(canonicalFilesystemPathSync(filePath));
    await expect(downloadMedia(url)).resolves.toEqual(contents);
  });

  it("applies allowed-root checks after decoding the URL", async () => {
    const filePath = path.join(fixture, "outside 角色.png");
    fs.writeFileSync(filePath, "synthetic media fixture");
    const url = pathToFileURL(filePath).href;

    expect(() => resolveAllowedLocalPath(url)).toThrow("path outside allowed roots");
    await expect(downloadMedia(url)).rejects.toThrow("path outside allowed roots");
  });
});
