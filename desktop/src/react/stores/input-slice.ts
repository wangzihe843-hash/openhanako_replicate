import type { AudioWaveform } from './chat-types';
import type { JSONContent } from '@tiptap/core';
import { HOME_DRAFT_KEY } from '../../../../shared/input-drafts.ts';
import { sessionScopedKey, sessionScopedValue, type SessionLocatorState } from './session-slice';
import { notifyDraftCleared, notifyDraftSet } from './input-draft-sync';

export interface AttachedFile {
  fileId?: string;
  path: string;
  name: string;
  isDirectory?: boolean;
  /** 内联 base64 数据（粘贴图片时使用，跳过文件读取） */
  base64Data?: string;
  mimeType?: string;
  waveform?: AudioWaveform;
}

export interface DocContextFile {
  path: string;
  name: string;
}

export interface FloatingAnchorRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

export type QuotedSourceKind =
  | 'preview'
  | 'chat'
  | 'accounting'
  | 'news'
  | 'secondhand'
  | 'shopping'
  | 'secret-space'
  | 'files'
  | 'secret-drawer'
  | 'journal';

export interface QuotedSelection {
  text: string;
  sourceTitle: string;
  sourceKind: QuotedSourceKind;
  sourceFilePath?: string;
  sourceSessionPath?: string;
  sourceMessageId?: string;
  sourceRole?: 'user' | 'assistant';
  lineStart?: number;
  lineEnd?: number;
  selectionAnchorKind?: 'native' | 'codemirror';
  charCount: number;
  anchorRect?: FloatingAnchorRect;
  updatedAt?: number;
}

/** A local send owns one input occurrence, independently of the mounted editor. */
export interface ComposerSubmission {
  id: symbol;
  owner: string;
  /** Document edit identity, stable through successful consumption and restoration. */
  revision: number;
  files: readonly AttachedFile[];
  quotes: readonly QuotedSelection[];
  context: string;
  contextChanged: boolean;
}

export function composerOwnerKey(state: SessionLocatorState & {
  pendingNewSession?: boolean;
  pendingDraftId?: string | null;
}): string | null {
  if (state.pendingNewSession && state.pendingDraftId) return `pending:${state.pendingDraftId}`;
  const key = sessionScopedKey(state, state.currentSessionPath);
  return key ? `session:${key}` : null;
}

const sameOccurrences = <T,>(left: readonly T[], right: readonly T[]) => (
  left.length === right.length && left.every((item, index) => item === right[index])
);

export interface InputSlice {
  attachedFiles: AttachedFile[];
  /** 按 session path 存储的附件（权威源） */
  attachedFilesBySession: Record<string, AttachedFile[]>;
  /** 按 session path 存储的草稿文本（内存级，关窗口清空） */
  drafts: Record<string, string>;
  /** 按 session path 存储的输入框富文本草稿（内存级，关窗口清空） */
  draftDocs: Record<string, JSONContent>;
  /** 草稿持久化 hydrate 完成时间戳（0 = 未 hydrate）；InputArea 恢复 effect 依赖它重跑 */
  draftsHydratedAt: number;
  /** Runtime edit identity, never persisted. User A → empty → A is a new draft; consumption is not. */
  draftRevisions: Record<string, number>;
  /** Only in-flight local sends; never persisted. Transferred before ChatPage remounts. */
  composerSubmissions: ComposerSubmission[];
  claimComposerSubmission: (input: Omit<ComposerSubmission, 'id' | 'contextChanged'>) => symbol | null;
  invalidateComposerSubmissionContext: (id: symbol) => void;
  releaseComposerSubmission: (id: symbol) => void;
  consumeComposerSubmission: (id: symbol, sessionPath: string, consumeQuotes: boolean, consumeContext: boolean) => void;
  deskContextAttached: boolean;
  docContextAttached: boolean;
  inputFocusTrigger: number;
  /** Source of the most recent requestInputFocus() call; consumers gate 'restore' by surface. */
  inputFocusTriggerSource: 'gesture' | 'restore';
  quoteCandidate: QuotedSelection | null;
  quotedSelections: QuotedSelection[];
  /** @deprecated Use quotedSelections for committed quotes and quoteCandidate for transient selection UI. */
  quotedSelection: QuotedSelection | null;
  addAttachedFile: (file: AttachedFile) => void;
  removeAttachedFile: (index: number) => void;
  setAttachedFiles: (files: AttachedFile[]) => void;
  clearAttachedFiles: () => void;
  /** 清理指定 session 的附件；只有目标仍是当前 session 时才同步清空可见附件。 */
  clearAttachedFilesForSession: (sessionPath: string, submitted?: readonly AttachedFile[]) => void;
  setDraft: (sessionPath: string, text: string, doc?: JSONContent | null, edited?: boolean) => void;
  clearDraft: (sessionPath: string) => void;
  setDeskContextAttached: (attached: boolean) => void;
  toggleDeskContext: () => void;
  setDocContextAttached: (attached: boolean) => void;
  toggleDocContext: () => void;
  requestInputFocus: (source?: 'gesture' | 'restore') => void;
  setQuoteCandidate: (sel: QuotedSelection) => void;
  clearQuoteCandidate: () => void;
  addQuotedSelection: (sel: QuotedSelection) => void;
  removeQuotedSelection: (index: number) => void;
  clearQuotedSelections: () => void;
  setQuotedSelections: (sels: QuotedSelection[]) => void;
  /** @deprecated Use addQuotedSelection or setQuoteCandidate. */
  setQuotedSelection: (sel: QuotedSelection) => void;
  /** @deprecated Use clearQuotedSelections and clearQuoteCandidate. */
  clearQuotedSelection: () => void;
  /**
   * 「待带入下一个聊天的引用」暂存槽。与 quotedSelection 的关键区别：跨 session
   * 切换不会被清除（switchSession 会清 quotedSelection）。秘密空间「去和 TA 聊聊」
   * 这类"在别处暂存内容、让用户自己挑聊天目的地"的入口用它暂存，进入任意聊天后
   * 由 redeemStagedChatQuote 兑换成 quotedSelection。
   */
  stagedChatQuote: QuotedSelection | null;
  stageChatQuote: (sel: QuotedSelection) => void;
  redeemStagedChatQuote: () => void;
}

