import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { SecretSpaceCategoryId } from './SecretSpaceHome';
import type { SecretSpaceSampleRecord } from './secret-space-record-types';
import { SecretSpaceRecordCard } from './SecretSpaceRecordCard';
import { SecretSpaceRecordListItem } from './SecretSpaceRecordListItem';
import styles from './XingyeShell.module.css';

export type { SecretSpaceSampleRecord } from './secret-space-record-types';

export interface SecretSpaceCategoryMeta {
  id: SecretSpaceCategoryId;
  title: string;
  description: string;
  recordsEmptyTitle: string;
  recordsEmptyBody: string;
  /** 设计稿统一的小写英文 kicker，e.g. "DRAFT · 没说出口的话"；可选 */
  kicker?: string;
}

interface SecretSpaceCategoryViewProps {
  meta: SecretSpaceCategoryMeta;
  onBack: () => void;
  stateSection?: ReactNode;
  records: SecretSpaceSampleRecord[];
  footer?: ReactNode;
  /** 删除当前详情记录：返回是否已从存储移除（未找到则为 false）。 */
  onRequestDeleteRecord?: (recordKey: string) => Promise<boolean>;
  deleteError?: string | null;
  /**
   * 自定义"记录列表"渲染（分类特有的便签 / 书签 / 朋友圈 / 标本 / 梦记 布局）。
   * 未提供时回退到默认 SecretSpaceRecordListItem 列表。`onOpen` 与默认列表共用，
   * 调用后会进入详情视图。
   */
  renderRecordList?: (args: {
    records: SecretSpaceSampleRecord[];
    onOpen: (recordKey: string) => void;
  }) => ReactNode;
  /**
   * 详情视图里在删除按钮旁渲染的额外动作（如 memory_fragment 的「推到 pinned」）。
   * 给当前选中的 record 返回 0..n 个按钮；返回 null 则不渲染额外动作。
   */
  renderRecordDetailExtraActions?: (record: SecretSpaceSampleRecord) => ReactNode;
}

export function SecretSpaceCategoryView({
  meta,
  onBack,
  stateSection,
  records,
  footer,
  onRequestDeleteRecord,
  deleteError,
  renderRecordList,
  renderRecordDetailExtraActions,
}: SecretSpaceCategoryViewProps) {
  const [selectedRecordKey, setSelectedRecordKey] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  useEffect(() => {
    setSelectedRecordKey(null);
  }, [meta.id]);

  const selectedRecord = useMemo(
    () => (selectedRecordKey ? records.find((r) => r.key === selectedRecordKey) ?? null : null),
    [records, selectedRecordKey],
  );

  const empty = records.length === 0;
  const inDetail = !!selectedRecord;
  const deleteButtonLabel = meta.id === 'memory_fragment' ? '删除这条回忆' : '删除此记录';

  const handleBack = () => {
    if (inDetail) {
      setSelectedRecordKey(null);
      return;
    }
    onBack();
  };

  const handleDeleteClick = () => {
    const rec = selectedRecord;
    if (!rec || !onRequestDeleteRecord || deleteBusy) return;
    if (!window.confirm('确定删除这条记录？删除后无法恢复。')) return;
    setDeleteBusy(true);
    void (async () => {
      try {
        const ok = await onRequestDeleteRecord(rec.key);
        if (ok) setSelectedRecordKey(null);
      } finally {
        setDeleteBusy(false);
      }
    })();
  };

  return (
    <div
      className={styles.secretSpaceCategory}
      data-testid={`secret-space-category-${meta.id}`}
      data-category={meta.id}
    >
      <header className={styles.secretSpaceCategoryHeader}>
        <button type="button" className={styles.secretSpaceBackButton} onClick={handleBack}>
          {inDetail ? '返回记录列表' : '返回'}
        </button>
        <div className={styles.secretSpaceCategoryHeading}>
          {meta.kicker ? (
            <div className={styles.secretSpaceCategoryKicker}>{meta.kicker}</div>
          ) : null}
          <h3 className={styles.secretSpaceCategoryTitle}>{meta.title}</h3>
          <p className={styles.secretSpaceCategoryDescription}>{meta.description}</p>
        </div>
      </header>

      {deleteError ? (
        <p className={styles.saveStatus} role="alert" data-testid="secret-space-delete-error">
          {deleteError}
        </p>
      ) : null}

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
        ) : inDetail && selectedRecord ? (
          <div className={styles.secretSpaceRecordDetailPane}>
            <SecretSpaceRecordCard record={selectedRecord} />
            {(onRequestDeleteRecord || renderRecordDetailExtraActions) ? (
              <div className={styles.secretSpaceRecordDetailActions}>
                {renderRecordDetailExtraActions ? renderRecordDetailExtraActions(selectedRecord) : null}
                {onRequestDeleteRecord ? (
                  <button
                    type="button"
                    className={styles.momentDeleteButton}
                    onClick={handleDeleteClick}
                    disabled={deleteBusy}
                    data-testid={`secret-space-delete-${selectedRecord.key}`}
                  >
                    {deleteBusy ? '删除中…' : deleteButtonLabel}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : renderRecordList ? (
          renderRecordList({ records, onOpen: setSelectedRecordKey })
        ) : (
          <ul className={styles.secretSpaceRecordIndexList} aria-label="记录索引">
            {records.map((rec) => (
              <li key={rec.key} className={styles.secretSpaceRecordIndexItem}>
                <SecretSpaceRecordListItem record={rec} onOpen={setSelectedRecordKey} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {!inDetail && footer ? <div className={styles.secretSpaceCategoryFooter}>{footer}</div> : null}
    </div>
  );
}
