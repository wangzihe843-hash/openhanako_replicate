import { useCallback, useEffect, useState } from 'react';
import type { Agent } from '../types';
import {
  emitAgentPinnedMemoryChanged,
  loadAgentPinnedMemory,
  normalizePinBulletForMatch,
  subscribeAgentPinnedMemoryChanged,
} from '../agent-pinned-memory';
import { hanaFetch } from '../hooks/use-hana-fetch';
import { getXingyeRoleProfileDisplay, useXingyeRoleProfile } from './xingye-profile-store';
import { MemoryCandidatePanel } from './MemoryCandidatePanel';
import { RelationshipStatePanel } from './RelationshipStatePanel';
import {
  SecretSpaceCategoryView,
  type SecretSpaceCategoryMeta,
} from './SecretSpaceCategoryView';
import { SecretSpaceHome, type SecretSpaceCategoryId } from './SecretSpaceHome';
import {
  SecretSpaceDraftGrid,
  SecretSpaceSavedList,
  SecretSpaceMomentsFeed,
  SecretSpaceMemoryGrid,
  SecretSpaceDreamFeed,
} from './SecretSpaceCategoryRenderers';
import type { SecretSpaceSampleRecord } from './secret-space-record-types';
import { generateSecretSpaceRecordWithAI, isSecretSpaceAiGenerableCategory } from './xingye-secret-space-ai';
import { generateSecretInterviewWithAI } from './xingye-secret-space-interview-ai';
import {
  flattenSecretInterviewToContent,
  normalizeSecretInterviewMetadata,
  type SecretInterviewMetadata,
} from './xingye-secret-space-interview-types';
import { SecretInterviewReader } from './SecretInterviewReader';
import {
  appendSecretSpaceRecord,
  deleteSecretSpaceRecord,
  listSecretSpaceRecords,
} from './xingye-secret-space-store';
import {
  confirmSecretSpaceDraft,
  discardSecretSpaceDraft,
  listSecretSpaceDrafts,
  SECRET_SPACE_DRAFT_ALLOWED_CATEGORIES,
  type SecretSpaceDraftCategory,
  type XingyePendingSecretSpaceDraft,
} from './xingye-secret-space-drafts';
import {
  importanceNumberFromLevel,
  XINGYE_MEMORY_CANDIDATE_IMPORTANCE_UI_OPTIONS,
  XINGYE_SECRET_SPACE_MANUAL_CANDIDATE_REASON_DEFAULT,
} from './xingye-memory-candidate-store';
import {
  confirmMemoryCandidateDraft,
  discardMemoryCandidateDraft,
  listMemoryCandidateDrafts,
  type XingyePendingMemoryCandidateDraft,
} from './xingye-memory-candidate-drafts';
import styles from './XingyeShell.module.css';

interface SecretSpacePanelProps {
  agent: Agent | null;
}

const EMPTY_RECORDS: Record<SecretSpaceCategoryId, SecretSpaceSampleRecord[]> = {
  state: [],
  draft_reply: [],
  dream: [],
  saved_item: [],
  unsent_moment: [],
  memory_fragment: [],
  interview: [],
};

const CATEGORY_META: SecretSpaceCategoryMeta[] = [
  {
    id: 'state',
    kicker: 'STATE · 此刻 / 心情',
    title: 'TA 的状态',
    description: 'TA 现在是什么样子，最近又在想些什么',
    recordsEmptyTitle: '尚无额外的文字记录',
    recordsEmptyBody: '这里预留展示与「状态」相关的短笔记。当前上方为关系与标签面板。',
  },
  {
    id: 'draft_reply',
    kicker: 'DRAFT · 没发出去的话',
    title: 'TA 的草稿箱',
    description: '写了一半，又删掉的那些回复',
    recordsEmptyTitle: '草稿箱是空的',
    recordsEmptyBody: '还没有未发出的回复草稿。',
  },
  {
    id: 'dream',
    kicker: 'DREAM · 梦的残片',
    title: 'TA 的梦境',
    description: 'TA 记得的，比 TA 能说出来的少得多',
    recordsEmptyTitle: '还没有梦境记录',
    recordsEmptyBody: '梦记只以文字呈现，不接图片或语音解梦。',
  },
  {
    id: 'saved_item',
    kicker: 'SAVED · 摘抄 / 收藏',
    title: 'TA 收藏的东西',
    description: '句子、对话、和被 TA 抄下来的瞬间',
    recordsEmptyTitle: '收藏夹是空的',
    recordsEmptyBody: '此分类只表现纯文本收藏，不做相册式或附件式收藏 UI。',
  },
  {
    id: 'unsent_moment',
    kicker: 'UNSENT · 草稿动态',
    title: 'TA 未发送的朋友圈',
    description: '只有 TA 自己能看见的朋友圈草稿',
    recordsEmptyTitle: '没有未发送草稿',
    recordsEmptyBody: '朋友圈草稿在此仅以文字呈现。',
  },
  {
    id: 'memory_fragment',
    kicker: 'MEMORY · 标本 / 碎片',
    title: '私藏回忆',
    description: '一句话、一个气味、一段对话的残角',
    recordsEmptyTitle: '还没有回忆片段',
    recordsEmptyBody: '可记录一句场景、气味或对话残片。',
  },
  {
    id: 'interview',
    kicker: 'INTERVIEW · 录制 / 弹幕 / 幕后',
    title: 'TA 的独家专访',
    description: '5 题录制 + 吃瓜弹幕 + 「相机关了之后」的彩蛋',
    recordsEmptyTitle: '还没有任何一期专访',
    recordsEmptyBody: '点下方「录一期专访」让模型出一期：5 题、弹幕、幕后彩蛋一次性生成。',
  },
];

function emptyRecords(): Record<SecretSpaceCategoryId, SecretSpaceSampleRecord[]> {
  return {
    state: [],
    draft_reply: [],
    dream: [],
    saved_item: [],
    unsent_moment: [],
    memory_fragment: [],
    interview: [],
  };
}

