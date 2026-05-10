import { useEffect, useMemo, useState } from 'react';
import {
  createLoreEntry,
  deleteLoreEntry,
  toggleLoreEntry,
  updateLoreEntry,
  useXingyeLoreEntries,
  type XingyeLoreCategory,
  type XingyeLoreEntry,
  type XingyeLoreInsertionMode,
  type XingyeLoreVisibility,
} from './xingye-lore-store';
import { LoreEntryCard } from './LoreEntryCard';
import styles from './XingyeShell.module.css';

interface LoreEditorProps {
  agentId: string;
}

const CATEGORY_OPTIONS: Array<{ value: XingyeLoreCategory; label: string }> = [
  { value: 'background', label: '背景' },
  { value: 'worldview', label: '世界观' },
  { value: 'relationship', label: '关系' },
  { value: 'event', label: '事件' },
  { value: 'location', label: '地点' },
  { value: 'organization', label: '组织' },
  { value: 'character', label: '人物' },
  { value: 'rule', label: '规则' },
];

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

  useEffect(() => {
    setEditingId(null);
    setDraft(emptyDraft);
  }, [agentId]);

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
    const input = {
      title: draft.title,
      content: draft.content,
      category: draft.category,
      keywords: draft.keywords,
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
            完整背景、世界观、事件、地点和组织保存在星野设定库。MVP 只保存和展示，不写入 OpenHanako memory，也不参与 prompt 注入。
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
            />
          ))
        )}
      </div>
    </div>
  );
}
