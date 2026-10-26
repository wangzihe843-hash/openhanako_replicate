import { afterEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { uploadQQLocalFile, QQApiError, QQ_UPLOAD_SIZE_LIMITS } from "../lib/bridge/qq-local-upload.ts";
import { createBridgeOutboundHttp } from "../lib/bridge/outbound-http.ts";
import { bridgeHttpLoopback } from "./fixtures/bridge-http-loopback.ts";

const digest = (kind: string, bytes: Buffer) => crypto.createHash(kind).update(bytes).digest("hex");
type UploadOptions = Parameters<typeof uploadQQLocalFile>[0];
const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(bytes: Buffer = Buffer.from([0, 255, 1, 128, 13, 10, 2, 3, 254])) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qq-upload-contract-"));
  roots.push(root);
  const filePath = path.join(root, "synthetic.bin");
  await fs.writeFile(filePath, bytes);
  return { filePath, bytes };
}

function prepare(size: number, block = 4, origin = "https://storage.invalid") {
  return {
    upload_id: "synthetic-upload", block_size: String(block),
    parts: Array.from({ length: Math.ceil(size / block) }, (_, index) => ({
      index, block_size: String(Math.min(block, size - index * block)),
      presigned_url: `${origin}/put-${index}`,
    })),
    upload_config: { concurrency: 1, retry_timeout: 300, retry_delay: 1 },
  };
}

async function harness(bytes?: Buffer, block = 4) {
  const file = await fixture(bytes);
  const response = prepare(file.bytes.length, block);
  const api = vi.fn<UploadOptions["apiRequest"]>(async (_method, endpoint) => {
    if (endpoint.endsWith("/upload_prepare")) return response;
    return endpoint.endsWith("/files") ? { file_info: "synthetic-info", file_uuid: "synthetic-uuid", ttl: 300 } : {};
  });
  const put = vi.fn<UploadOptions["outboundHttp"]["request"]>(async () => new Response(""));
  const run = (extra: Partial<UploadOptions> = {}) => uploadQQLocalFile({
    apiRequest: api, outboundHttp: { request: put }, chatId: "synthetic-user",
    filePath: file.filePath, fileType: 4, metadata: { isGroup: false }, ...extra,
  });
  return { ...file, response, api, put, run };
}

describe("QQ current chunk upload protocol", () => {
  it.each([1, 4, 8, 9])("uploads %i binary bytes through real local PUT/finish/merge services", async size => {
    const { filePath, bytes } = await fixture(Buffer.from(Array.from({ length: size }, (_, i) => (i * 131) % 256)));
    const loop = await bridgeHttpLoopback();
    const response = prepare(size, 4, loop.source);
    // Input order need not be sorted: index, never array position, owns the offset.
    response.parts.reverse();
    loop.respond((req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(req.path.endsWith("/upload_prepare") ? response
        : req.path.endsWith("/files") ? { file_uuid: "synthetic-uuid", file_info: "synthetic-info", ttl: 300 } : {}));
    });
    const http = createBridgeOutboundHttp({ platform: "qq", resolveDispatcher: () => ({ dispatcher: loop.agent, proxyUrl: "" }) });
    try {
      const result = await uploadQQLocalFile({
        apiRequest: async (method, endpoint, body, opts) => {
          const res = await http.request({ ...opts, method, url: loop.source + endpoint, body: JSON.stringify(body) });
          return res.json();
        },
        outboundHttp: { request: options => {
          expect(new URL(options.url).origin).toBe(loop.source);
          return http.request(options);
        } },
        chatId: "synthetic-user", filePath, fileType: 4, metadata: { isGroup: false, filename: "fixture.bin" },
      });
      expect(result.file_info).toBe("synthetic-info");
      const requests = loop.sourceRequests;
      expect(JSON.parse(requests[0].body)).toEqual({
        file_type: 4, file_name: "fixture.bin", file_size: String(size),
        md5: digest("md5", bytes), sha1: digest("sha1", bytes), md5_10m: digest("md5", bytes),
      });
      for (const part of response.parts) {
        const expected = bytes.subarray(part.index * 4, Math.min((part.index + 1) * 4, size));
        const put = requests.find(req => req.path === `/put-${part.index}`);
        // The loopback recorder retains raw bytes separately from its text body.
        expect(put.method).toBe("PUT");
        expect(put.bodyBytes).toEqual(expected);
        expect(put.headers["content-length"]).toBe(String(expected.length));
        const finish = requests.filter(req => req.path.endsWith("/upload_part_finish"))
          .map(req => JSON.parse(req.body)).find(body => body.part_index === part.index);
        expect(finish).toEqual({ upload_id: "synthetic-upload", part_index: part.index, block_size: String(expected.length), md5: digest("md5", expected) });
      }
      expect(JSON.parse(requests.at(-1).body)).toEqual({ upload_id: "synthetic-upload", file_type: 4, file_name: "fixture.bin", srv_send_msg: false });
      expect(requests.filter(req => req.path.endsWith("/files"))).toHaveLength(1);
    } finally { await loop.close(); }
  });
});

