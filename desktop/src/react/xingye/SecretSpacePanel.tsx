import { useEffect, useState } from 'react';
import type { Agent } from '../types';
import { getXingyeRoleProfileDisplay, useXingyeRoleProfile } from './xingye-profile-store';
import { MemoryCandidatePanel } from './MemoryCandidatePanel';
import { RelationshipStatePanel } from './RelationshipStatePanel';
import {
  SecretSpaceCategoryView,
  type SecretSpaceCategoryMeta,
  type SecretSpaceSampleRecord,
} from './SecretSpaceCategoryView';
import { SecretSpaceHome, type SecretSpaceCategoryId } from './SecretSpaceHome';
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

const CATEGORY_META: SecretSpaceCategoryMeta[] = [
  {
    id: 'state',
    title: 'TA 的状态',
    description: '与情绪、关系快照相关的视图；在「角色」页编辑资料与关系标签。',
  },
  {
    id: 'draft_reply',
    title: 'TA 的草稿箱',
    description: 'draft_reply 类占位视图（后续接入工作区记录）。',
  },
  {
    id: 'dream',
    title: 'TA 的梦境',
    description: '象征化梦境碎片等占位视图。',
  },
  {
    id: 'saved_item',
    title: 'TA 收藏的东西',
    description: '收藏类占位视图。',
  },
  {
    id: 'unsent_moment',
    title: 'TA 未发送的朋友圈',
    description: '未发送动态草稿占位视图。',
  },
  {
    id: 'memory_fragment',
    title: '私藏回忆',
    description: '回忆碎片类占位视图。',
  },
];

function metaById(id: SecretSpaceCategoryId): SecretSpaceCategoryMeta {
  const found = CATEGORY_META.find((m) => m.id === id);
  if (!found) {
    throw new Error(`Unknown secret space category: ${id}`);
  }
  return found;
}

function emptySamples(): Record<SecretSpaceCategoryId, SecretSpaceSampleRecord[]> {
  return {
    state: [],
    draft_reply: [],
    dream: [],
    saved_item: [],
    unsent_moment: [],
    memory_fragment: [],
  };
}

export function SecretSpacePanel({ agent }: SecretSpacePanelProps) {
  const profile = useXingyeRoleProfile(agent?.id);
  const [view, setView] = useState<'home' | 'category'>('home');
  const [activeCategory, setActiveCategory] = useState<SecretSpaceCategoryId | null>(null);
  const [samplesByCategory] = useState<Record<SecretSpaceCategoryId, SecretSpaceSampleRecord[]>>(
    emptySamples,
  );

  const [manualContent, setManualContent] = useState('');
  const [manualReason, setManualReason] = useState(XINGYE_SECRET_SPACE_MANUAL_CANDIDATE_REASON_DEFAULT);
  const [manualLevel, setManualLevel] = useState<'low' | 'medium' | 'high'>('medium');
  const [manualError, setManualError] = useState<string | null>(null);

  useEffect(() => {
    if (!agent?.id) {
      setManualContent('');
      setManualReason(XINGYE_SECRET_SPACE_MANUAL_CANDIDATE_REASON_DEFAULT);
      setManualLevel('medium');
      setManualError(null);
      setView('home');
      setActiveCategory(null);
    }
  }, [agent?.id]);

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
          手动保存为「重要记忆候选」（仅工作区与列表；确认后写入 OpenHanako <code className={styles.inlineCode}>pinned.md</code>）。
        </p>
        <label className={styles.profileField}>
          <span>候选记忆内容</span>
          <textarea
            value={manualContent}
            onChange={(e) => setManualContent(e.target.value)}
            rows={3}
            placeholder="输入一条你希望记住的要点…"
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
        <MemoryCandidatePanel agentId={agent.id} />
      </div>
    ) : null;

  if (!agent) {
    return (
      <div className={styles.panelInner}>
        <h2 className={styles.panelTitle}>秘密空间</h2>
        <p className={styles.panelDescription}>
          请在「角色」页选择一个角色后，再查看 TA 的状态与秘密空间占位内容。
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
  const activeSamples = activeCategory ? samplesByCategory[activeCategory] : [];

  const stateSection =
    activeCategory === 'state' && displayProfile ? (
      <div data-testid="secret-space-relationship-panel">
        <RelationshipStatePanel agent={agent} profile={displayProfile} />
      </div>
    ) : null;

  const categoryFooter =
    activeCategory === 'memory_fragment' ? memoryFragmentFooter : null;

  return (
    <div className={styles.panelInner}>
      <h2 className={styles.panelTitle}>秘密空间</h2>
      <p className={styles.panelDescription}>
        角色侧隐藏内容的导航骨架：按分类进入占位视图（本轮不接工作区列表、不经 OpenHanako 聊天管线）。
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
