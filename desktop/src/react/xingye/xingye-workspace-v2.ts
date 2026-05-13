/**
 * 星野 workspace v2：按 agent 分域落盘；与 v1/data/*.json 可读兼容。
 */

import { sanitizeAgentIdForPath } from './xingye-agent-path';

export const XINGYE_LAYOUT_VERSION = 2;
const WORKSPACE_V2_DISABLED_ERROR = 'workspace v2 storage is disabled; use agent-scoped Xingye storage under HANA_HOME/agents/{agentId}/xingye/';

export type XingyeWorkspaceManifestV2 = {
  schemaVersion: 2;
  layoutVersion: number;
  createdAt: string;
  updatedAt: string;
  workspaceRoot: string;
  workspaceRootHash: string;
  migratedFromLocalStorageAt?: string;
  migratedFromLayoutV1At?: string;
  agentIds: string[];
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

const SMS_INDEX_SCHEMA_VERSION = 1;
const SMS_THREAD_SCHEMA_VERSION = 1;

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

type SmsThreadIdentity = {
  ownerAgentId: string;
  targetType: string;
  targetId: string;
};

type SmsIndexEntry = SmsThreadIdentity & {
  threadKey: string;
  safeThreadId: string;
  file: string;
  threadId: string;
  updatedAt: string;
  messageCount: number;
};

type SmsIndexFile = {
  schemaVersion: 1;
  ownerAgentId: string;
  updatedAt: string;
  threads: Record<string, SmsIndexEntry>;
};

function utf8Bytes(input: string): number[] {
  if (typeof TextEncoder !== 'undefined') {
    return Array.from(new TextEncoder().encode(input));
  }
  const encoded = encodeURIComponent(input);
  const bytes: number[] = [];
  for (let i = 0; i < encoded.length; i += 1) {
    if (encoded[i] === '%') {
      bytes.push(Number.parseInt(encoded.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(encoded.charCodeAt(i));
    }
  }
  return bytes;
}

function rightRotate(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

function sha256Hex(input: string): string {
  const bytes = utf8Bytes(input);
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);

  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  for (const value of [high, low]) {
    bytes.push((value >>> 24) & 0xff);
    bytes.push((value >>> 16) & 0xff);
    bytes.push((value >>> 8) & 0xff);
    bytes.push(value & 0xff);
  }

  const h = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];

  for (let chunk = 0; chunk < bytes.length; chunk += 64) {
    const w = new Array<number>(64).fill(0);
    for (let i = 0; i < 16; i += 1) {
      const offset = chunk + i * 4;
      w[i] = (
        (bytes[offset] << 24)
        | (bytes[offset + 1] << 16)
        | (bytes[offset + 2] << 8)
        | bytes[offset + 3]
      ) >>> 0;
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rightRotate(w[i - 15], 7) ^ rightRotate(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rightRotate(w[i - 2], 17) ^ rightRotate(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i += 1) {
      const s1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
      const ch = (e & f) ^ ((~e) & g);
      const temp1 = (hh + s1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const s0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }

  return h.map((value) => value.toString(16).padStart(8, '0')).join('');
}

function safeSmsThreadId(threadKey: string): string {
  return `t_${sha256Hex(threadKey)}`;
}

function smsThreadRelativeFile(safeThreadId: string): string {
  return `threads/${safeThreadId}.json`;
}

function parseSmsThreadKey(threadKey: string): SmsThreadIdentity | null {
  const parts = threadKey.split('::');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;
  return {
    ownerAgentId: parts[0],
    targetType: parts[1],
    targetId: parts[2],
  };
}

function createSmsIndexEntry(threadKey: string, thread: Record<string, unknown>): SmsIndexEntry | null {
  const identity = parseSmsThreadKey(threadKey);
  if (!identity) return null;
  if (
    thread.ownerAgentId !== identity.ownerAgentId
    || thread.targetType !== identity.targetType
    || thread.targetId !== identity.targetId
  ) {
    return null;
  }
  const safeThreadId = safeSmsThreadId(threadKey);
  return {
    ...identity,
    threadKey,
    safeThreadId,
    file: smsThreadRelativeFile(safeThreadId),
    threadId: typeof thread.id === 'string' ? thread.id : '',
    updatedAt: typeof thread.updatedAt === 'string' ? thread.updatedAt : new Date(0).toISOString(),
    messageCount: Array.isArray(thread.messages) ? thread.messages.length : 0,
  };
}

export function workspaceRootHashFromRoot(root: string): string {
  const s = root.trim();
  let h = 0;
  for (let i = 0; i < s.length; i += 1) {
    h = ((h << 5) - h) + s.charCodeAt(i);
    h |= 0;
  }
  return `w${Math.abs(h).toString(16)}`;
}

export function collectXingyeAgentIds(memory: Map<string, string>): string[] {
  const ids = new Set<string>();

  const addFromProfileMap = (raw: string | undefined) => {
    if (!raw) return;
    try {
      const o = JSON.parse(raw);
      if (!isRecord(o)) return;
      Object.keys(o).forEach((id) => ids.add(id));
    } catch { /* */ }
  };

  const addFromLore = (raw: string | undefined) => {
    if (!raw) return;
    try {
      const o = JSON.parse(raw);
      if (!isRecord(o)) return;
      for (const v of Object.values(o)) {
        if (!isRecord(v)) continue;
        const aid = typeof v.agentId === 'string' ? v.agentId : '';
        if (aid) ids.add(aid);
      }
    } catch { /* */ }
  };

  const addFromRelationship = (raw: string | undefined) => {
    if (!raw) return;
    try {
      const o = JSON.parse(raw);
      if (!isRecord(o)) return;
      Object.keys(o).forEach((id) => ids.add(id));
    } catch { /* */ }
  };

  const addFromMoments = (raw: string | undefined) => {
    if (!raw) return;
    try {
      const o = JSON.parse(raw);
      if (!isRecord(o)) return;
      for (const v of Object.values(o)) {
        if (!isRecord(v)) continue;
        const aid = typeof v.authorAgentId === 'string' ? v.authorAgentId : '';
        if (aid) ids.add(aid);
      }
    } catch { /* */ }
  };

  const addOwnerFromRecordValues = (raw: string | undefined) => {
    if (!raw) return;
    try {
      const o = JSON.parse(raw);
      if (!isRecord(o)) return;
      for (const v of Object.values(o)) {
        if (!isRecord(v)) continue;
        const aid = typeof v.ownerAgentId === 'string' ? v.ownerAgentId : '';
        if (aid) ids.add(aid);
      }
    } catch { /* */ }
  };

  const addFromKeyedByOwner = (raw: string | undefined) => {
    if (!raw) return;
    try {
      const o = JSON.parse(raw);
      if (!isRecord(o)) return;
      Object.keys(o).forEach((k) => ids.add(k));
    } catch { /* */ }
  };

  const addFromAiGenMap = (raw: string | undefined) => {
    if (!raw) return;
    try {
      const o = JSON.parse(raw);
      if (!isRecord(o)) return;
      for (const v of Object.values(o)) {
        if (!isRecord(v)) continue;
        const aid = typeof v.ownerAgentId === 'string' ? v.ownerAgentId : '';
        if (aid) ids.add(aid);
      }
      for (const k of Object.keys(o)) {
        const prefix = k.split('::')[0];
        if (prefix) ids.add(prefix);
      }
    } catch { /* */ }
  };

  const addFromChangeLog = (raw: string | undefined) => {
    if (!raw) return;
    try {
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return;
      for (const v of arr) {
        if (!isRecord(v)) continue;
        const aid = typeof v.ownerAgentId === 'string' ? v.ownerAgentId : '';
        if (aid) ids.add(aid);
      }
    } catch { /* */ }
  };

  const addFromMemoryCandidates = (raw: string | undefined) => {
    if (!raw) return;
    try {
      const o = JSON.parse(raw);
      if (!isRecord(o)) return;
      for (const v of Object.values(o)) {
        if (!isRecord(v)) continue;
        const aid = typeof v.agentId === 'string' ? v.agentId : '';
        if (aid) ids.add(aid);
      }
    } catch { /* */ }
  };

  addFromProfileMap(memory.get('xingye.roleProfiles'));
  addFromLore(memory.get('xingye.loreEntries'));
  addFromRelationship(memory.get('xingye.relationshipStates'));
  addFromMoments(memory.get('xingye.moments'));
  addOwnerFromRecordValues(memory.get('xingye.phoneContacts'));
  addOwnerFromRecordValues(memory.get('xingye.phoneVirtualContacts'));
  addOwnerFromRecordValues(memory.get('xingye.phoneSmsThreads'));
  addFromKeyedByOwner(memory.get('xingye.phoneContactGenerationState'));
  addFromAiGenMap(memory.get('xingye.phoneAiGenerationState'));
  addFromKeyedByOwner(memory.get('xingye.phoneSmsHistoryGenerationState'));
  addFromKeyedByOwner(memory.get('xingye.phoneContactSnapshots'));
  addFromKeyedByOwner(memory.get('xingye.phoneContactAiUpdateState'));
  addFromChangeLog(memory.get('xingye.phone.contactChangeLog'));
  addFromMemoryCandidates(memory.get('xingye.memoryCandidates'));

  return [...ids].sort();
}

function agentBase(agentId: string): string {
  return `agents/${sanitizeAgentIdForPath(agentId)}`;
}

function rejectWorkspaceV2Storage(): never {
  throw new Error(WORKSPACE_V2_DISABLED_ERROR);
}

async function writeFile(_rel: string, _content: string, _encoding: 'utf8' | 'base64' = 'utf8'): Promise<void> {
  rejectWorkspaceV2Storage();
}

async function readFileText(_rel: string): Promise<string | null> {
  rejectWorkspaceV2Storage();
}

async function readFileBase64(_rel: string): Promise<string | null> {
  rejectWorkspaceV2Storage();
}

async function readJsonObjectFile(rel: string): Promise<Record<string, unknown> | null> {
  const t = await readFileText(rel);
  if (!t) return null;
  try {
    const o = JSON.parse(t) as unknown;
    return isRecord(o) ? o : null;
  } catch {
    return null;
  }
}

/** 读取单个 phone 类 JSON 对象文件（composite key → record），合并进内存 bucket。 */
async function mergePhoneJsonObjectFile(rel: string, bucket: Record<string, unknown>): Promise<void> {
  const o = await readJsonObjectFile(rel);
  if (!o) return;
  for (const [k, v] of Object.entries(o)) {
    bucket[k] = v;
  }
}

/**
 * Workspace v2 SMS **monolith fallback**：读取 `agents/<id>/phone/sms-threads.json`。
 * 键与 `xingye.phoneSmsThreads` 相同。仅在 bucket 中尚无该键时写入（per-thread 优先）。
 */
async function mergeAgentPhoneSmsThreadsMonolith(agentId: string, bucket: Record<string, unknown>): Promise<void> {
  const o = await readJsonObjectFile(`${agentBase(agentId)}/phone/sms-threads.json`);
  if (!o) return;
  for (const [k, v] of Object.entries(o)) {
    if (!(k in bucket)) bucket[k] = v;
  }
}

function isValidSmsIndexEntry(agentId: string, threadKey: string, value: unknown): value is SmsIndexEntry {
  if (!isRecord(value)) return false;
  if (value.threadKey !== threadKey) return false;
  const identity = parseSmsThreadKey(threadKey);
  if (!identity || identity.ownerAgentId !== agentId) return false;
  if (
    value.ownerAgentId !== identity.ownerAgentId
    || value.targetType !== identity.targetType
    || value.targetId !== identity.targetId
  ) {
    return false;
  }
  const expectedSafeThreadId = safeSmsThreadId(threadKey);
  return (
    value.safeThreadId === expectedSafeThreadId
    && value.file === smsThreadRelativeFile(expectedSafeThreadId)
  );
}

function smsThreadFromThreadFile(agentId: string, entry: SmsIndexEntry, value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  if (value.threadKey !== entry.threadKey) return null;
  if (
    value.ownerAgentId !== agentId
    || value.ownerAgentId !== entry.ownerAgentId
    || value.targetType !== entry.targetType
    || value.targetId !== entry.targetId
  ) {
    return null;
  }
  const { schemaVersion: _schemaVersion, threadKey: _threadKey, ...thread } = value;
  return thread;
}

async function writeAgentPhoneSmsThreadsPerThread(
  agentId: string,
  smsThreads: Record<string, unknown>,
  updatedAt: string,
): Promise<void> {
  const threads: Record<string, SmsIndexEntry> = {};
  for (const [threadKey, thread] of Object.entries(smsThreads)) {
    if (!isRecord(thread)) continue;
    const entry = createSmsIndexEntry(threadKey, thread);
    if (!entry || entry.ownerAgentId !== agentId) continue;
    threads[threadKey] = entry;
    const threadFile = {
      ...thread,
      schemaVersion: SMS_THREAD_SCHEMA_VERSION,
      threadKey,
    };
    await writeFile(
      `${agentBase(agentId)}/phone/sms/${entry.file}`,
      JSON.stringify(threadFile, null, 2),
    );
  }

  const index: SmsIndexFile = {
    schemaVersion: SMS_INDEX_SCHEMA_VERSION,
    ownerAgentId: agentId,
    updatedAt,
    threads,
  };
  await writeFile(`${agentBase(agentId)}/phone/sms/index.json`, JSON.stringify(index, null, 2));
}

async function mergeAgentPhoneSmsThreadsPerThread(agentId: string, bucket: Record<string, unknown>): Promise<void> {
  const index = await readJsonObjectFile(`${agentBase(agentId)}/phone/sms/index.json`) as SmsIndexFile | null;
  if (
    !index
    || index.schemaVersion !== SMS_INDEX_SCHEMA_VERSION
    || index.ownerAgentId !== agentId
    || !isRecord(index.threads)
  ) {
    return;
  }

  for (const [threadKey, rawEntry] of Object.entries(index.threads)) {
    if (!isValidSmsIndexEntry(agentId, threadKey, rawEntry)) continue;
    const threadFile = await readJsonObjectFile(`${agentBase(agentId)}/phone/sms/${rawEntry.file}`);
    const thread = smsThreadFromThreadFile(agentId, rawEntry, threadFile);
    if (thread) bucket[threadKey] = thread;
  }
}

export async function readWorkspaceManifestV2(): Promise<XingyeWorkspaceManifestV2 | null> {
  rejectWorkspaceV2Storage();
  const text = await readFileText('manifest.json');
  if (!text) return null;
  try {
    const o = JSON.parse(text) as XingyeWorkspaceManifestV2;
    if (o?.schemaVersion !== 2 || typeof o.layoutVersion !== 'number' || o.layoutVersion < XINGYE_LAYOUT_VERSION) {
      return null;
    }
    return o;
  } catch {
    return null;
  }
}

function parseDataUrl(dataUrl: string): { mime: string; base64: string } | null {
  const m = /^data:([^;,]+);base64,(.*)$/is.exec(dataUrl);
  if (!m) return null;
  return { mime: m[1].trim(), base64: m[2].trim().replace(/\s/g, '') };
}

function extFromMime(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes('png')) return 'png';
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('webp')) return 'webp';
  if (m.includes('gif')) return 'gif';
  return 'bin';
}

export async function materializeProfileMediaForV2(
  agentId: string,
  prof: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const copy = { ...prof };
  const base = `${agentBase(agentId)}/media`;
  const avatarUrl = copy.avatarDataUrl;
  if (typeof avatarUrl === 'string' && avatarUrl.startsWith('data:')) {
    const parsed = parseDataUrl(avatarUrl);
    if (parsed) {
      const ext = extFromMime(parsed.mime);
      const rel = `${base}/avatar.${ext}`;
      await writeFile(rel, parsed.base64, 'base64');
      copy.avatarMediaPath = rel;
      delete copy.avatarDataUrl;
    }
  }
  const bgUrl = copy.chatBackgroundDataUrl;
  if (typeof bgUrl === 'string' && bgUrl.startsWith('data:')) {
    const parsed = parseDataUrl(bgUrl);
    if (parsed) {
      const ext = extFromMime(parsed.mime);
      const rel = `${base}/chat-background.${ext}`;
      await writeFile(rel, parsed.base64, 'base64');
      copy.chatBackgroundMediaPath = rel;
      delete copy.chatBackgroundDataUrl;
    }
  }
  return copy;
}

export async function persistMemoryMapToWorkspaceV2(
  memory: Map<string, string>,
  workspaceRootNormalized: string,
  manifestPatch?: Partial<
    Pick<XingyeWorkspaceManifestV2, 'migratedFromLocalStorageAt' | 'migratedFromLayoutV1At' | 'createdAt'>
  >,
): Promise<void> {
  rejectWorkspaceV2Storage();
  const agentIds = collectXingyeAgentIds(memory);
  const now = new Date().toISOString();
  const prevMan = await readWorkspaceManifestV2();

  const parseObj = (raw: string | undefined): Record<string, unknown> => {
    if (!raw) return {};
    try {
      const p = JSON.parse(raw);
      return isRecord(p) ? p : {};
    } catch {
      return {};
    }
  };

  const profiles = parseObj(memory.get('xingye.roleProfiles')) as Record<string, Record<string, unknown>>;
  const loreMap = parseObj(memory.get('xingye.loreEntries')) as Record<string, Record<string, unknown>>;
  const relStates = parseObj(memory.get('xingye.relationshipStates'));
  const moments = parseObj(memory.get('xingye.moments')) as Record<string, Record<string, unknown>>;
  const mcMap = parseObj(memory.get('xingye.memoryCandidates')) as Record<string, Record<string, unknown>>;

  const cMap = parseObj(memory.get('xingye.phoneContacts'));
  const vMap = parseObj(memory.get('xingye.phoneVirtualContacts'));
  const sMap = parseObj(memory.get('xingye.phoneSmsThreads'));
  const genMap = parseObj(memory.get('xingye.phoneContactGenerationState'));
  const aiGenMap = parseObj(memory.get('xingye.phoneAiGenerationState'));
  const smsHistMap = parseObj(memory.get('xingye.phoneSmsHistoryGenerationState'));
  const snapMap = parseObj(memory.get('xingye.phoneContactSnapshots'));
  const aiUpdMap = parseObj(memory.get('xingye.phoneContactAiUpdateState'));

  const changeItems: unknown[] = (() => {
    const raw = memory.get('xingye.phone.contactChangeLog');
    if (!raw) return [];
    try {
      const p = JSON.parse(raw);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  })();

  /** 电话/SMS 等 map：仅导出属于该 agent 的行（键仍为全局 composite key，值含 ownerAgentId）。 */
  const filterMapByOwner = (m: Record<string, unknown>, agentId: string) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(m)) {
      if (isRecord(v) && v.ownerAgentId === agentId) out[k] = v;
    }
    return out;
  };

  const filterAiGen = (m: Record<string, unknown>, agentId: string) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(m)) {
      if (k.startsWith(`${agentId}::`)) {
        out[k] = v;
        continue;
      }
      if (isRecord(v) && v.ownerAgentId === agentId) out[k] = v;
    }
    return out;
  };

  for (const agentId of agentIds) {
    const prof = profiles[agentId];
    if (prof && typeof prof === 'object') {
      const diskProf = await materializeProfileMediaForV2(agentId, { ...prof, agentId });
      await writeFile(`${agentBase(agentId)}/profile.json`, JSON.stringify(diskProf, null, 2));
    }

    const loreList = Object.values(loreMap).filter((e) => isRecord(e) && (e as { agentId?: string }).agentId === agentId);
    await writeFile(`${agentBase(agentId)}/lore.json`, JSON.stringify(loreList, null, 2));

    const rel = relStates[agentId];
    if (rel && typeof rel === 'object') {
      await writeFile(`${agentBase(agentId)}/relationship/state.json`, JSON.stringify(rel, null, 2));
    }

    const momSub: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(moments)) {
      if (isRecord(v) && v.authorAgentId === agentId) momSub[k] = v;
    }
    await writeFile(`${agentBase(agentId)}/moments/moments.json`, JSON.stringify(momSub, null, 2));

    const mcList = Object.values(mcMap).filter(
      (e) => isRecord(e) && String((e as { agentId?: string }).agentId) === agentId,
    );
    await writeFile(`${agentBase(agentId)}/memory-candidates.json`, JSON.stringify(mcList, null, 2));

    await writeFile(
      `${agentBase(agentId)}/phone/contacts.json`,
      JSON.stringify(filterMapByOwner(cMap, agentId), null, 2),
    );
    await writeFile(
      `${agentBase(agentId)}/phone/virtual-contacts.json`,
      JSON.stringify(filterMapByOwner(vMap, agentId), null, 2),
    );
    const smsByOwner = filterMapByOwner(sMap, agentId);
    // SMS monolith：与 load 侧 `mergeAgentPhoneSmsThreadsMonolith` 路径一致。
    await writeFile(
      `${agentBase(agentId)}/phone/sms-threads.json`,
      JSON.stringify(smsByOwner, null, 2),
    );
    await writeAgentPhoneSmsThreadsPerThread(agentId, smsByOwner, now);

    const genState = genMap[agentId];
    if (genState) {
      await writeFile(`${agentBase(agentId)}/phone/contact-generation-state.json`, JSON.stringify(genState, null, 2));
    }

    const aiPart = filterAiGen(aiGenMap, agentId);
    if (Object.keys(aiPart).length) {
      await writeFile(`${agentBase(agentId)}/phone/ai-generation-state.json`, JSON.stringify(aiPart, null, 2));
    }

    const smsH = smsHistMap[agentId];
    if (smsH) {
      await writeFile(`${agentBase(agentId)}/phone/sms-history-generation-state.json`, JSON.stringify(smsH, null, 2));
    }

    const snaps = snapMap[agentId];
    if (snaps != null) {
      await writeFile(`${agentBase(agentId)}/phone/contact-snapshots.json`, JSON.stringify(snaps, null, 2));
    }

    const aiUpd = aiUpdMap[agentId];
    if (aiUpd != null) {
      await writeFile(`${agentBase(agentId)}/phone/contact-ai-update-state.json`, JSON.stringify(aiUpd, null, 2));
    }

    const changes = changeItems.filter(
      (item) => isRecord(item) && (item as { ownerAgentId?: string }).ownerAgentId === agentId,
    );
    await writeFile(`${agentBase(agentId)}/phone/contact-change-log.json`, JSON.stringify(changes, null, 2));
    const jsonl = changes.map((c) => JSON.stringify(c)).join('\n');
    if (jsonl) {
      await writeFile(`${agentBase(agentId)}/phone/contact-change-log.jsonl`, `${jsonl}\n`);
    }
  }

  const manifest: XingyeWorkspaceManifestV2 = {
    schemaVersion: 2,
    layoutVersion: XINGYE_LAYOUT_VERSION,
    createdAt: manifestPatch?.createdAt ?? prevMan?.createdAt ?? now,
    updatedAt: now,
    workspaceRoot: workspaceRootNormalized,
    workspaceRootHash: workspaceRootHashFromRoot(workspaceRootNormalized),
    migratedFromLocalStorageAt: manifestPatch?.migratedFromLocalStorageAt ?? prevMan?.migratedFromLocalStorageAt,
    migratedFromLayoutV1At: manifestPatch?.migratedFromLayoutV1At ?? prevMan?.migratedFromLayoutV1At,
    agentIds,
  };
  await writeFile('manifest.json', JSON.stringify(manifest, null, 2));
}

