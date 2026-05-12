import type { ReactNode } from 'react';
import type { SecretSpaceCategoryId } from './SecretSpaceHome';
import { SecretSpaceRecordCard } from './SecretSpaceRecordCard';
import styles from './XingyeShell.module.css';

export interface SecretSpaceCategoryMeta {
  id: SecretSpaceCategoryId;
  title: string;
  description: string;
}

export interface SecretSpaceSampleRecord {
  key: string;
  title: string;
  meta?: string;
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
          <p className={styles.secretSpaceEmptyState} data-testid="secret-space-empty">
            暂无记录
          </p>
        ) : (
          <div className={styles.secretSpaceRecordStack}>
            {records.map((rec) => (
              <SecretSpaceRecordCard key={rec.key} title={rec.title} meta={rec.meta} />
            ))}
          </div>
        )}
      </section>

      {footer ? <div className={styles.secretSpaceCategoryFooter}>{footer}</div> : null}
    </div>
  );
}
