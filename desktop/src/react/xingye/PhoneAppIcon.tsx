import type { ReactNode } from 'react';
import styles from './XingyeShell.module.css';

interface PhoneAppIconProps {
  icon: ReactNode;
  label: string;
  subtitle?: string;
  onClick: () => void;
  tone: 'journal' | 'album' | 'message' | 'audio' | 'contacts' | 'mmchat' | 'schedule' | 'divination' | 'files' | 'shopping';
}

export function PhoneAppIcon({ icon, label, subtitle, onClick, tone }: PhoneAppIconProps) {
  return (
    <button
      className={styles.phoneAppIcon}
      type="button"
      aria-label={subtitle ? `${label}，${subtitle}` : label}
      onClick={onClick}
    >
      <span className={`${styles.phoneAppGlyph} ${styles[`phoneAppGlyph_${tone}`]}`}>
        {icon}
      </span>
      <span className={styles.phoneAppLabel}>{label}</span>
    </button>
  );
}
