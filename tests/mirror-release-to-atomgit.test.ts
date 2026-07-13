import { describe, expect, it, vi } from "vitest";
import {
  buildAtomGitReleasePayload,
  mirrorRelease,
  normalizeUploadUrlPayload,
  parseArgs,
  selectGithubReleases,
} from "../scripts/mirror-release-to-atomgit.mjs";

function githubRelease(tagName: string, prerelease = true) {
  return {
    tag_name: tagName,
    target_commitish: "main",
    name: tagName,
    body: "Release notes",
    draft: false,
    prerelease,
    assets: [
      { name: "latest.yml", size: 120, browser_download_url: "https://example.com/latest.yml" },
      { name: "release-digest.v1.json", size: 240, browser_download_url: "https://example.com/release-digest.v1.json" },
    ],
  };
}

describe("mirror-release-to-atomgit", () => {
  it("defaults manual mirroring to the newest one release", () => {
    expect(parseArgs([], { GITHUB_REPOSITORY: "liliMozi/openhanako" })).toEqual(expect.objectContaining({
      githubOwner: "liliMozi",
      githubRepo: "openhanako",
      atomgitOwner: "liliMozi",
      atomgitRepo: "OpenHanako-Releases",
      selection: "newest",
      latest: 1,
    }));
  });

  it("selects newest published releases from GitHub, including prereleases", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      text: vi.fn().mockResolvedValue(JSON.stringify([
        githubRelease("v0.425.4", true),
        { ...githubRelease("v0.425.3", false), draft: true },
      ])),
    });

    const releases = await selectGithubReleases({
      githubOwner: "liliMozi",
      githubRepo: "openhanako",
      latest: 1,
    }, { env: {}, fetchImpl });

    expect(releases).toHaveLength(1);
    expect(releases[0].tag_name).toBe("v0.425.4");
  });

  it("can select stable releases without prereleases", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      text: vi.fn().mockResolvedValue(JSON.stringify([
        githubRelease("v0.425.4", true),
        githubRelease("v0.425.3", true),
        githubRelease("v0.425.2", false),
      ])),
    });

    const releases = await selectGithubReleases({
      githubOwner: "liliMozi",
      githubRepo: "openhanako",
      selection: "stable",
      latest: 1,
    }, { env: {}, fetchImpl });

    expect(releases).toHaveLength(1);
    expect(releases[0].tag_name).toBe("v0.425.2");
  });

  it("preserves prerelease state in the AtomGit release payload", () => {
    expect(buildAtomGitReleasePayload(githubRelease("v0.425.4", true))).toEqual(expect.objectContaining({
      tag_name: "v0.425.4",
      draft: false,
      prerelease: true,
      release_status: "pre",
    }));
    expect(buildAtomGitReleasePayload(githubRelease("v0.425.3", false))).not.toHaveProperty("release_status");
  });

  it("dry-runs without requiring AtomGit token or uploading assets", async () => {
    const result = await mirrorRelease({ dryRun: true }, githubRelease("v0.425.4"), {
      env: {},
      fetchImpl: vi.fn(),
    });
    expect(result).toEqual({
      tag: "v0.425.4",
      dryRun: true,
      prerelease: true,
      assetNames: ["latest.yml", "release-digest.v1.json"],
    });
  });

  it("uploads assets using the GitCode upload URL contract", async () => {
    const uploadBodies: unknown[] = [];
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const url = String(input);
      const method = init.method || "GET";

      if (url.includes("/releases/v0.425.4/upload_url")) {
        const parsed = new URL(url);
        expect(parsed.searchParams.get("file_name")).toMatch(/latest\.yml|release-digest\.v1\.json/);
        expect(parsed.searchParams.has("file_size")).toBe(false);
        return new Response(JSON.stringify({
          url: `https://upload.example.com/${parsed.searchParams.get("file_name")}`,
          headers: {
            "Content-Type": "application/octet-stream",
            "x-upload-token": "upload-token",
          },
        }), { status: 200 });
      }

      if (url.startsWith("https://upload.example.com/")) {
        expect(method).toBe("PUT");
        uploadBodies.push(init.body);
        expect(init.headers).toEqual(expect.objectContaining({
          "Content-Type": "application/octet-stream",
          "x-upload-token": "upload-token",
        }));
        return new Response("", { status: 200 });
      }

      if (url.startsWith("https://example.com/")) {
        return new Response(`bytes:${pathBasename(url)}`, { status: 200 });
      }

      if (url.includes("/repos/liliMozi/OpenHanako-Releases/releases/v0.425.4")) {
        return new Response("", { status: 404 });
      }

      if (url.includes("/repos/liliMozi/OpenHanako-Releases/releases") && method === "POST") {
        return new Response(JSON.stringify({ tag_name: "v0.425.4" }), { status: 201 });
      }

      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    const result = await mirrorRelease({
      atomgitOwner: "liliMozi",
      atomgitRepo: "OpenHanako-Releases",
      dryRun: false,
    }, githubRelease("v0.425.4"), {
      env: { ATOMGIT_TOKEN: "atomgit-token" },
      fetchImpl,
    });

    expect(result.dryRun).toBe(false);
    expect(uploadBodies).toHaveLength(2);
    expect(uploadBodies.every(body => Buffer.isBuffer(body))).toBe(true);
  });

  it("skips already mirrored assets only after verifying their size", async () => {
    const existingAssets = [
      { name: "latest.yml", type: "attach" },
      { name: "release-digest.v1.json", type: "attach" },
    ];
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const url = String(input);
      const method = init.method || "GET";

      if (url.includes("/attach_files/latest.yml/download") && method === "HEAD") {
        return new Response(null, { status: 200, headers: { "content-length": "120" } });
      }

      if (url.includes("/attach_files/release-digest.v1.json/download") && method === "HEAD") {
        return new Response(null, { status: 200, headers: { "content-length": "240" } });
      }

      if (url.includes("/repos/liliMozi/OpenHanako-Releases/releases/v0.425.4") && method === "GET") {
        return new Response(JSON.stringify({ tag_name: "v0.425.4", assets: existingAssets }), { status: 200 });
      }

      if (url.includes("/repos/liliMozi/OpenHanako-Releases/releases/v0.425.4") && method === "PATCH") {
        expect(JSON.parse(String(init.body))).toEqual(expect.objectContaining({
          release_status: "pre",
        }));
        return new Response(JSON.stringify({ tag_name: "v0.425.4", assets: existingAssets }), { status: 200 });
      }

      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    const result = await mirrorRelease({
      atomgitOwner: "liliMozi",
      atomgitRepo: "OpenHanako-Releases",
      dryRun: false,
    }, githubRelease("v0.425.4"), {
      env: { ATOMGIT_TOKEN: "atomgit-token" },
      fetchImpl,
    });

    expect(result.dryRun).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalledWith(expect.stringContaining("/upload_url"), expect.anything());
  });

  it("normalizes AtomGit upload URL responses from known shapes", () => {
    expect(normalizeUploadUrlPayload({ upload_url: "https://upload.example.com", headers: { "x-token": "a" } })).toEqual({
      uploadUrl: "https://upload.example.com",
      headers: { "x-token": "a" },
    });
    expect(() => normalizeUploadUrlPayload({})).toThrow(/upload URL/);
  });
});

function pathBasename(url: string) {
  return new URL(url).pathname.split("/").pop() || "asset";
}