function syncCurrentSessionAttachments(state: InputSlice & { currentSessionPath?: string | null }, files: AttachedFile[]) {
  const patch: Partial<InputSlice> & { attachedFilesBySession?: Record<string, AttachedFile[]> } = {
    attachedFiles: files,
  };
  const currentSessionPath = state.currentSessionPath;
  if (currentSessionPath) {
    const key = sessionScopedKey(state as any, currentSessionPath) || currentSessionPath;
    patch.attachedFilesBySession = {
      ...state.attachedFilesBySession,
      [key]: files,
    };
    if (key !== currentSessionPath) delete patch.attachedFilesBySession[currentSessionPath];
  }
  return patch;
}

let nextDraftRevision = 0;

/** Move the latest pending draft at activation, including edits made during session creation. */
export function pendingComposerActivationPatch(
  state: InputSlice & SessionLocatorState,
  sessionPath: string,
  pendingDraftId: string,
): Partial<InputSlice> {
  const key = sessionScopedKey(state, sessionPath) || sessionPath;
  const drafts = { ...state.drafts };
  const draftDocs = { ...state.draftDocs };
  const text = drafts[HOME_DRAFT_KEY];
  const doc = draftDocs[HOME_DRAFT_KEY];
  delete drafts[HOME_DRAFT_KEY];
  delete draftDocs[HOME_DRAFT_KEY];
  if (text !== undefined) drafts[key] = text;
  if (doc) draftDocs[key] = doc;
  notifyDraftCleared(HOME_DRAFT_KEY);
  if (text !== undefined || doc) notifyDraftSet(key, text || '', doc ?? null);
  return {
    drafts, draftDocs,
    composerSubmissions: state.composerSubmissions.map(submission => (
      submission.owner === `pending:${pendingDraftId}`
        ? { ...submission, owner: `session:${key}` }
        : submission
    )),
    draftRevisions: {
      ...state.draftRevisions,
      [key]: state.draftRevisions?.[HOME_DRAFT_KEY] || 0,
      [HOME_DRAFT_KEY]: ++nextDraftRevision,
    },
    attachedFiles: state.attachedFiles,
    attachedFilesBySession: { ...state.attachedFilesBySession, [key]: state.attachedFiles },
    docContextAttached: state.docContextAttached,
  };
}

