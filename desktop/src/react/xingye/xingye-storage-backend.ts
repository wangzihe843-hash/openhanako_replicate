import { sanitizeAgentIdForPath } from './xingye-agent-path';

export type XingyeStorageBackend = {
  readJson<T>(agentId: string, domain: string): Promise<T | null>;
  writeJson<T>(agentId: string, domain: string, data: T): Promise<void>;
  appendRecord<T>(agentId: string, domain: string, record: T): Promise<void>;
  listRecords<T>(agentId: string, domain: string): Promise<T[]>;
};

function agentPrefix(agentId: string): string {
  const safe = sanitizeAgentIdForPath(agentId);
  return `agents/${safe}`;
}

/** 内存实现：测试与本地原型。 */
export function createMemoryXingyeStorageBackend(): XingyeStorageBackend {
  const json = new Map<string, string>();
  const lines = new Map<string, string[]>();

  const key = (agentId: string, domain: string, kind: 'json' | 'log') =>
    `${agentId}::${domain}::${kind}`;

  return {
    async readJson<T>(agentId: string, domain: string): Promise<T | null> {
      const raw = json.get(key(agentId, domain, 'json'));
      if (raw == null) return null;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return null;
      }
    },
    async writeJson<T>(agentId: string, domain: string, data: T): Promise<void> {
      json.set(key(agentId, domain, 'json'), JSON.stringify(data));
    },
    async appendRecord<T>(agentId: string, domain: string, record: T): Promise<void> {
      const k = key(agentId, domain, 'log');
      const prev = lines.get(k) ?? [];
      prev.push(JSON.stringify(record));
      lines.set(k, prev);
    },
    async listRecords<T>(agentId: string, domain: string): Promise<T[]> {
      const k = key(agentId, domain, 'log');
      const arr = lines.get(k) ?? [];
      const out: T[] = [];
      for (const line of arr) {
        try {
          out.push(JSON.parse(line) as T);
        } catch { /* skip */ }
      }
      return out;
    },
  };
}

/** 将 domain 映射到旧版 localStorage 单键（仅用于迁移/兼容测试）。 */
export function createLocalStorageXingyeBackend(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  keyForDomain: (agentId: string, domain: string) => string,
): XingyeStorageBackend {
  return {
    async readJson<T>(agentId: string, domain: string): Promise<T | null> {
      const raw = storage.getItem(keyForDomain(agentId, domain));
      if (raw == null) return null;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return null;
      }
    },
    async writeJson<T>(agentId: string, domain: string, data: T): Promise<void> {
      storage.setItem(keyForDomain(agentId, domain), JSON.stringify(data));
    },
    async appendRecord<T>(agentId: string, domain: string, record: T): Promise<void> {
      const k = keyForDomain(agentId, `${domain}.jsonl`);
      const prev = storage.getItem(k);
      const line = `${JSON.stringify(record)}\n`;
      storage.setItem(k, (prev ?? '') + line);
    },
    async listRecords<T>(agentId: string, domain: string): Promise<T[]> {
      const k = keyForDomain(agentId, `${domain}.jsonl`);
      const raw = storage.getItem(k);
      if (!raw) return [];
      const out: T[] = [];
      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          out.push(JSON.parse(t) as T);
        } catch { /* skip */ }
      }
      return out;
    },
  };
}

type PostFn = (body: Record<string, unknown>) => Promise<any>;

/**
 * Workspace 实现：domain 为相对路径 stem（不含 .json），例如 `profile`、`phone/contacts`。
 * appendRecord / listRecords 使用 `records/{domain}.jsonl`。
 */
export function createWorkspaceXingyeStorageBackend(post: PostFn): XingyeStorageBackend {
  const jsonRel = (agentId: string, domain: string) => `${agentPrefix(agentId)}/${domain}.json`;
  const logRel = (agentId: string, domain: string) => `${agentPrefix(agentId)}/records/${domain}.jsonl`;

  return {
    async readJson<T>(agentId: string, domain: string): Promise<T | null> {
      const data = await post({ action: 'read', relativePath: jsonRel(agentId, domain) });
      if (data?.missing || data?.content == null) return null;
      if (typeof data.content !== 'string') return null;
      try {
        return JSON.parse(data.content) as T;
      } catch {
        return null;
      }
    },
    async writeJson<T>(agentId: string, domain: string, body: T): Promise<void> {
      await post({
        action: 'write',
        relativePath: jsonRel(agentId, domain),
        content: JSON.stringify(body, null, 2),
        encoding: 'utf8',
      });
    },
    async appendRecord<T>(agentId: string, domain: string, record: T): Promise<void> {
      await post({
        action: 'append',
        relativePath: logRel(agentId, domain),
        content: `${JSON.stringify(record)}\n`,
      });
    },
    async listRecords<T>(agentId: string, domain: string): Promise<T[]> {
      const data = await post({ action: 'read', relativePath: logRel(agentId, domain) });
      if (data?.missing || data?.content == null || typeof data.content !== 'string') return [];
      const out: T[] = [];
      for (const line of data.content.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          out.push(JSON.parse(t) as T);
        } catch { /* skip */ }
      }
      return out;
    },
  };
}
