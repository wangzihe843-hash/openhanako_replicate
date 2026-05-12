import type { SecretSpaceSampleRecord } from './secret-space-record-types';
import { SECRET_SPACE_RECORD_KIND_LABEL } from './secret-space-record-types';
import styles from './XingyeShell.module.css';

function formatDetailTime(createdAt: string, updatedAt?: string): string {
  try {
    const c = new Date(createdAt).toLocaleString();
    if (updatedAt && updatedAt !== createdAt) {
      return `创建：${c}\n更新：${new Date(updatedAt).toLocaleString()}`;
    }
    return `创建：${c}`;
  } catch {
    return createdAt;
  }
}

export interface SecretSpaceRecordCardProps {
  record: SecretSpaceSampleRecord;
}

/** 单条记录详情：完整正文、可滚动，用于分类内详情视图 */
export function SecretSpaceRecordCard({ record }: SecretSpaceRecordCardProps) {
  const kindLabel = SECRET_SPACE_RECORD_KIND_LABEL[record.kind];
  const timeBlock = formatDetailTime(record.createdAt, record.updatedAt);
  const tags = record.tags?.filter((t) => t.trim()).join(' · ');
  const hasMeta =
    !!(record.source?.trim() || tags || record.meta?.trim());

  return (
    <article
      className={styles.secretSpaceRecordDetail}
      data-testid={`secret-space-record-detail-${record.key}`}
    >
      <header className={styles.secretSpaceRecordDetailHeader}>
        <span className={styles.secretSpaceRecordKind}>{kindLabel}</span>
        <h4 className={styles.secretSpaceRecordDetailTitle}>{record.title}</h4>
        <pre className={styles.secretSpaceRecordDetailTime}>{timeBlock}</pre>
      </header>

      {hasMeta ? (
        <dl className={styles.secretSpaceRecordDetailMeta}>
          {record.source?.trim() ? (
            <>
              <dt>来源</dt>
              <dd>{record.source.trim()}</dd>
            </>
          ) : null}
          {tags ? (
            <>
              <dt>标签</dt>
              <dd>{tags}</dd>
            </>
          ) : null}
          {record.meta?.trim() ? (
            <>
              <dt>备注</dt>
              <dd>{record.meta.trim()}</dd>
            </>
          ) : null}
        </dl>
      ) : null}

      <div className={styles.secretSpaceRecordDetailBodyWrap}>
        <p className={styles.secretSpaceRecordDetailBodyLabel}>正文</p>
        <div className={styles.secretSpaceRecordDetailBodyScroll}>
          <pre className={styles.secretSpaceRecordDetailBody}>{record.body}</pre>
        </div>
      </div>
    </article>
  );
}
