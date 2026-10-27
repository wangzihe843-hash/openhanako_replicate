import { afterEach, describe, expect, it, vi } from "vitest";
import { telegramFixture as fixture, telegramOk as ok, telegramPending as pending, stopTelegramFixtures } from "./helpers/telegram-sdk-harness.ts";

afterEach(stopTelegramFixtures);
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

describe("Telegram media through the published SDK and fake transport", () => {
  it.each([
    ["image/png", "image.png", "sendPhoto", "photo"],
    ["video/mp4", "video.mp4", "sendVideo", "video"],
    ["audio/mpeg", "audio.mp3", "sendAudio", "audio"],
    ["text/plain", "note.txt", "sendDocument", "document"],
  ])("uploads %s as InputFile multipart with filename, MIME and topic", async (mime, filename, method, field) => {
    let form: FormData;
    const f = fixture({ [method]: async (_params, init) => {
      form = await new Response(init.body as BodyInit, { headers: init.headers }).formData();
      return ok({ message_id: 1 });
    } });
    await f.adapter.sendMediaBuffer("123", Buffer.from("synthetic bytes"), { mime, filename, replyContext: { messageThreadId: 7 } });
    const file = form!.get(field) as File;
    expect(file.name).toBe(filename);
    expect(file.type).toBe(mime);
    expect(await file.text()).toBe("synthetic bytes");
    expect(form!.get("chat_id")).toBe("123");
    expect(form!.get("message_thread_id")).toBe("7");
  });
  it.each([
    ["https://example.invalid/image.png", "sendPhoto", "photo"],
    ["https://example.invalid/video.mp4", "sendVideo", "video"],
    ["https://example.invalid/audio.mp3", "sendAudio", "audio"],
    ["https://example.invalid/archive.zip", "sendDocument", "document"],
  ])("retains URL routing for %s", async (url, method, field) => {
    const f = fixture();
    await f.adapter.sendMedia("123", url, { messageThreadId: 8 });
    expect(Object.fromEntries(f.calls.find(c => c.method === method)!.params)).toEqual({ chat_id: "123", [field]: url, message_thread_id: "8" });
  });
  it("preserves HTML, block replies, typing topics and long-text chunks", async () => {
    const f = fixture();
    await f.adapter.sendBlockReply("123", "**bold** and `code`", { messageThreadId: 7 });
    await f.adapter.sendReply("123", "x".repeat(9000));
    await f.adapter.sendTypingIndicator("123", { messageThreadId: 7 });
    const sends = f.calls.filter(c => c.method === "sendMessage");
    expect(Object.fromEntries(sends[0].params)).toMatchObject({ text: "<b>bold</b> and <code>code</code>", parse_mode: "HTML", message_thread_id: "7" });
    expect(sends.slice(1).map(c => c.params.get("text")).join("")).toBe("x".repeat(9000));
    expect(sends.slice(1).every(c => c.params.get("text")!.length <= 4096)).toBe(true);
    expect(Object.fromEntries(f.calls.find(c => c.method === "sendChatAction")!.params)).toMatchObject({ action: "typing", message_thread_id: "7" });
  });
  it("hands off Context messages with token-free file refs and bounded avatar data", async () => {
    let polls = 0;
    const f = fixture({
      getUpdates: (_p, init) => ++polls === 1 ? ok([{ update_id: 41, message: {
        message_id: 1, date: 0, text: "hello", chat: { id: 123, type: "supergroup" }, message_thread_id: 7,
        from: { id: 456, first_name: "Ada", last_name: "Lovelace" },
        photo: [{ file_id: "photo", width: 10, height: 20 }],
        document: { file_id: "doc", file_name: "note.txt", mime_type: "text/plain" },
        voice: { file_id: "voice", duration: 2, mime_type: "audio/ogg" },
        video: { file_id: "video", duration: 3, mime_type: "video/mp4" },
      } }]) : pending(init.signal),
      getUserProfilePhotos: () => ok({ total_count: 1, photos: [[{ file_id: "avatar" }]] }),
      getFile: p => ok({ file_id: p.get("file_id"), file_path: `files/${p.get("file_id")}.bin`, file_size: png.length }),
      "avatar.bin": () => new Response(png), "photo.bin": () => new Response(png),
      "doc.bin": () => new Response("note"), "voice.bin": () => new Response("voice"), "video.bin": () => new Response("video"),
    });
    await vi.waitFor(() => expect(f.onMessage).toHaveBeenCalledOnce());
    const message = f.onMessage.mock.calls[0][0];
    expect(message).toMatchObject({ platform: "telegram", chatId: "123", userId: "456", senderName: "Ada Lovelace", messageThreadId: 7, isGroup: true });
    expect(message.sessionKey).toBe(`tg_group_123@${f.options.agentId}`);
    expect(message.avatarUrl).toBe(`data:image/png;base64,${png.toString("base64")}`);
    expect(message.attachments.map(a => [a.type, a.platformRef])).toEqual([["image", "photo"], ["file", "doc"], ["audio", "voice"], ["video", "video"]]);
    expect(JSON.stringify(message)).not.toMatch(/SYNTHETIC_ONLY|api\.telegram|\/bot/);
    expect(message.attachments.every(a => !a.url)).toBe(true);
    expect(await f.adapter.downloadImage("photo")).toEqual(png);
    for (const id of ["doc", "voice", "video"]) expect((await f.adapter.downloadFileByRef(id)).length).toBeGreaterThan(0);
    expect(f.calls.filter(c => c.method === "getFile").map(c => c.params.get("file_id"))).toEqual(["avatar", "photo", "doc", "voice", "video"]);
  });
  it.each(["../secret", "https://evil.invalid/x", "files/../../x", "files/a?x=y", "files/%2e%2e/x", "files/a\\b"])("rejects untrusted getFile path %s without downloading", async file_path => {
    const f = fixture({ getFile: () => ok({ file_path }) });
    await expect(f.adapter.downloadFileByRef("file")).rejects.toThrow("invalid Telegram file path");
    expect(f.calls.every(c => !c.url.includes("/file/bot"))).toBe(true);
  });
  it("enforces declared and streamed download size limits", async () => {
    const f = fixture({ getFile: () => ok({ file_path: "files/a", file_size: 21 * 1024 * 1024 }) });
    await expect(f.adapter.downloadImage("too-large")).rejects.toThrow("budget");
    const g = fixture({ getFile: () => ok({ file_path: "files/a" }), a: () => new Response(new Uint8Array(21 * 1024 * 1024)) });
    await expect(g.adapter.downloadFileByRef("large-body")).rejects.toThrow("budget");
  });
  it("does not add audio-only, channel_post or rich_message inbound support", async () => {
    let polls = 0;
    const f = fixture({ getUpdates: (_p, init) => ++polls === 1 ? ok([
      { update_id: 1, message: { chat: { id: 1, type: "private" }, audio: { file_id: "a" } } },
      { update_id: 2, channel_post: { chat: { id: 1, type: "channel" }, text: "excluded" } },
      { update_id: 3, message: { chat: { id: 1, type: "private" }, rich_message: { markdown: "excluded" } } },
    ]) : pending(init.signal) });
    await vi.waitFor(() => expect(polls).toBe(2));
    expect(f.onMessage).not.toHaveBeenCalled();
  });
});
