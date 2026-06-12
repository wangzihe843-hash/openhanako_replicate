import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Agent } from '../types';
import { useStore } from '../stores';
import styles from './XingyeShell.module.css';
import { generateFilesDraftWithAI } from './xingye-files-ai';
import { runFilesBatchAdd, runFilesInit, type FilesBatchSummary } from './xingye-files-batch-ai';
import {
  appendFileEntry,
  confirmFileDraft,
  deleteFileEntry,
  discardFileDraft,
  DuplicateFileEntryError,
  ensureDefaultFileFolders,
  listFileDrafts,
  listFileEntries,
  listFileFolders,
  resolveFolderIdFromHint,
  resolveTargetEntry,
  updateFileEntry,
  type XingyeFileDraftPatch,
  type XingyePendingFileDraft,
  type XingyeFileEntry,
  type XingyeFileEntryDraft,
  type XingyeFileFolder,
} from './xingye-files-store';
import type { XingyeRoleProfile } from './xingye-profile-store';
import { listLoreEntries } from './xingye-lore-store';
// 已确认条目：待「新的朋友」通过的候选不参与密码素材/隐藏种子上下文。
import { getConfirmedVirtualContacts } from './xingye-phone-store';
import { getXingyePersistenceStorage } from './xingye-persistence';
import {
  collectHiddenPasswordCandidates,
  pickRandomCandidate,
} from './xingye-files-secret-passwords';
import {
  appendHiddenEntry,
  attemptUnlock,
  deleteHiddenEntry,
  listHiddenEntries,
  markHiddenFolderSeedGenerated,
  readHiddenFolderState,
  setHiddenFolderPassword,
  type XingyeHiddenFileEntry,
  type XingyeHiddenFileEntryKind,
  type XingyeHiddenFolderState,
} from './xingye-files-secret-store';
import { generateHiddenSeedsWithAI } from './xingye-files-secret-ai';
import {
  HiddenFolderRow,
  HiddenFolderView,
  HiddenPasswordModal,
  getWrongPasswordReaction,
} from './PhoneFilesHiddenFolder';

export interface PhoneFilesAppProps {
  ownerAgent: Agent | null;
  ownerProfile?: XingyeRoleProfile | null;
  displayName: string;
  onBack: () => void;
}

type ComposeMode = { kind: 'create'; folderId: string } | { kind: 'edit'; entry: XingyeFileEntry };

type FolderTint = 'terracotta' | 'plum' | 'ochre' | 'sage' | 'slate';
type FolderIcon = 'globe' | 'users' | 'heart' | 'search' | 'draft';

/**
 * 5 个默认文件夹（ensureDefaultFileFolders 创建的）按名字硬编码 tint/icon。
 * 见 optimized/IMPLEMENTATION_NOTES.md 2.2 表。
 */
const DEFAULT_FOLDER_PRESETS: Record<string, { tint: FolderTint; icon: FolderIcon }> = {
  '世界观整理': { tint: 'terracotta', icon: 'globe' },
  '人际关系':   { tint: 'plum',       icon: 'users' },
  '关于 user':  { tint: 'ochre',      icon: 'heart' },
  '线索与发现': { tint: 'sage',       icon: 'search' },
  '待确认':     { tint: 'slate',      icon: 'draft' },
};

const TINT_CYCLE: FolderTint[] = ['terracotta', 'plum', 'ochre', 'sage', 'slate'];

function hashStringToIndex(str: string, mod: number): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h) % Math.max(1, mod);
}

function getFolderPresentation(folder: XingyeFileFolder): { tint: FolderTint; icon: FolderIcon } {
  const preset = DEFAULT_FOLDER_PRESETS[folder.name];
  if (preset) return preset;
  return {
    tint: TINT_CYCLE[hashStringToIndex(folder.id, TINT_CYCLE.length)],
    icon: 'globe',
  };
}

const ROW_ICON_TINT_CLASS: Record<FolderTint, string> = {
  terracotta: styles.xyFilesRowIconTerracotta,
  plum: styles.xyFilesRowIconPlum,
  ochre: styles.xyFilesRowIconOchre,
  sage: styles.xyFilesRowIconSage,
  slate: styles.xyFilesRowIconSlate,
};

const FOLDER_HEADER_TINT_CLASS: Record<FolderTint, string> = {
  terracotta: styles.xyFolderHeaderTerracotta,
  plum: styles.xyFolderHeaderPlum,
  ochre: styles.xyFolderHeaderOchre,
  sage: styles.xyFolderHeaderSage,
  slate: styles.xyFolderHeaderSlate,
};

const TINT_HEX: Record<FolderTint, string> = {
  terracotta: '#c46a44',
  plum: '#864d5e',
  ochre: '#b08828',
  sage: '#6b7a56',
  slate: '#4a5a6a',
};

function FolderGlyph({ kind, color }: { kind: FolderIcon; color: string }) {
  const common = {
    width: 22,
    height: 22,
    viewBox: '0 0 24 24',
    fill: 'none' as const,
    stroke: color,
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  if (kind === 'users') {
    return (
      <svg {...common}>
        <circle cx="9" cy="9" r="3.2" />
        <path d="M15 11a2.8 2.8 0 1 0 0-5.6" />
        <path d="M3 19c0-3.3 2.7-6 6-6s6 2.7 6 6" />
        <path d="M16 19c0-2 1.4-3.7 3.4-4.2" />
      </svg>
    );
  }
  if (kind === 'heart') {
    return (
      <svg {...common}>
        <path d="M12 19.2 4.6 12a4.4 4.4 0 0 1 6.2-6.2L12 7l1.2-1.2a4.4 4.4 0 0 1 6.2 6.2Z" />
      </svg>
    );
  }
  if (kind === 'search') {
    return (
      <svg {...common}>
        <circle cx="11" cy="11" r="6" />
        <path d="m20 20-4.5-4.5" />
      </svg>
    );
  }
  if (kind === 'draft') {
    return (
      <svg {...common}>
        <path d="M5 4h9l5 5v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z" />
        <path d="M14 4v5h5" />
        <path d="M8 14h7" />
        <path d="M8 17h5" strokeDasharray="2 2" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="8" />
      <path d="M4 12h16" />
      <path d="M12 4c2.5 2.5 4 5.4 4 8s-1.5 5.5-4 8c-2.5-2.5-4-5.4-4-8s1.5-5.5 4-8Z" />
    </svg>
  );
}

function DocGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M6 3h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
      <path d="M14 3v4h4" />
      <path d="M9 13h6M9 16h4" />
    </svg>
  );
}

