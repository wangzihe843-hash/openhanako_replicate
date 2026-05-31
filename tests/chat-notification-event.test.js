import { describe, expect, it } from "vitest";

import { toNotificationWsMessage } from "../server/routes/chat.js";

describe("chat route notification messages", () => {
  it("carries the triggering agentId through to the desktop client", () => {
    expect(toNotificationWsMessage({
      type: "notification",
      title: "提醒",
      body: "该喝水了",
      agentId: "hana",
    })).toEqual({
      type: "notification",
      title: "提醒",
      body: "该喝水了",
      agentId: "hana",
    });
  });

  it("normalizes a missing agentId to null instead of dropping the field", () => {
    expect(toNotificationWsMessage({
      type: "notification",
      title: "提醒",
      body: "正文",
    })).toEqual({
      type: "notification",
      title: "提醒",
      body: "正文",
      agentId: null,
    });
  });
});
