import styles from './XingyeShell.module.css';

export type SecretSpaceCategoryId =
  | 'state'
  | 'draft_reply'
  | 'dream'
  | 'saved_item'
  | 'unsent_moment'
  | 'memory_fragment';

const ENTRIES: { id: SecretSpaceCategoryId; label: string; hint: string }[] = [
  { id: 'state', label: 'TA 的状态', hint: 'state' },
  { id: 'draft_reply', label: 'TA 的草稿箱', hint: 'draft_reply' },
  { id: 'dream', label: 'TA 的梦境', hint: 'dream' },
  { id: 'saved_item', label: 'TA 收藏的东西', hint: 'saved_item' },
  { id: 'unsent_moment', label: 'TA 未发送的朋友圈', hint: 'unsent_moment' },
  { id: 'memory_fragment', label: '私藏回忆', hint: 'memory_fragment' },
];

interface SecretSpaceHomeProps {
  onSelectCategory: (id: SecretSpaceCategoryId) => void;
}

export function SecretSpaceHome({ onSelectCategory }: SecretSpaceHomeProps) {
  return (
    <div className={styles.secretSpaceHome} data-testid="secret-space-home">
      <div className={styles.secretSpaceHomeGrid}>
        {ENTRIES.map((e) => (
          <button
            key={e.id}
            type="button"
            className={styles.secretSpaceHomeCard}
            data-testid={`secret-space-entry-${e.id}`}
            onClick={() => onSelectCategory(e.id)}
          >
            <span className={styles.secretSpaceHomeCardTitle}>{e.label}</span>
            <span className={styles.secretSpaceHomeCardHint}>{e.hint}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
