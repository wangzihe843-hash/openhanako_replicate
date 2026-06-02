import { memo } from 'react';
import { AttachmentChip } from '../shared/AttachmentChip';
import { FolderIcon } from '../shared/FolderIcon';
import styles from './InputArea.module.css';

export const AttachedFilesBar = memo(function AttachedFilesBar({ files, onRemove }: {
  files: Array<{ path: string; name: string; isDirectory?: boolean }>;
  onRemove: (index: number) => void;
}) {
  return (
    <div className={styles['attached-files']}>
      {files.map((f, i) => (
        <AttachmentChip
          key={f.path}
          icon={f.isDirectory ? <FolderIcon /> : <ClipIcon />}
          name={f.name}
          onRemove={() => onRemove(i)}
        />
      ))}
    </div>
  );
});

function ClipIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}