describe("QQ upload validation and bounded failure", () => {
  it.each([
    ["negative index", r => { r.parts[0].index = -1; }],
    ["one-based indices", r => { r.parts.forEach(p => p.index++); }],
    ["fractional index", r => { r.parts[0].index = 0.5; }],
    ["string index", r => { r.parts[0].index = "0" as never; }],
    ["duplicate index", r => { r.parts[1].index = 0; }],
    ["missing part", r => { r.parts.pop(); }],
    ["extra part", r => { r.parts.push(r.parts[0]); }],
    ["missing parts", r => { delete r.parts; }],
    ["zero block", r => { r.block_size = "0"; }],
    ["fractional block", r => { r.block_size = "4.5"; }],
    ["numeric block", r => { r.block_size = 4 as never; }],
    ["unsafe block", r => { r.block_size = "9007199254740992"; }],
    ["incorrect tail size", r => { r.parts[2].block_size = "4"; }],
    ["missing per-part size", r => { delete r.parts[1].block_size; }],
    ["missing upload ID", r => { r.upload_id = ""; }],
    ["invalid later URL", r => { r.parts[2].presigned_url = "not a URL"; }],
    ["plaintext URL", r => { r.parts[2].presigned_url = "http://storage.invalid/part"; }],
    ["URL credentials", r => { r.parts[2].presigned_url = "https://user:secret@storage.invalid/part"; }],
    ["config array", r => { r.upload_config = [] as never; }],
    ["config null", r => { r.upload_config = null; }],
    ["fractional concurrency", r => { r.upload_config.concurrency = 1.5; }],
    ["negative concurrency", r => { r.upload_config.concurrency = -1; }],
    ["string timeout", r => { r.upload_config.retry_timeout = "1" as never; }],
    ["zero delay", r => { r.upload_config.retry_delay = 0; }],
  ] as Array<[string, (response: ReturnType<typeof prepare>) => void]>)("rejects %s before any PUT", async (_name, mutate) => {
    const h = await harness();
    mutate(h.response);
    await expect(h.run()).rejects.toThrow(/upload_prepare/);
    expect(h.put).not.toHaveBeenCalled();
    expect(h.api).toHaveBeenCalledTimes(1);
  });

  it.each([10_002_431, 10_002_432, 10_002_433])("hashes exactly the first 10,002,432 bytes for size %i", async size => {
    const bytes = Buffer.alloc(size, 0x80);
    bytes[size - 1] = 0xff;
    const h = await harness(bytes, 6_000_000);
    await h.run();
    expect(h.api.mock.calls[0][2]).toMatchObject({
      file_size: String(size), md5: digest("md5", bytes), sha1: digest("sha1", bytes),
      md5_10m: digest("md5", bytes.subarray(0, 10_002_432)),
    });
  });

  it.each([1, 2, 3, 4])("keeps the existing type %i capacity boundary", async fileType => {
    const h = await harness();
    const max = QQ_UPLOAD_SIZE_LIMITS[fileType];
    // Sparse, synthetic on-disk fixtures; never read user files.
    const handle = await fs.open(h.filePath, "r+");
    try { await handle.truncate(max + 1); } finally { await handle.close(); }
    await expect(h.run({ fileType })).rejects.toThrow(/超过/);
    expect(h.api).not.toHaveBeenCalled();
    for (const size of [max - 1, max]) {
      await fs.truncate(h.filePath, size);
      h.api.mockRejectedValueOnce(new Error("synthetic prepare sentinel"));
      await expect(h.run({ fileType })).rejects.toThrow("synthetic prepare sentinel");
      expect(h.api.mock.calls.at(-1)[2].file_size).toBe(String(size));
    }
    expect(h.put).not.toHaveBeenCalled();
  });

  it.each(["empty", "directory", "missing", "invalid-type", "group-file"])("rejects %s without network", async kind => {
    const h = await harness();
    const extra: Partial<UploadOptions> = {};
    if (kind === "empty") await fs.truncate(h.filePath, 0);
    if (kind === "directory") extra.filePath = path.dirname(h.filePath);
    if (kind === "missing") extra.filePath = path.join(path.dirname(h.filePath), "absent");
    if (kind === "invalid-type") extra.fileType = "4" as never;
    if (kind === "group-file") extra.metadata = { isGroup: true };
    await expect(h.run(extra)).rejects.toThrow();
    expect(h.api).not.toHaveBeenCalled();
    expect(h.put).not.toHaveBeenCalled();
  });

  it("normalizes the filename once for prepare and merge", async () => {
    const h = await harness();
    await h.run({ metadata: { isGroup: false, filename: "../note\u0000.txt" } });
    expect(h.api.mock.calls[0][2].file_name).toBe("note_.txt");
    expect(h.api.mock.calls.at(-1)[2].file_name).toBe("note_.txt");
  });

  it.each(["prepare", "finish", "merge"])("does not retry a business error at %s or expose its message", async stage => {
    const h = await harness();
    const normal = h.api.getMockImplementation();
    h.api.mockImplementation(async (...args) => args[1].endsWith(stage === "prepare" ? "/upload_prepare" : stage === "finish" ? "/upload_part_finish" : "/files")
      ? { code: 850031, message: "SYNTHETIC_SECRET https://storage.invalid/?signature=SYNTHETIC_SIGNATURE" }
      : normal(...args));
    const error = await h.run({ metadata: {} }).catch(e => e);
    expect(error).toBeInstanceOf(QQApiError);
    expect(error.bizCode).toBe(850031);
    expect(error.message).not.toMatch(/SYNTHETIC|signature/);
    expect(h.api.mock.calls.filter(args => args[1].endsWith(stage === "prepare" ? "/upload_prepare" : stage === "finish" ? "/upload_part_finish" : "/files"))).toHaveLength(1);
    expect(h.api.mock.calls.every(args => args[1].includes("/users/"))).toBe(true);
    if (stage !== "merge") expect(h.api.mock.calls.some(args => args[1].endsWith("/files"))).toBe(false);
  });

  it.each(["finish", "merge"])("does not retry HTTP/unknown %s outcomes", async stage => {
    for (const error of [new QQApiError("SYNTHETIC_SECRET", { status: 503, bizCode: 999 }), new TypeError("synthetic unknown outcome")]) {
      const h = await harness();
      const normal = h.api.getMockImplementation();
      const suffix = stage === "finish" ? "/upload_part_finish" : "/files";
      h.api.mockImplementation(async (...args) => {
        if (args[1].endsWith(suffix)) throw error;
        return normal(...args);
      });
      await expect(h.run({ metadata: {} })).rejects.toThrow();
      expect(h.api.mock.calls.filter(args => args[1].endsWith(suffix))).toHaveLength(1);
      expect(h.api.mock.calls.every(args => args[1].includes("/users/"))).toBe(true);
    }
  });

  it.each([undefined, "", 12, {}])("rejects invalid merge file_info %j", async fileInfo => {
    const h = await harness();
    const normal = h.api.getMockImplementation();
    h.api.mockImplementation(async (...args) => args[1].endsWith("/files") ? { file_info: fileInfo } : normal(...args));
    await expect(h.run()).rejects.toThrow(/file_info/);
    expect(h.api.mock.calls.filter(args => args[1].endsWith("/files"))).toHaveLength(1);
  });

  it("discards a failed PUT body without exposing it or confirming/merging the part", async () => {
    const h = await harness();
    const cancel = vi.fn(async () => {});
    h.put.mockResolvedValue({ ok: false, status: 403, body: { cancel } });
    await expect(h.run()).rejects.toThrow("QQ part upload failed (HTTP 403)");
    expect(cancel).toHaveBeenCalledOnce();
    expect(h.api).toHaveBeenCalledOnce();
    expect(h.put.mock.calls[0][0]).toMatchObject({ idempotent: true, maxRetries: 2, timeoutMs: 300_000 });
  });

  it("uses nested concurrency with a local maximum of ten and defaults to one", async () => {
    for (const concurrency of [undefined, 2, 100]) {
      const h = await harness(Buffer.alloc(48));
      h.response.upload_config.concurrency = concurrency;
      Object.assign(h.response, { concurrency: 10 });
      const pending: Array<() => void> = [];
      h.put.mockImplementation(() => new Promise(resolve => pending.push(() => resolve(new Response("")))));
      const result = h.run();
      const expected = concurrency === undefined ? 1 : Math.min(concurrency, 10);
      await vi.waitFor(() => expect(pending).toHaveLength(expected));
      h.put.mockImplementation(async () => new Response(""));
      pending.splice(0).forEach(resolve => resolve());
      await result;
      expect(h.put).toHaveBeenCalledTimes(12);
    }
  });

  it("fills short filesystem reads and rejects truncation before PUT", async () => {
    const h = await harness();
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const file = await open(...args);
      const read = file.read.bind(file);
      vi.spyOn(file, "read").mockImplementation(((buffer: Buffer, offset: number, length: number, position: number) => read(buffer, offset, Math.min(length, 2), position)) as typeof file.read);
      return file;
    });
    await h.run();
    expect(Buffer.concat(await Promise.all(h.put.mock.calls.map(async ([opts]) => Buffer.from(await opts.body.arrayBuffer()))))).toEqual(h.bytes);
    vi.restoreAllMocks();
    const h2 = await harness();
    h2.api.mockImplementationOnce(async () => { await fs.truncate(h2.filePath, 0); return h2.response; });
    await expect(h2.run()).rejects.toThrow(/截断/);
    expect(h2.put).not.toHaveBeenCalled();
  });

  it("refuses merge if the source changes during upload", async () => {
    const h = await harness();
    h.put.mockImplementationOnce(async () => { await fs.appendFile(h.filePath, "changed"); return new Response(""); });
    await expect(h.run()).rejects.toThrow(/文件发生变化/);
    expect(h.api.mock.calls.some(args => args[1].endsWith("/files"))).toBe(false);
  });
});

