import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentsRoute } from '../server/routes/agents.ts';
import { addPinnedMemoryItem, readPinnedMemoryItems } from '../lib/memory/pinned-memory-store.ts';
import {
  confirmXingyeMemoryCandidateToPinned,
  createXingyeMemoryCandidate,
  getXingyeMemoryCandidate,
} from '../desktop/src/react/xingye/xingye-memory-candidate-store.ts';

vi.mock('../desktop/src/react/hooks/use-hana-fetch', () => ({
  hanaFetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }))),
  hanaUrl: (url: string) => url,
}));

describe('pinned memory optimistic concurrency', () => {
  let tempRoot: string;
  let agentDir: string;
  let app: Hono;
  let updateConfig: ReturnType<typeof vi.fn>;
  let emitEvent: ReturnType<typeof vi.fn>;
  const endpoint = '/api/agents/hana/pinned';
  const write = (body: unknown) => app.request(endpoint, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hana-pinned-cas-'));
    agentDir = path.join(tempRoot, 'hana');
    fs.mkdirSync(agentDir);
    fs.writeFileSync(path.join(agentDir, 'config.yaml'), 'agent:\n  name: Hana\n');
    updateConfig = vi.fn().mockResolvedValue(undefined);
    emitEvent = vi.fn();
    app = new Hono();
    app.route('/api', createAgentsRoute({ agentsDir: tempRoot, updateConfig, emitEvent }));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('rejects a stale append after pin_memory added an item, preserving both current pins', async () => {
    addPinnedMemoryItem(agentDir, 'existing');
    const { pins } = await (await app.request(endpoint)).json();
    addPinnedMemoryItem(agentDir, 'tool-added while the UI was saving');
    const response = await write({ pins: [...pins, 'candidate'], expectedPins: pins });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'pinned_memory_conflict' });
    expect(readPinnedMemoryItems(agentDir).map(item => item.content)).toEqual([
      'existing', 'tool-added while the UI was saving',
    ]);
    expect(updateConfig).not.toHaveBeenCalled();
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it('rejects a stale removal and succeeds when retried against the fresh snapshot', async () => {
    addPinnedMemoryItem(agentDir, 'remove this');
    const { pins } = await (await app.request(endpoint)).json();
    addPinnedMemoryItem(agentDir, 'keep concurrent addition');
    expect((await write({ pins: [], expectedPins: pins })).status).toBe(409);
    const current = readPinnedMemoryItems(agentDir).map(item => item.content);
    expect((await write({ pins: current.slice(1), expectedPins: current })).status).toBe(200);
    expect(readPinnedMemoryItems(agentDir).map(item => item.content)).toEqual(['keep concurrent addition']);
  });

  it.each([null, 'stale', [1], [{}]].map(expectedPins => ({ expectedPins })))('rejects malformed expectedPins: $expectedPins', async ({ expectedPins }) => {
    addPinnedMemoryItem(agentDir, 'keep');
    expect((await write({ pins: [], expectedPins })).status).toBe(400);
    expect(readPinnedMemoryItems(agentDir).map(item => item.content)).toEqual(['keep']);
  });

  it('keeps legacy unconditional PUT clients working', async () => {
    addPinnedMemoryItem(agentDir, 'old');
    expect((await write({ pins: ['replacement'] })).status).toBe(200);
    expect(readPinnedMemoryItems(agentDir).map(item => item.content)).toEqual(['replacement']);
  });

  it('keeps a candidate pending on real route conflict and confirms it after a safe retry', async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    const candidate = createXingyeMemoryCandidate('hana', { content: 'new candidate' }, storage);
    addPinnedMemoryItem(agentDir, 'existing');
    let injectConcurrentWrite = true;
    const fetchImpl = async (url: string, init?: RequestInit) => {
      if (init?.method === 'PUT' && injectConcurrentWrite) {
        injectConcurrentWrite = false;
        addPinnedMemoryItem(agentDir, 'concurrent tool pin');
      }
      return app.request(url, init);
    };
    await expect(confirmXingyeMemoryCandidateToPinned('hana', candidate.id, { storage, fetchImpl }))
      .rejects.toThrow('本次修改未保存，请重试');
    expect(getXingyeMemoryCandidate(candidate.id, storage)?.status).toBe('pending');
    expect(readPinnedMemoryItems(agentDir).map(item => item.content)).toEqual(['existing', 'concurrent tool pin']);
    await confirmXingyeMemoryCandidateToPinned('hana', candidate.id, { storage, fetchImpl });
    expect(getXingyeMemoryCandidate(candidate.id, storage)?.status).toBe('written');
    expect(readPinnedMemoryItems(agentDir).map(item => item.content)).toEqual([
      'existing', 'concurrent tool pin', 'new candidate',
    ]);
  });
});
