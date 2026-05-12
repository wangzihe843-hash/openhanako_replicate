export type XingyeStorageBackend = {
  readJson<T>(agentId: string, relativePath: string): Promise<T | null>;
  writeJson<T>(agentId: string, relativePath: string, data: T): Promise<void>;
  appendJsonl<T>(agentId: string, relativePath: string, record: T): Promise<void>;
  listJsonl<T>(agentId: string, relativePath: string): Promise<T[]>;
};

function key(agentId: string, relativePath: string): string {
  return `${agentId}::${relativePath}`;
}

export function createMemoryXingyeStorageBackend(): XingyeStorageBackend {
  const json = new Map<string, string>();
  const jsonl = new Map<string, string[]>();

  return {
    async readJson<T>(agentId: string, relativePath: string): Promise<T | null> {
      const raw = json.get(key(agentId, relativePath));
      if (raw == null) return null;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return null;
      }
    },
    async writeJson<T>(agentId: string, relativePath: string, data: T): Promise<void> {
      json.set(key(agentId, relativePath), JSON.stringify(data));
    },
    async appendJsonl<T>(agentId: string, relativePath: string, record: T): Promise<void> {
      const k = key(agentId, relativePath);
      jsonl.set(k, [...(jsonl.get(k) ?? []), JSON.stringify(record)]);
    },
    async listJsonl<T>(agentId: string, relativePath: string): Promise<T[]> {
      const out: T[] = [];
      for (const line of jsonl.get(key(agentId, relativePath)) ?? []) {
        try {
          out.push(JSON.parse(line) as T);
        } catch {
          // skip malformed development fallback data
        }
      }
      return out;
    },
  };
}

export function createLocalStorageXingyeBackend(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  keyForPath: (agentId: string, relativePath: string) => string,
): XingyeStorageBackend {
  return {
    async readJson<T>(agentId: string, relativePath: string): Promise<T | null> {
      const raw = storage.getItem(keyForPath(agentId, relativePath));
      if (raw == null) return null;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return null;
      }
    },
    async writeJson<T>(agentId: string, relativePath: string, data: T): Promise<void> {
      storage.setItem(keyForPath(agentId, relativePath), JSON.stringify(data));
    },
    async appendJsonl<T>(agentId: string, relativePath: string, record: T): Promise<void> {
      const k = keyForPath(agentId, relativePath);
      const line = `${JSON.stringify(record)}\n`;
      storage.setItem(k, (storage.getItem(k) ?? '') + line);
    },
    async listJsonl<T>(agentId: string, relativePath: string): Promise<T[]> {
      const raw = storage.getItem(keyForPath(agentId, relativePath));
      if (!raw) return [];
      const out: T[] = [];
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          out.push(JSON.parse(trimmed) as T);
        } catch {
          // skip malformed development fallback data
        }
      }
      return out;
    },
  };
}

type PostFn = (body: Record<string, unknown>) => Promise<any>;

export function createAgentXingyeStorageBackend(post: PostFn): XingyeStorageBackend {
  return {
    async readJson<T>(agentId: string, relativePath: string): Promise<T | null> {
      const data = await post({ action: 'readJson', agentId, relativePath });
      if (data?.missing || data?.data == null) return null;
      return data.data as T;
    },
    async writeJson<T>(agentId: string, relativePath: string, body: T): Promise<void> {
      await post({ action: 'writeJson', agentId, relativePath, data: body });
    },
    async appendJsonl<T>(agentId: string, relativePath: string, record: T): Promise<void> {
      await post({ action: 'appendJsonl', agentId, relativePath, data: record });
    },
    async listJsonl<T>(agentId: string, relativePath: string): Promise<T[]> {
      const data = await post({ action: 'listJsonl', agentId, relativePath });
      return Array.isArray(data?.records) ? data.records as T[] : [];
    },
  };
}
