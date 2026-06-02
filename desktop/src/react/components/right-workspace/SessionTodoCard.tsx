/**
 * SessionTodoCard — 右侧「待办」卡（最高优先级，置顶任务区）
 *
 * 复用 TodoDisplay 的三态逻辑（○ pending / ⟳ in_progress / ✓ completed），
 * 展示当前对话的 sessionTodos。无 todo / 无对话时返回 null。
 */
import { useStore } from '../../stores';
import type { TodoItem, TodoStatus } from '../../types';
import styles from './SessionTodoCard.module.css';

const STATUS_ICON: Record<TodoStatus, string> = {
  pending: '○',
  in_progress: '⟳',
  completed: '✓',
};

function displayText(todo: TodoItem): string {
  if (todo.status === 'in_progress' && todo.activeForm) return todo.activeForm;
  return todo.content || todo.activeForm || '';
}

export function SessionTodoCard() {
  const sessionPath = useStore((s) => s.currentSessionPath);
  const todos = useStore((s) => s.sessionTodos);
  const t = window.t ?? ((k: string) => k);

  if (!sessionPath || !todos.length) return null;

  const done = todos.filter((td) => td.status === 'completed').length;

  return (
    <section className={`jian-card ${styles.card}`} aria-label={t('rightWorkspace.todo.title')}>
      <div className={styles.header}>
        <span className={styles.title}>{t('rightWorkspace.todo.title')}</span>
        <span className={styles.count}>{done}/{todos.length}</span>
      </div>
      <div className={styles.list}>
        {todos.map((td, i) => (
          <div key={`todo-${i}`} className={styles.row} data-status={td.status}>
            <span className={styles.icon} aria-hidden="true">{STATUS_ICON[td.status]}</span>
            <span className={styles.text}>{displayText(td)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