export async function loadWorkspaceV2IntoMemoryMap(memory: Map<string, string>): Promise<void> {
  rejectWorkspaceV2Storage();
  const man = await readWorkspaceManifestV2();
  if (!man) return;

  const profiles: Record<string, Record<string, unknown>> = {};
  const loreMerged: Record<string, Record<string, unknown>> = {};
  const relStates: Record<string, unknown> = {};
  const momentsMerged: Record<string, Record<string, unknown>> = {};
  const mcMerged: Record<string, Record<string, unknown>> = {};
  const cMerged: Record<string, unknown> = {};
  const vMerged: Record<string, unknown> = {};
  const sMerged: Record<string, unknown> = {};
  const genMerged: Record<string, unknown> = {};
  const aiGenMerged: Record<string, unknown> = {};
  const smsHistMerged: Record<string, unknown> = {};
  const snapMerged: Record<string, unknown> = {};
  const aiUpdMerged: Record<string, unknown> = {};
  const changeMerged: unknown[] = [];

  const hydrateMediaPath = async (prof: Record<string, unknown>) => {
    const avatarPath = prof.avatarMediaPath;
    if (typeof avatarPath === 'string' && !prof.avatarDataUrl) {
      try {
        const content = await readFileBase64(avatarPath);
        if (content) {
          const ext = (avatarPath.split('.').pop() || 'png').toLowerCase();
          const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
          prof.avatarDataUrl = `data:${mime};base64,${content}`;
        }
      } catch { /* */ }
    }
    const bgPath = prof.chatBackgroundMediaPath;
    if (typeof bgPath === 'string' && !prof.chatBackgroundDataUrl) {
      try {
        const content = await readFileBase64(bgPath);
        if (content) {
          const ext = (bgPath.split('.').pop() || 'webp').toLowerCase();
          const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
          prof.chatBackgroundDataUrl = `data:${mime};base64,${content}`;
        }
      } catch { /* */ }
    }
  };

  for (const agentId of man.agentIds) {
    const profText = await readFileText(`${agentBase(agentId)}/profile.json`);
    if (profText) {
      try {
        const p = JSON.parse(profText) as Record<string, unknown>;
        if (isRecord(p) && typeof p.agentId === 'string') {
          await hydrateMediaPath(p);
          profiles[p.agentId] = p;
        }
      } catch { /* */ }
    }

    const loreText = await readFileText(`${agentBase(agentId)}/lore.json`);
    if (loreText) {
      try {
        const arr = JSON.parse(loreText) as unknown;
        if (Array.isArray(arr)) {
          for (const item of arr) {
            if (!isRecord(item)) continue;
            const id = typeof item.id === 'string' ? item.id : '';
            if (id) loreMerged[id] = item;
          }
        }
      } catch { /* */ }
    }

    const relText = await readFileText(`${agentBase(agentId)}/relationship/state.json`);
    if (relText) {
      try {
        const st = JSON.parse(relText) as unknown;
        if (isRecord(st) && typeof st.agentId === 'string') {
          relStates[st.agentId] = st;
        }
      } catch { /* */ }
    }

    const momText = await readFileText(`${agentBase(agentId)}/moments/moments.json`);
    if (momText) {
      try {
        const o = JSON.parse(momText) as unknown;
        if (isRecord(o)) {
          for (const [k, v] of Object.entries(o)) {
            if (isRecord(v)) momentsMerged[k] = v;
          }
        }
      } catch { /* */ }
    }

    const mcText = await readFileText(`${agentBase(agentId)}/memory-candidates.json`);
    if (mcText) {
      try {
        const arr = JSON.parse(mcText) as unknown;
        if (Array.isArray(arr)) {
          for (const item of arr) {
            if (!isRecord(item)) continue;
            const id = typeof item.id === 'string' ? item.id : '';
            if (id) mcMerged[id] = item;
          }
        }
      } catch { /* */ }
    }

    await mergePhoneJsonObjectFile(`${agentBase(agentId)}/phone/contacts.json`, cMerged);
    await mergePhoneJsonObjectFile(`${agentBase(agentId)}/phone/virtual-contacts.json`, vMerged);
    await mergeAgentPhoneSmsThreadsPerThread(agentId, sMerged);
    await mergeAgentPhoneSmsThreadsMonolith(agentId, sMerged);

    const genT = await readFileText(`${agentBase(agentId)}/phone/contact-generation-state.json`);
    if (genT) {
      try {
        genMerged[agentId] = JSON.parse(genT);
      } catch { /* */ }
    }

    const aiGenT = await readFileText(`${agentBase(agentId)}/phone/ai-generation-state.json`);
    if (aiGenT) {
      try {
        const o = JSON.parse(aiGenT) as Record<string, unknown>;
        for (const [k, v] of Object.entries(o)) {
          aiGenMerged[k] = v;
        }
      } catch { /* */ }
    }

    const smsHistT = await readFileText(`${agentBase(agentId)}/phone/sms-history-generation-state.json`);
    if (smsHistT) {
      try {
        smsHistMerged[agentId] = JSON.parse(smsHistT);
      } catch { /* */ }
    }

    const snapT = await readFileText(`${agentBase(agentId)}/phone/contact-snapshots.json`);
    if (snapT) {
      try {
        snapMerged[agentId] = JSON.parse(snapT);
      } catch { /* */ }
    }

    const aiUpdT = await readFileText(`${agentBase(agentId)}/phone/contact-ai-update-state.json`);
    if (aiUpdT) {
      try {
        aiUpdMerged[agentId] = JSON.parse(aiUpdT);
      } catch { /* */ }
    }

    const chT = await readFileText(`${agentBase(agentId)}/phone/contact-change-log.json`);
    if (chT) {
      try {
        const arr = JSON.parse(chT) as unknown;
        if (Array.isArray(arr)) changeMerged.push(...arr);
      } catch { /* */ }
    }
  }

  memory.set('xingye.roleProfiles', JSON.stringify(profiles));
  memory.set('xingye.loreEntries', JSON.stringify(loreMerged));
  memory.set('xingye.relationshipStates', JSON.stringify(relStates));
  memory.set('xingye.moments', JSON.stringify(momentsMerged));
  memory.set('xingye.memoryCandidates', JSON.stringify(mcMerged));
  memory.set('xingye.phoneContacts', JSON.stringify(cMerged));
  memory.set('xingye.phoneVirtualContacts', JSON.stringify(vMerged));
  memory.set('xingye.phoneSmsThreads', JSON.stringify(sMerged));
  memory.set('xingye.phoneContactGenerationState', JSON.stringify(genMerged));
  memory.set('xingye.phoneAiGenerationState', JSON.stringify(aiGenMerged));
  memory.set('xingye.phoneSmsHistoryGenerationState', JSON.stringify(smsHistMerged));
  memory.set('xingye.phoneContactSnapshots', JSON.stringify(snapMerged));
  memory.set('xingye.phoneContactAiUpdateState', JSON.stringify(aiUpdMerged));
  memory.set('xingye.phone.contactChangeLog', JSON.stringify(changeMerged));
}
