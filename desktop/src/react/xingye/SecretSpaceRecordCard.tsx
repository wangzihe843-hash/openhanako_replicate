import type { SecretSpaceRecordKind, SecretSpaceSampleRecord } from './secret-space-record-types';
import styles from './XingyeShell.module.css';

const KIND_LABEL: Record<SecretSpaceRecordKind, string> = {
  draft_reply: '草稿',
  dream: '梦境',
  saved_item: '文字收藏',
  unsent_moment: '朋友圈草稿',
  memory_fragment: '回忆',
};

export interface SecretSpaceRecordCardProps {
  record: SecretSpaceSampleRecord;
}

export function SecretSpaceRecordCard({ record }: SecretSpaceRecordCardProps) {
  return (
    <article className={styles.secretSpaceRecordCardV2} data-testid={`secret-space-record-${record.key}`}>
      <div className={styles.secretSpaceRecordCardHeader}>
        <span className={styles.secretSpaceRecordKind}>{KIND_LABEL[record.kind]}</span>
        <h4 className={styles.secretSpaceRecordCardTitle}>{record.title}</h4>
      </div>
      <p className={styles.secretSpaceRecordBody}>{record.body}</p>
      {record.meta ? <p className={styles.secretSpaceRecordFoot}>{record.meta}</p> : null}
    </article>
  );
}
