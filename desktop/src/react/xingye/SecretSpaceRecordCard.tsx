import styles from './XingyeShell.module.css';

export interface SecretSpaceRecordCardProps {
  title: string;
  meta?: string;
}

export function SecretSpaceRecordCard({ title, meta }: SecretSpaceRecordCardProps) {
  return (
    <div className={styles.secretSpaceRecordCard}>
      <span className={styles.secretSpaceRecordTitle}>{title}</span>
      {meta ? <span className={styles.secretSpaceRecordMeta}>{meta}</span> : null}
    </div>
  );
}
