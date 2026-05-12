import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createLoreEntry,
  deleteLoreEntry,
  toggleLoreEntry,
  updateLoreEntry,
  useXingyeLoreEntries,
  XINGYE_LORE_CATEGORIES,
  XINGYE_LORE_CATEGORY_LABELS,
  type XingyeLoreCategory,
  type XingyeLoreEntry,
  type XingyeLoreInsertionMode,
  type XingyeLoreVisibility,
} from './xingye-lore-store';
import {
  createXingyeMemoryCandidate,
  importanceNumberFromLevel,
} from './xingye-memory-candidate-store';
import { LoreEntryCard } from './LoreEntryCard';
import styles from './XingyeShell.module.css';

const LORE_CANDIDATE_REASON = '用户从设定库保存为候选重要记忆';
const LORE_CANDIDATE_FLASH_OK = '已加入候选重要记忆，请到记忆候选中确认写入';

function buildLoreCandidateContent(entry: XingyeLoreEntry): string {
  return `【设定】${entry.title}\n${entry.content}`;
}

interface LoreEditorProps {
  agentId: string;
}

const CATEGORY_OPTIONS: Array<{ value: XingyeLoreCategory; label: string }> = XINGYE_LORE_CATEGORIES.map(
  (value) => ({ value, label: XINGYE_LORE_CATEGORY_LABELS[value] }),
);

const INSERTION_OPTIONS: Array<{ value: XingyeLoreInsertionMode; label: string }> = [
  { value: 'manual', label: '手动' },
  { value: 'keyword', label: '关键词' },
  { value: 'always', label: '始终' },
];

const VISIBILITY_OPTIONS: Array<{ value: XingyeLoreVisibility; label: string }> = [
  { value: 'canonical', label: '正式设定' },
  { value: 'private', label: '私有备注' },
  { value: 'draft', label: '草稿' },
];

const emptyDraft = {
  title: '',
  content: '',
  category: 'background' as XingyeLoreCategory,
  keywords: '',
  priority: 50,
  insertionMode: 'manual' as XingyeLoreInsertionMode,
  visibility: 'canonical' as XingyeLoreVisibility,
};

