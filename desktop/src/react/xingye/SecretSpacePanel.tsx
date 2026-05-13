import { useEffect, useState } from 'react';
import type { Agent } from '../types';
import { getXingyeRoleProfileDisplay, useXingyeRoleProfile } from './xingye-profile-store';
import { MemoryCandidatePanel } from './MemoryCandidatePanel';
import { RelationshipStatePanel } from './RelationshipStatePanel';
import {
  SecretSpaceCategoryView,
  type SecretSpaceCategoryMeta,
} from './SecretSpaceCategoryView';
import { SecretSpaceHome, type SecretSpaceCategoryId } from './SecretSpaceHome';
import type { SecretSpaceSampleRecord } from './secret-space-record-types';
import { appendSecretSpaceRecord, listSecretSpaceRecords } from './xingye-secret-space-store';
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
    title: 'TA 的状态',
    description: '与情绪、关系快照相关的视图；在「角色」页编辑资料与关系标签。',
    recordsEmptyTitle: '尚无额外的文字记录',
    recordsEmptyBody: '这里预留展示与「状态」相关的短笔记。当前上方为关系与标签面板。',
  },
  {
    id: 'draft_reply',
    title: 'TA 的草稿箱',
    description: '尚未发送的回复草稿，仅保存纯文本。',
    recordsEmptyTitle: '草稿箱是空的',
    recordsEmptyBody: '还没有未发出的回复草稿。',
  },
  {
    id: 'dream',
    title: 'TA 的梦境',
    description: '象征化、片段化的梦记，仅保存纯文本。',
    recordsEmptyTitle: '还没有梦境记录',
    recordsEmptyBody: '梦记只以文字呈现，不接图片或语音解梦。',
  },
  {
    id: 'saved_item',
    title: 'TA 收藏的东西',
    description: '仅展示收藏的文字摘录、事件摘要与对话片段。',
    recordsEmptyTitle: '收藏夹是空的',
    recordsEmptyBody: '此分类只表现纯文本收藏，不做相册式或附件式收藏 UI。',
  },
  {
    id: 'unsent_moment',
    title: 'TA 未发送的朋友圈',
    description: '未发送的朋友圈动态草稿，仅纯文字。',
    recordsEmptyTitle: '没有未发送草稿',
    recordsEmptyBody: '朋友圈草稿在此仅以文字呈现。',
  },
  {
    id: 'memory_fragment',
    title: '私藏回忆',
    description: '短回忆与碎片入口；底部可手动写入「重要记忆候选」。',
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

/** Categories that allow appending a plain-text record via storage (not state / memory_fragment). */
const ADD_RECORD_CATEGORY_IDS = new Set<SecretSpaceCategoryId>([
  'draft_reply',
  'dream',
  'saved_item',
  'unsent_moment',
]);

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
      setView('home');
      setActiveCategory(null);
      setRecordsByCategory(emptyRecords());
    }
  }, [agent?.id]);

  useEffect(() => {
    if (!activeCategory || !ADD_RECORD_CATEGORY_IDS.has(activeCategory)) return;
    setAddRecordTitle('');
    setAddRecordBody('');
    setAddRecordError(null);
    setAddRecordSaving(false);
  }, [activeCategory, agent?.id]);

  useEffect(() => {
    if (!agent?.id || !activeCategory) return undefined;
    let cancelled = false;
    const load = async () => {
      const records = await listSecretSpaceRecords(agent.id, activeCategory).catch(() => []);
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
        <button type="button" className={styles.secondaryButton} onClick={handleCreateManualCandidate}>
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
    activeCategory && ADD_RECORD_CATEGORY_IDS.has(activeCategory) ? (
      <div className={styles.profileForm} data-testid="secret-space-add-record">
        <p className={styles.secretSpacePlaceholder} style={{ marginTop: 0 }}>
          在本分类追加一条纯文本记录；保存后写入当前角色的秘密空间存储。
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
    ) : null;

  const categoryFooter =
    activeCategory === 'memory_fragment'
      ? memoryFragmentFooter
      : addRecordFooter;

  return (
    <div className={styles.panelInner}>
      <h2 className={styles.panelTitle}>秘密空间</h2>
      <p className={styles.panelDescription}>
        角色侧隐藏内容的分类入口；记录从当前 agent 的 Xingye storage 读取。
      </p>

      {view === 'home' ? (
        <SecretSpaceHome onSelectCategory={openCategory} />
      ) : activeMeta ? (
        <SecretSpaceCategoryView
          meta={activeMeta}
          onBack={goHome}
          stateSection={stateSection}
          records={activeSamples}
          footer={categoryFooter}
        />
      ) : null}
    </div>
  );
}
