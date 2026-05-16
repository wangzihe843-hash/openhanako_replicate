import fs from "fs";
import os from "os";
import path from "path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hana-mobile-static-"));
}

describe("mobile static route", () => {
  let tmpDir = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("serves the mobile renderer entry from /mobile without allowing traversal", async () => {
    tmpDir = makeTmpDir();
    fs.mkdirSync(path.join(tmpDir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "mobile.html"), "<!doctype html><title>Mobile</title>", "utf-8");
    fs.writeFileSync(path.join(tmpDir, "assets", "mobile.js"), "console.log('mobile')", "utf-8");
    const { createMobileStaticRoute } = await import("../server/routes/mobile-static.js");
    const app = new Hono();
    app.route("", createMobileStaticRoute({ distDir: tmpDir }));

    const entry = await app.request("/mobile/");
    expect(entry.status).toBe(200);
    expect(entry.headers.get("content-type")).toContain("text/html");
    expect(await entry.text()).toContain("<title>Mobile</title>");

    const asset = await app.request("/mobile/assets/mobile.js");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("text/javascript");

    const traversal = await app.request("/mobile/assets/../mobile.html");
    expect(traversal.status).toBe(404);
  });
});
