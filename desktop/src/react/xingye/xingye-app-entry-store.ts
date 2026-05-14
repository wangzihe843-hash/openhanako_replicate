import type { XingyeStorageBackend } from './xingye-storage-backend';
import {
  createXingyeStore,
  generateXingyeId,
  nowIso,
  requireSafeXingyeAgentId,
  resolveAgentScopedXingyePath,
} from './xingye-store-utils';

export const XINGYE_APP_ENTRY_APP_IDS = [
  'diary',
  'divination',
  'shopping',
  'reading_notes',
] as const;

export type XingyeAppEntryAppId = typeof XINGYE_APP_ENTRY_APP_IDS[number];

export type AppEntry = {
  id: string;
  agentId: string;
  appId: XingyeAppEntryAppId;
  title: string;
  content: string;
  metadata: Record<string, unknown>;
  source: string;
  createdAt: string;
  updatedAt: string;
};

export type AppEntryInput = {
  title: string;
  content: string;
  metadata?: Record<string, unknown>;
  source?: string;
};

export type AppEntryPatch = Partial<AppEntryInput>;

export type XingyeAppEntryStoreOptions = {
  idFactory?: () => string;
  now?: () => string;
};

/** Divination JSONL lives at `apps/divination/entries.jsonl` under each agent's `xingye/` directory. */
export const XINGYE_DIVINATION_APP_ID = 'divination' as const satisfies XingyeAppEntryAppId;

export type DivinationEntryMetadata = {
  method: string;
  methodLabel: string;
  /**
   * 历史兼容：旧记录可能仅有 `question`。
   * 新语义下应与 `agentQuestion` 同步，表示 TA 自己想确认的事，而非用户替问。
   */
  question: string;
  /** TA 自己想确认的事（占问主体，由 agent 侧生成）。 */
  agentQuestion: string;
  /** 用户可选关注方向（不是最终占问）。 */
  userProvidedTheme?: string;
  themeHint?: string;
  /** 写入占卜记录时的上下文来源摘要（人类可读）。 */
  contextSummary?: string;
  symbols: unknown[];
  autoSelected: boolean;
  resolverReason: string;
};

export type DivinationEntry = Omit<AppEntry, 'appId' | 'metadata'> & {
  appId: typeof XINGYE_DIVINATION_APP_ID;
  metadata: DivinationEntryMetadata;
};

export type DivinationEntryAppendInput = {
  title: string;
  content: string;
  metadata?: Partial<DivinationEntryMetadata>;
};

const SIMPLE_APP_ENTRY_IDS = new Set<string>(XINGYE_APP_ENTRY_APP_IDS);

