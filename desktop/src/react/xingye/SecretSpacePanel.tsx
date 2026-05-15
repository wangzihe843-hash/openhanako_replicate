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
import {
  appendSecretSpaceRecord,
  deleteSecretSpaceRecord,
  listSecretSpaceRecords,
} from './xingye-secret-space-store';
import {
  createXingyeMemoryCandidate,
  importanceNumberFromLevel,
  XINGYE_MEMORY_CANDIDATE_IMPORTANCE_UI_OPTIONS,
  XINGYE_SECRET_SPACE_MANUAL_CANDIDATE_REASON_DEFAULT,
} from './xingye-memory-candidate-store';
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
];

function emptyRecords(): Record<SecretSpaceCategoryId, SecretSpaceSampleRecord[]> {
  return {
    state: [],
    draft_reply: [],
    dream: [],
    saved_item: [],
    unsent_moment: [],
    memory_fragment: [],
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
    source: 'OpenHanako pinned',
  };
}

function pinnedMemoryRecordsFromPins(pins: string[]): SecretSpaceSampleRecord[] {
  return pins.map(pinnedMemoryToRecord);
}

/**
 * 允许在本面板追加纯文本 JSONL 的分类。
 * `state` 使用上方 RelationshipStatePanel，不进此列表；`memory_fragment` 用手动记忆候选表单。
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

  const [addRecordTitle, setAddRecordTitle] = useState('');
  const [addRecordBody, setAddRecordBody] = useState('');
  const [addRecordError, setAddRecordError] = useState<string | null>(null);
  const [addRecordSaving, setAddRecordSaving] = useState(false);

  const [savedItemSeed, setSavedItemSeed] = useState('');
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [secretSpaceDeleteError, setSecretSpaceDeleteError] = useState<string | null>(null);

  useEffect(() => {
    if (!agent?.id) {
      setManualContent('');
      setManualReason(XINGYE_SECRET_SPACE_MANUAL_CANDIDATE_REASON_DEFAULT);
      setManualLevel('medium');
      setManualError(null);
      setAddRecordTitle('');
      setAddRecordBody('');
      setAddRecordError(null);
      setAddRecordSaving(false);
      setSavedItemSeed('');
      setAiError(null);
      setAiLoading(false);
      setSecretSpaceDeleteError(null);
      setView('home');
      setActiveCategory(null);
      setRecordsByCategory(emptyRecords());
    }
  }, [agent?.id]);

  useEffect(() => {
    setSecretSpaceDeleteError(null);
  }, [agent?.id, activeCategory]);

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

  const reloadPinnedMemoryFragmentRecords = useCallback(async () => {
    if (!agent?.id) return;
    const pins = await loadAgentPinnedMemory(agent.id, hanaFetch);
    setRecordsByCategory((prev) => ({
      ...prev,
      memory_fragment: pinnedMemoryRecordsFromPins(pins),
    }));
  }, [agent?.id]);

  useEffect(() => {
    if (!agent?.id || !activeCategory) return undefined;
    let cancelled = false;
    const load = async () => {
      const records =
        activeCategory === 'memory_fragment'
          ? pinnedMemoryRecordsFromPins(await loadAgentPinnedMemory(agent.id, hanaFetch).catch(() => []))
          : await listSecretSpaceRecords(agent.id, activeCategory).catch(() => []);
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
      void reloadPinnedMemoryFragmentRecords();
    });
  }, [agent?.id, activeCategory, reloadPinnedMemoryFragmentRecords]);

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

  const handleDeletePinnedMemoryFragment = async (recordKey: string) => {
    if (!agent?.id) {
      setSecretSpaceDeleteError('删除失败：当前未绑定角色（缺少 agentId）。');
      return false;
    }
    const selected = recordsByCategory.memory_fragment.find((record) => record.key === recordKey);
    if (!selected) {
      setSecretSpaceDeleteError('删除失败：未找到当前 pinned 回忆。');
      return false;
    }
    const target = normalizePinBulletForMatch(selected.body);
    if (!target) {
      setSecretSpaceDeleteError('删除失败：当前 pinned 回忆内容为空。');
      return false;
    }
    setSecretSpaceDeleteError(null);
    try {
      const pins = await loadAgentPinnedMemory(agent.id, hanaFetch);
      const removeIndex = pins.findIndex((pin) => normalizePinBulletForMatch(pin) === target);
      if (removeIndex < 0) {
        setSecretSpaceDeleteError('删除失败：当前 pinned 中未找到这条回忆（可能已经被删除）。');
        await reloadPinnedMemoryFragmentRecords();
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
      setRecordsByCategory((prev) => ({
        ...prev,
        memory_fragment: pinnedMemoryRecordsFromPins(nextPins),
      }));
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

  const handleCreateManualCandidate = () => {
    if (!agent?.id) return;
    setManualError(null);
    const content = manualContent.trim();
    if (!content) {
      setManualError('请填写候选记忆内容。');
      return;
    }
    try {
      createXingyeMemoryCandidate(agent.id, {
        content,
        reason: manualReason.trim() || XINGYE_SECRET_SPACE_MANUAL_CANDIDATE_REASON_DEFAULT,
        importance: importanceNumberFromLevel(manualLevel),
        sourceDomain: 'secret_space',
        sourceId: 'manual-secret-space',
        target: 'pinned',
      });
      setManualContent('');
      setManualReason(XINGYE_SECRET_SPACE_MANUAL_CANDIDATE_REASON_DEFAULT);
      setManualLevel('medium');
    } catch (e) {
      setManualError(e instanceof Error ? e.message : String(e));
    }
  };

  const displayProfile = agent ? getXingyeRoleProfileDisplay(agent, profile) : null;

  const memoryFragmentFooter =
    agent?.id ? (
      <div className={styles.profileForm} data-testid="secret-space-manual-candidate">
        <p className={styles.secretSpacePlaceholder} style={{ marginTop: 0 }}>
          手动保存为「重要记忆候选」；确认后写入 OpenHanako <code className={styles.inlineCode}>pinned.md</code>。
        </p>
        <label className={styles.profileField}>
          <span>候选记忆内容</span>
          <textarea
            value={manualContent}
            onChange={(e) => setManualContent(e.target.value)}
            rows={3}
            placeholder="输入一条你希望记住的要点"
            aria-label="候选记忆内容"
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
        <button
          type="button"
          className={styles.secondaryButton}
          onClick={handleCreateManualCandidate}
          data-testid="secret-space-create-memory-candidate"
        >
          创建候选记忆
        </button>
        <MemoryCandidatePanel agentId={agent.id} agentName={agent.name} />
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

  const categoryFooter =
    activeCategory === 'memory_fragment'
      ? memoryFragmentFooter
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

      {view === 'home' ? (
        <SecretSpaceHome onSelectCategory={openCategory} />
      ) : activeMeta ? (
        <SecretSpaceCategoryView
          meta={activeMeta}
          onBack={goHome}
          stateSection={stateSection}
          records={activeSamples}
          footer={categoryFooter}
          renderRecordList={renderRecordListForCategory}
          onRequestDeleteRecord={
            agent?.id
              ? (key) =>
                  activeCategory === 'memory_fragment'
                    ? handleDeletePinnedMemoryFragment(key)
                    : handleRequestDeleteSecretSpaceRecord(key)
              : undefined
          }
          deleteError={secretSpaceDeleteError}
        />
      ) : null}
    </div>
  );
}