function excerptForList(body: string, max = 96): string {
  const collapsed = body.replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, Math.max(1, max - 1))}…`;
}

function tagsToInputValue(tags: string[] | undefined): string {
  return Array.isArray(tags) ? tags.join(', ') : '';
}

function parseTagsInput(value: string): string[] | undefined {
  const out = value
    .split(/[,，;；\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  return out.length ? out : undefined;
}

/**
 * 「X 分钟前 / X 小时前 / X 天前 / X 月 X 日」相对时间，匹配设计稿 right-aligned mono 字号 11 的尺寸。
 */
function relativeTime(iso: string | undefined): string {
  if (!iso) return '';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return '';
  const diffMs = Date.now() - ts;
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const days = Math.floor(hr / 24);
  if (days < 30) return `${days} 天前`;
  const d = new Date(ts);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

/**
 * 资料柜详情页 meta：「修改于 X · 来源：Y · N 行」。
 * 行数从 body 里按 \n 计算（与设计稿一致，最少 1 行）。
 */
function bodyLineCount(body: string): number {
  if (!body) return 0;
  return body.split(/\r?\n/).length;
}

/**
 * 隐藏文件夹 entry「去和 TA 聊聊」拼 chat text 时用的 kind 中文短语。
 * 内部独立维护一份是为了把 chat text 的措辞和 PhoneFilesHiddenFolder 内的 UI badge
 * 解耦——两边在将来可能分化（badge 要短，chat text 可以更具语义）。
 */
const HIDDEN_KIND_CHAT_LABEL: Record<XingyeHiddenFileEntryKind, string> = {
  weakness: '弱点',
  guilty_pleasure: '不光彩的喜好',
  secret_taste: '说不出口的偏好',
  secret_plan: '不可告人的计划',
  manual: '手记',
};

/**
 * 把 body 按 \n\n 切段渲染成 <p>；以 `> ` 开头的行包成 <blockquote>。
 */
function renderPaperBody(body: string): ReactNode {
  const text = body ?? '';
  if (!text.trim()) {
    return <p style={{ color: 'var(--xy-ink-mute)' }}>（空白）</p>;
  }
  const blocks = text.split(/\n{2,}/);
  return blocks.map((block, idx) => {
    const trimmed = block.trim();
    if (trimmed.startsWith('> ')) {
      const quoteText = trimmed.replace(/^> /, '').replace(/\n> /g, '\n');
      return (
        <blockquote key={idx} className={styles.xyDetailPaperQuote}>
          {quoteText}
        </blockquote>
      );
    }
    return (
      <p key={idx}>
        {block.split('\n').map((line, lineIdx, arr) => (
          <span key={lineIdx}>
            {line}
            {lineIdx < arr.length - 1 ? <br /> : null}
          </span>
        ))}
      </p>
    );
  });
}

function isEmptyBatch(summary: FilesBatchSummary): boolean {
  return summary.created === 0 && summary.skipped === 0 && summary.failed === 0;
}

function summarizeBatch(mode: 'init' | 'add', summary: FilesBatchSummary): string {
  const verb = mode === 'init' ? '新增' : '生成草稿';
  const parts = [`${verb} ${summary.created} 条`];
  if (summary.skipped) parts.push(`跳过 ${summary.skipped}`);
  if (summary.failed) parts.push(`失败 ${summary.failed}`);
  const dest = mode === 'add' ? '，已放到下方「待确认」区' : '';
  // 计划条数超过本轮上限时，未执行的尾部不会静默丢弃——明确告知并提示可续跑
  //（再点一次时规划会看到已生成条目、自动接着整理剩下的）。
  const more = summary.truncated > 0 ? `；还有 ${summary.truncated} 条未整理，可再点一次继续` : '';
  return `整理完成：${parts.join('，')}${dest}${more}。`;
}

export function PhoneFilesApp({ ownerAgent, ownerProfile, displayName, onBack }: PhoneFilesAppProps) {
  const ownerAgentId = ownerAgent?.id ?? '';

  const [folders, setFolders] = useState<XingyeFileFolder[]>([]);
  const [entries, setEntries] = useState<XingyeFileEntry[]>([]);
  const [pendingDrafts, setPendingDrafts] = useState<XingyePendingFileDraft[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);

  const [composeMode, setComposeMode] = useState<ComposeMode | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftBody, setDraftBody] = useState('');
  const [draftTags, setDraftTags] = useState('');
  const [draftSource, setDraftSource] = useState('');
  const [draftIntent, setDraftIntent] = useState('');
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [initBusy, setInitBusy] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiFolderName, setAiFolderName] = useState<string | null>(null);
  /**
   * 批量动作（初始化 / 批量整理最近聊天）状态。两者互斥（共用 batchBusy），
   * batchMode 决定文案；batchProgress 是 Phase-2 逐条生成的进度。
   */
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchMode, setBatchMode] = useState<'init' | 'add' | null>(null);
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null);
  const [batchNotice, setBatchNotice] = useState<string | null>(null);
  const [batchError, setBatchError] = useState<string | null>(null);
  /**
   * 「待确认草稿」行内编辑缓冲（**仅 action='add' 用**）。Key = draft.id。
   * folderId 可由用户改（下拉选 folder）；title/body 也能编辑。
   */
  const [pendingDraftEdits, setPendingDraftEdits] = useState<
    Record<string, { title: string; body: string; folderId: string }>
  >({});
  /**
   * 「待确认草稿」行内编辑缓冲（**仅 action='update' 用**）。Key = draft.id。
   * 用户可在 update 卡片里编辑 patch 字段（bodyAppend / summary / title / tags / folderId）。
   */
  const [pendingDraftUpdateEdits, setPendingDraftUpdateEdits] = useState<
    Record<string, XingyeFileDraftPatch>
  >({});
  const [pendingDraftBusyId, setPendingDraftBusyId] = useState<string | null>(null);
  const [pendingDraftError, setPendingDraftError] = useState<string | null>(null);
  /**
   * 手动新建命中已有 entry 时，存被命中的老 entry；UI 据此弹 modal 让用户决定
   * 「打开那条编辑 / 仍然新建一条 / 取消」。null 表示无冲突。
   */
  const [duplicateHit, setDuplicateHit] = useState<XingyeFileEntry | null>(null);
  /**
   * 用户在 duplicate modal 上点「仍然新建一条」时设为 true，让随后的 handleSave
   * 用 skipDedupe=true 调 appendFileEntry。**用 ref 不用 state**：React state
   * 异步、setForceCreateOverride 后立即 handleSave() 闭包里仍是旧值；ref 立即同步。
   * 一次性开关：handleSave 读到 true 后 reset 回 false。
   */
  const forceCreateOverrideRef = useRef(false);

  // ── 隐藏文件夹（抽屉最底层）状态 ──
  const userName = useStore((s) => s.userName);
  const [hiddenState, setHiddenState] = useState<XingyeHiddenFolderState | null>(null);
  const [hiddenEntries, setHiddenEntries] = useState<XingyeHiddenFileEntry[]>([]);
  const [hiddenPwModalOpen, setHiddenPwModalOpen] = useState(false);
  const [hiddenAttemptCount, setHiddenAttemptCount] = useState(0);
  const [hiddenReaction, setHiddenReaction] = useState<string | null>(null);
  const [hiddenShake, setHiddenShake] = useState(false);
  const [hiddenPwBusy, setHiddenPwBusy] = useState(false);
  const [hiddenPwError, setHiddenPwError] = useState<string | null>(null);
  const [inHiddenView, setInHiddenView] = useState(false);
  const [hiddenSeedBusy, setHiddenSeedBusy] = useState(false);
  const [hiddenSeedError, setHiddenSeedError] = useState<string | null>(null);
  /** 「我也想加一条」弹窗状态。 */
  const [hiddenManualOpen, setHiddenManualOpen] = useState(false);
  const [hiddenManualTitle, setHiddenManualTitle] = useState('');
  const [hiddenManualBody, setHiddenManualBody] = useState('');
  const [hiddenManualKind, setHiddenManualKind] = useState<XingyeHiddenFileEntryKind>('manual');
  const [hiddenManualBusy, setHiddenManualBusy] = useState(false);
  const [hiddenManualError, setHiddenManualError] = useState<string | null>(null);

  /**
   * 「去和 TA 聊聊」入口的反馈状态。和购物/记账同款：点完按钮后 4s 自动复位。
   * 同一个 state 既给主资料柜的文件详情用，也给隐藏文件夹列表里的 entry 卡用——
   * 两边互斥（主资料柜进了详情就看不到抽屉列表，反之亦然），不会冲突。
   * value = `'file:' + entryId` 或 `'hidden:' + entryId`，让两边的 UI 各认各的。
   */
  const [sharedToChatKey, setSharedToChatKey] = useState<string | null>(null);

  useEffect(() => {
    if (!sharedToChatKey) return undefined;
    const timer = setTimeout(() => setSharedToChatKey(null), 4000);
    return () => clearTimeout(timer);
  }, [sharedToChatKey]);

  /**
   * 防跨角色脏写：切角色 / 跑批量动作时会有多轮异步读取在飞，落 setState 前用单调请求号
   * 校验仍是最新一轮（与 PhoneMailApp 同语义）。批量 handler 也快照本 ref 守卫自己的写入。
   */
  const reloadSeqRef = useRef(0);

  const reload = useCallback(async () => {
    const seq = ++reloadSeqRef.current;
    if (!ownerAgentId) {
      setFolders([]);
      setEntries([]);
      setPendingDrafts([]);
      setPendingDraftEdits({});
      setPendingDraftUpdateEdits({});
      return;
    }
    setListLoading(true);
    setListError(null);
    try {
      const [f, e, drafts] = await Promise.all([
        listFileFolders(ownerAgentId),
        listFileEntries(ownerAgentId),
        listFileDrafts(ownerAgentId),
      ]);
      if (seq !== reloadSeqRef.current) return; // 被更晚一轮取代，丢弃本次结果
      setFolders(f);
      setEntries(e);
      setPendingDrafts(drafts);
    } catch (err) {
      if (seq !== reloadSeqRef.current) return;
      setListError(err instanceof Error ? err.message : String(err));
    } finally {
      if (seq === reloadSeqRef.current) setListLoading(false);
    }
  }, [ownerAgentId]);

  /**
   * 读取隐藏文件夹 state + entries。如果 state 还没有密码（首次进入），
   * 用一条随机候选自动锁定——这样用户进来就有「上锁」感，需要先猜对密码。
   *
   * 候选池为空（极端情况：没角色名、没用户名、没 NPC、没联系人）→ 跳过锁定，
   * 让 UI 显示一个 disabled 的"暂无可用候选密码"提示。
   */
  const reloadHidden = useCallback(async () => {
    if (!ownerAgentId) {
      setHiddenState(null);
      setHiddenEntries([]);
      setInHiddenView(false);
      return;
    }
    try {
      const [state, entries] = await Promise.all([
        readHiddenFolderState(ownerAgentId),
        listHiddenEntries(ownerAgentId),
      ]);
      let stateOut = state;
      if (!state.passwordHash) {
        const storage = getXingyePersistenceStorage();
        const candidates = collectHiddenPasswordCandidates({
          agent: ownerAgent,
          profile: ownerProfile,
          userName,
          loreEntries: listLoreEntries(ownerAgentId, storage),
          virtualContacts: getConfirmedVirtualContacts(ownerAgentId, storage),
        });
        const picked = pickRandomCandidate(candidates);
        if (picked) {
          try {
            stateOut = await setHiddenFolderPassword(ownerAgentId, {
              password: picked.value,
              candidateLabel: picked.label,
            });
          } catch (err) {
            console.warn('[PhoneFilesApp] init hidden lock failed:', err);
          }
        }
      }
      setHiddenState(stateOut);
      setHiddenEntries(entries);
    } catch (err) {
      console.warn('[PhoneFilesApp] reloadHidden failed:', err);
    }
  }, [ownerAgentId, ownerAgent, ownerProfile, userName]);

  /**
   * 草稿编辑缓冲的统一访问入口。
   *
   * - action='add'：返回 `{ kind: 'add', title, body, folderId }`，沿用既有渲染逻辑。
   * - action='update'：返回 `{ kind: 'update', patch, target }`，patch 是用户在 UI 上
   *   编辑过的最终态（缺省取 draft.patch）；target 是 resolveTargetEntry 解析出的老 entry
   *   （可能为 null —— 草稿写入后用户手动删了 target；UI 据此显示提示）。
   */
  const pendingDraftWorkingValue = useCallback(
    (d: XingyePendingFileDraft) => {
      if (d.action === 'update') {
        const editedPatch = pendingDraftUpdateEdits[d.id] ?? d.patch ?? {};
        const target = resolveTargetEntry(entries, d);
        return { kind: 'update' as const, patch: editedPatch, target };
      }
      const edit = pendingDraftEdits[d.id];
      const folderId = edit?.folderId
        ?? (folders.length > 0 ? resolveFolderIdFromHint(folders, d.folderHint) : '');
      return {
        kind: 'add' as const,
        title: edit?.title ?? d.title,
        body: edit?.body ?? d.body,
        folderId,
      };
    },
    [pendingDraftEdits, pendingDraftUpdateEdits, folders, entries],
  );

  const handlePendingDraftFieldChange = (
    draftId: string,
    patch: Partial<{ title: string; body: string; folderId: string }>,
  ) => {
    setPendingDraftEdits((prev) => {
      const d = pendingDrafts.find((entry) => entry.id === draftId);
      if (!d) return prev;
      const base = prev[draftId] ?? {
        title: d.title,
        body: d.body,
        folderId: folders.length > 0 ? resolveFolderIdFromHint(folders, d.folderHint) : '',
      };
      return { ...prev, [draftId]: { ...base, ...patch } };
    });
  };

  const handlePendingDraftPatchChange = (
    draftId: string,
    patchDelta: Partial<XingyeFileDraftPatch>,
  ) => {
    setPendingDraftUpdateEdits((prev) => {
      const d = pendingDrafts.find((entry) => entry.id === draftId);
      if (!d || d.action !== 'update') return prev;
      const base = prev[draftId] ?? d.patch ?? {};
      return { ...prev, [draftId]: { ...base, ...patchDelta } };
    });
  };

  const clearDraftEdits = (draftId: string) => {
    setPendingDraftEdits((prev) => {
      if (!(draftId in prev)) return prev;
      const { [draftId]: _omitted, ...rest } = prev;
      return rest;
    });
    setPendingDraftUpdateEdits((prev) => {
      if (!(draftId in prev)) return prev;
      const { [draftId]: _omitted, ...rest } = prev;
      return rest;
    });
  };

  const handleConfirmPendingDraft = async (d: XingyePendingFileDraft) => {
    if (!ownerAgentId) return;
    setPendingDraftBusyId(d.id);
    setPendingDraftError(null);
    try {
      const working = pendingDraftWorkingValue(d);
      const entry = working.kind === 'update'
        ? await confirmFileDraft(ownerAgentId, d.id, { patch: working.patch })
        : await confirmFileDraft(ownerAgentId, d.id, {
            folderId: working.folderId || undefined,
            title: working.title,
            body: working.body,
          });
      setEntries((prev) => [entry, ...prev.filter((p) => p.id !== entry.id)]);
      setPendingDrafts((prev) => prev.filter((p) => p.id !== d.id));
      clearDraftEdits(d.id);
      if (folders.length === 0) {
        await reload();
      }
    } catch (err) {
      setPendingDraftError(err instanceof Error ? err.message : String(err));
    } finally {
      setPendingDraftBusyId(null);
    }
  };

  const handleDiscardPendingDraft = async (d: XingyePendingFileDraft) => {
    if (!ownerAgentId) return;
    if (!window.confirm('确定丢弃这条待确认资料柜草稿？此操作不可恢复，但角色可在下次巡检里重新提议。')) {
      return;
    }
    setPendingDraftBusyId(d.id);
    setPendingDraftError(null);
    try {
      const ok = await discardFileDraft(ownerAgentId, d.id);
      if (ok) {
        setPendingDrafts((prev) => prev.filter((p) => p.id !== d.id));
        clearDraftEdits(d.id);
      } else {
        await reload();
      }
    } catch (err) {
      setPendingDraftError(err instanceof Error ? err.message : String(err));
    } finally {
      setPendingDraftBusyId(null);
    }
  };

  useEffect(() => {
    setSelectedFolderId(null);
    setSelectedEntryId(null);
    setComposeMode(null);
    setSaveError(null);
    setListError(null);
    setBatchBusy(false);
    setBatchMode(null);
    setBatchProgress(null);
    setBatchNotice(null);
    setBatchError(null);
  }, [ownerAgentId]);

  useEffect(() => {
    void reload();
    // 卸载 / 切角色时让在飞的 reload 与批量 handler 都失效（seq 前移）。
    return () => {
      reloadSeqRef.current += 1;
    };
  }, [reload]);

  useEffect(() => {
    void reloadHidden();
  }, [reloadHidden]);

  /** 切换 agent 时也要重置隐藏文件夹 UI 状态。 */
  useEffect(() => {
    setHiddenPwModalOpen(false);
    setHiddenAttemptCount(0);
    setHiddenReaction(null);
    setHiddenShake(false);
    setHiddenPwError(null);
    setInHiddenView(false);
    setHiddenSeedError(null);
    setHiddenManualOpen(false);
    setHiddenManualError(null);
  }, [ownerAgentId]);

  const selectedFolder = useMemo(
    () => (selectedFolderId ? folders.find((f) => f.id === selectedFolderId) ?? null : null),
    [folders, selectedFolderId],
  );

  const selectedEntry = useMemo(
    () => (selectedEntryId ? entries.find((e) => e.id === selectedEntryId) ?? null : null),
    [entries, selectedEntryId],
  );

  const folderEntries = useMemo(() => {
    if (!selectedFolderId) return [] as XingyeFileEntry[];
    return entries.filter((e) => e.folderId === selectedFolderId);
  }, [entries, selectedFolderId]);

  const folderEntryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of entries) {
      counts.set(entry.folderId, (counts.get(entry.folderId) ?? 0) + 1);
    }
    return counts;
  }, [entries]);

  /**
   * 每个 folder 上「· N 草稿」的红字角标。
   * 用 folderHint 解析回 folderId，统计落在每个 folder 上的草稿数。
   */
  const folderPendingCounts = useMemo(() => {
    const counts = new Map<string, number>();
    if (folders.length === 0) return counts;
    for (const draft of pendingDrafts) {
      const fid = resolveFolderIdFromHint(folders, draft.folderHint);
      counts.set(fid, (counts.get(fid) ?? 0) + 1);
    }
    return counts;
  }, [pendingDrafts, folders]);

  const recentEntries = useMemo(() => entries.slice(0, 3), [entries]);

  const ta = displayName || ownerAgent?.name || 'TA';

  const openCreateInFolder = (folderId: string) => {
    setComposeMode({ kind: 'create', folderId });
    setDraftTitle('');
    setDraftBody('');
    setDraftTags('');
    setDraftSource('');
    setDraftIntent('');
    setSaveError(null);
    setAiError(null);
    setAiFolderName(null);
  };

  const openEdit = (entry: XingyeFileEntry) => {
    setComposeMode({ kind: 'edit', entry });
    setDraftTitle(entry.title);
    setDraftBody(entry.body);
    setDraftTags(tagsToInputValue(entry.tags));
    setDraftSource(entry.source ?? '');
    setDraftIntent('');
    setSaveError(null);
    setAiError(null);
    setAiFolderName(null);
  };

  const closeCompose = () => {
    setComposeMode(null);
    setSaveError(null);
    setAiError(null);
    setAiFolderName(null);
  };

  const handleGenerateDraft = async () => {
    if (!ownerAgent || !composeMode) return;
    const targetFolderId =
      composeMode.kind === 'create' ? composeMode.folderId : composeMode.entry.folderId;
    const targetFolder = folders.find((f) => f.id === targetFolderId);
    setAiBusy(true);
    setAiError(null);
    try {
      const result = await generateFilesDraftWithAI({
        agent: ownerAgent,
        ownerProfile: ownerProfile ?? null,
        targetFolder: targetFolder
          ? { id: targetFolder.id, name: targetFolder.name, description: targetFolder.description }
          : null,
        folderOptions: folders.map((f) => ({
          id: f.id,
          name: f.name,
          description: f.description,
        })),
        existingEntries: entries.map((e) => ({
          id: e.id,
          folderName: folders.find((f) => f.id === e.folderId)?.name ?? '（其它）',
          title: e.title,
          summary: e.summary,
        })),
        userIntent: draftIntent.trim(),
      });
      setDraftTitle(result.title);
      setDraftBody(result.body);
      if (result.tags && result.tags.length > 0) {
        setDraftTags(result.tags.join(', '));
      }
      setAiFolderName(result.folderName);
    } catch (err) {
      setAiError(err instanceof Error ? err.message : String(err));
    } finally {
      setAiBusy(false);
    }
  };

  /**
   * 「让 TA 初始化资料柜」：两阶段——先一次规划调用看 lore 目录，再逐条只喂选中设定生成，
   * 结果直接写入 entries（去重命中跳过计数）。seq 快照守卫 agent 切换时丢弃 UI 写入。
   */
  const handleRunInit = async () => {
    if (!ownerAgent || !ownerAgentId || batchBusy) return;
    const seq = reloadSeqRef.current;
    setBatchBusy(true);
    setBatchMode('init');
    setBatchProgress(null);
    setBatchNotice(null);
    setBatchError(null);
    try {
      const { summary, createdEntries } = await runFilesInit({
        agent: ownerAgent,
        ownerAgentId,
        ownerProfile: ownerProfile ?? null,
        folders,
        existingEntries: entries,
        userName,
        onProgress: (done, total) => {
          if (seq === reloadSeqRef.current) setBatchProgress({ done, total });
        },
      });
      if (seq !== reloadSeqRef.current) return;
      if (isEmptyBatch(summary)) {
        setBatchNotice('TA 的设定库还没有可整理的条目，先去「设定库」加一些再来。');
      } else {
        setEntries((prev) => {
          const ids = new Set(createdEntries.map((c) => c.id));
          return [...createdEntries, ...prev.filter((p) => !ids.has(p.id))];
        });
        setBatchNotice(summarizeBatch('init', summary));
      }
    } catch (err) {
      if (seq === reloadSeqRef.current) setBatchError(err instanceof Error ? err.message : String(err));
    } finally {
      if (seq === reloadSeqRef.current) {
        setBatchBusy(false);
        setBatchMode(null);
        setBatchProgress(null);
      }
    }
  };

  /**
   * 「批量整理最近聊天」：两阶段——先一次规划调用看最近聊天+目录，再逐条只喂相关聊天/设定生成，
   * 结果写入「待确认」草稿（add / update 补丁），复用现有确认区。
   */
  const handleRunBatchAdd = async () => {
    if (!ownerAgent || !ownerAgentId || batchBusy) return;
    const seq = reloadSeqRef.current;
    setBatchBusy(true);
    setBatchMode('add');
    setBatchProgress(null);
    setBatchNotice(null);
    setBatchError(null);
    try {
      const { summary, appendedDrafts } = await runFilesBatchAdd({
        agent: ownerAgent,
        ownerAgentId,
        ownerProfile: ownerProfile ?? null,
        folders,
        existingEntries: entries,
        pendingDrafts,
        userName,
        onProgress: (done, total) => {
          if (seq === reloadSeqRef.current) setBatchProgress({ done, total });
        },
      });
      if (seq !== reloadSeqRef.current) return;
      if (isEmptyBatch(summary)) {
        setBatchNotice('最近没有可整理的聊天，先和 TA 聊几句再来。');
      } else {
        setPendingDrafts((prev) => {
          const ids = new Set(appendedDrafts.map((d) => d.id));
          return [...appendedDrafts, ...prev.filter((p) => !ids.has(p.id))];
        });
        setBatchNotice(summarizeBatch('add', summary));
      }
    } catch (err) {
      if (seq === reloadSeqRef.current) setBatchError(err instanceof Error ? err.message : String(err));
    } finally {
      if (seq === reloadSeqRef.current) {
        setBatchBusy(false);
        setBatchMode(null);
        setBatchProgress(null);
      }
    }
  };

  // ── 隐藏文件夹 handlers ──

  const openHiddenPasswordModal = () => {
    setHiddenPwModalOpen(true);
    setHiddenReaction(null);
    setHiddenPwError(null);
  };

  const closeHiddenPasswordModal = () => {
    setHiddenPwModalOpen(false);
    setHiddenPwError(null);
  };

  const handleHiddenPasswordAttempt = async (attempt: string) => {
    if (!ownerAgentId) return;
    setHiddenPwBusy(true);
    setHiddenPwError(null);
    try {
      const { ok, state } = await attemptUnlock(ownerAgentId, attempt);
      if (ok) {
        setHiddenState(state);
        setHiddenPwModalOpen(false);
        setHiddenReaction(null);
        setHiddenAttemptCount(0);
        setInHiddenView(true);
      } else {
        const nextAttempt = hiddenAttemptCount + 1;
        setHiddenAttemptCount(nextAttempt);
        const reaction = getWrongPasswordReaction({
          agentName: ownerProfile?.displayName?.trim() || ownerAgent?.name || 'TA',
          attemptCount: nextAttempt,
          gender: ownerProfile?.gender,
        });
        setHiddenReaction(reaction);
        setHiddenShake(true);
        window.setTimeout(() => setHiddenShake(false), 500);
      }
    } catch (err) {
      setHiddenPwError(err instanceof Error ? err.message : String(err));
    } finally {
      setHiddenPwBusy(false);
    }
  };

  const handleHiddenRelock = async () => {
    if (!ownerAgentId || !ownerAgent) return;
    const storage = getXingyePersistenceStorage();
    const candidates = collectHiddenPasswordCandidates({
      agent: ownerAgent,
      profile: ownerProfile,
      userName,
      loreEntries: listLoreEntries(ownerAgentId, storage),
      virtualContacts: getConfirmedVirtualContacts(ownerAgentId, storage),
    });
    const picked = pickRandomCandidate(candidates, {
      excludeValue: undefined,
    });
    if (!picked) {
      /** 没有候选密码——把状态置回锁定但不换密码（保留旧 hash）。 */
      try {
        const previous = await readHiddenFolderState(ownerAgentId);
        if (previous.passwordHash) {
          const reloaded = await setHiddenFolderPassword(ownerAgentId, {
            password: '__none__',
            candidateLabel: previous.candidateLabel,
          });
          setHiddenState(reloaded);
        }
      } catch (err) {
        console.warn('relock without candidates failed:', err);
      }
      setInHiddenView(false);
      return;
    }
    try {
      const next = await setHiddenFolderPassword(ownerAgentId, {
        password: picked.value,
        candidateLabel: picked.label,
      });
      setHiddenState(next);
      setInHiddenView(false);
    } catch (err) {
      console.warn('manual relock failed:', err);
    }
  };

  const handleGenerateHiddenSeeds = async () => {
    if (!ownerAgentId || !ownerAgent || hiddenSeedBusy) return;
    setHiddenSeedBusy(true);
    setHiddenSeedError(null);
    try {
      const storage = getXingyePersistenceStorage();
      const drafts = await generateHiddenSeedsWithAI({
        agent: ownerAgent,
        profile: ownerProfile,
        loreEntries: listLoreEntries(ownerAgentId, storage),
        virtualContacts: getConfirmedVirtualContacts(ownerAgentId, storage),
        // 反重复 anchor + 入库前兜底用——首次解锁通常为空，但 markHiddenFolderSeedGenerated
        // 之外的再次触发（例如未来的「再生成几条」按钮）会有历史条目要避开。
        existingEntries: hiddenEntries,
        count: 3,
      });
      const appended: XingyeHiddenFileEntry[] = [];
      for (const draft of drafts) {
        const entry = await appendHiddenEntry(ownerAgentId, {
          kind: draft.kind,
          title: draft.title,
          body: draft.body,
          source: 'ai_seed',
        });
        appended.push(entry);
      }
      const next = await markHiddenFolderSeedGenerated(ownerAgentId);
      setHiddenState(next);
      setHiddenEntries((prev) => [...appended, ...prev]);
    } catch (err) {
      setHiddenSeedError(err instanceof Error ? err.message : String(err));
    } finally {
      setHiddenSeedBusy(false);
    }
  };

  const openHiddenManual = () => {
    setHiddenManualOpen(true);
    setHiddenManualTitle('');
    setHiddenManualBody('');
    setHiddenManualKind('manual');
    setHiddenManualError(null);
  };

  const handleSaveHiddenManual = async () => {
    if (!ownerAgentId || hiddenManualBusy) return;
    const title = hiddenManualTitle.trim();
    if (!title) {
      setHiddenManualError('标题不能为空。');
      return;
    }
    setHiddenManualBusy(true);
    setHiddenManualError(null);
    try {
      const entry = await appendHiddenEntry(ownerAgentId, {
        kind: hiddenManualKind,
        title,
        body: hiddenManualBody,
        source: 'manual',
      });
      setHiddenEntries((prev) => [entry, ...prev]);
      setHiddenManualOpen(false);
    } catch (err) {
      setHiddenManualError(err instanceof Error ? err.message : String(err));
    } finally {
      setHiddenManualBusy(false);
    }
  };

  const handleDeleteHiddenEntry = async (entry: XingyeHiddenFileEntry) => {
    if (!ownerAgentId) return;
    if (!window.confirm('确定删掉这条？删了 TA 也不会写回来。')) return;
    try {
      const ok = await deleteHiddenEntry(ownerAgentId, entry.id);
      if (ok) {
        setHiddenEntries((prev) => prev.filter((e) => e.id !== entry.id));
      } else {
        await reloadHidden();
      }
    } catch (err) {
      console.warn('delete hidden entry failed:', err);
    }
  };

  const handleInitFolders = async () => {
    if (!ownerAgentId || initBusy) return;
    setInitBusy(true);
    setListError(null);
    try {
      const created = await ensureDefaultFileFolders(ownerAgentId);
      setFolders(created);
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
    } finally {
      setInitBusy(false);
    }
  };

  const handleSave = async () => {
    if (!ownerAgentId || !composeMode) return;
    const title = draftTitle.trim();
    if (!title) {
      setSaveError('标题不能为空。');
      return;
    }
    setSaveBusy(true);
    setSaveError(null);
    try {
      if (composeMode.kind === 'create') {
        const draft: XingyeFileEntryDraft = {
          folderId: composeMode.folderId,
          title,
          body: draftBody,
          tags: parseTagsInput(draftTags),
          source: draftSource.trim() || undefined,
        };
        const shouldSkipDedupe = forceCreateOverrideRef.current;
        let row: XingyeFileEntry;
        try {
          row = await appendFileEntry(ownerAgentId, draft, {
            knownEntries: entries,
            skipDedupe: shouldSkipDedupe,
          });
        } catch (err) {
          if (err instanceof DuplicateFileEntryError) {
            setDuplicateHit(err.existing);
            setSaveBusy(false);
            return;
          }
          throw err;
        }
        if (shouldSkipDedupe) forceCreateOverrideRef.current = false;
        setEntries((prev) => [row, ...prev.filter((p) => p.id !== row.id)]);
        setSelectedEntryId(row.id);
      } else {
        const updated = await updateFileEntry(ownerAgentId, composeMode.entry.id, {
          folderId: composeMode.entry.folderId,
          title,
          body: draftBody,
          tags: parseTagsInput(draftTags),
          source: draftSource.trim() || undefined,
        });
        if (updated) {
          setEntries((prev) => {
            const next = prev.filter((p) => p.id !== updated.id);
            next.unshift(updated);
            return next;
          });
          setSelectedEntryId(updated.id);
        } else {
          await reload();
        }
      }
      setComposeMode(null);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaveBusy(false);
    }
  };

  /**
   * 主资料柜文件详情「去和 TA 聊聊」：把当前条目的「所属文件夹路径 + 标题 + tags +
   * 修改时间 + source + 全量正文」拼成 quote text，写到 stagedChatQuote 全局槽。
   * sourceKind: 'files'。不导航——用户自己挑聊天目的地。
   */
  const handleShareFileToChat = useCallback(
    (entry: XingyeFileEntry) => {
      const folderName = folders.find((f) => f.id === entry.folderId)?.name ?? '—';
      const lines: string[] = [];
      lines.push(`资料柜 › ${folderName}`);
      lines.push(`《${entry.title}》`);
      if (entry.tags && entry.tags.length > 0) {
        lines.push(`标签：${entry.tags.map((t) => `#${t}`).join(' ')}`);
      }
      if (entry.source) lines.push(`来源：${entry.source}`);
      lines.push(`修改于 ${relativeTime(entry.updatedAt ?? entry.createdAt)}`);
      if (entry.body) {
        lines.push('');
        lines.push(entry.body);
      }
      const text = lines.join('\n').trim();
      if (!text) return;
      useStore.getState().stageChatQuote({
        text,
        sourceTitle: `资料柜 · ${entry.title}`,
        sourceKind: 'files',
        charCount: text.length,
        updatedAt: Date.now(),
      });
      setSharedToChatKey(`file:${entry.id}`);
    },
    [folders],
  );

  /**
   * 抽屉最底层 entry「去和 TA 聊聊」：拼「[kind 中文] 《标题》 + 正文」。
   * sourceKind: 'secret-drawer' —— agent 拿到引用时会读到底牌级 hint，
   * 知道这是用户通过解锁翻到的私密档案，不是闲聊素材。
   */
  const handleShareHiddenEntryToChat = useCallback((entry: XingyeHiddenFileEntry) => {
    const lines: string[] = [];
    lines.push(`[${HIDDEN_KIND_CHAT_LABEL[entry.kind]}] 《${entry.title}》`);
    if (entry.body) {
      lines.push('');
      lines.push(entry.body);
    }
    const text = lines.join('\n').trim();
    if (!text) return;
    useStore.getState().stageChatQuote({
      text,
      sourceTitle: `抽屉 · ${entry.title}`,
      sourceKind: 'secret-drawer',
      charCount: text.length,
      updatedAt: Date.now(),
    });
    setSharedToChatKey(`hidden:${entry.id}`);
  }, []);

  const handleDeleteSelected = async () => {
    if (!selectedEntry || !ownerAgentId) return;
    if (!window.confirm('确定删除这条文件？此操作不可恢复。')) return;
    setDeleteBusy(true);
    try {
      const ok = await deleteFileEntry(ownerAgentId, selectedEntry.id);
      if (ok) {
        setEntries((prev) => prev.filter((e) => e.id !== selectedEntry.id));
        setSelectedEntryId(null);
      } else {
        await reload();
      }
    } finally {
      setDeleteBusy(false);
    }
  };

  if (!ownerAgentId) {
    return (
      <div className={`${styles.phoneShell} ${styles.xyPalette}`} aria-label="文件管理">
        <div className={styles.phoneStatusBar}>
          <button type="button" className={styles.phoneBackButton} onClick={onBack}>
            返回首页
          </button>
          <span>文件管理</span>
        </div>
        <div className={styles.phoneBody}>
          <section className={styles.phoneAppCard}>
            <h3 className={styles.phoneAppTitle}>文件管理不可用</h3>
            <p className={styles.phoneAppHint}>
              未选择角色 / 小手机不可用。资料柜写入当前角色在 HANA_HOME 下的星野目录，不能使用隐式回退。
            </p>
            <p className={styles.phoneAppHint}>请返回星野角色页，选择有效角色后再打开文件管理。</p>
          </section>
        </div>
      </div>
    );
  }

  const inFolderDetail = Boolean(selectedFolder);
  const inEntryDetail = Boolean(selectedEntry);

  const handleBack = () => {
    if (inHiddenView) {
      setInHiddenView(false);
      return;
    }
    if (inEntryDetail) {
      setSelectedEntryId(null);
      return;
    }
    if (inFolderDetail) {
      setSelectedFolderId(null);
      return;
    }
    onBack();
  };

  const backLabel = inHiddenView
    ? '返回资料柜'
    : inEntryDetail
      ? '返回文件列表'
      : inFolderDetail
        ? '返回文件夹列表'
        : '返回首页';

  const totalEntries = entries.length;

  return (
    <div className={`${styles.phoneShell} ${styles.xyPalette}`} aria-label="文件管理">
      <div className={styles.phoneStatusBar}>
        <button type="button" className={styles.phoneBackButton} onClick={handleBack}>
          {backLabel}
        </button>
        <span>文件管理</span>
      </div>

      <div className={styles.xyBody}>
        {listError ? (
          <p className={styles.phoneAppHint} role="alert" style={{ padding: '8px 18px' }}>
            加载失败：{listError}
          </p>
        ) : null}
        {listLoading && folders.length === 0 && entries.length === 0 ? (
          <p className={styles.phoneAppHint} style={{ padding: '8px 18px' }}>加载中…</p>
        ) : null}

        {/* 资料柜首页 */}
        {!inFolderDetail && !inEntryDetail && !inHiddenView ? (
          <div className={styles.xyScroll}>
            <header className={styles.xyFilesHero}>
              <div>
                <p className={styles.xyFilesKicker}>CABINET</p>
                <h2 className={styles.xyFilesTitle}>{ta} 的资料柜</h2>
              </div>
              <span className={styles.xyFilesMeta}>
                {totalEntries} 条 · {folders.length} 文件夹
              </span>
            </header>

            {folders.length > 0 ? (
              <div style={{ padding: '0 18px' }} data-testid="phone-files-batch-actions">
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className={styles.xyBtnGhost}
                    onClick={() => void handleRunInit()}
                    disabled={batchBusy || listLoading || !ownerAgent}
                    data-testid="phone-files-init-batch-button"
                    title="让 TA 翻一遍设定库，按文件夹批量整理资料（逐条单独生成）"
                  >
                    {batchBusy && batchMode === 'init' ? '整理中…' : '让 TA 初始化资料柜'}
                  </button>
                  <button
                    type="button"
                    className={styles.xyBtnGhost}
                    onClick={() => void handleRunBatchAdd()}
                    disabled={batchBusy || listLoading || !ownerAgent}
                    data-testid="phone-files-batch-add-button"
                    title="根据最近聊天，批量补几条资料到「待确认」区"
                  >
                    {batchBusy && batchMode === 'add' ? '整理中…' : '批量整理最近聊天'}
                  </button>
                </div>
                {batchBusy ? (
                  <p className={styles.phoneAppHint} style={{ margin: '8px 0 0' }}>
                    {batchMode === 'init' ? '正在翻看 TA 的设定库' : '正在整理最近聊天'}
                    {batchProgress ? `（${batchProgress.done}/${batchProgress.total}）` : '…'}
                  </p>
                ) : null}
                {batchNotice ? (
                  <p className={styles.phoneAppHint} style={{ margin: '8px 0 0' }} data-testid="phone-files-batch-notice">
                    {batchNotice}
                  </p>
                ) : null}
                {batchError ? (
                  <p className={styles.xyEditorError} role="alert" style={{ margin: '8px 0 0' }}>
                    批量整理失败：{batchError}
                  </p>
                ) : null}
              </div>
            ) : null}

            <div className={styles.xyBreadcrumb}>
              <span>本机</span>
              <span className={styles.xyBcSep}>›</span>
              <span>{ta}</span>
              <span className={styles.xyBcSep}>›</span>
              <b>资料柜</b>
            </div>

            {pendingDrafts.length > 0 ? (
              <section
                className={styles.xyDraftSection}
                aria-label="待确认资料柜草稿"
                data-testid="phone-files-pending-drafts"
              >
                <p className={styles.xyDraftHeader}>待确认草稿 · 来自巡检 / 批量整理</p>
                {pendingDraftError ? (
                  <p className={styles.xyDraftError} role="alert">{pendingDraftError}</p>
                ) : null}
                {pendingDrafts.map((d) => {
                  const working = pendingDraftWorkingValue(d);
                  const busy = pendingDraftBusyId === d.id;
                  if (working.kind === 'update') {
                    const target = working.target;
                    const patch = working.patch;
                    const targetMissing = !target;
                    return (
                      <div
                        key={d.id}
                        className={styles.xyDraftCard}
                        data-testid={`phone-files-pending-draft-${d.id}`}
                        data-action="update"
                      >
                        <p className={styles.xyDraftHint}>
                          <em className={styles.xyDraftKindBadge}>更新</em>
                          {targetMissing
                            ? '目标条目已不存在（可能被用户手动删除）'
                            : '将把以下补丁应用到老条目。'}
                        </p>
                        <div className={styles.xyDraftTargetBox}>
                          {target ? (
                            <>
                              <div><b>目标条目：</b>《{target.title}》</div>
                              <div className={styles.xyDraftHint}>
                                文件夹：{folders.find((f) => f.id === target.folderId)?.name ?? '（未知）'}
                              </div>
                              {target.summary ? (
                                <div className={styles.xyDraftHint}>摘要：{target.summary}</div>
                              ) : null}
                            </>
                          ) : (
                            <div className={styles.xyDraftHint}>
                              targetEntryId / matchTitle：
                              {d.targetEntryId || d.matchTitle || '（未提供）'}
                            </div>
                          )}
                        </div>
                        {patch.bodyAppend !== undefined ? (
                          <>
                            <span className={styles.xyDraftHint}>将追加到正文末尾的段落：</span>
                            <textarea
                              className={styles.xyDraftTextarea}
                              value={patch.bodyAppend ?? ''}
                              onChange={(e) => handlePendingDraftPatchChange(d.id, { bodyAppend: e.target.value })}
                              rows={4}
                              aria-label="待确认资料柜草稿追加段落"
                              data-testid={`phone-files-pending-draft-bodyappend-${d.id}`}
                              disabled={busy || targetMissing}
                            />
                          </>
                        ) : null}
                        {patch.title !== undefined ? (
                          <>
                            <span className={styles.xyDraftHint}>新标题：</span>
                            <input
                              type="text"
                              className={styles.xyDraftInput}
                              value={patch.title ?? ''}
                              onChange={(e) => handlePendingDraftPatchChange(d.id, { title: e.target.value })}
                              aria-label="待确认资料柜草稿新标题"
                              disabled={busy || targetMissing}
                            />
                          </>
                        ) : null}
                        {patch.summary !== undefined ? (
                          <>
                            <span className={styles.xyDraftHint}>新摘要：</span>
                            <input
                              type="text"
                              className={styles.xyDraftInput}
                              value={patch.summary ?? ''}
                              onChange={(e) => handlePendingDraftPatchChange(d.id, { summary: e.target.value })}
                              aria-label="待确认资料柜草稿新摘要"
                              disabled={busy || targetMissing}
                            />
                          </>
                        ) : null}
                        {patch.tags !== undefined && patch.tags.length > 0 ? (
                          <p className={styles.xyDraftHint}>
                            标签将整体替换为：{patch.tags.join('、')}
                          </p>
                        ) : null}
                        {d.reason ? (
                          <p className={styles.xyDraftReason}>理由：{d.reason}</p>
                        ) : null}
                        <div className={styles.xyDraftActions}>
                          <button
                            type="button"
                            className={styles.xyDraftConfirm}
                            onClick={() => void handleConfirmPendingDraft(d)}
                            disabled={busy || targetMissing}
                            data-testid={`phone-files-pending-draft-confirm-${d.id}`}
                          >
                            {busy ? '处理中…' : '确认更新'}
                          </button>
                          <button
                            type="button"
                            className={styles.xyDraftDiscard}
                            onClick={() => void handleDiscardPendingDraft(d)}
                            disabled={busy}
                            data-testid={`phone-files-pending-draft-discard-${d.id}`}
                          >
                            丢弃
                          </button>
                        </div>
                      </div>
                    );
                  }
                  return (
                    <div
                      key={d.id}
                      className={styles.xyDraftCard}
                      data-testid={`phone-files-pending-draft-${d.id}`}
                      data-action="add"
                    >
                      <p className={styles.xyDraftHint}>
                        <em className={styles.xyDraftKindBadge}>新增</em>
                        新条目草稿。
                      </p>
                      <input
                        type="text"
                        className={styles.xyDraftInput}
                        value={working.title}
                        onChange={(e) => handlePendingDraftFieldChange(d.id, { title: e.target.value })}
                        placeholder="标题"
                        aria-label="待确认资料柜草稿标题"
                        data-testid={`phone-files-pending-draft-title-${d.id}`}
                        disabled={busy}
                      />
                      <textarea
                        className={styles.xyDraftTextarea}
                        value={working.body}
                        onChange={(e) => handlePendingDraftFieldChange(d.id, { body: e.target.value })}
                        rows={4}
                        placeholder="正文"
                        aria-label="待确认资料柜草稿正文"
                        data-testid={`phone-files-pending-draft-body-${d.id}`}
                        disabled={busy}
                      />
                      <div className={styles.xyDraftRow}>
                        <span className={styles.xyDraftHint}>文件夹：</span>
                        {folders.length > 0 ? (
                          <select
                            className={styles.xyDraftSelect}
                            value={working.folderId}
                            onChange={(e) => handlePendingDraftFieldChange(d.id, { folderId: e.target.value })}
                            disabled={busy}
                            aria-label="待确认资料柜草稿文件夹"
                            data-testid={`phone-files-pending-draft-folder-${d.id}`}
                          >
                            {folders.map((folder) => (
                              <option key={folder.id} value={folder.id}>
                                {folder.name}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className={styles.xyDraftHint}>
                            未初始化（确认时会自动建默认文件夹）
                          </span>
                        )}
                        {d.folderHint ? (
                          <span className={styles.xyDraftHint}>
                            建议：「{d.folderHint}」
                          </span>
                        ) : null}
                      </div>
                      {d.reason ? (
                        <p className={styles.xyDraftReason}>理由：{d.reason}</p>
                      ) : null}
                      <div className={styles.xyDraftActions}>
                        <button
                          type="button"
                          className={styles.xyDraftConfirm}
                          onClick={() => void handleConfirmPendingDraft(d)}
                          disabled={busy}
                          data-testid={`phone-files-pending-draft-confirm-${d.id}`}
                        >
                          {busy ? '处理中…' : '确认生成'}
                        </button>
                        <button
                          type="button"
                          className={styles.xyDraftDiscard}
                          onClick={() => void handleDiscardPendingDraft(d)}
                          disabled={busy}
                          data-testid={`phone-files-pending-draft-discard-${d.id}`}
                        >
                          丢弃
                        </button>
                      </div>
                    </div>
                  );
                })}
              </section>
            ) : null}

            {folders.length === 0 ? (
              <div className={styles.xyFilesEmpty} data-testid="phone-files-empty">
                <p>还没有文件夹。点「初始化资料柜」生成默认分类</p>
                <p style={{ marginTop: 4, fontSize: 12 }}>
                  （世界观整理 / 人际关系 / 关于 user / 线索与发现 / 待确认）
                </p>
                <button
                  type="button"
                  className={styles.xyEditorPrimary}
                  onClick={() => void handleInitFolders()}
                  disabled={initBusy || listLoading}
                  data-testid="phone-files-init-button"
                >
                  {initBusy ? '初始化中…' : '初始化资料柜'}
                </button>
              </div>
            ) : (
              <>
                <div className={styles.xyFilesColHead}>
                  <span className={styles.xyFilesColName}>名称</span>
                  <span className={styles.xyFilesColCount}>条数</span>
                  <span className={styles.xyFilesColTime}>修改</span>
                </div>
                <div className={styles.xyFilesList} aria-label="文件夹列表">
                  {folders.map((folder) => {
                    const count = folderEntryCounts.get(folder.id) ?? 0;
                    const draftCount = folderPendingCounts.get(folder.id) ?? 0;
                    const pres = getFolderPresentation(folder);
                    const rowCls = `${styles.xyFilesRow}${draftCount > 0 ? ` ${styles.xyFilesRowPending}` : ''}`;
                    return (
                      <button
                        key={folder.id}
                        type="button"
                        className={rowCls}
                        onClick={() => {
                          setSelectedFolderId(folder.id);
                          setSelectedEntryId(null);
                        }}
                        data-testid={`phone-files-folder-${folder.id}`}
                      >
                        <span className={`${styles.xyFilesRowIcon} ${ROW_ICON_TINT_CLASS[pres.tint]}`}>
                          <FolderGlyph kind={pres.icon} color={TINT_HEX[pres.tint]} />
                        </span>
                        <span className={styles.xyFilesRowMain}>
                          <span className={styles.xyFilesRowName}>
                            {folder.name}
                            {draftCount > 0 ? (
                              <em className={styles.xyFilesRowDraftBadge}> · {draftCount} 草稿</em>
                            ) : null}
                          </span>
                          {folder.description ? (
                            <span className={styles.xyFilesRowDesc}>{folder.description}</span>
                          ) : null}
                        </span>
                        <span className={styles.xyFilesRowCount}>{count > 0 ? count : '—'}</span>
                        <span className={styles.xyFilesRowTime}>{relativeTime(folder.updatedAt)}</span>
                      </button>
                    );
                  })}
                  {hiddenState ? (
                    <HiddenFolderRow
                      hiddenState={hiddenState}
                      entryCount={hiddenEntries.length}
                      disabled={!hiddenState.passwordHash}
                      onClickLocked={openHiddenPasswordModal}
                      onClickUnlocked={() => setInHiddenView(true)}
                      rowClassName={styles.xyFilesRow}
                      iconWrapClassName={styles.xyFilesRowIcon}
                      mainClassName={styles.xyFilesRowMain}
                      nameClassName={styles.xyFilesRowName}
                      descClassName={styles.xyFilesRowDesc}
                      countClassName={styles.xyFilesRowCount}
                      timeClassName={styles.xyFilesRowTime}
                    />
                  ) : null}
                </div>

                {recentEntries.length > 0 ? (
                  <>
                    <p className={styles.xyFilesSectionLabel}>最近文件</p>
                    <div className={styles.xyFilesList}>
                      {recentEntries.map((entry) => {
                        const folderName = folders.find((f) => f.id === entry.folderId)?.name ?? '—';
                        return (
                          <button
                            key={entry.id}
                            type="button"
                            className={styles.xyFilesRow}
                            onClick={() => setSelectedEntryId(entry.id)}
                          >
                            <span className={`${styles.xyFilesRowIcon} ${styles.xyFilesRowIconDoc}`}>
                              <DocGlyph />
                            </span>
                            <span className={styles.xyFilesRowMain}>
                              <span className={styles.xyFilesRowName}>{entry.title}</span>
                              <span className={styles.xyFilesRowDesc}>
                                {folderName} · {bodyLineCount(entry.body)} 行
                              </span>
                            </span>
                            <span className={styles.xyFilesRowCount}>—</span>
                            <span className={styles.xyFilesRowTime}>
                              {relativeTime(entry.updatedAt ?? entry.createdAt)}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </>
                ) : null}

                <button
                  type="button"
                  className={styles.xyFab}
                  onClick={() => openCreateInFolder(folders[0].id)}
                  data-testid="phone-files-new-from-home"
                  aria-label="新建文件"
                >
                  ＋ 新建文件
                </button>
              </>
            )}
          </div>
        ) : null}

        {/* 文件夹内容 */}
        {inFolderDetail && selectedFolder && !inEntryDetail ? (
          <div className={styles.xyScroll}>
            {(() => {
              const pres = getFolderPresentation(selectedFolder);
              return (
                <header
                  className={`${styles.xyFolderHeader} ${FOLDER_HEADER_TINT_CLASS[pres.tint]}`}
                  aria-label={`${selectedFolder.name} 文件夹`}
                >
                  <span className={styles.xyFolderHeaderGlyph}>
                    <FolderGlyph kind={pres.icon} color={TINT_HEX[pres.tint]} />
                  </span>
                  <div className={styles.xyFolderHeaderMain}>
                    <h2 className={styles.xyFolderHeaderName}>{selectedFolder.name}</h2>
                    <p className={styles.xyFolderHeaderDesc}>
                      {selectedFolder.description ?? 'TA 的资料柜分类'} · {folderEntries.length} 条
                    </p>
                  </div>
                </header>
              );
            })()}

            {folderEntries.length === 0 ? (
              <p
                className={styles.xyFilesEmpty}
                data-testid="phone-files-folder-empty"
              >
                这个文件夹还没有文件。
              </p>
            ) : (
              <div className={styles.xyNoteList}>
                {folderEntries.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    className={styles.xyNoteCard}
                    onClick={() => setSelectedEntryId(entry.id)}
                    data-testid={`phone-files-entry-${entry.id}`}
                  >
                    <h3 className={styles.xyNoteCardTitle}>{entry.title}</h3>
                    {entry.body ? (
                      <p className={styles.xyNoteCardBody}>{excerptForList(entry.body)}</p>
                    ) : null}
                    <div className={styles.xyNoteCardFoot}>
                      {entry.tags && entry.tags.length > 0
                        ? entry.tags.map((t) => (
                            <span key={t} className={`${styles.xyChip} ${styles.xyChipTintSage}`}>
                              #{t}
                            </span>
                          ))
                        : null}
                      <span className={styles.xyNoteSpacer} />
                      <span className={styles.xyNoteTime}>
                        {relativeTime(entry.updatedAt ?? entry.createdAt)}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            )}

            <button
              type="button"
              className={styles.xyFab}
              onClick={() => openCreateInFolder(selectedFolder.id)}
              data-testid="phone-files-new-in-folder"
              aria-label="新建文件"
            >
              ＋ 新建文件
            </button>
          </div>
        ) : null}

        {/* 文件详情 */}
        {inEntryDetail && selectedEntry ? (
          <div className={styles.xyScroll}>
            <article className={styles.xyDetailPaper} aria-label="文件详情">
              <p className={styles.xyDetailPaperPath}>
                资料柜 › {folders.find((f) => f.id === selectedEntry.folderId)?.name ?? '—'}
              </p>
              <h1 className={styles.xyDetailPaperTitle}>{selectedEntry.title}</h1>
              <p className={styles.xyDetailPaperMeta}>
                修改于 {relativeTime(selectedEntry.updatedAt ?? selectedEntry.createdAt)}
                {selectedEntry.source ? ` · 来源：${selectedEntry.source}` : ''}
                {' · '}{bodyLineCount(selectedEntry.body)} 行
              </p>
              {selectedEntry.tags && selectedEntry.tags.length > 0 ? (
                <div className={styles.xyDetailPaperTags}>
                  {selectedEntry.tags.map((t) => (
                    <span key={t} className={`${styles.xyChip} ${styles.xyChipTintSage}`}>
                      #{t}
                    </span>
                  ))}
                </div>
              ) : null}
              <hr className={styles.xyDetailPaperRule} />
              <div className={styles.xyDetailPaperBody}>{renderPaperBody(selectedEntry.body)}</div>
              <hr className={styles.xyDetailPaperRule} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
                <button
                  type="button"
                  className={styles.xyBtnGhost}
                  onClick={() => handleShareFileToChat(selectedEntry)}
                  data-testid={`phone-files-share-to-chat-${selectedEntry.id}`}
                  title={`把这条带到和 ${ta} 的聊天里`}
                  style={{ alignSelf: 'flex-start' }}
                >
                  去和 {ta} 聊聊这条
                </button>
                {sharedToChatKey === `file:${selectedEntry.id}` ? (
                  <p
                    className={styles.phoneAppHint}
                    role="status"
                    data-testid={`phone-files-share-to-chat-notice-${selectedEntry.id}`}
                    style={{ margin: 0 }}
                  >
                    已放进聊天输入框引用 —— 打开任意对话即可发出
                  </p>
                ) : null}
              </div>
              <div className={styles.xyDetailPaperFoot}>
                <button
                  type="button"
                  className={styles.xyBtnGhost}
                  onClick={() => openEdit(selectedEntry)}
                  data-testid="phone-files-edit-button"
                >
                  编辑
                </button>
                <button
                  type="button"
                  className={`${styles.xyBtnGhost} ${styles.xyBtnGhostDanger}`}
                  onClick={() => void handleDeleteSelected()}
                  disabled={deleteBusy}
                  data-testid="phone-files-delete-button"
                >
                  {deleteBusy ? '删除中…' : '删除'}
                </button>
              </div>
            </article>
          </div>
        ) : null}

        {/* 隐藏文件夹：解锁后视图 */}
        {inHiddenView ? (
          <HiddenFolderView
            agent={ownerAgent}
            profile={ownerProfile}
            entries={hiddenEntries}
            hiddenState={hiddenState}
            seedBusy={hiddenSeedBusy}
            seedError={hiddenSeedError}
            onGenerateSeeds={() => void handleGenerateHiddenSeeds()}
            onAddManual={openHiddenManual}
            onDelete={(entry) => void handleDeleteHiddenEntry(entry)}
            onRelock={() => void handleHiddenRelock()}
            onShareEntryToChat={handleShareHiddenEntryToChat}
            sharedEntryKey={sharedToChatKey}
            displayName={ta}
            scrollClassName={styles.xyScroll}
            cardClassName={styles.xyNoteCard}
            titleClassName={styles.xyNoteCardTitle}
            bodyClassName={styles.xyNoteCardBody}
            footClassName={styles.xyNoteCardFoot}
            emptyClassName={styles.xyFilesEmpty}
            hintClassName={styles.phoneAppHint}
          />
        ) : null}
      </div>

      {hiddenPwModalOpen ? (
        <HiddenPasswordModal
          agent={ownerAgent}
          profile={ownerProfile}
          busy={hiddenPwBusy}
          error={hiddenPwError}
          attemptCount={hiddenAttemptCount}
          lastReaction={hiddenReaction}
          shaking={hiddenShake}
          onClose={closeHiddenPasswordModal}
          onSubmit={(attempt) => void handleHiddenPasswordAttempt(attempt)}
        />
      ) : null}

      {hiddenManualOpen ? (
        <div
          className={styles.phoneModalOverlay}
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !hiddenManualBusy) {
              setHiddenManualOpen(false);
            }
          }}
        >
          <div
            className={styles.phoneModalSheet}
            role="dialog"
            aria-modal="true"
            aria-labelledby="phone-files-hidden-manual-title"
          >
            <h3
              id="phone-files-hidden-manual-title"
              className={styles.phoneModalTitle}
            >
              加一条到抽屉里
            </h3>
            <div className={styles.phoneModalBody}>
              <label className={styles.xyEditorField}>
                <span>类型</span>
                <select
                  value={hiddenManualKind}
                  onChange={(e) => setHiddenManualKind(e.target.value as XingyeHiddenFileEntryKind)}
                  disabled={hiddenManualBusy}
                  data-testid="phone-files-hidden-manual-kind"
                >
                  <option value="manual">手记</option>
                  <option value="weakness">弱点</option>
                  <option value="guilty_pleasure">不光彩的喜好</option>
                  <option value="secret_taste">说不出口的偏好</option>
                  <option value="secret_plan">不可告人的计划</option>
                </select>
              </label>
              <label className={styles.xyEditorField}>
                <span>标题</span>
                <input
                  value={hiddenManualTitle}
                  onChange={(e) => setHiddenManualTitle(e.target.value)}
                  placeholder="这条叫什么"
                  disabled={hiddenManualBusy}
                  data-testid="phone-files-hidden-manual-title"
                />
              </label>
              <label className={styles.xyEditorField}>
                <span>正文</span>
                <textarea
                  value={hiddenManualBody}
                  onChange={(e) => setHiddenManualBody(e.target.value)}
                  rows={5}
                  placeholder="写下来——抽屉锁上的时候只有 TA 自己能看到。"
                  disabled={hiddenManualBusy}
                  data-testid="phone-files-hidden-manual-body"
                />
              </label>
              {hiddenManualError ? (
                <p className={styles.xyEditorError} role="alert">{hiddenManualError}</p>
              ) : null}
            </div>
            <div className={styles.phoneModalActions}>
              <button
                type="button"
                className={styles.xyBtnGhost}
                onClick={() => setHiddenManualOpen(false)}
                disabled={hiddenManualBusy}
              >
                取消
              </button>
              <button
                type="button"
                className={styles.xyEditorPrimary}
                onClick={() => void handleSaveHiddenManual()}
                disabled={hiddenManualBusy}
                data-testid="phone-files-hidden-manual-save"
              >
                {hiddenManualBusy ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {composeMode ? (
        <div
          className={styles.phoneModalOverlay}
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeCompose();
          }}
        >
          <div
            className={styles.phoneModalSheet}
            role="dialog"
            aria-modal="true"
            aria-labelledby="phone-files-compose-title"
          >
            <h3 id="phone-files-compose-title" className={styles.phoneModalTitle}>
              {composeMode.kind === 'create' ? '新建文件' : '编辑文件'}
            </h3>
            <div className={styles.phoneModalBody}>
              <label className={styles.xyEditorField}>
                <span>整理意图</span>
                <textarea
                  value={draftIntent}
                  onChange={(event) => setDraftIntent(event.target.value)}
                  rows={2}
                  placeholder="可选：想让 TA 整理什么方向的资料"
                  data-testid="phone-files-intent-input"
                />
              </label>
              <button
                type="button"
                className={styles.xyBtnGhost}
                onClick={() => void handleGenerateDraft()}
                disabled={aiBusy || saveBusy || !ownerAgent}
                data-testid="phone-files-ai-button"
                style={{ flex: '0 0 auto', alignSelf: 'flex-start' }}
              >
                {aiBusy ? '生成中…' : '让 TA 自己整理'}
              </button>
              {aiError ? (
                <p className={styles.xyEditorError} role="alert">{aiError}</p>
              ) : null}
              {aiFolderName && composeMode.kind === 'create' ? (
                (() => {
                  const targetFolder = folders.find((f) => f.id === composeMode.folderId);
                  if (!targetFolder || targetFolder.name === aiFolderName) return null;
                  return (
                    <p className={styles.xyDraftHint} data-testid="phone-files-ai-folder-mismatch">
                      TA 想把这条放进「{aiFolderName}」，但当前文件夹是「{targetFolder.name}」；保存后会落在当前文件夹。
                    </p>
                  );
                })()
              ) : null}
              <label className={styles.xyEditorField}>
                <span>标题</span>
                <input
                  value={draftTitle}
                  onChange={(event) => setDraftTitle(event.target.value)}
                  placeholder="给这条文件一个名字"
                  data-testid="phone-files-title-input"
                />
              </label>
              <label className={styles.xyEditorField}>
                <span>正文</span>
                <textarea
                  value={draftBody}
                  onChange={(event) => setDraftBody(event.target.value)}
                  rows={6}
                  placeholder="可以写设定 / 关系 / 线索 / 摘抄等内容…"
                  data-testid="phone-files-body-input"
                />
              </label>
              <label className={styles.xyEditorField}>
                <span>标签</span>
                <input
                  value={draftTags}
                  onChange={(event) => setDraftTags(event.target.value)}
                  placeholder="可选，用逗号分隔，如 设定, 关系"
                  data-testid="phone-files-tags-input"
                />
              </label>
              <label className={styles.xyEditorField}>
                <span>来源</span>
                <input
                  value={draftSource}
                  onChange={(event) => setDraftSource(event.target.value)}
                  placeholder="可选，如「2026-05-15 闲聊」"
                  data-testid="phone-files-source-input"
                />
              </label>
              {saveError ? (
                <p className={styles.xyEditorError} role="alert">{saveError}</p>
              ) : null}
            </div>
            <div className={styles.phoneModalActions}>
              <button
                type="button"
                className={styles.xyBtnGhost}
                onClick={closeCompose}
                disabled={saveBusy || aiBusy}
                style={{ flex: '0 0 auto' }}
              >
                取消
              </button>
              <button
                type="button"
                className={styles.xyEditorPrimary}
                onClick={() => void handleSave()}
                disabled={saveBusy || aiBusy}
                data-testid="phone-files-save-button"
                style={{ flex: '0 0 auto', padding: '10px 18px' }}
              >
                {saveBusy ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {duplicateHit ? (
        <div
          className={styles.phoneModalOverlay}
          role="presentation"
          data-testid="phone-files-duplicate-modal"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setDuplicateHit(null);
          }}
        >
          <div
            className={styles.phoneModalSheet}
            role="dialog"
            aria-modal="true"
            aria-labelledby="phone-files-duplicate-title"
          >
            <h3 id="phone-files-duplicate-title" className={styles.phoneModalTitle}>
              资料柜里已有相似条目
            </h3>
            <div className={styles.phoneModalBody}>
              <p>
                《{duplicateHit.title}》
                {(() => {
                  const folder = folders.find((f) => f.id === duplicateHit.folderId);
                  return folder ? <span className={styles.xyDraftHint}>（{folder.name}）</span> : null;
                })()}
              </p>
              {duplicateHit.summary ? (
                <p className={styles.xyDraftHint}>摘要：{duplicateHit.summary}</p>
              ) : null}
              {duplicateHit.body ? (
                <p className={styles.xyDraftHint}>
                  片段：{duplicateHit.body.slice(0, 120)}
                  {duplicateHit.body.length > 120 ? '…' : ''}
                </p>
              ) : null}
              <p className={styles.xyDraftHint}>
                是不是想找的就是这条？打开它在原条目上编辑通常比新建一份相似的条目更合适。
              </p>
            </div>
            <div className={styles.phoneModalActions}>
              <button
                type="button"
                className={styles.xyBtnGhost}
                onClick={() => setDuplicateHit(null)}
                data-testid="phone-files-duplicate-cancel"
              >
                取消
              </button>
              <button
                type="button"
                className={styles.xyDraftDiscard}
                onClick={() => {
                  forceCreateOverrideRef.current = true;
                  setDuplicateHit(null);
                  void handleSave();
                }}
                data-testid="phone-files-duplicate-force-create"
              >
                仍然新建一条
              </button>
              <button
                type="button"
                className={styles.xyEditorPrimary}
                onClick={() => {
                  const target = duplicateHit;
                  setDuplicateHit(null);
                  setComposeMode({ kind: 'edit', entry: target });
                  setSelectedEntryId(target.id);
                  setSelectedFolderId(target.folderId);
                  setDraftTitle(target.title);
                  setDraftBody(target.body);
                  setDraftTags(target.tags?.join(', ') ?? '');
                  setDraftSource(target.source ?? '');
                  setSaveError(null);
                }}
                data-testid="phone-files-duplicate-open-target"
              >
                打开那条编辑
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