function metaById(id: SecretSpaceCategoryId): SecretSpaceCategoryMeta {
  const found = CATEGORY_META.find((m) => m.id === id);
  if (!found) {
    throw new Error(`Unknown secret space category: ${id}`);
  }
  return found;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * memory_fragment 视图里"OpenHanako pinned"那一支条目用的来源标志。
 * memory_fragment.jsonl 自身的条目（来自心跳草稿确认或秘密空间手动建私藏）source 是
 * `xingye-heartbeat-tool` / `xingye-secret-space-store` 等；只有这个常量值代表
 * "其实是 OpenHanako 自动从聊天提取的 pinned bullet,只是借 memory_fragment 视图展示"。
 * UI 用它判断：是否展示"删除 pinned"按钮、是否隐藏"推到 pinned"按钮。
 */
export const MEMORY_FRAGMENT_PINNED_SOURCE = 'OpenHanako pinned';

function pinnedMemoryToRecord(pin: string, index: number): SecretSpaceSampleRecord {
  const body = pin.trim();
  const title = body.length > 48 ? `${body.slice(0, 48)}…` : body;
  return {
    recordId: `memory-fragment-pinned-${index}`,
    key: `memory-fragment-pinned-${index}`,
    title,
    body,
    summary: body.length > 120 ? `${body.slice(0, 120)}…` : body,
    createdAt: '1970-01-01T00:00:00.000Z',
    kind: 'memory_fragment',
    source: MEMORY_FRAGMENT_PINNED_SOURCE,
  };
}

function pinnedMemoryRecordsFromPins(pins: string[]): SecretSpaceSampleRecord[] {
  return pins.map(pinnedMemoryToRecord);
}

/**
 * memory_fragment 视图的合并逻辑：jsonl 里的私藏回忆条目排在最前（最近创建在最上），
 * 后面接 OpenHanako pinned 的 bullets（按 pinned.md 顺序）。
 * 两者来源由各自 record.source 区分；UI 用 MEMORY_FRAGMENT_PINNED_SOURCE 判定。
 */
function mergeMemoryFragmentRecords(
  jsonlRecords: SecretSpaceSampleRecord[],
  pinnedRecords: SecretSpaceSampleRecord[],
): SecretSpaceSampleRecord[] {
  return [...jsonlRecords, ...pinnedRecords];
}

/**
 * 允许在本面板追加纯文本 JSONL 的分类。
 * `state` 使用上方 RelationshipStatePanel，不进此列表；`memory_fragment` 用「手动记忆候选」
 * 入口（弹出表单 → 直接写 memory_fragment.jsonl，不再经由 OpenHanako pinned 候选流程）。
 */
const ADD_RECORD_CATEGORY_IDS = new Set<SecretSpaceCategoryId>([
  'draft_reply',
  'dream',
  'saved_item',
  'unsent_moment',
]);

function isSecretSpaceManualAppendDebugEnabled(): boolean {
  return typeof process !== 'undefined' && process.env.NODE_ENV === 'development';
}

export function SecretSpacePanel({ agent }: SecretSpacePanelProps) {
  const profile = useXingyeRoleProfile(agent?.id);
  const [view, setView] = useState<'home' | 'category'>('home');
  const [activeCategory, setActiveCategory] = useState<SecretSpaceCategoryId | null>(null);
  const [recordsByCategory, setRecordsByCategory] = useState<Record<SecretSpaceCategoryId, SecretSpaceSampleRecord[]>>(
    EMPTY_RECORDS,
  );

  const [manualContent, setManualContent] = useState('');
  const [manualReason, setManualReason] = useState(XINGYE_SECRET_SPACE_MANUAL_CANDIDATE_REASON_DEFAULT);
  const [manualLevel, setManualLevel] = useState<'low' | 'medium' | 'high'>('medium');
  const [manualError, setManualError] = useState<string | null>(null);
  const [memoryCreateOpen, setMemoryCreateOpen] = useState(false);

  const [addRecordTitle, setAddRecordTitle] = useState('');
  const [addRecordBody, setAddRecordBody] = useState('');
  const [addRecordError, setAddRecordError] = useState<string | null>(null);
  const [addRecordSaving, setAddRecordSaving] = useState(false);

  const [savedItemSeed, setSavedItemSeed] = useState('');
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [secretSpaceDeleteError, setSecretSpaceDeleteError] = useState<string | null>(null);

  // interview 生成专属状态：用户出题（可空） + 生成态 + 错误
  const [interviewUserQuestion, setInterviewUserQuestion] = useState('');
  const [interviewLoading, setInterviewLoading] = useState(false);
  const [interviewError, setInterviewError] = useState<string | null>(null);

  /**
   * 秘密空间「待确认草稿」状态。drafts.jsonl 跨 category 共用一个文件，
   * 用 `category` 字段区分；UI 在 home 顶部统一展示一段。
   */
  const [pendingDrafts, setPendingDrafts] = useState<XingyePendingSecretSpaceDraft[]>([]);
  const [pendingDraftEdits, setPendingDraftEdits] = useState<
    Record<string, { title: string; body: string; category: SecretSpaceDraftCategory }>
  >({});
  const [pendingDraftBusyId, setPendingDraftBusyId] = useState<string | null>(null);
  const [pendingDraftError, setPendingDraftError] = useState<string | null>(null);

  /**
   * 记忆候选「待确认草稿」单独管，schema 与秘密空间 drafts 不同（带 importance）。
   * 展示在 memory_fragment 视图顶部，用户在此采纳 → 写 memory_fragment.jsonl,
   * 不自动写 pinned；用户再在卡片上手动决定要不要「推到 pinned」。
   */
  const [pendingMemoryCandidateDrafts, setPendingMemoryCandidateDrafts] = useState<
    XingyePendingMemoryCandidateDraft[]
  >([]);
  const [memoryDraftBusyId, setMemoryDraftBusyId] = useState<string | null>(null);
  const [memoryDraftError, setMemoryDraftError] = useState<string | null>(null);

  /** memory_fragment 列表卡片上"推到 pinned"操作的 busy / error 状态，按 recordId 分。 */
  const [pushPinnedBusyKey, setPushPinnedBusyKey] = useState<string | null>(null);
  const [pushPinnedFlash, setPushPinnedFlash] = useState<string | null>(null);

  useEffect(() => {
    if (!agent?.id) {
      setManualContent('');
      setManualReason(XINGYE_SECRET_SPACE_MANUAL_CANDIDATE_REASON_DEFAULT);
      setManualLevel('medium');
      setManualError(null);
      setMemoryCreateOpen(false);
      setAddRecordTitle('');
      setAddRecordBody('');
      setAddRecordError(null);
      setAddRecordSaving(false);
      setSavedItemSeed('');
      setAiError(null);
      setAiLoading(false);
      setInterviewUserQuestion('');
      setInterviewError(null);
      setInterviewLoading(false);
      setSecretSpaceDeleteError(null);
      setView('home');
      setActiveCategory(null);
      setRecordsByCategory(emptyRecords());
    }
  }, [agent?.id]);

  useEffect(() => {
    setSecretSpaceDeleteError(null);
  }, [agent?.id, activeCategory]);

  /**
   * 加载 / 刷新当前 agent 的秘密空间待确认草稿。
   * 仅在 home view 展示，但 fetch 不区分 view（agent 切换或我们 confirm/discard 后都刷新）。
   */
  const reloadPendingSecretSpaceDrafts = useCallback(async () => {
    if (!agent?.id) {
      setPendingDrafts([]);
      setPendingDraftEdits({});
      return;
    }
    try {
      const drafts = await listSecretSpaceDrafts(agent.id);
      setPendingDrafts(drafts);
    } catch (err) {
      setPendingDraftError(err instanceof Error ? err.message : String(err));
    }
  }, [agent?.id]);

  useEffect(() => {
    void reloadPendingSecretSpaceDrafts();
  }, [reloadPendingSecretSpaceDrafts]);

  const pendingDraftWorkingValue = useCallback(
    (d: XingyePendingSecretSpaceDraft) => {
      const edit = pendingDraftEdits[d.id];
      if (edit) return edit;
      return {
        title: d.title ?? '',
        body: d.body,
        category: d.category,
      };
    },
    [pendingDraftEdits],
  );

  const handlePendingDraftFieldChange = (
    draftId: string,
    patch: Partial<{ title: string; body: string; category: SecretSpaceDraftCategory }>,
  ) => {
    setPendingDraftEdits((prev) => {
      const d = pendingDrafts.find((entry) => entry.id === draftId);
      if (!d) return prev;
      const base = prev[draftId] ?? {
        title: d.title ?? '',
        body: d.body,
        category: d.category,
      };
      return { ...prev, [draftId]: { ...base, ...patch } };
    });
  };

  const handleConfirmPendingDraft = async (d: XingyePendingSecretSpaceDraft) => {
    if (!agent?.id) return;
    setPendingDraftBusyId(d.id);
    setPendingDraftError(null);
    try {
      const working = pendingDraftWorkingValue(d);
      await confirmSecretSpaceDraft(agent.id, d.id, {
        category: working.category,
        title: working.title,
        body: working.body,
      });
      setPendingDrafts((prev) => prev.filter((p) => p.id !== d.id));
      setPendingDraftEdits((prev) => {
        if (!(d.id in prev)) return prev;
        const { [d.id]: _omitted, ...rest } = prev;
        return rest;
      });
      /** 若用户当前正打开 confirm 的 category，刷新该 category 的记录列表。 */
      if (activeCategory === working.category) {
        const records = await listSecretSpaceRecords(agent.id, working.category);
        setRecordsByCategory((prev) => ({ ...prev, [working.category]: records }));
      }
    } catch (err) {
      setPendingDraftError(err instanceof Error ? err.message : String(err));
    } finally {
      setPendingDraftBusyId(null);
    }
  };

  const handleDiscardPendingDraft = async (d: XingyePendingSecretSpaceDraft) => {
    if (!agent?.id) return;
    if (!window.confirm('确定丢弃这条待确认秘密空间草稿？此操作不可恢复，但角色可在下次巡检里重新提议。')) {
      return;
    }
    setPendingDraftBusyId(d.id);
    setPendingDraftError(null);
    try {
      const ok = await discardSecretSpaceDraft(agent.id, d.id);
      if (ok) {
        setPendingDrafts((prev) => prev.filter((p) => p.id !== d.id));
        setPendingDraftEdits((prev) => {
          if (!(d.id in prev)) return prev;
          const { [d.id]: _omitted, ...rest } = prev;
          return rest;
        });
      } else {
        await reloadPendingSecretSpaceDrafts();
      }
    } catch (err) {
      setPendingDraftError(err instanceof Error ? err.message : String(err));
    } finally {
      setPendingDraftBusyId(null);
    }
  };

  const CATEGORY_DRAFT_LABEL: Record<SecretSpaceDraftCategory, string> = {
    state: '此刻心境 (state)',
    dream: '梦境 (dream)',
    saved_item: '摘录 (saved_item)',
    draft_reply: '没发出去的话 (draft_reply)',
    unsent_moment: '朋友圈草稿 (unsent_moment)',
  };

  useEffect(() => {
    if (!activeCategory || !isSecretSpaceAiGenerableCategory(activeCategory)) return;
    setAddRecordTitle('');
    setAddRecordBody('');
    setAddRecordError(null);
    setAddRecordSaving(false);
    setSavedItemSeed('');
    setAiError(null);
    setAiLoading(false);
  }, [activeCategory, agent?.id]);

  const reloadMemoryFragmentRecords = useCallback(async () => {
    if (!agent?.id) return;
    const [pins, jsonl] = await Promise.all([
      loadAgentPinnedMemory(agent.id, hanaFetch).catch(() => [] as string[]),
      listSecretSpaceRecords(agent.id, 'memory_fragment').catch(() => [] as SecretSpaceSampleRecord[]),
    ]);
    setRecordsByCategory((prev) => ({
      ...prev,
      memory_fragment: mergeMemoryFragmentRecords(jsonl, pinnedMemoryRecordsFromPins(pins)),
    }));
  }, [agent?.id]);

  useEffect(() => {
    if (!agent?.id || !activeCategory) return undefined;
    let cancelled = false;
    const load = async () => {
      let records: SecretSpaceSampleRecord[];
      if (activeCategory === 'memory_fragment') {
        const [pins, jsonl] = await Promise.all([
          loadAgentPinnedMemory(agent.id, hanaFetch).catch(() => [] as string[]),
          listSecretSpaceRecords(agent.id, 'memory_fragment').catch(() => [] as SecretSpaceSampleRecord[]),
        ]);
        records = mergeMemoryFragmentRecords(jsonl, pinnedMemoryRecordsFromPins(pins));
      } else {
        records = await listSecretSpaceRecords(agent.id, activeCategory).catch(() => []);
      }
      if (cancelled) return;
      setRecordsByCategory((prev) => ({ ...prev, [activeCategory]: records }));
    };
    void load();
    const onChanged = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.agentId === agent.id && detail?.category === activeCategory) {
        void load();
      }
    };
    window.addEventListener('xingye-secret-space-changed', onChanged);
    return () => {
      cancelled = true;
      window.removeEventListener('xingye-secret-space-changed', onChanged);
    };
  }, [agent?.id, activeCategory]);

  useEffect(() => {
    if (!agent?.id || activeCategory !== 'memory_fragment') return undefined;
    return subscribeAgentPinnedMemoryChanged((detail) => {
      if (detail.agentId !== agent.id) return;
      void reloadMemoryFragmentRecords();
    });
  }, [agent?.id, activeCategory, reloadMemoryFragmentRecords]);

  /**
   * memory_fragment 视图打开时，加载本 agent 的「记忆候选待确认草稿」(memory-candidate/drafts.jsonl)。
   * 仅在 memory_fragment 视图展示——其它视图不渲染。
   */
  const reloadMemoryCandidateDrafts = useCallback(async () => {
    if (!agent?.id) {
      setPendingMemoryCandidateDrafts([]);
      return;
    }
    try {
      const drafts = await listMemoryCandidateDrafts(agent.id);
      setPendingMemoryCandidateDrafts(drafts);
    } catch (err) {
      setMemoryDraftError(err instanceof Error ? err.message : String(err));
    }
  }, [agent?.id]);

  useEffect(() => {
    if (activeCategory === 'memory_fragment') {
      void reloadMemoryCandidateDrafts();
    }
  }, [activeCategory, reloadMemoryCandidateDrafts]);

  const handleConfirmMemoryCandidateDraft = async (draftId: string) => {
    if (!agent?.id) return;
    setMemoryDraftBusyId(draftId);
    setMemoryDraftError(null);
    try {
      await confirmMemoryCandidateDraft(agent.id, draftId);
      setPendingMemoryCandidateDrafts((prev) => prev.filter((d) => d.id !== draftId));
      await reloadMemoryFragmentRecords();
    } catch (err) {
      setMemoryDraftError(err instanceof Error ? err.message : String(err));
    } finally {
      setMemoryDraftBusyId(null);
    }
  };

  const handleDiscardMemoryCandidateDraft = async (draftId: string) => {
    if (!agent?.id) return;
    if (typeof window !== 'undefined' && !window.confirm('确定丢弃这条心跳巡检提议的记忆草稿？此操作不可恢复，但角色可在下次巡检里重新提议。')) {
      return;
    }
    setMemoryDraftBusyId(draftId);
    setMemoryDraftError(null);
    try {
      const ok = await discardMemoryCandidateDraft(agent.id, draftId);
      if (ok) {
        setPendingMemoryCandidateDrafts((prev) => prev.filter((d) => d.id !== draftId));
      } else {
        await reloadMemoryCandidateDrafts();
      }
    } catch (err) {
      setMemoryDraftError(err instanceof Error ? err.message : String(err));
    } finally {
      setMemoryDraftBusyId(null);
    }
  };

  /**
   * 单条 memory_fragment 记录「推到 pinned」：拿条目正文，GET 现有 pins，去重后 PUT 回去。
   * 不修改 memory_fragment.jsonl 本身——条目仍在私藏回忆列表里。pinned 是另一份独立存储,
   * 由 OpenHanako 内置 memory 维护；本动作让两者就这一条记录形成"也固化进 pinned"的并集。
   *
   * KNOWN（lost-update race）：GET → 本地拼 nextPins → PUT 之间没有 etag/lock。如果同一窗口
   * Settings panel / pin_memory 工具 / MemoryCandidatePanel 并发写一次，最后那一次 PUT 会覆盖
   * 本次添加。3 个 panel 都订阅 OPENHANAKO_AGENT_PINNED_MEMORY_CHANGED，状态最终一致——但
   * 用户加的这条可能无声丢失，需要重点。要彻底治需要 server 端加 etag 或 append-only 端点。
   */
  const handlePushRecordToPinned = async (record: SecretSpaceSampleRecord) => {
    if (!agent?.id) return;
    const bullet = normalizePinBulletForMatch(record.body);
    if (!bullet) {
      setPushPinnedFlash('内容为空，无法推到 pinned。');
      return;
    }
    setPushPinnedBusyKey(record.key);
    setPushPinnedFlash(null);
    try {
      const pins = await loadAgentPinnedMemory(agent.id, hanaFetch);
      const already = pins.some((p) => normalizePinBulletForMatch(p) === bullet);
      if (already) {
        setPushPinnedFlash('pinned 中已存在相同内容；无需重复写入。');
        await reloadMemoryFragmentRecords();
        return;
      }
      const nextPins = [...pins, record.body.trim()];
      const putRes = await hanaFetch(`/api/agents/${agent.id}/pinned`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pins: nextPins }),
      });
      const putJson: unknown = await putRes.json().catch(() => ({}));
      if (!putRes.ok) {
        const err =
          isRecord(putJson) && typeof putJson.error === 'string'
            ? putJson.error
            : `PUT pinned failed (${putRes.status})`;
        throw new Error(err);
      }
      if (isRecord(putJson) && putJson.error) {
        throw new Error(String(putJson.error));
      }
      emitAgentPinnedMemoryChanged({
        agentId: agent.id,
        source: 'xingye-secret-space',
        pinsCount: nextPins.length,
      });
      setPushPinnedFlash('已推到 pinned。');
      await reloadMemoryFragmentRecords();
    } catch (e) {
      setPushPinnedFlash(e instanceof Error ? e.message : String(e));
    } finally {
      setPushPinnedBusyKey(null);
    }
  };

  const handleAppendSecretSpaceRecord = async () => {
    if (!agent?.id || !activeCategory || !ADD_RECORD_CATEGORY_IDS.has(activeCategory)) return;
    const bodyText = addRecordBody.trim();
    if (!bodyText) {
      setAddRecordError('请填写正文。');
      return;
    }
    setAddRecordError(null);
    setAddRecordSaving(true);
    try {
      const titleText = addRecordTitle.trim();
      const title = titleText || bodyText.slice(0, 48);
      const summary = bodyText.length > 120 ? `${bodyText.slice(0, 120)}…` : bodyText;
      await appendSecretSpaceRecord(agent.id, activeCategory, {
        title,
        body: bodyText,
        summary,
      });
      const records = await listSecretSpaceRecords(agent.id, activeCategory);
      setRecordsByCategory((prev) => ({ ...prev, [activeCategory]: records }));
      setAddRecordTitle('');
      setAddRecordBody('');
    } catch (e) {
      setAddRecordError(e instanceof Error ? e.message : String(e));
    } finally {
      setAddRecordSaving(false);
    }
  };

  /**
   * memory_fragment 删除有两条路径：
   *  - 条目 source === MEMORY_FRAGMENT_PINNED_SOURCE：从 OpenHanako pinned.md 移除；
   *  - 其它（jsonl 私藏回忆）：从 secret-space/memory_fragment.jsonl 移除（不动 pinned）。
   * 推到 pinned 之后再删 jsonl 不会自动回收 pinned 那一份——两份独立维护。
   */
  const handleDeleteMemoryFragment = async (recordKey: string) => {
    if (!agent?.id) {
      setSecretSpaceDeleteError('删除失败：当前未绑定角色（缺少 agentId）。');
      return false;
    }
    const selected = recordsByCategory.memory_fragment.find((record) => record.key === recordKey);
    if (!selected) {
      setSecretSpaceDeleteError('删除失败：未找到这条回忆。');
      return false;
    }
    setSecretSpaceDeleteError(null);
    /** jsonl 来源：走标准 secret_space delete。 */
    if (selected.source !== MEMORY_FRAGMENT_PINNED_SOURCE) {
      try {
        const ok = await deleteSecretSpaceRecord(agent.id, 'memory_fragment', recordKey);
        if (!ok) {
          setSecretSpaceDeleteError('删除失败：存储中未找到该回忆（可能已被删除）。');
          await reloadMemoryFragmentRecords();
          return false;
        }
        await reloadMemoryFragmentRecords();
        return true;
      } catch (e) {
        setSecretSpaceDeleteError(e instanceof Error ? e.message : String(e));
        return false;
      }
    }
    /**
     * pinned 来源：从 pinned.md 移除（保持兼容旧行为）。
     *
     * KNOWN（lost-update race）：与 handlePushRecordToPinned 同款——GET→PUT 之间无 etag/lock,
     * 并发写有概率让本次删除"被重新写回"或让其它新加 pin 丢失。最终一致由
     * OPENHANAKO_AGENT_PINNED_MEMORY_CHANGED 兜底，但单次删除/新增意图可能无声丢失。
     */
    const target = normalizePinBulletForMatch(selected.body);
    if (!target) {
      setSecretSpaceDeleteError('删除失败：当前 pinned 回忆内容为空。');
      return false;
    }
    try {
      const pins = await loadAgentPinnedMemory(agent.id, hanaFetch);
      const removeIndex = pins.findIndex((pin) => normalizePinBulletForMatch(pin) === target);
      if (removeIndex < 0) {
        setSecretSpaceDeleteError('删除失败：当前 pinned 中未找到这条回忆（可能已经被删除）。');
        await reloadMemoryFragmentRecords();
        return false;
      }
      const nextPins = pins.filter((_, index) => index !== removeIndex);
      const putRes = await hanaFetch(`/api/agents/${agent.id}/pinned`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pins: nextPins }),
      });
      const putJson: unknown = await putRes.json().catch(() => ({}));
      if (!putRes.ok) {
        const err =
          isRecord(putJson) && typeof putJson.error === 'string'
            ? putJson.error
            : `PUT pinned failed (${putRes.status})`;
        throw new Error(err);
      }
      if (isRecord(putJson) && putJson.error) {
        throw new Error(String(putJson.error));
      }
      emitAgentPinnedMemoryChanged({
        agentId: agent.id,
        source: 'xingye-secret-space',
        pinsCount: nextPins.length,
      });
      await reloadMemoryFragmentRecords();
      return true;
    } catch (e) {
      setSecretSpaceDeleteError(e instanceof Error ? e.message : String(e));
      return false;
    }
  };

  const handleRequestDeleteSecretSpaceRecord = async (recordKey: string) => {
    if (!agent?.id) {
      setSecretSpaceDeleteError('删除失败：当前未绑定角色（缺少 agentId）。');
      return false;
    }
    if (!activeCategory) {
      setSecretSpaceDeleteError('删除失败：未选择分类（缺少 category）。');
      return false;
    }
    if (!recordKey.trim()) {
      setSecretSpaceDeleteError('删除失败：缺少 recordId。');
      return false;
    }
    setSecretSpaceDeleteError(null);
    try {
      const ok = await deleteSecretSpaceRecord(agent.id, activeCategory, recordKey);
      if (!ok) {
        setSecretSpaceDeleteError('删除失败：存储中未找到该 recordId（可能已被删除）。');
        return false;
      }
      const records = await listSecretSpaceRecords(agent.id, activeCategory);
      setRecordsByCategory((prev) => ({ ...prev, [activeCategory]: records }));
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('hanaFetch') && msg.includes('400')) {
        setSecretSpaceDeleteError(`存储接口返回 400（请检查 agentId / 路径）。${msg}`);
      } else {
        setSecretSpaceDeleteError(msg);
      }
      return false;
    }
  };

  const handleGenerateInterview = async () => {
    if (!agent?.id || activeCategory !== 'interview') return;
    setInterviewError(null);
    setInterviewLoading(true);
    try {
      const meta = await generateSecretInterviewWithAI({
        agent,
        ownerProfile: profile,
        userQuestion: interviewUserQuestion.trim() || undefined,
      });
      const content = flattenSecretInterviewToContent(meta);
      const summary = content.length > 120 ? `${content.slice(0, 120)}…` : content;
      await appendSecretSpaceRecord(agent.id, 'interview', {
        title: meta.title,
        body: content,
        summary,
        source: 'ai',
        metadata: meta as unknown as Record<string, unknown>,
      });
      const records = await listSecretSpaceRecords(agent.id, 'interview');
      setRecordsByCategory((prev) => ({ ...prev, interview: records }));
      setInterviewUserQuestion('');
    } catch (e) {
      setInterviewError(e instanceof Error ? e.message : String(e));
    } finally {
      setInterviewLoading(false);
    }
  };

  const handleAiGenerate = async () => {
    if (!agent?.id || !activeCategory || !isSecretSpaceAiGenerableCategory(activeCategory)) return;
    setAiError(null);
    setAiLoading(true);
    try {
      const { title, content, meta, tags } = await generateSecretSpaceRecordWithAI({
        agent,
        ownerProfile: profile,
        category: activeCategory,
        seedText: activeCategory === 'saved_item' ? savedItemSeed.trim() || undefined : undefined,
      });
      const summary = content.length > 120 ? `${content.slice(0, 120)}…` : content;
      await appendSecretSpaceRecord(agent.id, activeCategory, {
        title,
        body: content,
        summary,
        source: 'ai',
        ...(meta ? { meta } : {}),
        ...(tags && tags.length ? { tags } : {}),
      });
      const records = await listSecretSpaceRecords(agent.id, activeCategory);
      setRecordsByCategory((prev) => ({ ...prev, [activeCategory]: records }));
      if (activeCategory === 'saved_item') setSavedItemSeed('');
    } catch (e) {
      setAiError(e instanceof Error ? e.message : String(e));
    } finally {
      setAiLoading(false);
    }
  };

  const handleCreateManualCandidate = async () => {
    if (!agent?.id) return;
    setManualError(null);
    const content = manualContent.trim();
    if (!content) {
      setManualError('请填写回忆内容。');
      return;
    }
    try {
      const recordKey = `manual-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const reasonText = manualReason.trim() || XINGYE_SECRET_SPACE_MANUAL_CANDIDATE_REASON_DEFAULT;
      await appendSecretSpaceRecord(agent.id, 'memory_fragment', {
        key: recordKey,
        id: recordKey,
        recordId: recordKey,
        title: content.length > 48 ? `${content.slice(0, 48)}…` : content,
        body: content,
        summary: content.length > 120 ? `${content.slice(0, 120)}…` : content,
        source: 'manual-secret-space',
        importance: importanceNumberFromLevel(manualLevel),
        importanceLevel: manualLevel,
        reason: reasonText,
      });
      setManualContent('');
      setManualReason(XINGYE_SECRET_SPACE_MANUAL_CANDIDATE_REASON_DEFAULT);
      setManualLevel('medium');
      setMemoryCreateOpen(false);
      await reloadMemoryFragmentRecords();
    } catch (e) {
      setManualError(e instanceof Error ? e.message : String(e));
    }
  };

  const closeMemoryCreate = () => {
    setMemoryCreateOpen(false);
    setManualError(null);
    /**
     * 关闭模态时也清掉表单缓冲。否则下次打开还能看到上次的草稿——这是
     * UX bug，不是 feature（成功提交时已经清过，但取消/点 × 不会触发
     * handleCreateManualCandidate）。
     */
    setManualContent('');
    setManualReason(XINGYE_SECRET_SPACE_MANUAL_CANDIDATE_REASON_DEFAULT);
    setManualLevel('medium');
  };

  const displayProfile = agent ? getXingyeRoleProfileDisplay(agent, profile) : null;

  const memoryFragmentFooter =
    agent?.id ? (
      <div className={styles.secretSpaceMemoryFooter}>
        {pendingMemoryCandidateDrafts.length > 0 ? (
          <section
            className={styles.profileForm}
            style={{ borderLeft: '3px solid #ffb84a', paddingLeft: 12, marginBottom: 12 }}
            data-testid="memory-fragment-pending-drafts"
            aria-label="待确认草稿 · 来自心跳巡检"
          >
            <h4 className={styles.detailSectionTitle} style={{ marginTop: 0 }}>
              待确认草稿 · 来自心跳巡检
            </h4>
            <p className={styles.secretSpacePlaceholder} style={{ margin: 0 }}>
              这是 TA 在心跳巡检里主动提议的回忆。点「采纳为回忆」后写入私藏回忆列表，
              **不会**自动写到 OpenHanako pinned；之后你可以在每条回忆卡片上再单独决定要不要「推到 pinned」。
            </p>
            {memoryDraftError ? <p className={styles.saveStatus}>{memoryDraftError}</p> : null}
            {pendingMemoryCandidateDrafts.map((d) => (
              <div
                key={d.id}
                className={styles.profileForm}
                style={{ border: '1px dashed rgba(0,0,0,0.2)', padding: 10, marginBottom: 8 }}
                data-testid={`memory-fragment-pending-draft-${d.id}`}
              >
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'baseline' }}>
                  <strong>记忆候选草稿</strong>
                  <span className={styles.secretSpaceRecordMeta}>
                    重要度 {d.importanceLevel === 'low' ? '低' : d.importanceLevel === 'high' ? '高' : '中'}
                  </span>
                  <span className={styles.secretSpaceRecordMeta}>来源 {d.source}</span>
                </div>
                <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{d.content}</p>
                {d.reason ? (
                  <p className={styles.secretSpacePlaceholder} style={{ margin: 0 }}>
                    理由：{d.reason}
                  </p>
                ) : null}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    onClick={() => void handleConfirmMemoryCandidateDraft(d.id)}
                    disabled={memoryDraftBusyId === d.id}
                    data-testid={`memory-fragment-pending-draft-confirm-${d.id}`}
                  >
                    {memoryDraftBusyId === d.id ? '处理中…' : '采纳为回忆'}
                  </button>
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    onClick={() => void handleDiscardMemoryCandidateDraft(d.id)}
                    disabled={memoryDraftBusyId === d.id}
                    data-testid={`memory-fragment-pending-draft-discard-${d.id}`}
                  >
                    丢弃
                  </button>
                </div>
              </div>
            ))}
          </section>
        ) : null}
        {pushPinnedFlash ? (
          <p className={styles.saveStatus} role="status" data-testid="memory-fragment-push-pinned-flash">
            {pushPinnedFlash}
          </p>
        ) : null}
        <MemoryCandidatePanel agentId={agent.id} agentName={agent.name} />
      </div>
    ) : null;

  const memoryCreateModal =
    agent?.id && memoryCreateOpen ? (
      <div
        className={styles.secretSpaceMemoryCreateOverlay}
        role="presentation"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeMemoryCreate();
        }}
      >
        <div
          className={styles.secretSpaceMemoryCreateSheet}
          role="dialog"
          aria-modal="true"
          aria-labelledby="secret-space-memory-create-title"
          data-testid="secret-space-manual-candidate"
        >
          <div className={styles.secretSpaceMemoryCreateHeader}>
            <h3
              id="secret-space-memory-create-title"
              className={styles.secretSpaceMemoryCreateTitle}
            >
              新建私藏回忆
            </h3>
            <button
              type="button"
              className={styles.secretSpaceMemoryCreateClose}
              onClick={closeMemoryCreate}
              aria-label="关闭"
            >
              ×
            </button>
          </div>
          <p className={styles.secretSpaceMemoryCreateHint}>
            手动添加到 TA 的私藏回忆列表。**不会**自动写入 OpenHanako{' '}
            <code className={styles.inlineCode}>pinned.md</code>；之后可以在卡片上单独「推到 pinned」。
          </p>
          <label className={styles.profileField}>
            <span>回忆内容</span>
            <textarea
              value={manualContent}
              onChange={(e) => setManualContent(e.target.value)}
              rows={3}
              placeholder="输入一条你希望角色记住的回忆"
              aria-label="回忆内容"
              data-testid="secret-space-memory-candidate-content"
            />
          </label>
          <label className={styles.profileField}>
            <span>重要度</span>
            <select
              value={manualLevel}
              onChange={(e) => setManualLevel(e.target.value as 'low' | 'medium' | 'high')}
              aria-label="候选记忆重要度"
            >
              {XINGYE_MEMORY_CANDIDATE_IMPORTANCE_UI_OPTIONS.map((opt) => (
                <option key={opt.level} value={opt.level}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.profileField}>
            <span>理由</span>
            <textarea
              value={manualReason}
              onChange={(e) => setManualReason(e.target.value)}
              rows={2}
              aria-label="候选记忆理由"
            />
          </label>
          {manualError ? <p className={styles.saveStatus}>{manualError}</p> : null}
          <div className={styles.secretSpaceMemoryCreateActions}>
            <button
              type="button"
              className={styles.secretSpaceMemoryCreateGhost}
              onClick={closeMemoryCreate}
            >
              取消
            </button>
            <button
              type="button"
              className={styles.secretSpaceMemoryCreatePrimary}
              onClick={() => void handleCreateManualCandidate()}
              data-testid="secret-space-create-memory-candidate"
            >
              保存到私藏回忆
            </button>
          </div>
        </div>
      </div>
    ) : null;

  if (!agent) {
    return (
      <div className={styles.panelInner}>
        <h2 className={styles.panelTitle}>秘密空间</h2>
        <p className={styles.panelDescription}>
          请在「角色」页选择一个角色后，再查看 TA 的状态与秘密空间内容。
        </p>
      </div>
    );
  }

  const openCategory = (id: SecretSpaceCategoryId) => {
    setActiveCategory(id);
    setView('category');
  };

  const goHome = () => {
    setView('home');
    setActiveCategory(null);
    /**
     * activeCategory 变 null 后 reset useEffect 早返回（line 385 `if (!activeCategory)`）
     * 不会清这些 per-category 缓冲，导致下次开同一类目时残留陈旧文本/错误/flash。
     * 这里同步清。
     */
    setAddRecordTitle('');
    setAddRecordBody('');
    setAddRecordError(null);
    setSavedItemSeed('');
    setAiError(null);
    setPushPinnedFlash(null);
  };

  const activeMeta = activeCategory ? metaById(activeCategory) : null;
  const activeSamples = activeCategory ? recordsByCategory[activeCategory] : [];

  const stateSection =
    activeCategory === 'state' && displayProfile ? (
      <div data-testid="secret-space-relationship-panel">
        <RelationshipStatePanel agent={agent} profile={displayProfile} />
      </div>
    ) : null;

  const addRecordFooter =
    activeCategory && isSecretSpaceAiGenerableCategory(activeCategory) ? (
      <div className={styles.profileForm} data-testid="secret-space-category-record-actions">
        {ADD_RECORD_CATEGORY_IDS.has(activeCategory) && isSecretSpaceManualAppendDebugEnabled() ? (
          <div data-testid="secret-space-manual-add-record">
            <p className={styles.secretSpacePlaceholder} style={{ marginTop: 0 }}>
              [调试] 在本分类追加一条纯文本记录；保存后写入当前角色的秘密空间存储。
            </p>
            <label className={styles.profileField}>
              <span>标题（可选）</span>
              <input
                type="text"
                value={addRecordTitle}
                onChange={(e) => setAddRecordTitle(e.target.value)}
                placeholder="简短标题"
                aria-label="秘密空间记录标题"
                disabled={addRecordSaving}
                data-testid="secret-space-add-record-title"
              />
            </label>
            <label className={styles.profileField}>
              <span>正文</span>
              <textarea
                value={addRecordBody}
                onChange={(e) => setAddRecordBody(e.target.value)}
                rows={4}
                placeholder="输入记录正文"
                aria-label="秘密空间记录正文"
                disabled={addRecordSaving}
                data-testid="secret-space-add-record-body"
              />
            </label>
            {addRecordError ? <p className={styles.saveStatus}>{addRecordError}</p> : null}
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => void handleAppendSecretSpaceRecord()}
              disabled={addRecordSaving}
              data-testid="secret-space-add-record-submit"
            >
              {addRecordSaving ? '保存中…' : '保存记录'}
            </button>
          </div>
        ) : null}

        <p className={styles.secretSpacePlaceholder} style={{ marginTop: 0 }}>
          使用 AI 根据角色资料与设定参考生成一条记录（失败时不会写入）。
        </p>
        {activeCategory === 'saved_item' ? (
          <label className={styles.profileField}>
            <span>收藏线索（可选）</span>
            <textarea
              value={savedItemSeed}
              onChange={(e) => setSavedItemSeed(e.target.value)}
              rows={2}
              placeholder="想让收藏围绕的关键词或一句话"
              aria-label="收藏线索种子"
              disabled={aiLoading}
              data-testid="secret-space-ai-seed"
            />
          </label>
        ) : null}
        {aiError ? <p className={styles.saveStatus}>{aiError}</p> : null}
        <button
          type="button"
          className={styles.secondaryButton}
          onClick={() => void handleAiGenerate()}
          disabled={aiLoading || addRecordSaving}
          data-testid="secret-space-ai-generate"
        >
          {aiLoading ? 'AI 生成中…' : 'AI 生成'}
        </button>
      </div>
    ) : null;

  const interviewFooter =
    activeCategory === 'interview' && agent?.id ? (
      <div className={styles.profileForm} data-testid="secret-space-interview-footer">
        <p className={styles.secretSpacePlaceholder} style={{ marginTop: 0 }}>
          录一期专访：模型一次性生成 5 个 Q&A、每题 4-6 条弹幕、加一段「相机关了之后」的彩蛋。
          也可以给一题你想问的，让它落在第 3 或第 4 题位置；不出题模型自己决定 5 题。
        </p>
        <label className={styles.profileField}>
          <span>你想问 TA 的一题（可空）</span>
          <textarea
            value={interviewUserQuestion}
            onChange={(e) => setInterviewUserQuestion(e.target.value)}
            rows={2}
            placeholder="例：在你过去那么多年里，有没有过想放弃的时刻？"
            aria-label="独家专访用户出题"
            disabled={interviewLoading}
            data-testid="secret-space-interview-user-question"
          />
        </label>
        {interviewError ? <p className={styles.saveStatus}>{interviewError}</p> : null}
        <button
          type="button"
          className={styles.secondaryButton}
          onClick={() => void handleGenerateInterview()}
          disabled={interviewLoading}
          data-testid="secret-space-interview-generate"
        >
          {interviewLoading ? '正在录制本期…' : '录一期专访'}
        </button>
      </div>
    ) : null;

  const categoryFooter =
    activeCategory === 'memory_fragment'
      ? memoryFragmentFooter
      : activeCategory === 'interview'
      ? interviewFooter
      : addRecordFooter;

  /**
   * 分类内页的"列表渲染器"：每个分类用各自的标志性版式（便签 / 书签卡 / 朋友圈
   * timeline / 标本卡 / 墨晕梦记）。`state` 走 stateSection 单卡视图，没有列表。
   */
  const momentsDisplayName = displayProfile?.displayName || agent?.name || 'TA';
  const momentsAvatarChar = momentsDisplayName.slice(0, 1) || '星';
  const renderRecordListForCategory = activeCategory
    ? activeCategory === 'draft_reply'
      ? ({ records, onOpen }: { records: SecretSpaceSampleRecord[]; onOpen: (key: string) => void }) => (
          <SecretSpaceDraftGrid records={records} onOpen={onOpen} />
        )
      : activeCategory === 'saved_item'
      ? ({ records, onOpen }: { records: SecretSpaceSampleRecord[]; onOpen: (key: string) => void }) => (
          <SecretSpaceSavedList records={records} onOpen={onOpen} />
        )
      : activeCategory === 'unsent_moment'
      ? ({ records, onOpen }: { records: SecretSpaceSampleRecord[]; onOpen: (key: string) => void }) => (
          <SecretSpaceMomentsFeed
            records={records}
            onOpen={onOpen}
            displayName={momentsDisplayName}
            avatarChar={momentsAvatarChar}
            agent={agent}
            coverBackgroundUrl={displayProfile?.chatBackgroundDataUrl}
          />
        )
      : activeCategory === 'memory_fragment'
      ? ({ records, onOpen }: { records: SecretSpaceSampleRecord[]; onOpen: (key: string) => void }) => (
          <SecretSpaceMemoryGrid records={records} onOpen={onOpen} />
        )
      : activeCategory === 'dream'
      ? ({ records, onOpen }: { records: SecretSpaceSampleRecord[]; onOpen: (key: string) => void }) => (
          <SecretSpaceDreamFeed records={records} onOpen={onOpen} />
        )
      : undefined
    : undefined;

  /**
   * interview 详情走专属的翻页阅读器（含弹幕 / 幕后彩蛋），不走默认 SecretSpaceRecordCard。
   * record.metadata 来自 store 透传的结构化数据；缺失或解析失败时给一个降级提示，
   * 让用户至少能看到 record.body（flatten 后的纯文本备份），方便排错。
   */
  const renderInterviewDetail = (record: SecretSpaceSampleRecord) => {
    const meta = normalizeSecretInterviewMetadata(record.metadata) as SecretInterviewMetadata | null;
    if (meta) {
      return <SecretInterviewReader meta={meta} />;
    }
    return (
      <div
        className={styles.profileForm}
        data-testid="secret-interview-fallback"
        style={{ padding: 16, whiteSpace: 'pre-wrap' }}
      >
        <p className={styles.secretSpacePlaceholder} style={{ marginTop: 0 }}>
          这期专访的结构化数据缺失或损坏；以下是纯文本备份：
        </p>
        <p>{record.body}</p>
      </div>
    );
  };

  return (
    <div className={styles.panelInner}>
      {view !== 'home' ? (
        <>
          <h2 className={styles.panelTitle}>秘密空间</h2>
          <p className={styles.panelDescription}>
            角色侧隐藏内容的分类入口；记录从当前 agent 的 Xingye storage 读取。
          </p>
        </>
      ) : null}

      {view === 'home' && pendingDrafts.length > 0 ? (
        <section
          className={styles.profileForm}
          aria-label="待确认秘密空间草稿"
          data-testid="secret-space-pending-drafts"
        >
          <h3 className={styles.panelTitle}>待确认草稿 · 来自心跳巡检</h3>
          <p className={styles.panelDescription}>
            这些草稿由角色在巡检里提议，**还没**写进任何分类的「已生成」列表里；可改 category / 标题 / 正文后点「确认生成」，丢弃不留痕。
            支持的分类：state / dream / saved_item（其它分类走单独流程，不在此提议范围）。
          </p>
          {pendingDraftError ? <p className={styles.saveStatus}>{pendingDraftError}</p> : null}
          {pendingDrafts.map((d) => {
            const working = pendingDraftWorkingValue(d);
            const busy = pendingDraftBusyId === d.id;
            return (
              <div
                key={d.id}
                className={styles.profileForm}
                style={{ border: '1px dashed rgba(0,0,0,0.2)', padding: 10, marginBottom: 8 }}
                data-testid={`secret-space-pending-draft-${d.id}`}
              >
                <label className={styles.profileField}>
                  <span>分类</span>
                  <select
                    value={working.category}
                    onChange={(e) =>
                      handlePendingDraftFieldChange(d.id, {
                        category: e.target.value as SecretSpaceDraftCategory,
                      })
                    }
                    disabled={busy}
                    aria-label="待确认秘密空间草稿分类"
                    data-testid={`secret-space-pending-draft-category-${d.id}`}
                  >
                    {SECRET_SPACE_DRAFT_ALLOWED_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {CATEGORY_DRAFT_LABEL[c]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={styles.profileField}>
                  <span>标题（可选）</span>
                  <input
                    type="text"
                    value={working.title}
                    onChange={(e) =>
                      handlePendingDraftFieldChange(d.id, { title: e.target.value })
                    }
                    placeholder="为空时会用正文前几字"
                    aria-label="待确认秘密空间草稿标题"
                    data-testid={`secret-space-pending-draft-title-${d.id}`}
                    disabled={busy}
                  />
                </label>
                <label className={styles.profileField}>
                  <span>正文</span>
                  <textarea
                    value={working.body}
                    onChange={(e) =>
                      handlePendingDraftFieldChange(d.id, { body: e.target.value })
                    }
                    rows={4}
                    aria-label="待确认秘密空间草稿正文"
                    data-testid={`secret-space-pending-draft-body-${d.id}`}
                    disabled={busy}
                  />
                </label>
                {d.reason ? (
                  <p className={styles.panelDescription} style={{ margin: 0 }}>
                    理由：{d.reason}
                  </p>
                ) : null}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    onClick={() => void handleConfirmPendingDraft(d)}
                    disabled={busy}
                    data-testid={`secret-space-pending-draft-confirm-${d.id}`}
                  >
                    {busy ? '处理中…' : '确认生成'}
                  </button>
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    onClick={() => void handleDiscardPendingDraft(d)}
                    disabled={busy}
                    data-testid={`secret-space-pending-draft-discard-${d.id}`}
                  >
                    丢弃
                  </button>
                </div>
              </div>
            );
          })}
        </section>
      ) : null}

      {view === 'home' ? (
        <SecretSpaceHome onSelectCategory={openCategory} />
      ) : activeMeta ? (
        activeCategory === 'memory_fragment' ? (
          <div className={styles.secretSpaceMemoryWrapper}>
            <SecretSpaceCategoryView
              meta={activeMeta}
              onBack={goHome}
              stateSection={stateSection}
              records={activeSamples}
              footer={categoryFooter}
              renderRecordList={renderRecordListForCategory}
              onRequestDeleteRecord={
                agent?.id ? (key) => handleDeleteMemoryFragment(key) : undefined
              }
              renderRecordDetailExtraActions={(record) =>
                record.source !== MEMORY_FRAGMENT_PINNED_SOURCE ? (
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    onClick={() => void handlePushRecordToPinned(record)}
                    disabled={pushPinnedBusyKey === record.key}
                    data-testid={`memory-fragment-push-pinned-${record.key}`}
                  >
                    {pushPinnedBusyKey === record.key ? '推送中…' : '推到 OpenHanako pinned'}
                  </button>
                ) : null
              }
              deleteError={secretSpaceDeleteError}
            />
            {agent?.id ? (
              <button
                type="button"
                className={styles.secretSpaceMemoryCreateFab}
                onClick={() => setMemoryCreateOpen(true)}
                aria-label="新建回忆"
                data-testid="secret-space-open-memory-create"
              >
                +
              </button>
            ) : null}
            {memoryCreateModal}
          </div>
        ) : (
          <SecretSpaceCategoryView
            meta={activeMeta}
            onBack={goHome}
            stateSection={stateSection}
            records={activeSamples}
            footer={categoryFooter}
            renderRecordList={renderRecordListForCategory}
            renderRecordDetail={activeCategory === 'interview' ? renderInterviewDetail : undefined}
            onRequestDeleteRecord={
              agent?.id ? (key) => handleRequestDeleteSecretSpaceRecord(key) : undefined
            }
            deleteError={secretSpaceDeleteError}
          />
        )
      ) : null}
    </div>
  );
}
