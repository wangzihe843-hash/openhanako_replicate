import type { XingyeLoreEntry } from './xingye-lore-store';
import { XINGYE_LORE_CATEGORY_LABELS } from './xingye-lore-store';
import styles from './XingyeShell.module.css';

interface LoreEntryCardProps {
  entry: XingyeLoreEntry;
  onEdit: (entry: XingyeLoreEntry) => void;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
}

export function LoreEntryCard({ entry, onEdit, onToggle, onDelete }: LoreEntryCardProps) {
  return (
    <article className={styles.loreCard}>
      <div className={styles.loreCardHeader}>
        <div className={styles.loreTitleBlock}>
          <h4>{entry.title}</h4>
          <p>
            {XINGYE_LORE_CATEGORY_LABELS[entry.category]} · {entry.visibility} · {entry.insertionMode} · priority {entry.priority}
          </p>
        </div>
        <button type="button" onClick={() => onToggle(entry.id)}>
          {entry.enabled ? '停用' : '启用'}
        </button>
      </div>
      <p className={styles.loreContent}>{entry.content}</p>
      {entry.keywords.length > 0 && (
        <div className={styles.loreKeywords}>
          {entry.keywords.map((keyword) => <span key={keyword}>{keyword}</span>)}
        </div>
      )}
      <div className={styles.loreActions}>
        <button type="button" onClick={() => onEdit(entry)}>编辑</button>
        <button type="button" onClick={() => onDelete(entry.id)}>删除</button>
      </div>
    </article>
  );
}
