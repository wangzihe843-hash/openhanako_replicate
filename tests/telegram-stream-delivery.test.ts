import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeManager } from "../lib/bridge/bridge-manager.ts";
import { telegramFixture as fixture, telegramOk as ok, stopTelegramFixtures } from "./helpers/telegram-sdk-harness.ts";

afterEach(stopTelegramFixtures);
function delivery(adapter) {
  const manager = new BridgeManager({ engine: { hanakoHome: os.tmpdir() }, hub: {} });
  return manager._createStreamDelivery({ adapter, chatId: "123", isGroup: false, platform: "telegram", messageThreadId: 7, replyContext: null });
}
describe("Telegram rich streaming fallback with the actual SDK", () => {
  it.each(["network", "timeout", "parse", "server"])("does not send a second persistent message after an unknown %s final-send result", async failure => {
    const f = fixture({ sendRichMessage: () => {
      if (failure === "network") throw new Error("synthetic connection reset after upload");
      if (failure === "timeout") throw new DOMException("synthetic timeout", "TimeoutError");
      if (failure === "parse") return new Response("broken response");
      return Response.json({ ok: false, error_code: 500, description: "server failed" }, { status: 500 });
    } });
    await expect(delivery(f.adapter).finish("final text")).rejects.toMatchObject({ deliveryUnknown: true });
    expect(f.calls.filter(c => c.method === "sendRichMessage")).toHaveLength(1);
    expect(f.calls.filter(c => c.method === "sendMessage")).toHaveLength(0);
  });
  it.each(["sendRichMessageDraft", "sendRichMessage"])("retains plain fallback after a definite %s rejection", async method => {
    const f = fixture({ [method]: () => Response.json({ ok: false, error_code: 400, description: "rich messages unsupported" }, { status: 400 }) });
    await expect(delivery(f.adapter).finish("final text")).resolves.toEqual([]);
    expect(f.calls.filter(c => c.method === "sendMessage")).toHaveLength(1);
  });
  it("retains normal persistent rich completion", async () => {
    const f = fixture({ sendRichMessage: () => ok({ message_id: 9 }) });
    await delivery(f.adapter).finish("final text");
    expect(f.calls.filter(c => c.method === "sendRichMessage")).toHaveLength(1);
    expect(f.calls.filter(c => c.method === "sendMessage")).toHaveLength(0);
  });
});
