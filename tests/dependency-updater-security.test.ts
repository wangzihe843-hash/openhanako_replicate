import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

// Resolve from the real updater so a safe unrelated root copy cannot mask its runtime.
const updaterRequire = createRequire(createRequire(import.meta.url).resolve("electron-updater"));
const { HttpExecutor, configureRequestOptionsFromUrl } = updaterRequire("builder-util-runtime");

describe("updater redirect credential boundary", () => {
  it.each(["https://cdn.invalid/file", "https://updates.invalid:8443/file", "http://updates.invalid/file"])("strips credential header variants on redirect to %s", target => {
    const headers = { Authorization: "fake-bearer", "PRIVATE-TOKEN": "fake-token", X_Api_Key: "fake-key", Cookie: "fake-cookie", Accept: "application/octet-stream" };
    const options = configureRequestOptionsFromUrl("https://updates.invalid/release", { headers });
    const redirected = HttpExecutor.prepareRedirectUrlOptions(target, options);
    expect(redirected.headers).toMatchObject({ Accept: "application/octet-stream" });
    for (const header of ["Authorization", "PRIVATE-TOKEN", "X_Api_Key", "Cookie"]) expect(redirected.headers).not.toHaveProperty(header);
  });

  it("retains credentials for a same-origin release redirect", () => {
    const headers = { Authorization: "fake-bearer", "PRIVATE-TOKEN": "fake-token" };
    const options = configureRequestOptionsFromUrl("https://updates.invalid/release", { headers });
    expect(HttpExecutor.prepareRedirectUrlOptions("https://updates.invalid/asset", options).headers).toMatchObject(headers);
  });
});