describe("QQ upload retries and cancellation", () => {
  it.each([2, 100])("honors nested retry_delay %i with the local 30 second cap", async retryDelay => {
    const h = await harness(Buffer.from("one"));
    vi.useFakeTimers();
    h.response.upload_config.retry_delay = retryDelay;
    const normal = h.api.getMockImplementation();
    let finishes = 0;
    h.api.mockImplementation(async (...args) => {
      if (args[1].endsWith("/upload_part_finish") && ++finishes === 1) return { code: 40093001 };
      return normal(...args);
    });
    const result = h.run();
    await vi.waitFor(() => expect(finishes).toBe(1));
    await vi.advanceTimersByTimeAsync((Math.min(retryDelay, 30) - 1) * 1000);
    expect(finishes).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    await result;
    expect(finishes).toBe(2);
    expect(h.put).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([1, 10000])("bounds retry_timeout %i including a pending confirmation", async retryTimeout => {
    const h = await harness(Buffer.from("one"));
    vi.useFakeTimers();
    h.response.upload_config.retry_timeout = retryTimeout;
    const normal = h.api.getMockImplementation();
    let finishes = 0;
    h.api.mockImplementation(async (...args) => {
      if (!args[1].endsWith("/upload_part_finish")) return normal(...args);
      if (++finishes === 1) throw new QQApiError("not ready", { status: 400, bizCode: 40093001 });
      const signal = args[3].signal as AbortSignal;
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    const result = h.run().catch(error => error);
    await vi.waitFor(() => expect(finishes).toBe(1));
    await vi.advanceTimersByTimeAsync(Math.min(retryTimeout, 600) * 1000);
    expect(await result).toBeInstanceOf(Error);
    expect(h.api.mock.calls.some(args => args[1].endsWith("/files"))).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["before", "prepare", "put", "finish", "merge", "backoff"])("aborts at %s without starting any later stage", async stage => {
    const h = await harness();
    const caller = new AbortController();
    const reason = new Error("synthetic caller cancellation");
    const normal = h.api.getMockImplementation();
    let pending = false;
    if (stage === "before") caller.abort(reason);
    const wait = (signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
      pending = true;
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    if (stage === "put") h.put.mockImplementation(({ signal }) => wait(signal));
    h.api.mockImplementation(async (...args) => {
      const endpoint = args[1];
      if ((stage === "prepare" && endpoint.endsWith("/upload_prepare"))
        || (stage === "finish" && endpoint.endsWith("/upload_part_finish"))
        || (stage === "merge" && endpoint.endsWith("/files"))) return wait(args[3].signal);
      if (stage === "backoff" && endpoint.endsWith("/upload_part_finish")) {
        pending = true;
        return { code: 40093001 };
      }
      return normal(...args);
    });
    const result = h.run({ signal: caller.signal }).catch(error => error);
    if (stage !== "before") {
      await vi.waitFor(() => expect(pending).toBe(true));
      caller.abort(reason);
    }
    expect(await result).toBeInstanceOf(Error);
    const apiCalls = h.api.mock.calls.length;
    const putCalls = h.put.mock.calls.length;
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(h.api).toHaveBeenCalledTimes(apiCalls);
    expect(h.put).toHaveBeenCalledTimes(putCalls);
    if (stage !== "merge") expect(h.api.mock.calls.some(args => args[1].endsWith("/files"))).toBe(false);
    if (["before", "prepare"].includes(stage)) expect(h.put).not.toHaveBeenCalled();
  });

  it("aborts and drains sibling PUTs, closes the file, and never starts queued parts after failure", async () => {
    const h = await harness(Buffer.alloc(20));
    h.response.upload_config.concurrency = 2;
    const open = fs.open.bind(fs);
    let close: ReturnType<typeof vi.spyOn>;
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const file = await open(...args);
      close = vi.spyOn(file, "close");
      return file;
    });
    let fail: (error: Error) => void;
    let siblingDrained = false;
    h.put.mockImplementation(({ url, signal }) => new Promise((_resolve, reject) => {
      if (url.endsWith("put-0")) fail = reject;
      else signal.addEventListener("abort", () => {
        expect(close).not.toHaveBeenCalled();
        siblingDrained = true;
        reject(signal.reason);
      }, { once: true });
    }));
    const result = h.run().catch(error => error);
    await vi.waitFor(() => expect(h.put).toHaveBeenCalledTimes(2));
    fail(new Error("synthetic PUT failure"));
    expect((await result).message).toBe("synthetic PUT failure");
    expect(siblingDrained).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    expect(h.put).toHaveBeenCalledTimes(2);
    expect(h.api).toHaveBeenCalledOnce();
  });
});
