import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../lib/pi-sdk/index.ts";
import {
  pruneSessionInlineMediaHistory,
  repairSessionInlineMediaEntriesInFile,
} from "../core/session-inline-media-prune.ts";

const IMG_BLOCK = { type: "image", data: "BASE64DATA", mimeType: "image/png" } as const;
const AUDIO_BLOCK = { type: "audio", data: "BASE64AUDIO", mimeType: "audio/wav" };
const TEXT_BLOCK = (text: string) => ({ type: "text" as const, text });

function sessionHeader() {
  return { type: "session", version: 3, id: "sess-media", timestamp: "2026-06-04T00:00:00.000Z" };
}

function writeJsonl(file, entries) {
  fs.writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf-8");
}

function readJsonl(file) {
  return fs.readFileSync(file, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe("pruneSessionInlineMediaHistory", () => {
  it("does not restore inline media from a context edit when Pi refreshes the live context", () => {
    const manager = SessionManager.inMemory();
    const userId = manager.appendMessage({ role: "user", content: "original", timestamp: Date.now() });
    manager.appendContextEdit(userId, { content: [TEXT_BLOCK("[attached_image: /tmp/a.png]"), IMG_BLOCK] });
    const session = {
      sessionManager: manager,
      agent: { state: { messages: manager.buildSessionContext().messages } },
      refreshContext() { this.agent.state.messages = manager.buildSessionContext().messages; },
    };

    const result = pruneSessionInlineMediaHistory(session);

    expect(result.strippedImages).toBeGreaterThan(0);
    expect(JSON.stringify(session.agent.state.messages)).not.toContain("BASE64DATA");
    expect(JSON.stringify(manager.getBranch())).not.toContain("BASE64DATA");
    expect(manager.buildSessionContext().messages[0]).toMatchObject({
      role: "user", content: [TEXT_BLOCK("[attached_image: /tmp/a.png]")],
    });
  });

  it("从 session JSONL entries 和 agent runtime state 中移除 inline image base64", () => {
    const rewriteFile = vi.fn();
    const manager = {
      fileEntries: [
        { type: "session", id: "session" },
        {
          type: "message",
          id: "u1",
          message: {
            role: "user",
            content: [TEXT_BLOCK("[attached_image: /tmp/a.png]\n看图"), { ...IMG_BLOCK }],
          },
        },
        { type: "message", id: "a1", message: { role: "assistant", content: [TEXT_BLOCK("seen")] } },
      ],
      _rewriteFile: rewriteFile,
    };
    const session = {
      sessionManager: manager,
      agent: {
        state: {
          messages: [
            {
              role: "user",
              content: [TEXT_BLOCK("[attached_image: /tmp/a.png]\n看图"), { ...IMG_BLOCK }],
            },
            { role: "assistant", content: [TEXT_BLOCK("seen")] },
          ],
        },
      },
    };

    const result = pruneSessionInlineMediaHistory(session);

    expect(result.strippedImages).toBe(2);
    expect(manager.fileEntries[1].message.content).toEqual([
      TEXT_BLOCK("[attached_image: /tmp/a.png]\n看图"),
    ]);
    expect(session.agent.state.messages[0].content).toEqual(manager.fileEntries[1].message.content);
    expect(rewriteFile).toHaveBeenCalledTimes(1);
  });

  it("没有 inline media 时不重写 session 文件", () => {
    const rewriteFile = vi.fn();
    const session = {
      sessionManager: {
        fileEntries: [
          { type: "session", id: "session" },
          { type: "message", id: "u1", message: { role: "user", content: [TEXT_BLOCK("hi")] } },
        ],
        _rewriteFile: rewriteFile,
      },
      agent: { state: { messages: [{ role: "user", content: [TEXT_BLOCK("hi")] }] } },
    };

    const result = pruneSessionInlineMediaHistory(session);

    expect(result.stripped).toBe(0);
    expect(rewriteFile).not.toHaveBeenCalled();
  });
});

describe("repairSessionInlineMediaEntriesInFile", () => {
  let tmpDir;
  let sessionPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inline-media-repair-"));
    sessionPath = path.join(tmpDir, "session.jsonl");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("repairs persisted context-edit replacements while preserving omission edits", () => {
    const manager = SessionManager.inMemory();
    const userId = manager.appendMessage({ role: "user", content: "original", timestamp: Date.now() });
    const omittedId = manager.appendMessage({ role: "user", content: "omitted", timestamp: Date.now() });
    manager.appendContextEdit(userId, { content: [TEXT_BLOCK("[attached_image: /tmp/a.png]"), IMG_BLOCK] });
    manager.appendContextEdit(omittedId, null);
    writeJsonl(sessionPath, [sessionHeader(), ...manager.getBranch()]);

    const result = repairSessionInlineMediaEntriesInFile(sessionPath);

    expect(result).toMatchObject({ repaired: true, strippedImages: 1 });
    expect(fs.readFileSync(sessionPath, "utf-8")).not.toContain("BASE64DATA");
    expect(readJsonl(sessionPath).at(-1).replacement).toBeNull();
    expect(SessionManager.open(sessionPath).buildSessionContext().messages[0]).toMatchObject({
      role: "user", content: [TEXT_BLOCK("[attached_image: /tmp/a.png]")],
    });
  });

  it("preserves null JSONL rows while repairing surrounding media", () => {
    writeJsonl(sessionPath, [
      sessionHeader(),
      null,
      { type: "message", id: "u1", message: { role: "user", content: [IMG_BLOCK] } },
    ]);

    expect(repairSessionInlineMediaEntriesInFile(sessionPath))
      .toMatchObject({ repaired: true, strippedImages: 1 });
    expect(readJsonl(sessionPath)[1]).toBeNull();
    expect(fs.readFileSync(sessionPath, "utf-8")).not.toContain("BASE64DATA");
  });

  it("落盘修复 user/toolResult 里的 inline media，只保留轻量引用或占位", () => {
    writeJsonl(sessionPath, [
      sessionHeader(),
      {
        type: "message",
        id: "u1",
        parentId: null,
        message: {
          role: "user",
          content: [TEXT_BLOCK("[attached_audio: /tmp/recording.wav]\n听这个"), { ...AUDIO_BLOCK }],
        },
      },
      {
        type: "message",
        id: "tr1",
        parentId: "u1",
        message: {
          role: "toolResult",
          toolCallId: "call_image",
          toolName: "browser_screenshot",
          content: [TEXT_BLOCK("Screenshot captured"), { ...IMG_BLOCK }],
        },
      },
      {
        type: "message",
        id: "a1",
        parentId: "tr1",
        message: { role: "assistant", content: [TEXT_BLOCK("done")] },
      },
    ]);

    const result = repairSessionInlineMediaEntriesInFile(sessionPath);

    expect(result).toEqual({
      repaired: true,
      stripped: 2,
      strippedImages: 1,
      strippedVideos: 0,
      strippedAudios: 1,
    });
    const raw = fs.readFileSync(sessionPath, "utf-8");
    expect(raw).not.toContain("BASE64DATA");
    expect(raw).not.toContain("BASE64AUDIO");
    const entries = readJsonl(sessionPath);
    expect(entries[1].message.content).toEqual([
      TEXT_BLOCK("[attached_audio: /tmp/recording.wav]\n听这个"),
    ]);
    expect(entries[2].message.content).toEqual([
      TEXT_BLOCK("Screenshot captured"),
      TEXT_BLOCK("[图片已省略：历史图片保留为文件引用，避免重复发送原始 base64]"),
    ]);
  });

  it("没有 inline media 时不改写文件字节", () => {
    const entries = [
      sessionHeader(),
      { type: "message", id: "u1", message: { role: "user", content: [TEXT_BLOCK("hi")] } },
    ];
    writeJsonl(sessionPath, entries);
    const before = fs.readFileSync(sessionPath, "utf-8");

    const result = repairSessionInlineMediaEntriesInFile(sessionPath);

    expect(result.repaired).toBe(false);
    expect(result.stripped).toBe(0);
    expect(fs.readFileSync(sessionPath, "utf-8")).toBe(before);
  });

  it("坏行或非法 header 放弃修复，避免无损 round-trip 风险", () => {
    fs.writeFileSync(
      sessionPath,
      `${JSON.stringify(sessionHeader())}\nnot json\n${JSON.stringify({
        type: "message",
        id: "u1",
        message: { role: "user", content: [IMG_BLOCK] },
      })}\n`,
      "utf-8",
    );
    const before = fs.readFileSync(sessionPath, "utf-8");

    const result = repairSessionInlineMediaEntriesInFile(sessionPath);

    expect(result.repaired).toBe(false);
    expect(result.stripped).toBe(0);
    expect(fs.readFileSync(sessionPath, "utf-8")).toBe(before);
  });
});