export const createInputSlice = (
  set: (partial: Partial<InputSlice> | ((s: InputSlice) => Partial<InputSlice>)) => void
): InputSlice => ({
  attachedFiles: [],
  attachedFilesBySession: {},
  drafts: {},
  draftDocs: {},
  draftsHydratedAt: 0,
  draftRevisions: {},
  composerSubmissions: [],
  claimComposerSubmission: (input) => {
    let id: symbol | null = null;
    set((s) => {
      const duplicate = s.composerSubmissions.some(submission => (
        submission.owner === input.owner && submission.revision === input.revision
        && submission.context === input.context
        && !submission.contextChanged
        && sameOccurrences(submission.files, input.files)
        && sameOccurrences(submission.quotes, input.quotes)
      ));
      if (duplicate) return {};
      id = Symbol('composer submission');
      return { composerSubmissions: [...s.composerSubmissions, { ...input, id, contextChanged: false }] };
    });
    return id;
  },
  invalidateComposerSubmissionContext: (id) => set((s) => ({
    composerSubmissions: s.composerSubmissions.map(submission => (
      submission.id === id ? { ...submission, contextChanged: true } : submission
    )),
  })),
  releaseComposerSubmission: (id) => set((s) => ({
    composerSubmissions: s.composerSubmissions.filter(submission => submission.id !== id),
  })),
  consumeComposerSubmission: (id, sessionPath, consumeQuotes, consumeContext) => set((s) => {
    const submission = s.composerSubmissions.find(item => item.id === id);
    if (!submission) return {};
    const state = s as InputSlice & SessionLocatorState;
    const visible = composerOwnerKey(state) === submission.owner;
    const key = sessionScopedKey(state, sessionPath) || sessionPath;
    const files = (visible ? s.attachedFiles : sessionScopedValue(state, s.attachedFilesBySession, sessionPath) || [])
      .filter(file => !submission.files.includes(file));
    const attachedFilesBySession = { ...s.attachedFilesBySession };
    delete attachedFilesBySession[key];
    delete attachedFilesBySession[sessionPath];
    if (files.length) attachedFilesBySession[key] = files;
    const consumedQuotes = visible && consumeQuotes ? submission.quotes : [];
    const quotes = s.quotedSelections.filter(quote => !consumedQuotes.includes(quote));
    const contextConsumed = visible && consumeContext;
    // The store owns edit identity across editor lifetimes. Consume the matching
    // edit without minting a new revision: every overlapping send of that edit
    // still owns the remaining input, even once the editor restores an empty doc.
    const draftKey = submission.owner.startsWith('session:')
      ? submission.owner.slice('session:'.length)
      : visible ? HOME_DRAFT_KEY : null;
    const draftConsumed = draftKey !== null
      && (s.draftRevisions[draftKey] || 0) === submission.revision;
    const drafts = { ...s.drafts };
    const draftDocs = { ...s.draftDocs };
    if (draftConsumed) {
      delete drafts[draftKey];
      delete draftDocs[draftKey];
      if (draftKey === key) {
        delete drafts[sessionPath];
        delete draftDocs[sessionPath];
      }
      notifyDraftCleared(draftKey);
    }
    return {
      ...(draftConsumed ? { drafts, draftDocs } : {}),
      attachedFilesBySession,
      ...(visible ? { attachedFiles: files } : {}),
      ...(consumedQuotes.length ? { quotedSelections: quotes, quotedSelection: quotes[0] ?? null } : {}),
      ...(contextConsumed ? { docContextAttached: false } : {}),
      // Consuming shared input is not a user edit. Keep other in-flight claims
      // aligned with what remains visible, without changing their frozen payloads.
      composerSubmissions: s.composerSubmissions.map(item => item.owner !== submission.owner ? item : {
        ...item,
        files: item.files.filter(file => !submission.files.includes(file)),
        quotes: item.quotes.filter(quote => !consumedQuotes.includes(quote)),
        context: contextConsumed && item.context === submission.context ? JSON.stringify([false, null]) : item.context,
      }),
    };
  }),
  deskContextAttached: false,
  docContextAttached: false,
  inputFocusTrigger: 0,
  inputFocusTriggerSource: 'gesture',
  quoteCandidate: null,
  quotedSelections: [],
  quotedSelection: null,
  addAttachedFile: (file) =>
    set((s) => syncCurrentSessionAttachments(s as InputSlice & { currentSessionPath?: string | null }, [...s.attachedFiles, { ...file }])),
  removeAttachedFile: (index) =>
    set((s) => syncCurrentSessionAttachments(
      s as InputSlice & { currentSessionPath?: string | null },
      s.attachedFiles.filter((_, i) => i !== index),
    )),
  setAttachedFiles: (files) =>
    set((s) => syncCurrentSessionAttachments(s as InputSlice & { currentSessionPath?: string | null }, files)),
  clearAttachedFiles: () =>
    set((s) => syncCurrentSessionAttachments(s as InputSlice & { currentSessionPath?: string | null }, [])),
  clearAttachedFilesForSession: (sessionPath, submitted) =>
    set((s) => {
      const state = s as InputSlice & { currentSessionPath?: string | null };
      const key = sessionScopedKey(state as any, sessionPath) || sessionPath;
      const attachedFilesBySession = { ...s.attachedFilesBySession };
      const current = state.currentSessionPath === sessionPath
        ? s.attachedFiles
        : sessionScopedValue(state, attachedFilesBySession, sessionPath) || [];
      const remaining = submitted ? current.filter(file => !submitted.includes(file)) : [];
      delete attachedFilesBySession[key];
      delete attachedFilesBySession[sessionPath];
      if (remaining.length) attachedFilesBySession[key] = remaining;
      return {
        attachedFilesBySession,
        ...(state.currentSessionPath === sessionPath ? { attachedFiles: remaining } : {}),
      };
    }),
  setDraft: (sessionPath, text, doc, edited = false) =>
    set((s) => {
      const key = sessionScopedKey(s as any, sessionPath) || sessionPath;
      const prevText = Object.prototype.hasOwnProperty.call(s.drafts, key)
        ? s.drafts[key]
        : Object.prototype.hasOwnProperty.call(s.drafts, sessionPath)
          ? s.drafts[sessionPath]
          : undefined;
      const prevDoc = Object.prototype.hasOwnProperty.call(s.draftDocs, key)
        ? s.draftDocs[key]
        : Object.prototype.hasOwnProperty.call(s.draftDocs, sessionPath)
          ? s.draftDocs[sessionPath]
          : undefined;
      const nextDoc = doc ?? null;
      const sameText = prevText === text;
      const sameDoc = nextDoc
        ? !!prevDoc && JSON.stringify(prevDoc) === JSON.stringify(nextDoc)
        : prevDoc === undefined;
      // 内容未变则保持 drafts/draftDocs 引用不变，避免 InputArea 订阅方空转，
      // 也让「恢复走 emitUpdate」时不会 update→setDraft→effect 死循环。
      if (sameText && sameDoc && prevText !== undefined) {
        // An editor transaction can replace text with identical content. Keep
        // mirror references stable, but relinquish the earlier send's ownership.
        return edited ? { draftRevisions: { ...s.draftRevisions, [key]: ++nextDraftRevision } } : {};
      }
      const drafts = { ...s.drafts, [key]: text };
      const draftDocs = { ...s.draftDocs };
      if (doc) draftDocs[key] = doc;
      else delete draftDocs[key];
      if (key !== sessionPath) delete drafts[sessionPath];
      if (key !== sessionPath) delete draftDocs[sessionPath];
      notifyDraftSet(key, text, doc ?? null);
      return { drafts, draftDocs, draftRevisions: { ...s.draftRevisions, [key]: ++nextDraftRevision } };
    }),
  clearDraft: (sessionPath) =>
    set((s) => {
      const key = sessionScopedKey(s as any, sessionPath) || sessionPath;
      const rest = { ...s.drafts };
      const draftDocs = { ...s.draftDocs };
      delete rest[key];
      delete rest[sessionPath];
      delete draftDocs[key];
      delete draftDocs[sessionPath];
      notifyDraftCleared(key);
      return { drafts: rest, draftDocs, draftRevisions: { ...s.draftRevisions, [key]: ++nextDraftRevision } };
    }),
  setDeskContextAttached: (attached) => set({ deskContextAttached: attached }),
  toggleDeskContext: () =>
    set((s) => ({ deskContextAttached: !s.deskContextAttached })),
  setDocContextAttached: (attached) => set({ docContextAttached: attached }),
  toggleDocContext: () =>
    set((s) => ({ docContextAttached: !s.docContextAttached })),
  requestInputFocus: (source = 'gesture') =>
    set((s) => ({ inputFocusTrigger: s.inputFocusTrigger + 1, inputFocusTriggerSource: source })),
  setQuoteCandidate: (sel) => set({ quoteCandidate: sel }),
  clearQuoteCandidate: () => set({ quoteCandidate: null }),
  addQuotedSelection: (sel) =>
    set((s) => {
      const quotedSelections = [...s.quotedSelections, { ...sel }];
      return { quotedSelections, quotedSelection: quotedSelections[0] ?? null };
    }),
  removeQuotedSelection: (index) =>
    set((s) => {
      const quotedSelections = s.quotedSelections.filter((_, i) => i !== index);
      return { quotedSelections, quotedSelection: quotedSelections[0] ?? null };
    }),
  clearQuotedSelections: () => set({ quotedSelections: [], quotedSelection: null }),
  setQuotedSelections: (sels) => {
    const quotedSelections = sels.map(sel => ({ ...sel }));
    set({ quotedSelections, quotedSelection: quotedSelections[0] ?? null });
  },
  setQuotedSelection: (sel) => {
    const quote = { ...sel };
    set({ quotedSelections: [quote], quotedSelection: quote });
  },
  clearQuotedSelection: () => set({ quoteCandidate: null, quotedSelections: [], quotedSelection: null }),
  stagedChatQuote: null,
  stageChatQuote: (sel) => set({ stagedChatQuote: sel }),
  redeemStagedChatQuote: () =>
    set((s) =>
      s.stagedChatQuote
        ? {
            quotedSelections: [s.stagedChatQuote],
            quotedSelection: s.stagedChatQuote,
            stagedChatQuote: null,
          }
        : {},
    ),
});
