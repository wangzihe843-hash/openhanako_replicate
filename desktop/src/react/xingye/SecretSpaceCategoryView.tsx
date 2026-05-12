import type { ReactNode } from 'react';
import type { SecretSpaceCategoryId } from './SecretSpaceHome';
import type { SecretSpaceSampleRecord } from './secret-space-record-types';
import { SecretSpaceRecordCard } from './SecretSpaceRecordCard';
import styles from './XingyeShell.module.css';

export type { SecretSpaceSampleRecord } from './secret-space-record-types';

export interface SecretSpaceCategoryMeta {
  id: SecretSpaceCategoryId;
  title: string;
  description: string;
  /** 记录列表为空时的标题与说明（分类专属空状态） */
  recordsEmptyTitle: string;
  recordsEmptyBody: string;
}

interface SecretSpaceCategoryViewProps {
  meta: SecretSpaceCategoryMeta;
  onBack: () => void;
  stateSection?: ReactNode;
  records: SecretSpaceSampleRecord[];
  footer?: ReactNode;
}

export function SecretSpaceCategoryView({
  meta,
  onBack,
  stateSection,
  records,
  footer,
}: SecretSpaceCategoryViewProps) {
  const empty = records.length === 0;

  return (
    <div className={styles.secretSpaceCategory} data-testid={`secret-space-category-${meta.id}`}>
      <header className={styles.secretSpaceCategoryHeader}>
        <button type="button" className={styles.secretSpaceBackButton} onClick={onBack}>
          返回
        </button>
        <div className={styles.secretSpaceCategoryHeading}>
          <h3 className={styles.secretSpaceCategoryTitle}>{meta.title}</h3>
          <p className={styles.secretSpaceCategoryDescription}>{meta.description}</p>
        </div>
      </header>

      {stateSection ? (
        <div className={styles.secretSpaceCategoryBlock} data-testid="secret-space-state-section">
          {stateSection}
        </div>
      ) : null}

      <section className={styles.secretSpaceCategoryRecords} aria-label={`${meta.title} 记录列表`}>
        {empty ? (
          <div className={styles.secretSpaceEmptyBlock} data-testid="secret-space-empty">
            <p className={styles.secretSpaceEmptyBlockTitle}>{meta.recordsEmptyTitle}</p>
            <p className={styles.secretSpaceEmptyBlockBody}>{meta.recordsEmptyBody}</p>
          </div>
        ) : (
          <div className={styles.secretSpaceRecordStack}>
            {records.map((rec) => (
              <SecretSpaceRecordCard key={rec.key} record={rec} />
            ))}
          </div>
        )}
      </section>

      {footer ? <div className={styles.secretSpaceCategoryFooter}>{footer}</div> : null}
    </div>
  );
}
