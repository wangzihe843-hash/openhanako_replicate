import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Keep the bridge factories synchronous without loading their SDKs at server startup.
export function loadTelegramSdk(): typeof import("node-telegram-bot-api") {
  // v2 exposes named Bot/Api/InputFile through its CJS root export. Avoid the
  // /node entry, whose optional DEBUG sink writes upstream diagnostics raw.
  return require("node-telegram-bot-api");
}

export function loadFeishuSdk(): typeof import("@larksuiteoapi/node-sdk") {
  return require("@larksuiteoapi/node-sdk");
}
