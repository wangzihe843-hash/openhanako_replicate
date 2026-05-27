/**
 * @vitest-environment node
 *
 * store 的核心是 hash + memory backend 的读写流程；
 * 走真服务端的部分这里都 mock 掉（postXingyeStorage）改用内存 backend。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./xingye-storage-api', () => ({ postXingyeStorage: vi.fn() }));

const memJson = new Map<string, string>();
const memJsonl = new Map<string, string[]>();

function backendKey(agentId: string, rel: string): string {
  return `${agentId}::${rel}`;
}

vi.mock('./xingye-storage-backend', () => ({
  createAgentXingyeStorageBackend: () => ({
    async readJson(agentId: string, rel: string) {
      const v = memJson.get(backendKey(agentId, rel));
      return v ? JSON.parse(v) : null;
    },
    async writeJson(agentId: string, rel: string, data: unknown) {
      memJson.set(backendKey(agentId, rel), JSON.stringify(data));
    },
    async listJsonl(agentId: string, rel: string) {
      const arr = memJsonl.get(backendKey(agentId, rel)) ?? [];
      return arr.map((line) => JSON.parse(line));
    },
    async appendJsonl(agentId: string, rel: string, record: unknown) {
      const k = backendKey(agentId, rel);
      const arr = memJsonl.get(k) ?? [];
      arr.push(JSON.stringify(record));
      memJsonl.set(k, arr);
    },
    async deleteJsonlRecord(agentId: string, rel: string, recordId: string) {
      const k = backendKey(agentId, rel);
      const arr = memJsonl.get(k);
      if (!arr) return false;
      const next: string[] = [];
      let deleted = false;
      for (const line of arr) {
        try {
          const obj = JSON.parse(line);
          if (!deleted && (obj.id === recordId || obj.key === recordId)) {
            deleted = true;
            continue;
          }
        } catch {}
        next.push(line);
      }
      memJsonl.set(k, next);
      return deleted;
    },
    async writeJsonl(agentId: string, rel: string, records: unknown[]) {
      memJsonl.set(
        backendKey(agentId, rel),
        records.map((r) => JSON.stringify(r)),
      );
    },
  }),
}));

vi.mock('./xingye-event-log', () => ({
  appendXingyeEvent: vi.fn().mockResolvedValue(undefined),
}));

import {
  appendHiddenEntry,
  attemptUnlock,
  deleteHiddenEntry,
  hashPassword,
  listHiddenEntries,
  markHiddenFolderSeedGenerated,
  maybeRelockOnHeartbeat,
  readHiddenFolderState,
  setHiddenFolderPassword,
} from './xingye-files-secret-store';

beforeEach(() => {
  memJson.clear();
  memJsonl.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('hashPassword', () => {
  it('相同输入产生相同 hash（lowercase + trim）', async () => {
    const a = await hashPassword('LW');
    const b = await hashPassword('  lw  ');
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(8);
  });

  it('不同输入产生不同 hash', async () => {
    const a = await hashPassword('AA');
    const b = await hashPassword('BB');
    expect(a).not.toBe(b);
  });

  it('空输入返回空字符串', async () => {
    expect(await hashPassword('')).toBe('');
    expect(await hashPassword('   ')).toBe('');
  });
});

describe('readHiddenFolderState / setHiddenFolderPassword', () => {
  it('初始读取返回默认 locked + 空 hash', async () => {
    const s = await readHiddenFolderState('a1');
    expect(s.locked).toBe(true);
    expect(s.passwordHash).toBe('');
  });

  it('setHiddenFolderPassword 写入后读回一致', async () => {
    const s = await setHiddenFolderPassword('a1', { password: 'LW', candidateLabel: '林雾首字母' });
    expect(s.locked).toBe(true);
    expect(s.passwordHash.length).toBeGreaterThan(8);
    expect(s.candidateLabel).toBe('林雾首字母');

    const reread = await readHiddenFolderState('a1');
    expect(reread.passwordHash).toBe(s.passwordHash);
    expect(reread.candidateLabel).toBe('林雾首字母');
  });
});

describe('attemptUnlock', () => {
  it('密码正确 → ok=true, 状态变为 unlocked', async () => {
    await setHiddenFolderPassword('a1', { password: 'LW', candidateLabel: 'x' });
    const r = await attemptUnlock('a1', 'lw');
    expect(r.ok).toBe(true);
    expect(r.state.locked).toBe(false);
    expect(r.state.lastUnlockedAt).toBeDefined();
  });

  it('密码错误 → ok=false, 状态保持 locked', async () => {
    await setHiddenFolderPassword('a1', { password: 'LW', candidateLabel: 'x' });
    const r = await attemptUnlock('a1', 'WRONG');
    expect(r.ok).toBe(false);
    expect(r.state.locked).toBe(true);
  });

  it('passwordHash 为空时一律返回 false（防止「无密码可解」漏锁）', async () => {
    const r = await attemptUnlock('a1', 'whatever');
    expect(r.ok).toBe(false);
  });
});

describe('maybeRelockOnHeartbeat', () => {
  it('解锁状态 + 命中概率 → 重锁 + 写入新 hash', async () => {
    await setHiddenFolderPassword('a1', { password: 'OLD', candidateLabel: 'old' });
    await attemptUnlock('a1', 'OLD');

    const r = await maybeRelockOnHeartbeat('a1', {
      nextPassword: 'NEW',
      nextCandidateLabel: 'new',
      probability: 0.5,
      randomSource: () => 0, // 永远命中
    });
    expect(r.relocked).toBe(true);
    expect(r.state.locked).toBe(true);
    expect(r.state.candidateLabel).toBe('new');

    /** 旧密码已废弃。 */
    const oldAttempt = await attemptUnlock('a1', 'OLD');
    expect(oldAttempt.ok).toBe(false);
    /** 新密码生效。 */
    const newAttempt = await attemptUnlock('a1', 'NEW');
    expect(newAttempt.ok).toBe(true);
  });

  it('未命中概率 → 不重锁', async () => {
    await setHiddenFolderPassword('a1', { password: 'OLD', candidateLabel: 'old' });
    await attemptUnlock('a1', 'OLD');
    const r = await maybeRelockOnHeartbeat('a1', {
      nextPassword: 'NEW',
      nextCandidateLabel: 'new',
      probability: 0.02,
      randomSource: () => 0.5, // 大于概率
    });
    expect(r.relocked).toBe(false);
    expect(r.state.locked).toBe(false);
  });

  it('已经处于上锁状态 → 不重锁', async () => {
    await setHiddenFolderPassword('a1', { password: 'X', candidateLabel: 'x' });
    const r = await maybeRelockOnHeartbeat('a1', {
      nextPassword: 'Y',
      nextCandidateLabel: 'y',
      probability: 1,
      randomSource: () => 0,
    });
    expect(r.relocked).toBe(false);
    /** 候选密码 X 应该还能解锁。 */
    const unlock = await attemptUnlock('a1', 'X');
    expect(unlock.ok).toBe(true);
  });

  it('nextPassword 为空字符串 → 不重锁', async () => {
    await setHiddenFolderPassword('a1', { password: 'X', candidateLabel: 'x' });
    await attemptUnlock('a1', 'X');
    const r = await maybeRelockOnHeartbeat('a1', {
      nextPassword: '   ',
      nextCandidateLabel: 'y',
      probability: 1,
      randomSource: () => 0,
    });
    expect(r.relocked).toBe(false);
  });
});

