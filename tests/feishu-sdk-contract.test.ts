import { describe, expect, it, vi } from "vitest";
import { Client } from "@larksuiteoapi/node-sdk";

describe("Feishu SDK CardKit payload contract", () => {
  it("unwraps the SDK data envelope into the HTTP request body", async () => {
    const client: any = new Client({ appId: "app-id", appSecret: "app-secret" });
    const request = vi.fn(async () => ({ data: { card_id: "card_1" } }));
    client.httpInstance = { request };

    await client.cardkit.v1.card.create({
      data: {
        type: "card_json",
        data: "{\"schema\":\"2.0\"}",
      },
    });

    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      method: "POST",
      data: {
        type: "card_json",
        data: "{\"schema\":\"2.0\"}",
      },
    }));
  });
});
