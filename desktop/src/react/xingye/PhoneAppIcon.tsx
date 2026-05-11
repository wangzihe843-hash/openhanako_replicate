import type { ReactNode } from 'react';
import styles from './XingyeShell.module.css';

interface PhoneAppIconProps {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  tone: 'journal' | 'album' | 'message' | 'audio';
}

export function PhoneAppIcon({ icon, label, onClick, tone }: PhoneAppIconProps) {
  return (
    <button
      className={styles.phoneAppIcon}
      type="button"
      aria-label={`${label}功能将在后续接入`}
      onClick={onClick}
    >
      <span className={`${styles.phoneAppGlyph} ${styles[`phoneAppGlyph_${tone}`]}`}>
        {icon}
      </span>
      <span className={styles.phoneAppLabel}>{label}</span>
    </button>
  );
}
