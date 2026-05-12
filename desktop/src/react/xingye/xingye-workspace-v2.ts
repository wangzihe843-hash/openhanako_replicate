/**
 * 星野 workspace v2：按 agent 分域落盘；与 v1/data/*.json 可读兼容。
 */

import { sanitizeAgentIdForPath } from './xingye-agent-path';
import { postXingyeStorage } from './xingye-storage-api';

export const XINGYE_LAYOUT_VERSION = 2;

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

async function writeFile(rel: string, content: string, encoding: 'utf8' | 'base64' = 'utf8'): Promise<void> {
  await postXingyeStorage({
    action: 'write',
    relativePath: rel,
    content,
    encoding,
  });
}

async function readFileText(rel: string): Promise<string | null> {
  const data = await postXingyeStorage({ action: 'read', relativePath: rel });
  if (data?.missing || data?.content == null) return null;
  return typeof data.content === 'string' ? data.content : null;
}

/** 读取单个 phone 类 JSON 对象文件（composite key → record），合并进内存 bucket。 */
async function mergePhoneJsonObjectFile(rel: string, bucket: Record<string, unknown>): Promise<void> {
  const t = await readFileText(rel);
  if (!t) return;
  try {
    const o = JSON.parse(t) as unknown;
    if (!isRecord(o)) return;
    for (const [k, v] of Object.entries(o)) {
      bucket[k] = v;
    }
  } catch { /* */ }
}

/**
 * Workspace v2 SMS **monolith** loader：只读 `agents/<id>/phone/sms-threads.json`。
 * 文件内为扁平对象，键与 localStorage `xingye.phoneSmsThreads` 相同（`ownerAgentId::targetType::targetId`）。
 * 未来若改为 per-thread / index，应在此函数旁增加分支；本轮不读取 `sms-index.json` 或 per-thread 文件，以免半迁移双格式。
 *
 * **Migration marker（仅规范，运行时暂不读写）：** 将来可选用例如 `agents/<id>/phone/.sms-storage-version`
 * 声明布局版本；未迁移 agent 仅有本 monolith 文件即可。
 */
async function mergeAgentPhoneSmsThreadsMonolith(agentId: string, bucket: Record<string, unknown>): Promise<void> {
  await mergePhoneJsonObjectFile(`${agentBase(agentId)}/phone/sms-threads.json`, bucket);
}

export async function readWorkspaceManifestV2(): Promise<XingyeWorkspaceManifestV2 | null> {
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
    // SMS monolith：与 load 侧 `mergeAgentPhoneSmsThreadsMonolith` 路径一致。
    await writeFile(
      `${agentBase(agentId)}/phone/sms-threads.json`,
      JSON.stringify(filterMapByOwner(sMap, agentId), null, 2),
    );

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
        const r = await postXingyeStorage({ action: 'read', relativePath: avatarPath, binary: true });
        if (r?.encoding === 'base64' && r?.content) {
          const ext = (avatarPath.split('.').pop() || 'png').toLowerCase();
          const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
          prof.avatarDataUrl = `data:${mime};base64,${r.content}`;
        }
      } catch { /* */ }
    }
    const bgPath = prof.chatBackgroundMediaPath;
    if (typeof bgPath === 'string' && !prof.chatBackgroundDataUrl) {
      try {
        const r = await postXingyeStorage({ action: 'read', relativePath: bgPath, binary: true });
        if (r?.encoding === 'base64' && r?.content) {
          const ext = (bgPath.split('.').pop() || 'webp').toLowerCase();
          const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
          prof.chatBackgroundDataUrl = `data:${mime};base64,${r.content}`;
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