describe('hidden entries CRUD', () => {
  it('appendHiddenEntry + listHiddenEntries 反映新条目', async () => {
    const entry = await appendHiddenEntry('a1', {
      kind: 'weakness',
      title: '弱点 1',
      body: '只在生人面前手会抖。',
    });
    expect(entry.id).toBeTruthy();
    const all = await listHiddenEntries('a1');
    expect(all).toHaveLength(1);
    expect(all[0].title).toBe('弱点 1');
    expect(all[0].kind).toBe('weakness');
  });

  it('deleteHiddenEntry 命中返回 true 并从列表移除', async () => {
    const e = await appendHiddenEntry('a1', { kind: 'manual', title: 'gone', body: 'x' });
    const ok = await deleteHiddenEntry('a1', e.id);
    expect(ok).toBe(true);
    const all = await listHiddenEntries('a1');
    expect(all).toHaveLength(0);
  });

  it('appendHiddenEntry 标题为空 → 抛错', async () => {
    await expect(
      appendHiddenEntry('a1', { kind: 'manual', title: '  ', body: '' }),
    ).rejects.toThrow();
  });
});

describe('markHiddenFolderSeedGenerated', () => {
  it('标记后 seedGenerated 持久化', async () => {
    const s = await markHiddenFolderSeedGenerated('a1');
    expect(s.seedGenerated).toBe(true);
    const reread = await readHiddenFolderState('a1');
    expect(reread.seedGenerated).toBe(true);
  });
});
