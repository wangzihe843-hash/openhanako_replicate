import fs from "fs";
import os from "os";
import path from "path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";

describe("resources route", () => {
  let tmpDir = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  function makeFile() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-resources-route-"));
    const filePath = path.join(tmpDir, "asset.txt");
    fs.writeFileSync(filePath, "hello resources\n", "utf-8");
    return filePath;
  }

  it("returns resource metadata from the engine resource service", async () => {
    const { createResourcesRoute } = await import("../server/routes/resources.js");
    const app = new Hono();
    app.route("/api", createResourcesRoute({
      getResource: () => ({
        schemaVersion: 1,
        resourceId: "res_sf_route",
        name: "studios/studio_route/resources/res_sf_route",
        studioId: "studio_route",
        type: "file",
        source: "session_file",
        fileId: "sf_route",
        displayName: "route.txt",
        lifecycle: { status: "available", missingAt: null },
        links: {
          self: "/api/resources/res_sf_route",
          content: "/api/resources/res_sf_route/content",
        },
      }),
    }));

    const res = await app.request("/api/resources/res_sf_route");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      resourceId: "res_sf_route",
      name: "studios/studio_route/resources/res_sf_route",
      fileId: "sf_route",
    });
  });

  it("passes request context into the resource service", async () => {
    const { createResourcesRoute } = await import("../server/routes/resources.js");
    let seenContext = null;
    const app = new Hono();
    app.route("/api", createResourcesRoute({
      getRuntimeContext: () => ({
        serverId: "server_ctx",
        userId: "user_ctx",
        studioId: "studio_ctx",
        connectionKind: "local",
        credentialKind: "loopback_token",
        platformAccountId: null,
        officialServiceKind: null,
      }),
      getResource: (_resourceId, options = {}) => {
        seenContext = options.requestContext;
        return {
          schemaVersion: 1,
          resourceId: "res_sf_ctx",
          name: "studios/studio_ctx/resources/res_sf_ctx",
          studioId: "studio_ctx",
          type: "file",
          source: "session_file",
          fileId: "sf_ctx",
          displayName: "ctx.txt",
          lifecycle: { status: "available", missingAt: null },
          links: {
            self: "/api/resources/res_sf_ctx",
            content: "/api/resources/res_sf_ctx/content",
          },
        };
      },
    }));

    const res = await app.request("/api/resources/res_sf_ctx");

    expect(res.status).toBe(200);
    expect(seenContext).toMatchObject({
      serverId: "server_ctx",
      userId: "user_ctx",
      studioId: "studio_ctx",
      connectionKind: "local",
      credentialKind: "loopback_token",
      authPrincipal: {
        kind: "local_user",
        userId: "user_ctx",
        credentialKind: "loopback_token",
      },
    });
    expect(seenContext.request.method).toBe("GET");
  });

  it("fails explicitly when request context cannot be created", async () => {
    const { createResourcesRoute } = await import("../server/routes/resources.js");
    const app = new Hono();
    app.route("/api", createResourcesRoute({
      getRuntimeContext: () => {
        throw new Error("identity context not initialized");
      },
      getResource: () => {
        throw new Error("should not be called");
      },
    }));

    const res = await app.request("/api/resources/res_sf_no_context");

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "resource_error",
      detail: "identity context not initialized",
    });
  });

  it("streams local resource content and supports HEAD metadata", async () => {
    const { createResourcesRoute } = await import("../server/routes/resources.js");
    const filePath = makeFile();
    const app = new Hono();
    app.route("/api", createResourcesRoute({
      resolveResourceContent: () => ({
        resourceId: "res_sf_content",
        filePath,
        mime: "text/plain",
        size: Buffer.byteLength("hello resources\n"),
        filename: "asset.txt",
      }),
    }));

    const head = await app.request("/api/resources/res_sf_content/content", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toContain("text/plain");
    expect(head.headers.get("content-length")).toBe(String(Buffer.byteLength("hello resources\n")));

    const res = await app.request("/api/resources/res_sf_content/content");
    expect(res.status).toBe(200);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(await res.text()).toBe("hello resources\n");
  });

  it("serves local content whose filename contains non-ASCII characters", async () => {
    const { createResourcesRoute } = await import("../server/routes/resources.js");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-resources-route-"));
    const filePath = path.join(tmpDir, "粘贴图片_mp0qkfvq_eb2b8042.png");
    fs.writeFileSync(filePath, "png-bytes", "utf-8");
    const app = new Hono();
    app.route("/api", createResourcesRoute({
      resolveResourceContent: () => ({
        resourceId: "res_sf_cjk",
        filePath,
        mime: "image/png",
        size: Buffer.byteLength("png-bytes"),
        filename: "粘贴图片_mp0qkfvq_eb2b8042.png",
      }),
    }));

    const res = await app.request("/api/resources/res_sf_cjk/content");

    expect(res.status).toBe(200);
    const disposition = res.headers.get("content-disposition") || "";
    expect(disposition).toContain("filename*=UTF-8''");
    expect(disposition).toContain("%E7%B2%98%E8%B4%B4%E5%9B%BE%E7%89%87");
    expect(disposition).not.toMatch(/[^\x00-\x7F]/);
    expect(await res.text()).toBe("png-bytes");
  });

  it("serves a byte range for local resource content", async () => {
    const { createResourcesRoute } = await import("../server/routes/resources.js");
    const filePath = makeFile();
    const app = new Hono();
    app.route("/api", createResourcesRoute({
      resolveResourceContent: () => ({
        resourceId: "res_sf_range",
        filePath,
        mime: "text/plain",
        size: Buffer.byteLength("hello resources\n"),
        filename: "asset.txt",
      }),
    }));

    const res = await app.request("/api/resources/res_sf_range/content", {
      headers: { Range: "bytes=6-14" },
    });

    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 6-14/16");
    expect(await res.text()).toBe("resources");
  });
});
