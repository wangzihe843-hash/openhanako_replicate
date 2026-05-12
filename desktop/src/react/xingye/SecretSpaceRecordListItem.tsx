import type { SecretSpaceSampleRecord } from './secret-space-record-types';
import { SECRET_SPACE_RECORD_KIND_LABEL } from './secret-space-record-types';
import styles from './XingyeShell.module.css';

function formatRecordTime(createdAt: string, updatedAt?: string): string {
  try {
    const created = new Date(createdAt).toLocaleString();
    if (updatedAt && updatedAt !== createdAt) {
      return `创建 ${created} · 更新 ${new Date(updatedAt).toLocaleString()}`;
    }
    return created;
  } catch {
    return createdAt;
  }
}

export interface SecretSpaceRecordListItemProps {
  record: SecretSpaceSampleRecord;
  onOpen: (key: string) => void;
}

export function SecretSpaceRecordListItem({ record, onOpen }: SecretSpaceRecordListItemProps) {
  const timeLine = formatRecordTime(record.createdAt, record.updatedAt);
  const kindLabel = SECRET_SPACE_RECORD_KIND_LABEL[record.kind];
  const summary = (record.summary ?? '').trim();
  const metaHint = (record.meta ?? '').trim();

  return (
    <button
      type="button"
      className={styles.secretSpaceRecordListButton}
      data-testid={`secret-space-record-row-${record.key}`}
      onClick={() => onOpen(record.key)}
    >
      <span className={styles.secretSpaceRecordListButtonTop}>
        <span className={styles.secretSpaceRecordListKind}>{kindLabel}</span>
        <span className={styles.secretSpaceRecordListTitle}>{record.title}</span>
      </span>
      <span className={styles.secretSpaceRecordListTime}>{timeLine}</span>
      {summary ? <span className={styles.secretSpaceRecordListSummary}>{summary}</span> : null}
      {!summary && metaHint ? (
        <span className={styles.secretSpaceRecordListSummaryMuted}>{metaHint}</span>
      ) : null}
    </button>
  );
}
