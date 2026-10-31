/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConnection } from '../services/server-connection';
import {
  attemptUnlock, markHiddenFolderSeedGenerated, maybeRelockOnHeartbeat,
  listHiddenEntries, readHiddenFolderState, setHiddenFolderPassword,
  XINGYE_FILES_HIDDEN_ENTRIES_JSONL, XINGYE_FILES_HIDDEN_STATE_JSON,
  type XingyeHiddenFolderState,
} from './xingye-files-secret-store';

// Only the final fetch is synthetic: store, backend, post and hanaFetch are real.
// The .invalid target is never contacted and no listener or user data is used.
const h = vi.hoisted(() => ({ connection: null as unknown as ServerConnection }));
vi.mock('../stores', () => ({ useStore: { getState: () => ({
  activeServerConnection: h.connection,
  activeServerConnectionId: h.connection.connectionId,
  serverConnections: { [h.connection.connectionId]: h.connection },
}) } }));

type RequestBody = { action: string; agentId: string; relativePath: string; data?: unknown };
type Reply = () => Response | Promise<Response>;
const original: XingyeHiddenFolderState = {
  agentId: 'synthetic-owner', locked: false, passwordHash: 'SYNTHETIC_CONFIRMED_HASH',
  candidateLabel: 'SYNTHETIC_CONFIRMED_HINT', seedGenerated: false,
  lastUnlockedAt: '2026-10-30T10:00:00.000Z', lockedAt: '2026-10-29T10:00:00.000Z',
  updatedAt: '2026-10-30T10:00:00.000Z',
};
const jsonReply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});
const badJsonReply = () => new Response('{', { headers: { 'Content-Type': 'application/json' } });
let stored: string;
let requests: RequestBody[];
let readReply: Reply;
let writeReply: Reply;
let listReply: Reply;

