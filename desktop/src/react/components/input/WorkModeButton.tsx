import { useCallback } from 'react';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { useI18n } from '../../hooks/use-i18n';
import { useStore } from '../../stores';
import styles from './InputArea.module.css';

/**
 * 工作模式开关：按会话布尔。开启后该会话剥离星野角色注入（lore/资料/关系/性别），
 * 切成务实诚实的工作助手。状态走 /api/session-work-mode（per-session），服务端
 * 通过 work_mode ws 事件回灌；这里只做乐观更新 + 失败回滚。
 */
export function WorkModeButton({ enabled, onChange }: {
  enabled: boolean;
  onChange: (v: boolean) => void;
}) {
  const { t } = useI18n();

  const toggle = useCallback(async () => {
    const state = useStore.getState();
    const sessionPath = state.currentSessionPath;
    if (!sessionPath) {
      // 新会话还没落盘，没有 sessionPath 可挂；提示用户先发一条消息。
      window.dispatchEvent(new CustomEvent('hana-inline-notice', {
        detail: { text: t('input.workModeNeedsSession'), type: 'info' },
      }));
      return;
    }
    const next = !enabled;
    onChange(next); // 乐观更新
    try {
      const res = await hanaFetch('/api/session-work-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionPath, enabled: next }),
      });
      const data = await res.json();
      if (data?.ok === false) {
        onChange(enabled); // 回滚
      } else {
        onChange(data?.enabled === true);
      }
    } catch (err) {
      console.error('[work-mode] toggle failed:', err);
      onChange(enabled); // 回滚
    }
  }, [enabled, onChange, t]);

  return (
    <button
      type="button"
      className={`${styles['plan-mode-btn']}${enabled ? ` ${styles['work-mode-on']}` : ''}`}
      title={t('input.workModeHint')}
      aria-pressed={enabled}
      onClick={(e) => { e.stopPropagation(); void toggle(); }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="7" width="18" height="13" rx="2" />
        <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      </svg>
      <span className={styles['plan-mode-label']}>{t('input.workMode')}</span>
    </button>
  );
}
