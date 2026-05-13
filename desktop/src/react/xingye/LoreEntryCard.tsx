import type { XingyeLoreEntry, XingyeLoreInsertionMode, XingyeLoreVisibility } from './xingye-lore-store';
import { XINGYE_LORE_CATEGORY_LABELS } from './xingye-lore-store';
import styles from './XingyeShell.module.css';

const LORE_INSERTION_LABEL: Record<XingyeLoreInsertionMode, string> = {
  manual: '手动',
  keyword: '关键词',
  always: '始终',
};

const LORE_VISIBILITY_LABEL: Record<XingyeLoreVisibility, string> = {
  canonical: '正式设定',
  private: '私有备注',
  draft: '草稿',
};

interface LoreEntryCardProps {
  entry: XingyeLoreEntry;
  onEdit: (entry: XingyeLoreEntry) => void;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
  onSaveAsCandidate?: (entry: XingyeLoreEntry) => void;
  saveAsCandidateDisabled?: boolean;
}

export function LoreEntryCard({
  entry,
  onEdit,
  onToggle,
  onDelete,
  onSaveAsCandidate,
  saveAsCandidateDisabled,
}: LoreEntryCardProps) {
  return (
    <article
      className={styles.loreCard}
      data-testid={`lore-entry-card-${entry.id}`}
      title="点击卡片载入上方编辑区"
      onClick={() => onEdit(entry)}
    >
      <div className={styles.loreCardHeader}>
        <div className={styles.loreTitleBlock}>
          <h4>{entry.title}</h4>
          <p title="每条目为注入最小单位；关键词命中时整段正文注入；「始终」宜短，小手机/秘密空间等会默认引用。">
            {XINGYE_LORE_CATEGORY_LABELS[entry.category]} · {LORE_VISIBILITY_LABEL[entry.visibility]} · {LORE_INSERTION_LABEL[entry.insertionMode]} · 优先级 {entry.priority}
          </p>
        </div>
        <button type="button" onClick={(event) => { event.stopPropagation(); onToggle(entry.id); }}>
          {entry.enabled ? '停用' : '启用'}
        </button>
      </div>
      <p className={styles.loreContent}>{entry.content}</p>
      {entry.keywords.length > 0 && (
        <div className={styles.loreKeywords}>
          {entry.keywords.map((keyword) => <span key={keyword}>{keyword}</span>)}
        </div>
      )}
      <div className={styles.loreActions} onClick={(event) => event.stopPropagation()}>
        <button type="button" onClick={() => onEdit(entry)}>编辑</button>
        <button type="button" onClick={() => onDelete(entry.id)}>删除</button>
        {onSaveAsCandidate ? (
          <button
            type="button"
            onClick={() => onSaveAsCandidate(entry)}
            disabled={saveAsCandidateDisabled}
            data-testid={`lore-entry-save-candidate-${entry.id}`}
          >
            保存为候选重要记忆
          </button>
        ) : null}
      </div>
    </article>
  );
}
