import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UniversalMediaManager } from "../core/media/universal-media-manager.ts";
import { BridgeManager } from "../lib/bridge/bridge-manager.ts";
import { execute as generateImage } from "../plugins/media/tools/generate-image.ts";
import { execute as generateVideo } from "../plugins/media/tools/generate-video.ts";

function gate() {
  let release: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release: () => release() };
}

function origin(chatId = "origin-chat", platform = "telegram") {
  return {
    isBridgeSession: true,
    platform,
    chatId,
    agentId: "synthetic-agent",
    sessionKey: `${platform}_dm_${chatId}@synthetic-agent`,
    chatType: "dm",
  };
}

function targetFor(bridge = origin()) {
  const { isBridgeSession: _isBridgeSession, ...fields } = bridge;
  return { kind: "bridge", ...fields };
}

const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
  vi.spyOn(net.Socket.prototype, "connect").mockImplementation(() => {
    throw new Error("real network forbidden in media target regression");
  });
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("real fetch forbidden in media target regression");
  }));
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type HarnessOptions = {
  submit?: (params: unknown) => unknown;
  query?: (task: unknown) => unknown;
  refresh?: () => unknown;
};

function harness(options: HarnessOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-video-target-"));
  const sessionPath = path.join(root, "synthetic-session.jsonl");
  fs.writeFileSync(sessionPath, "{}\n");
  let bound: ReturnType<typeof origin> | null = origin();
  const bridge = new BridgeManager({
    engine: {
      hanakoHome: root,
      getAgent: () => null,
      getBridgeContextForSessionPath: () => null,
      rcState: {
        getAttachedBridgeSessionKey: () => bound?.sessionKey || null,
        getAttachment: () => bound,
      },
    },
    hub: { eventBus: { emit() {} } },
  });
  const replySpies = {
    telegram: vi.fn(async (..._args: unknown[]) => {}),
    qq: vi.fn(async (..._args: unknown[]) => {}),
  };
  for (const platform of ["telegram", "qq"]) {
    bridge._platforms.set(`${platform}:synthetic-agent`, {
      platform, agentId: "synthetic-agent", status: "connected",
      adapter: { stop() {}, sendReply: replySpies[platform] },
    });
  }
  // The actual deferred delivery code chooses the target. Only the final
  // outbound transport is replaced, so these tests never contact a platform.
  const sendMedia = vi.spyOn(bridge, "_sendMediaItem").mockResolvedValue(undefined);
  const registrations = new Map<string, { meta: { deliveryTarget?: unknown }; sessionPath: string }>();
  const handlers = new Map<string, (payload: unknown) => unknown>();
  const events: Array<{ name: string; payload: unknown }> = [];
  const bus = {
    handle(name, handler) {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
    subscribe: () => () => {},
    emit() {},
    async request(name, payload) {
      if (handlers.has(name)) return handlers.get(name)(payload);
      events.push({ name, payload });
      if (name === "deferred:register") registrations.set(payload.taskId, payload);
      if (["deferred:resolve", "deferred:fail", "deferred:abort"].includes(name)) {
        const registration = registrations.get(payload.taskId);
        if (!registration) throw new Error(`missing registration for ${payload.taskId}`);
        return bridge._handleDeferredResultMediaEvent({
          type: "deferred_result",
          taskId: payload.taskId,
          status: name === "deferred:resolve" ? "success" : name === "deferred:abort" ? "aborted" : "failed",
          meta: registration.meta,
          result: payload,
          reason: payload.error || payload.reason,
        }, registration.sessionPath);
      }
      return {};
    },
  };
  let nextTask = 0;
  const adapter = {
    id: "synthetic-media",
    types: ["image", "video"],
    submit: vi.fn(async (params) => {
      await options.submit?.(params);
      return { taskId: `synthetic-${++nextTask}` };
    }),
    query: vi.fn(async (_taskId, ctx) => options.query
      ? options.query(ctx.task)
      : { status: "success", files: [ctx.task.type === "image" ? "image.png" : "video.mp4"] }),
  };
  const makeMedia = () => new UniversalMediaManager({
    hanakoHome: root,
    preferences: {},
    providerRegistry: {
      getMediaProviders: () => [],
      resolveMediaModel() { throw new Error("using synthetic legacy adapter"); },
      refreshRuntimeMediaCapabilities: async () => { await options.refresh?.(); },
    },
    builtinAdapters: [adapter],
    registerSessionFile({ filePath }) {
      const video = path.extname(filePath) === ".mp4";
      return { fileId: path.basename(filePath), filePath, kind: video ? "video" : "image", mime: video ? "video/mp4" : "image/png" };
    },
    logger: { info() {}, warn() {}, error() {}, log() {} },
  });
  let media = makeMedia();
  media.start(bus);
  for (const file of ["image.png", "video.mp4"]) {
    fs.writeFileSync(path.join(media.generatedDir, file), "inert local media fixture");
  }
  cleanups.push(async () => {
    media.dispose();
    await bridge.stopAll();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    get media() { return media; },
    bridge, bus, adapter, registrations, events, sendMedia, replySpies, sessionPath,
    bind(value) { bound = value; },
    async submit(kind = "video", bridgeContext: ReturnType<typeof origin> | null = origin()) {
      const result = await (kind === "image" ? generateImage : generateVideo)({
        provider: adapter.id, prompt: `synthetic ${kind}`,
      }, { bus, pluginId: "media", sessionPath, sessionId: "synthetic-session", bridgeContext });
      const taskId = "details" in result ? result.details?.mediaGeneration?.tasks?.[0]?.taskId : undefined;
      expect(taskId).toBeTypeOf("string");
      // Image submits in the background; allow its adapter ID update to finish.
      for (let i = 0; i < 8; i++) await Promise.resolve();
      return taskId;
    },
    async finish(taskId) { await media.poller.checkNow(taskId); },
    restart() {
      expect(media.store.flushSync()).toBe(true);
      media.dispose();
      registrations.clear();
      media = makeMedia();
      media.start(bus);
    },
  };
}

describe("video task delivery target ownership", () => {
  it.each(["image", "video"])("keeps the submitting %s tool's origin after RC rebind", async (kind) => {
    const h = harness();
    const taskId = await h.submit(kind);
    const expected = targetFor();
    expect(h.media.store.get(taskId).deliveryTarget).toEqual(expected);
    expect(h.registrations.get(taskId).meta.deliveryTarget).toEqual(expected);
    h.bind(origin("replacement-chat", "qq"));
    await h.finish(taskId);
    expect(h.media.store.get(taskId).status).toBe("done");
    expect(h.sendMedia).toHaveBeenCalledExactlyOnceWith(expect.anything(), "origin-chat", expect.anything(), expect.objectContaining({ platform: "telegram" }));
  });

  it("keeps the video origin after RC detach", async () => {
    const h = harness();
    const taskId = await h.submit();
    h.bind(null);
    await h.finish(taskId);
    expect(h.sendMedia).toHaveBeenCalledExactlyOnceWith(expect.anything(), "origin-chat", expect.anything(), expect.objectContaining({ platform: "telegram" }));
  });

  it("does not use a replacement binding when the original platform is unavailable", async () => {
    const h = harness();
    const taskId = await h.submit();
    h.bridge._platforms.delete("telegram:synthetic-agent");
    h.bind(origin("replacement-chat", "qq"));
    await h.finish(taskId);
    expect(h.media.store.get(taskId).status).toBe("done");
    expect(h.sendMedia).not.toHaveBeenCalled();
  });

  it("keeps separate origins for tasks in the same session completed in reverse order", async () => {
    const h = harness();
    const first = await h.submit("video", origin("first-chat"));
    const second = await h.submit("video", origin("second-chat", "qq"));
    h.bind(origin("unrelated-chat", "qq"));
    await h.finish(second);
    await h.finish(first);
    expect(h.sendMedia.mock.calls.map((call) => [call[1], call[3].platform])).toEqual([
      ["second-chat", "qq"], ["first-chat", "telegram"],
    ]);
  });

  it("snapshots bridgeContext before capability refresh awaits", async () => {
    const pending = gate();
    const entered = gate();
    const h = harness({ refresh: async () => { entered.release(); await pending.promise; } });
    const bridgeContext = origin();
    const resultPromise = h.media.generateVideoFromBus({
      sessionPath: h.sessionPath, prompt: "synthetic video", provider: h.adapter.id, bridgeContext,
    });
    await entered.promise;
    Object.assign(bridgeContext, origin("mutated-chat", "qq"));
    h.bind(origin("replacement-chat", "qq"));
    pending.release();
    const result = await resultPromise;
    const taskId = result.tasks[0].taskId;
    expect(h.media.store.get(taskId).deliveryTarget).toEqual(targetFor());
    await h.finish(taskId);
    expect(h.sendMedia.mock.calls[0]?.[1]).toBe("origin-chat");
  });

  it.each(["refresh", "submit"])("snapshots explicit group/thread targets before %s awaits", async (phase) => {
    const pending = gate();
    const entered = gate();
    const h = harness({ [phase]: async () => { entered.release(); await pending.promise; } });
    const deliveryTarget = {
      ...targetFor(origin("explicit-group")),
      chatType: "group",
      messageThreadId: 42,
      messageId: "origin-message",
      replyContext: { messageThreadId: 42, targetType: "group", messageId: "origin-message" },
    };
    const expected = structuredClone(deliveryTarget);
    const resultPromise = h.media.generateVideoFromBus({
      sessionPath: h.sessionPath, input: { prompt: "synthetic video", provider: h.adapter.id },
      bridgeContext: origin(), deliveryTarget,
    });
    await entered.promise;
    deliveryTarget.chatId = "mutated-group";
    deliveryTarget.replyContext.messageThreadId = 99;
    h.bind(origin("replacement-chat", "qq"));
    pending.release();
    const taskId = (await resultPromise).tasks[0].taskId;
    expect(h.media.store.get(taskId).deliveryTarget).toEqual(expected);
    expect(h.registrations.get(taskId).meta.deliveryTarget).toEqual(expected);
    await h.finish(taskId);
    expect(h.sendMedia).toHaveBeenCalledExactlyOnceWith(expect.anything(), "explicit-group", expect.anything(), expect.objectContaining({
      platform: "telegram", isGroup: true,
      replyContext: expect.objectContaining({ messageThreadId: 42, messageId: "origin-message" }),
    }));
  });

  it("re-registers a persisted video with the same origin after manager recreation", async () => {
    const h = harness();
    const taskId = await h.submit();
    h.bind(origin("replacement-chat", "qq"));
    h.restart();
    expect(h.media.store.get(taskId).deliveryTarget).toEqual(targetFor());
    expect(h.registrations.get(taskId).meta.deliveryTarget).toEqual(targetFor());
    await h.finish(taskId);
    expect(h.sendMedia.mock.calls[0]?.[1]).toBe("origin-chat");
  });

  it("does not register or send response delivery despite supplied bridge targets", async () => {
    const h = harness();
    const result = await h.media.generateVideoFromBus({
      prompt: "response video", provider: h.adapter.id,
      delivery: { mode: "response" }, bridgeContext: origin(), deliveryTarget: targetFor(),
    });
    const taskId = result.tasks[0].taskId;
    expect(h.media.store.get(taskId).deliveryTarget).toBeNull();
    expect(h.registrations.has(taskId)).toBe(false);
    await h.finish(taskId);
    expect(h.media.store.get(taskId).status).toBe("done");
    expect(h.sendMedia).not.toHaveBeenCalled();
  });

  it.each(["missing", "not-bridge", "explicit-null", "legacy"])("preserves existing fallback for a %s origin", async (mode) => {
    const h = harness();
    let taskId;
    if (mode === "legacy") {
      taskId = "historic-video";
      h.media.store.add({ taskId, adapterId: h.adapter.id, batchId: "legacy", type: "video", prompt: "legacy", params: {}, sessionPath: h.sessionPath });
      h.restart();
    } else {
      const result = await h.media.generateVideoFromBus({
        sessionPath: h.sessionPath, prompt: "synthetic video", provider: h.adapter.id,
        ...(mode === "not-bridge" ? { bridgeContext: { ...origin(), isBridgeSession: false } } : {}),
        ...(mode === "explicit-null" ? { bridgeContext: origin(), deliveryTarget: null } : {}),
      });
      taskId = result.tasks[0].taskId;
    }
    expect(h.media.store.get(taskId).deliveryTarget).toBeNull();
    expect(h.registrations.get(taskId).meta.deliveryTarget).toBeUndefined();
    h.bind(origin("replacement-chat", "qq"));
    await h.finish(taskId);
    expect(h.sendMedia).toHaveBeenCalledExactlyOnceWith(expect.anything(), "replacement-chat", expect.anything(), expect.objectContaining({ platform: "qq" }));
  });

  it("does not invent a bridge destination for an unattached local task", async () => {
    const h = harness();
    const taskId = await h.submit("video", null);
    h.bind(null);
    await h.finish(taskId);
    expect(h.media.store.get(taskId).status).toBe("done");
    expect(h.sendMedia).not.toHaveBeenCalled();
  });

  it("does not register or deliver when provider submission rejects", async () => {
    const h = harness({ submit() { throw new Error("synthetic submission failure"); } });
    await expect(h.media.generateVideoFromBus({
      sessionPath: h.sessionPath, prompt: "synthetic video", provider: h.adapter.id, bridgeContext: origin(),
    })).rejects.toThrow("synthetic submission failure");
    h.bind(origin("replacement-chat", "qq"));
    expect(h.registrations.size).toBe(0);
    expect(h.media.store.listAll()).toEqual([]);
    expect(h.sendMedia).not.toHaveBeenCalled();
    expect(h.replySpies.telegram).not.toHaveBeenCalled();
    expect(h.replySpies.qq).not.toHaveBeenCalled();
  });

  it("does not deliver media after generation fails", async () => {
    const h = harness({ query: () => ({ status: "failed", failReason: "synthetic generation failure" }) });
    const taskId = await h.submit();
    h.bind(origin("replacement-chat", "qq"));
    await h.finish(taskId);
    expect(h.media.store.get(taskId).status).toBe("failed");
    expect(h.sendMedia).not.toHaveBeenCalled();
    expect(h.replySpies.telegram).toHaveBeenCalledOnce();
    expect(h.replySpies.telegram.mock.calls[0][0]).toBe("origin-chat");
    expect(h.replySpies.qq).not.toHaveBeenCalled();
  });

  it("ignores an in-flight successful query after cancellation and rebind", async () => {
    const pending = gate();
    const entered = gate();
    const h = harness({ query: async () => {
      entered.release();
      await pending.promise;
      return { status: "success", files: ["video.mp4"] };
    } });
    const taskId = await h.submit();
    const finishing = h.finish(taskId);
    await entered.promise;
    h.media.poller.cancel(taskId);
    h.bind(origin("replacement-chat", "qq"));
    pending.release();
    await finishing;
    expect(h.media.store.get(taskId).status).toBe("cancelled");
    expect(h.sendMedia).not.toHaveBeenCalled();
    expect(h.events.some((event) => event.name === "deferred:resolve")).toBe(false);
    expect(h.replySpies.telegram).toHaveBeenCalledOnce();
    expect(h.replySpies.telegram.mock.calls[0][0]).toBe("origin-chat");
    expect(h.replySpies.qq).not.toHaveBeenCalled();
  });

  it.each(["failed", "cancelled"])("does not redirect a %s notice when the original platform is unavailable", async (status) => {
    const h = harness({ query: () => ({ status: "failed", failReason: "synthetic generation failure" }) });
    const taskId = await h.submit();
    h.bridge._platforms.delete("telegram:synthetic-agent");
    h.bind(origin("replacement-chat", "qq"));
    if (status === "failed") {
      await h.finish(taskId);
    } else {
      h.media.poller.cancel(taskId);
      // Cancellation schedules the real deferred event without awaiting it.
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(h.media.store.get(taskId).status).toBe(status);
    expect(h.sendMedia).not.toHaveBeenCalled();
    expect(h.replySpies.telegram).not.toHaveBeenCalled();
    expect(h.replySpies.qq).not.toHaveBeenCalled();
  });
});
