import { useState, useEffect, useRef, useCallback } from 'react';
import { hanaFetch } from '../api';
import { t } from '../helpers';
import { Overlay } from '../../ui';
import styles from './WechatQrcodeOverlay.module.css';

type QrStatus = 'loading' | 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'error';

const MAX_REFRESH = 3;

export function WechatQrcodeOverlay() {
  const [visible, setVisible] = useState(false);
  const [qrcodeUrl, setQrcodeUrl] = useState('');
  const [qrcodeId, setQrcodeId] = useState('');
  const [status, setStatus] = useState<QrStatus>('loading');
  const [error, setError] = useState('');
  const refreshCountRef = useRef(0);
  const agentIdRef = useRef<string | null>(null);
  const generationRef = useRef(0);
  const qrRequestRef = useRef(0);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const invalidate = useCallback(() => {
    generationRef.current += 1;
    qrRequestRef.current += 1;
    if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);

  const close = useCallback(() => {
    invalidate();
    setVisible(false);
    setQrcodeUrl('');
    setQrcodeId('');
    setStatus('loading');
    setError('');
    refreshCountRef.current = 0;
    agentIdRef.current = null;
  }, [invalidate]);

  const fetchQrcode = useCallback(async () => {
    const generation = generationRef.current;
    const request = ++qrRequestRef.current;
    const isCurrent = () => generation === generationRef.current && request === qrRequestRef.current;
    setStatus('loading');
    setError('');
    try {
      const res = await hanaFetch('/api/bridge/wechat/qrcode', { method: 'POST' });
      if (!isCurrent()) return;
      const data = await res.json();
      if (!isCurrent()) return;
      if (data.ok && data.qrcodeUrl) {
        setQrcodeUrl(data.qrcodeUrl);
        setQrcodeId(data.qrcodeId);
        setStatus('waiting');
      } else {
        setStatus('error');
        setError(data.error || t('settings.bridge.wechatLoginFailed'));
      }
    } catch (err: unknown) {
      if (!isCurrent()) return;
      setStatus('error');
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  /**
   * 递归 await 轮询。每次等上一个请求完成后再等 1s 发下一个，
   * 避免 setInterval 在长轮询（35s hold）期间堆叠请求。
   */
  const startPolling = useCallback((id: string) => {
    const generation = generationRef.current;
    const agentId = agentIdRef.current;
    let cancelled = false;
    let cancelDelay = () => {};
    const isCurrent = () => !cancelled && generation === generationRef.current;

    (async () => {
      while (isCurrent()) {
        try {
          const res = await hanaFetch('/api/bridge/wechat/qrcode-status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ qrcodeId: id }),
          });
          if (!isCurrent()) return;
          const data = await res.json();
          if (!isCurrent()) return;

          if (data.status === 'scanned') {
            setStatus('scanned');
          } else if (data.status === 'confirmed' && data.botToken) {
            // Credentials belong to the agent that started this QR flow.
            const agentQuery = agentId ? `?agentId=${encodeURIComponent(agentId)}` : '';
            try {
              await hanaFetch(`/api/bridge/config${agentQuery}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  platform: 'wechat',
                  credentials: { botToken: data.botToken },
                  enabled: true,
                }),
              });
              if (!isCurrent()) return;
              // 微信只绑定一个账号，扫码用户即 owner
              if (data.userId) {
                await hanaFetch(`/api/bridge/owner${agentQuery}`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ platform: 'wechat', userId: data.userId }),
                });
              }
            } catch (err: unknown) {
              if (isCurrent()) {
                setStatus('error');
                setError(err instanceof Error ? err.message : String(err));
              }
              return;
            }
            if (!isCurrent()) return;
            setStatus('confirmed');
            window.dispatchEvent(new Event('hana-bridge-reload'));
            closeTimerRef.current = setTimeout(() => { if (isCurrent()) close(); }, 1200);
            return;
          } else if (data.status === 'expired') {
            refreshCountRef.current += 1;
            if (refreshCountRef.current >= MAX_REFRESH) {
              setStatus('error');
              setError(t('settings.bridge.wechatExpired'));
            } else {
              fetchQrcode();
            }
            return;
          }
        } catch { /* 网络错误静默重试 */ }

        // 请求完成后等 1 秒再发下一个
        if (isCurrent()) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 1000);
            cancelDelay = () => { clearTimeout(timer); resolve(); };
          });
        }
      }
    })();
    return () => { cancelled = true; cancelDelay(); };
  }, [close, fetchQrcode]);

  // 监听显示事件
  useEffect(() => {
    const show = (e: Event) => {
      const detail = (e as CustomEvent<{ agentId?: string | null }>).detail;
      invalidate();
      agentIdRef.current = detail?.agentId ?? null;
      setVisible(true);
      setQrcodeId('');
      setQrcodeUrl('');
      refreshCountRef.current = 0;
      fetchQrcode();
    };
    window.addEventListener('hana-show-wechat-qrcode', show);
    return () => {
      window.removeEventListener('hana-show-wechat-qrcode', show);
      invalidate();
    };
  }, [fetchQrcode, invalidate]);

  // qrcodeId 变化时开始轮询（不依赖 status，避免 scanned 状态触发 cleanup）
  useEffect(() => {
    if (qrcodeId) {
      return startPolling(qrcodeId);
    }
  }, [qrcodeId, startPolling]);

  const statusLabel = (() => {
    switch (status) {
      case 'loading': return t('settings.bridge.wechatScanning');
      case 'waiting': return t('settings.bridge.wechatScanning');
      case 'scanned': return t('settings.bridge.wechatScanned');
      case 'confirmed': return t('settings.bridge.wechatLoginSuccess');
      case 'expired': return t('settings.bridge.wechatExpired');
      case 'error': return error || t('settings.bridge.wechatLoginFailed');
      default: return '';
    }
  })();

  const statusClass = status === 'confirmed' ? styles.success
    : (status === 'error' || status === 'expired') ? styles.error
    : '';

  return (
    <Overlay
      scope="inline"
      open={visible}
      onClose={close}
      backdrop="blur"
      zIndex={100}
      className={styles.card}
      disableContainerAnimation
    >
        <button className={styles.closeBtn} onClick={close} aria-label="close">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>

        <div className={styles.title}>{t('settings.bridge.wechat')}</div>

        <div className={styles.qrcodeContainer}>
          {status === 'loading' && <span className={styles.loading}>...</span>}
          {qrcodeUrl && status !== 'loading' && (
            <img className={styles.qrcodeImg} src={qrcodeUrl} alt="WeChat QR Code" />
          )}
        </div>

        <div className={`${styles.statusText} ${statusClass}`}>{statusLabel}</div>
    </Overlay>
  );
}
