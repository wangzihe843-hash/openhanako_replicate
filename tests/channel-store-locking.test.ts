import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addBookmarkEntry,
  addChannelMember,
  appendMessage,
  deleteChannel,
  parseChannel,
  readBookmarks,
  removeChannelMember,
  updateBookmark,
} from "../lib/channels/channel-store.ts";

function mktemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hana-channel-store-"));
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

describe("channel-store write locking", () => {
  let tmpDir;

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      tmpDir = null;
    }
  });

  it("does not recreate a channel when an append queued behind its deletion", async () => {
    tmpDir = mktemp();
    const channelPath = path.join(tmpDir, "crew.md");
    fs.writeFileSync(channelPath, "---\nmembers: [alice, bob]\n---\n");
    const entered = deferred(), release = deferred();
    const unlink = fs.promises.unlink.bind(fs.promises);
    vi.spyOn(fs.promises, "unlink").mockImplementation(async target => {
      if (target === channelPath) { entered.resolve(); await release.promise; }
      return unlink(target);
    });
    const deletion = deleteChannel(channelPath);
    await entered.promise;
    expect(fs.existsSync(channelPath)).toBe(true);
    const appended = appendMessage(channelPath, "alice", "late reply").then(
      () => null, error => error,
    );
    release.resolve();
    await deletion;
    const error = await appended;
    expect(error).toMatchObject({ code: "channel_not_found" });
    expect(fs.existsSync(channelPath)).toBe(false);
  });

  it.each(["member-removal", "cancellation"])("rejects queued writes after %s", async scenario => {
    tmpDir = mktemp();
    const channelPath = path.join(tmpDir, "crew.md");
    fs.writeFileSync(channelPath, "---\nmembers: [alice, bob]\n---\n");
    const entered = deferred(), release = deferred();
    const rename = fs.promises.rename.bind(fs.promises);
    vi.spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
      if (to === channelPath) { entered.resolve(); await release.promise; }
      return rename(from, to);
    });
    const rewrite = scenario === "member-removal"
      ? removeChannelMember(channelPath, "alice")
      : addChannelMember(channelPath, "carol");
    await entered.promise;
    const controller = new AbortController();
    const appended = appendMessage(channelPath, "alice", "forbidden late reply", {
      memberId: "alice", signal: controller.signal,
    }).then(() => null, error => error);
    if (scenario === "cancellation") controller.abort();
    release.resolve();
    await rewrite;
    const error = await appended;
    expect(error).toMatchObject({
      code: scenario === "member-removal" ? "channel_not_member" : "channel_write_cancelled",
    });
    const { messages } = parseChannel(fs.readFileSync(channelPath, "utf8"));
    expect(messages).toEqual([]);
    // A different remaining member can still write after the failed append.
    await appendMessage(channelPath, "bob", "allowed reply", { memberId: "bob" });
    expect(parseChannel(fs.readFileSync(channelPath, "utf8")).messages[0].body).toBe("allowed reply");
  });

  it("preserves appended messages when frontmatter rewrite overlaps", async () => {
    tmpDir = mktemp();
    const channelPath = path.join(tmpDir, "crew.md");
    fs.writeFileSync(
      channelPath,
      [
        "---",
        "members: [alice]",
        "---",
        "",
      ].join("\n"),
      "utf-8",
    );

    const originalWriteFile = fs.promises.writeFile.bind(fs.promises);
    const rewritePaused = deferred();
    const allowRewrite = deferred();
    const tmpPath = channelPath + ".tmp";

    vi.spyOn(fs.promises, "writeFile").mockImplementation(async (target, data, options) => {
      if (target === tmpPath) {
        rewritePaused.resolve();
        await allowRewrite.promise;
      }
      return originalWriteFile(target, data, options);
    });

    const rewritePromise = addChannelMember(channelPath, "bob");
    await rewritePaused.promise;

    const appendPromise = appendMessage(channelPath, "alice", "hello from lock test");

    allowRewrite.resolve();
    await Promise.all([rewritePromise, appendPromise]);

    const content = fs.readFileSync(channelPath, "utf-8");
    const { meta, messages } = parseChannel(content);
    expect(meta.members).toContain("alice");
    expect(meta.members).toContain("bob");
    expect(messages).toHaveLength(1);
    expect(messages[0].body).toBe("hello from lock test");
  });

  it("preserves bookmark updates across concurrent read-modify-write operations", async () => {
    tmpDir = mktemp();
    const bookmarksPath = path.join(tmpDir, "channels.md");
    fs.writeFileSync(
      bookmarksPath,
      [
        "# 频道",
        "",
        "- ch_alpha (last: never)",
        "",
      ].join("\n"),
      "utf-8",
    );

    const originalWriteFile = fs.promises.writeFile.bind(fs.promises);
    const writePaused = deferred();
    const allowWrite = deferred();
    const tmpPath = bookmarksPath + ".tmp";

    vi.spyOn(fs.promises, "writeFile").mockImplementation(async (target, data, options) => {
      if (target === tmpPath) {
        writePaused.resolve();
        await allowWrite.promise;
      }
      return originalWriteFile(target, data, options);
    });

    const updatePromise = updateBookmark(bookmarksPath, "ch_alpha", "2026-04-23 12:34:56");
    await writePaused.promise;

    const addPromise = addBookmarkEntry(bookmarksPath, "ch_beta");

    allowWrite.resolve();
    await Promise.all([updatePromise, addPromise]);

    const bookmarks = readBookmarks(bookmarksPath);
    expect(bookmarks.get("ch_alpha")).toBe("2026-04-23 12:34:56");
    expect(bookmarks.get("ch_beta")).toBe("never");
  });
});
