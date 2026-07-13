/**
 * ChannelRenameOverlay — 频道重命名弹窗
 *
 * Electron 的 BrowserWindow 不支持 window.prompt()，所以重命名走自带的 Overlay。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../stores';
import { useI18n } from '../../hooks/use-i18n';
import { renameChannel } from '../../stores/channel-actions';
import { Overlay } from '../../ui';
import styles from './Channels.module.css';

export function ChannelRenameOverlay() {
  const { t } = useI18n();
  const targetChannelId = useStore((s) => s.channelRenameOverlayChannelId);
  const setTarget = useStore((s) => s.setChannelRenameOverlayChannelId);
  const channels = useStore((s) => s.channels);

  const targetChannel = targetChannelId
    ? channels.find((c) => c.id === targetChannelId) ?? null
    : null;
  const currentName = targetChannel?.name || targetChannelId || '';

  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const nameRef = useRef<HTMLInputElement>(null);

  // When overlay opens, prefill with current name and focus + select all
  useEffect(() => {
    if (!targetChannelId) return;
    setName(currentName);
    setSubmitError('');
    requestAnimationFrame(() => {
      const el = nameRef.current;
      if (!el) return;
      el.focus();
      el.select();
    });
  }, [targetChannelId, currentName]);

  const handleClose = useCallback(() => {
    if (submitting) return;
    setTarget(null);
  }, [submitting, setTarget]);

  const handleSubmit = useCallback(async () => {
    if (submitting || !targetChannelId) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setSubmitError(t('channel.renameEmpty'));
      nameRef.current?.focus();
      return;
    }
    if (trimmed === currentName) {
      setTarget(null);
      return;
    }
    setSubmitting(true);
    setSubmitError('');
    try {
      await renameChannel(targetChannelId, trimmed);
      setTarget(null);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setSubmitError(msg || t('channel.renameFailed'));
    } finally {
      setSubmitting(false);
    }
  }, [submitting, targetChannelId, name, currentName, setTarget, t]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
        e.preventDefault();
        void handleSubmit();
      }
    },
    [handleSubmit],
  );

  return (
    <Overlay
      scope="window"
      open={!!targetChannelId}
      onClose={handleClose}
      backdrop="blur"
      zIndex={110}
      className={styles.createCard}
      disableContainerAnimation
    >
      <h3 className={styles.createTitle}>{t('channel.renameChannel')}</h3>
      <div className={styles.createField}>
        <label className={styles.createFieldLabel}>{t('channel.createName')}</label>
        <input
          ref={nameRef}
          className={styles.createInput}
          type="text"
          autoComplete="off"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setSubmitError('');
          }}
          onKeyDown={handleKeyDown}
        />
      </div>
      {submitError ? (
        <div className={styles.createError} role="alert">
          {submitError}
        </div>
      ) : null}
      <div className={styles.createActions}>
        <button
          className={styles.createCancel}
          onClick={handleClose}
          disabled={submitting}
        >
          {t('channel.createCancel')}
        </button>
        <button
          className={styles.createConfirm}
          onClick={() => void handleSubmit()}
          disabled={submitting || !name.trim()}
        >
          {t('channel.createConfirm')}
        </button>
      </div>
    </Overlay>
  );
}