beforeEach(() => {
  h.connection = {
    connectionId: 'hf03-synthetic', kind: 'custom_remote', serverId: 'synthetic-server',
    studioId: 'synthetic-studio', label: 'Synthetic HF03',
    baseUrl: 'https://hf03-storage.invalid', wsUrl: 'wss://hf03-storage.invalid',
    token: null, authState: 'paired', trustState: 'tunnel',
    credentialKind: 'device_credential', capabilities: [],
  };
  stored = JSON.stringify(original);
  requests = [];
  readReply = () => jsonReply({ ok: true, data: JSON.parse(stored) });
  writeReply = () => jsonReply({ ok: true });
  listReply = () => jsonReply({ ok: true, records: [] });
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    expect(String(input)).toBe('https://hf03-storage.invalid/api/xingye/storage');
    const body = JSON.parse(String(init?.body)) as RequestBody;
    expect(body.agentId).toBe(original.agentId);
    expect([XINGYE_FILES_HIDDEN_STATE_JSON, XINGYE_FILES_HIDDEN_ENTRIES_JSONL]).toContain(body.relativePath);
    requests.push(body);
    if (body.action === 'readJson') return readReply();
    if (body.action === 'listJsonl') return listReply();
    if (body.action === 'writeJson') return writeReply();
    throw new Error(`Unexpected synthetic action: ${body.action}`);
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function expectNoWriteAndOriginalState() {
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every(request => request.action === 'readJson')).toBe(true);
  expect(stored).toBe(JSON.stringify(original));
}

const invalidReads: Array<{ name: string; reply: Reply }> = [
  { name: 'fetch rejection', reply: () => Promise.reject(new Error('SYNTHETIC_READ_DENIED')) },
  { name: 'HTTP 500 EACCES', reply: () => jsonReply({ error: 'EACCES' }, 500) },
  { name: 'HTTP 500 invalid JSON file', reply: () => jsonReply({ error: 'invalid JSON file' }, 500) },
  { name: 'response JSON rejection', reply: badJsonReply },
  { name: 'empty successful envelope', reply: () => jsonReply({}) },
  { name: 'null data without confirmed missing', reply: () => jsonReply({ ok: true, data: null }) },
  { name: 'null data with missing false', reply: () => jsonReply({ ok: true, data: null, missing: false }) },
  { name: 'missing envelope with existing data', reply: () => jsonReply({ ok: true, missing: true, data: original }) },
  ...(['false', 1] as const).map(missing => ({
    name: `invalid missing flag ${missing}`, reply: () => jsonReply({ ok: true, missing, data: original }),
  })),
  { name: 'ok false with existing data', reply: () => jsonReply({ ok: false, data: original }) },
  { name: 'wrong owner', reply: () => jsonReply({ ok: true, data: { ...original, agentId: 'another-owner' } }) },
  { name: 'array state', reply: () => jsonReply({ ok: true, data: [] }) },
  ...(['locked', 'passwordHash', 'candidateLabel', 'seedGenerated', 'updatedAt'] as const).map(field => ({
    name: `missing required ${field}`,
    reply: () => jsonReply({ ok: true, data: { ...original, [field]: undefined } }),
  })),
  ...([
    ['locked', 'false'], ['passwordHash', 42], ['candidateLabel', 42],
    ['seedGenerated', 'false'], ['updatedAt', 42], ['lastUnlockedAt', 42], ['lockedAt', 42],
  ] as const).map(([field, value]) => ({
    name: `damaged ${field}`,
    reply: () => jsonReply({ ok: true, data: { ...original, [field]: value } }),
  })),
];

describe('hidden state read protection through the final fetch', () => {
  it('initializes only an explicitly missing state envelope', async () => {
    readReply = () => jsonReply({ ok: true, data: null, missing: true });
    const state = await readHiddenFolderState(original.agentId, h.connection);
    expect(state).toEqual({
      agentId: original.agentId, locked: true, passwordHash: '', candidateLabel: '',
      seedGenerated: false, updatedAt: new Date(0).toISOString(),
    });
    expectNoWriteAndOriginalState();
  });

  it('accepts a complete legitimate initial state with empty hash and hint', async () => {
    const empty = { ...original, locked: true, passwordHash: '', candidateLabel: '' };
    stored = JSON.stringify(empty);
    expect(await readHiddenFolderState(original.agentId, h.connection)).toEqual(empty);
    expect(requests.map(request => request.action)).toEqual(['readJson']);
    expect(stored).toBe(JSON.stringify(empty));
  });

  it.each(invalidReads)('rejects $name without replacing existing metadata', async ({ reply }) => {
    readReply = reply;
    await expect(readHiddenFolderState(original.agentId, h.connection)).rejects.toThrow();
    await expect(markHiddenFolderSeedGenerated(original.agentId, h.connection)).rejects.toThrow();
    expectNoWriteAndOriginalState();
  });
});

describe('hidden seed state write acknowledgement', () => {
  it('returns an already marked state without rewriting its metadata', async () => {
    const marked = { ...original, seedGenerated: true };
    stored = JSON.stringify(marked);
    expect(await markHiddenFolderSeedGenerated(original.agentId, h.connection)).toEqual(marked);
    expect(requests.map(request => request.action)).toEqual(['readJson']);
    expect(stored).toBe(JSON.stringify(marked));
  });

  it('does not start a state write when its context expires during the read', async () => {
    let releaseRead!: () => void;
    readReply = () => new Promise<Response>(resolve => {
      releaseRead = () => resolve(jsonReply({ ok: true, data: original }));
    });
    let current = true;
    const pending = markHiddenFolderSeedGenerated(original.agentId, h.connection, () => current);
    expect(requests.map(request => request.action)).toEqual(['readJson']);
    current = false;
    releaseRead();
    // Cancellation may reject or return its unchanged state; neither may write.
    await Promise.allSettled([pending]);
    expectNoWriteAndOriginalState();
  });

  it('changes only the seed marker and update time after a valid state read', async () => {
    writeReply = () => {
      stored = JSON.stringify(requests.at(-1)?.data);
      return jsonReply({ ok: true });
    };
    const state = await markHiddenFolderSeedGenerated(original.agentId, h.connection);
    expect({ ...state, updatedAt: original.updatedAt }).toEqual({ ...original, seedGenerated: true });
    expect(Number.isFinite(Date.parse(state.updatedAt))).toBe(true);
    expect(JSON.parse(stored)).toEqual(state);
    expect(requests.map(request => request.action)).toEqual(['readJson', 'writeJson']);
  });

  it.each([
    { name: 'transport rejection before commit', reply: () => Promise.reject(new Error('SYNTHETIC_WRITE_DENIED')) },
    { name: 'HTTP 500 before commit', reply: () => jsonReply({ error: 'SYNTHETIC_WRITE_DENIED' }, 500) },
    { name: 'empty 200 acknowledgement', reply: () => jsonReply({}) },
    { name: 'ok false acknowledgement', reply: () => jsonReply({ ok: false }) },
    { name: 'invalid acknowledgement JSON', reply: badJsonReply },
  ])('does not report success for $name', async ({ reply }) => {
    writeReply = reply;
    await expect(markHiddenFolderSeedGenerated(original.agentId, h.connection)).rejects.toThrow();
    expect(requests.map(request => request.action)).toEqual(['readJson', 'writeJson']);
    expect(stored).toBe(JSON.stringify(original));
  });

  it('surfaces an invalid late receipt while preserving the already committed state', async () => {
    writeReply = () => {
      stored = JSON.stringify(requests.at(-1)?.data);
      return badJsonReply();
    };
    await expect(markHiddenFolderSeedGenerated(original.agentId, h.connection)).rejects.toThrow();
    expect({ ...JSON.parse(stored), updatedAt: original.updatedAt }).toEqual({ ...original, seedGenerated: true });
    expect(requests.map(request => request.action)).toEqual(['readJson', 'writeJson']);
  });
});

describe('shared hidden state readers never write after a failed read', () => {
  it.each([
    { name: 'set password', run: () => setHiddenFolderPassword(original.agentId, {
      password: 'SYNTHETIC_NEW', candidateLabel: 'SYNTHETIC_NEW_HINT',
    }) },
    { name: 'attempt unlock', run: () => attemptUnlock(original.agentId, 'SYNTHETIC_ATTEMPT') },
    { name: 'heartbeat relock', run: () => maybeRelockOnHeartbeat(original.agentId, {
      nextPassword: 'SYNTHETIC_NEW', nextCandidateLabel: 'SYNTHETIC_NEW_HINT',
      probability: 1, randomSource: () => 0,
    }) },
  ])('rejects $name without overwriting stored metadata', async ({ run }) => {
    readReply = () => Promise.reject(new Error('SYNTHETIC_READ_DENIED'));
    await expect(run()).rejects.toThrow();
    expectNoWriteAndOriginalState();
  });
});


describe('strict hidden entry reads used by state recovery', () => {
  it('returns valid persisted entries without mutating state', async () => {
    const entry = {
      id: 'synthetic-entry', key: 'synthetic-entry', agentId: original.agentId,
      kind: 'secret_plan', title: 'SYNTHETIC_TITLE', body: 'SYNTHETIC_BODY',
      source: 'ai_seed', createdAt: original.updatedAt,
    };
    listReply = () => jsonReply({ ok: true, records: [entry] });
    expect(await listHiddenEntries(original.agentId, h.connection, true)).toEqual([entry]);
    expect(requests.map(request => request.action)).toEqual(['listJsonl']);
    expect(stored).toBe(JSON.stringify(original));
  });

  it.each([
    { name: 'transport rejection', reply: () => Promise.reject(new Error('SYNTHETIC_LIST_DENIED')) },
    { name: 'HTTP failure', reply: () => jsonReply({ error: 'EACCES' }, 500) },
    { name: 'missing records field', reply: () => jsonReply({ ok: true }) },
    { name: 'non-array records', reply: () => jsonReply({ ok: true, records: {} }) },
    { name: 'ok false response', reply: () => jsonReply({ ok: false, records: [] }) },
    { name: 'invalid persisted row', reply: () => jsonReply({ ok: true, records: [{ agentId: 'other-owner' }] }) },
  ])('rejects $name during recovery instead of claiming an empty drawer', async ({ reply }) => {
    listReply = reply;
    await expect(listHiddenEntries(original.agentId, h.connection, true)).rejects.toThrow();
    expect(requests.map(request => request.action)).toEqual(['listJsonl']);
    expect(stored).toBe(JSON.stringify(original));
  });

  it('retains the existing best-effort empty list contract outside recovery', async () => {
    listReply = () => Promise.reject(new Error('SYNTHETIC_LIST_DENIED'));
    expect(await listHiddenEntries(original.agentId, h.connection)).toEqual([]);
    expect(requests.map(request => request.action)).toEqual(['listJsonl']);
    expect(stored).toBe(JSON.stringify(original));
  });
});