export function LoreEditor({ agentId }: LoreEditorProps) {
  const entries = useXingyeLoreEntries(agentId);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState(emptyDraft);
  const [flash, setFlash] = useState<string | null>(null);
  const [savingCandidateId, setSavingCandidateId] = useState<string | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setEditingId(null);
    setDraft(emptyDraft);
    setFlash(null);
  }, [agentId]);

  useEffect(() => {
    return () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    };
  }, []);

  const showFlash = useCallback((msg: string) => {
    setFlash(msg);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    if (typeof window === 'undefined') return;
    flashTimerRef.current = setTimeout(() => setFlash(null), 5000);
  }, []);

  const handleSaveAsCandidate = useCallback(
    (entry: XingyeLoreEntry) => {
      if (!agentId) return;
      setSavingCandidateId(entry.id);
      try {
        createXingyeMemoryCandidate(agentId, {
          content: buildLoreCandidateContent(entry),
          sourceDomain: 'lore',
          sourceId: entry.id,
          reason: LORE_CANDIDATE_REASON,
          importance: importanceNumberFromLevel('medium'),
          target: 'pinned',
        });
        showFlash(LORE_CANDIDATE_FLASH_OK);
      } catch (error) {
        showFlash(error instanceof Error ? error.message : String(error));
      } finally {
        setSavingCandidateId(null);
      }
    },
    [agentId, showFlash],
  );

  const editingEntry = useMemo(
    () => entries.find((entry) => entry.id === editingId) ?? null,
    [editingId, entries],
  );

  const resetDraft = () => {
    setEditingId(null);
    setDraft(emptyDraft);
  };

  const startEdit = (entry: XingyeLoreEntry) => {
    setEditingId(entry.id);
    setDraft({
      title: entry.title,
      content: entry.content,
      category: entry.category,
      keywords: entry.keywords.join(', '),
      priority: entry.priority,
      insertionMode: entry.insertionMode,
      visibility: entry.visibility,
    });
  };

  const saveDraft = () => {
    const keywords = Array.from(
      new Set(draft.keywords.split(/[,\n，、]/).map((s) => s.trim()).filter(Boolean)),
    );
    const input = {
      title: draft.title,
      content: draft.content,
      category: draft.category,
      keywords,
      priority: draft.priority,
      insertionMode: draft.insertionMode,
      visibility: draft.visibility,
    };
    if (editingEntry) {
      updateLoreEntry(editingEntry.id, input);
    } else {
      createLoreEntry(agentId, input);
    }
    resetDraft();
  };

  return (
    <div className={styles.loreEditor}>
      <div className={styles.loreEditorHeader}>
        <div>
          <h3 className={styles.detailSectionTitle}>背景故事 / 设定库</h3>
          <p className={styles.loreHint}>
            完整背景、世界观、事件、地点和组织保存在星野设定库。设定库条目仅保存在 workspace，不会自动写入 OpenHanako identity / ishiki。
          </p>
        </div>
        {editingEntry && <button type="button" onClick={resetDraft}>取消编辑</button>}
      </div>

      <div className={styles.loreForm}>
        <label className={styles.profileField}>
          <span>标题</span>
          <input
            type="text"
            value={draft.title}
            placeholder="例如：旧王国崩塌"
            onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
          />
        </label>
        <label className={styles.profileField}>
          <span>完整设定内容</span>
          <textarea
            value={draft.content}
            placeholder="完整背景故事、世界观规则、重要事件等写在这里。"
            rows={5}
            onChange={(event) => setDraft((current) => ({ ...current, content: event.target.value }))}
          />
        </label>
        <div className={styles.loreMetaGrid}>
          <label className={styles.profileField}>
            <span>分类</span>
            <select
              value={draft.category}
              onChange={(event) => setDraft((current) => ({ ...current, category: event.target.value as XingyeLoreCategory }))}
            >
              {CATEGORY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label className={styles.profileField}>
            <span>插入模式</span>
            <select
              value={draft.insertionMode}
              onChange={(event) => setDraft((current) => ({ ...current, insertionMode: event.target.value as XingyeLoreInsertionMode }))}
            >
              {INSERTION_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label className={styles.profileField}>
            <span>可见性</span>
            <select
              value={draft.visibility}
              onChange={(event) => setDraft((current) => ({ ...current, visibility: event.target.value as XingyeLoreVisibility }))}
            >
              {VISIBILITY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label className={styles.profileField}>
            <span>优先级</span>
            <input
              type="number"
              min={0}
              max={100}
              value={draft.priority}
              onChange={(event) => setDraft((current) => ({ ...current, priority: Number(event.target.value) }))}
            />
          </label>
        </div>
        <label className={styles.profileField}>
          <span>关键词</span>
          <input
            type="text"
            value={draft.keywords}
            placeholder="用逗号分隔，例如：王国, 灯塔, 誓约"
            onChange={(event) => setDraft((current) => ({ ...current, keywords: event.target.value }))}
          />
        </label>
        <button type="button" className={styles.primaryAction} onClick={saveDraft}>
          {editingEntry ? '保存设定条目' : '新增设定条目'}
        </button>
      </div>

      {flash ? (
        <p className={styles.saveStatus} role="status" data-testid="lore-editor-flash">
          {flash}
        </p>
      ) : null}

      <div className={styles.loreList}>
        {entries.length === 0 ? (
          <p className={styles.loreEmpty}>还没有设定条目。</p>
        ) : (
          entries.map((entry) => (
            <LoreEntryCard
              key={entry.id}
              entry={entry}
              onEdit={startEdit}
              onToggle={(id) => toggleLoreEntry(id)}
              onDelete={(id) => deleteLoreEntry(id)}
              onSaveAsCandidate={handleSaveAsCandidate}
              saveAsCandidateDisabled={savingCandidateId === entry.id}
            />
          ))
        )}
      </div>
    </div>
  );
}