function requireSimpleAppId(appId: string): XingyeAppEntryAppId {
  const id = String(appId ?? '').trim();
  if (!SIMPLE_APP_ENTRY_IDS.has(id)) {
    throw new Error('appId is not supported by the simple AppEntry store');
  }
  return id as XingyeAppEntryAppId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeMetadata(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function normalizeEntry(value: unknown, agentId: string, appId: XingyeAppEntryAppId): AppEntry | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === 'string' && value.id.trim() ? value.id.trim() : '';
  if (!id) return null;
  return {
    id,
    agentId,
    appId,
    title: typeof value.title === 'string' ? value.title : '',
    content: typeof value.content === 'string' ? value.content : '',
    metadata: normalizeMetadata(value.metadata),
    source: typeof value.source === 'string' && value.source.trim() ? value.source : 'manual',
    createdAt: typeof value.createdAt === 'string' && value.createdAt ? value.createdAt : new Date(0).toISOString(),
    updatedAt: typeof value.updatedAt === 'string' && value.updatedAt ? value.updatedAt : new Date(0).toISOString(),
  };
}

export function xingyeAppEntriesPath(appId: XingyeAppEntryAppId | string): string {
  return `apps/${requireSimpleAppId(appId)}/entries.jsonl`;
}

/** Resolved `HANA_HOME/agents/{agentId}/xingye/apps/divination/entries.jsonl` for logging and diagnostics. */
export function resolveDivinationEntriesScopedPath(agentId: string) {
  return resolveAgentScopedXingyePath(agentId, xingyeAppEntriesPath(XINGYE_DIVINATION_APP_ID));
}

export function createXingyeAppEntryStore(
  backend?: XingyeStorageBackend,
  options: XingyeAppEntryStoreOptions = {},
) {
  const store = createXingyeStore(backend);
  const idFactory = options.idFactory ?? (() => generateXingyeId('app-entry'));
  const getNow = options.now ?? nowIso;

  return {
    async listEntries(agentId: string, appId: XingyeAppEntryAppId | string): Promise<AppEntry[]> {
      const aid = requireSafeXingyeAgentId(agentId);
      const simpleAppId = requireSimpleAppId(appId);
      const rows = await store.listJsonl<unknown>(aid, xingyeAppEntriesPath(simpleAppId));
      return rows
        .map((row) => normalizeEntry(row, aid, simpleAppId))
        .filter((entry): entry is AppEntry => Boolean(entry));
    },

    async appendEntry(
      agentId: string,
      appId: XingyeAppEntryAppId | string,
      input: AppEntryInput,
    ): Promise<AppEntry> {
      const aid = requireSafeXingyeAgentId(agentId);
      const simpleAppId = requireSimpleAppId(appId);
      const timestamp = getNow();
      const entry: AppEntry = {
        id: idFactory(),
        agentId: aid,
        appId: simpleAppId,
        title: input.title.trim(),
        content: input.content,
        metadata: normalizeMetadata(input.metadata),
        source: input.source?.trim() || 'manual',
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await store.appendJsonl<AppEntry>(aid, xingyeAppEntriesPath(simpleAppId), entry);
      return entry;
    },

    async updateEntry(
      agentId: string,
      appId: XingyeAppEntryAppId | string,
      entryId: string,
      patch: AppEntryPatch,
    ): Promise<AppEntry | null> {
      const aid = requireSafeXingyeAgentId(agentId);
      const simpleAppId = requireSimpleAppId(appId);
      const updatedAt = getNow();
      return store.updateJsonlRecord<AppEntry>(
        aid,
        xingyeAppEntriesPath(simpleAppId),
        entryId,
        (entry) => ({
          ...entry,
          title: patch.title === undefined ? entry.title : patch.title.trim(),
          content: patch.content === undefined ? entry.content : patch.content,
          metadata: patch.metadata === undefined ? entry.metadata : normalizeMetadata(patch.metadata),
          source: patch.source === undefined ? entry.source : (patch.source.trim() || 'manual'),
          updatedAt,
        }),
      );
    },

    deleteEntry(agentId: string, appId: XingyeAppEntryAppId | string, entryId: string): Promise<boolean> {
      const aid = requireSafeXingyeAgentId(agentId);
      const simpleAppId = requireSimpleAppId(appId);
      return store.deleteJsonlRecord(aid, xingyeAppEntriesPath(simpleAppId), entryId);
    },
  };
}

export type XingyeAppEntryStoreApi = Pick<
  ReturnType<typeof createXingyeAppEntryStore>,
  'listEntries' | 'appendEntry' | 'deleteEntry'
>;

function normalizeDivinationMetadata(meta: Record<string, unknown>): DivinationEntryMetadata {
  const symbols = meta.symbols;
  const rawQ = typeof meta.question === 'string' ? meta.question : '';
  const rawAq = typeof meta.agentQuestion === 'string' ? meta.agentQuestion : '';
  const agentQuestion = rawAq.trim() || rawQ.trim();
  const question = rawQ.trim() || rawAq.trim();

  const out: DivinationEntryMetadata = {
    method: typeof meta.method === 'string' ? meta.method : '',
    methodLabel: typeof meta.methodLabel === 'string' ? meta.methodLabel : '',
    question,
    agentQuestion,
    symbols: Array.isArray(symbols) ? symbols : [],
    autoSelected: Boolean(meta.autoSelected),
    resolverReason: typeof meta.resolverReason === 'string' ? meta.resolverReason : '',
  };
  if (typeof meta.userProvidedTheme === 'string' && meta.userProvidedTheme.trim()) {
    out.userProvidedTheme = meta.userProvidedTheme.trim();
  }
  if (typeof meta.themeHint === 'string' && meta.themeHint.trim()) {
    out.themeHint = meta.themeHint.trim();
  }
  if (typeof meta.contextSummary === 'string' && meta.contextSummary.trim()) {
    out.contextSummary = meta.contextSummary.trim();
  }
  return out;
}

function mergeDivinationMetadata(partial?: Partial<DivinationEntryMetadata>): DivinationEntryMetadata {
  const agentQuestion = (partial?.agentQuestion?.trim() || partial?.question?.trim() || '');
  const legacyQuestion = (partial?.question?.trim() || '');
  const resolvedAgent = agentQuestion || legacyQuestion;
  const resolvedLegacy = legacyQuestion || agentQuestion;

  const out: DivinationEntryMetadata = {
    method: partial?.method ?? '',
    methodLabel: partial?.methodLabel ?? '',
    question: resolvedLegacy,
    agentQuestion: resolvedAgent,
    symbols: Array.isArray(partial?.symbols) ? partial!.symbols : [],
    autoSelected: Boolean(partial?.autoSelected),
    resolverReason: partial?.resolverReason ?? '',
  };
  const ut = partial?.userProvidedTheme?.trim();
  if (ut) out.userProvidedTheme = ut;
  const th = partial?.themeHint?.trim();
  if (th) out.themeHint = th;
  const cs = partial?.contextSummary?.trim();
  if (cs) out.contextSummary = cs;
  return out;
}

/** 列表/详情展示用：优先 agentQuestion，回退旧字段 question。 */
export function getDivinationEntryAgentTopic(meta: DivinationEntryMetadata): string {
  const aq = typeof meta.agentQuestion === 'string' ? meta.agentQuestion.trim() : '';
  if (aq) return aq;
  const q = typeof meta.question === 'string' ? meta.question.trim() : '';
  return q;
}

export function getDivinationEntryUserThemeHint(meta: DivinationEntryMetadata): string | undefined {
  const u = typeof meta.userProvidedTheme === 'string' ? meta.userProvidedTheme.trim() : '';
  if (u) return u;
  const t = typeof meta.themeHint === 'string' ? meta.themeHint.trim() : '';
  return t || undefined;
}

export function createDivinationEntryApi(store: XingyeAppEntryStoreApi) {
  return {
    async loadDivinationEntries(agentId: string): Promise<DivinationEntry[]> {
      const rows = await store.listEntries(agentId, XINGYE_DIVINATION_APP_ID);
      return rows.map((row) => ({
        ...row,
        appId: XINGYE_DIVINATION_APP_ID,
        metadata: normalizeDivinationMetadata(row.metadata),
      }));
    },

    async appendDivinationEntry(agentId: string, input: DivinationEntryAppendInput): Promise<DivinationEntry> {
      const metadata = mergeDivinationMetadata(input.metadata);
      const entry = await store.appendEntry(agentId, XINGYE_DIVINATION_APP_ID, {
        title: input.title,
        content: input.content,
        metadata: metadata as Record<string, unknown>,
        source: 'divination',
      });
      return { ...entry, appId: XINGYE_DIVINATION_APP_ID, metadata };
    },

    deleteDivinationEntry(agentId: string, entryId: string): Promise<boolean> {
      return store.deleteEntry(agentId, XINGYE_DIVINATION_APP_ID, entryId);
    },
  };
}

const defaultAppEntryStore = createXingyeAppEntryStore();
const defaultDivinationEntryApi = createDivinationEntryApi(defaultAppEntryStore);

export const loadDivinationEntries = defaultDivinationEntryApi.loadDivinationEntries;
export const appendDivinationEntry = defaultDivinationEntryApi.appendDivinationEntry;
export const deleteDivinationEntry = defaultDivinationEntryApi.deleteDivinationEntry;

export const listAppEntries = defaultAppEntryStore.listEntries;
export const appendAppEntry = defaultAppEntryStore.appendEntry;
export const updateAppEntry = defaultAppEntryStore.updateEntry;
export const deleteAppEntry = defaultAppEntryStore.deleteEntry;
