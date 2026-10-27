import { useState, useEffect, useRef, useCallback } from 'react';
import { hanaFetch } from '../api';
import { t } from '../helpers';
import { Overlay } from '../../ui';
import styles from './WechatQrcodeOverlay.module.css';

type QrStatus = 'loading' | 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'error' | 'need_verifycode' | 'verify_code_blocked' | 'binded_redirect';
const MAX_REFRESH = 3;

export function WechatQrcodeOverlay() {
  const [visible, setVisible] = useState(false);
  const [qrcodeUrl, setQrcodeUrl] = useState('');
  const [qrcodeId, setQrcodeId] = useState('');
  const [status, setStatus] = useState<QrStatus>('loading');
  const [error, setError] = useState('');
  const [verifyCode, setVerifyCode] = useState('');
  const [pollVersion, setPollVersion] = useState(0);
  const pendingCodeRef = useRef<string | undefined>(undefined);
  const refreshCountRef = useRef(0);
  const agentIdRef = useRef<string | null>(null);
  const sessionRef = useRef('');
  const generationRef = useRef(0);
  const requestAbortRef = useRef<AbortController | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const invalidate = useCallback(() => {
    generationRef.current += 1;
    requestAbortRef.current?.abort();
    requestAbortRef.current = null;
    if (sessionRef.current && agentIdRef.current) {
      void hanaFetch(`/api/bridge/wechat/qrcode-cancel?agentId=${encodeURIComponent(agentIdRef.current)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionRef.current }),
      }).catch(() => {});
    }
    sessionRef.current = '';
    pendingCodeRef.current = undefined;
    if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);

  const close = useCallback(() => {
    invalidate();
    setVisible(false); setQrcodeUrl(''); setQrcodeId(''); setStatus('loading'); setError(''); setVerifyCode('');
    refreshCountRef.current = 0;
    agentIdRef.current = null;
  }, [invalidate]);

  const fetchQrcode = useCallback(async () => {
    invalidate();
    const generation = generationRef.current;
    const agentId = agentIdRef.current;
    const isCurrent = () => generation === generationRef.current;
    setQrcodeId(''); setQrcodeUrl(''); setStatus('loading'); setError(''); setVerifyCode('');
    if (!agentId) { setStatus('error'); setError(t('settings.bridge.wechatLoginFailed')); return; }
    const sessionId = crypto.randomUUID();
    sessionRef.current = sessionId;
    const controller = new AbortController(); requestAbortRef.current = controller;
    try {
      const res = await hanaFetch(`/api/bridge/wechat/qrcode?agentId=${encodeURIComponent(agentId)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }), signal: controller.signal,
      });
      if (!isCurrent()) return;
      const data = await res.json();
      if (!isCurrent()) return;
      if (!data.ok || !data.qrcodeUrl || !data.sessionId) throw new Error(data.error || t('settings.bridge.wechatLoginFailed'));
      sessionRef.current = data.sessionId;
      setQrcodeUrl(data.qrcodeUrl); setQrcodeId(data.sessionId); setStatus('waiting');
    } catch (err: unknown) {
      if (!isCurrent()) return;
      setStatus('error'); setError(err instanceof Error ? err.message : String(err));
    }
  }, [invalidate]);

  const startPolling = useCallback((id: string) => {
    const generation = generationRef.current;
    const agentId = agentIdRef.current;
    let cancelled = false;
    let cancelDelay = () => {};
    let controller: AbortController | undefined;
    const isCurrent = () => !cancelled && generation === generationRef.current;
    const agentQuery = `?agentId=${encodeURIComponent(agentId || '')}`;

    void (async () => {
      while (isCurrent()) {
        try {
          controller = new AbortController(); requestAbortRef.current = controller;
          const code = pendingCodeRef.current; pendingCodeRef.current = undefined;
          const res = await hanaFetch(`/api/bridge/wechat/qrcode-status${agentQuery}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: id, ...(code ? { verifyCode: code } : {}) }),
            signal: controller.signal, timeout: 45_000,
          });
          if (!isCurrent()) return;
          const data = await res.json();
          if (!isCurrent()) return;
          if (data.status === 'scanned' || data.status === 'scaned_but_redirect') setStatus('scanned');
          else if (data.status === 'need_verifycode' || data.status === 'verify_code_blocked' || data.status === 'binded_redirect') {
            setStatus(data.status); return;
          } else if (data.status === 'error') {
            setStatus('error'); setError(data.error || t('settings.bridge.wechatLoginFailed')); return;
          } else if (data.status === 'confirmed' && data.botToken) {
            const saved = await hanaFetch(`/api/bridge/config${agentQuery}`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
              body: JSON.stringify({ platform: 'wechat', loginSessionId: id,
                credentials: { botToken: data.botToken, baseUrl: data.baseUrl }, enabled: true }),
            });
            if (!isCurrent()) return;
            const savedData = await saved.json();
            if (!isCurrent()) return;
            if (!savedData.ok) throw new Error(savedData.error || t('settings.saveFailed'));
            if (data.userId) {
              const owner = await hanaFetch(`/api/bridge/owner${agentQuery}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
                body: JSON.stringify({ platform: 'wechat', userId: data.userId }),
              });
              if (!isCurrent()) return;
              const ownerData = await owner.json();
              if (!isCurrent()) return;
              if (!ownerData.ok) throw new Error(ownerData.error || t('settings.saveFailed'));
            }
            setStatus('confirmed'); window.dispatchEvent(new Event('hana-bridge-reload'));
            closeTimerRef.current = setTimeout(() => { if (isCurrent()) close(); }, 1200);
            return;
          } else if (data.status === 'expired') {
            refreshCountRef.current += 1;
            if (refreshCountRef.current >= MAX_REFRESH) { setStatus('error'); setError(t('settings.bridge.wechatExpired')); }
            else void fetchQrcode();
            return;
          } else if (data.status !== 'waiting') throw new Error(t('settings.bridge.wechatLoginFailed'));
        } catch (err: unknown) {
          if (!isCurrent()) return;
          // Never replay a verification code or a save whose outcome is unknown.
          setStatus('error'); setError(err instanceof Error ? err.message : String(err)); return;
        }
        if (isCurrent()) await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 1000);
          cancelDelay = () => { clearTimeout(timer); resolve(); };
        });
      }
    })();
    return () => { cancelled = true; controller?.abort(); cancelDelay(); };
  }, [close, fetchQrcode]);

  useEffect(() => {
    const show = (e: Event) => {
      const detail = (e as CustomEvent<{ agentId?: string | null }>).detail;
      invalidate(); agentIdRef.current = detail?.agentId ?? null;
      setVisible(true); refreshCountRef.current = 0; void fetchQrcode();
    };
    window.addEventListener('hana-show-wechat-qrcode', show);
    window.addEventListener('hana-close-wechat-qrcode', close);
    return () => {
      window.removeEventListener('hana-show-wechat-qrcode', show);
      window.removeEventListener('hana-close-wechat-qrcode', close);
      invalidate();
    };
  }, [close, fetchQrcode, invalidate]);

  useEffect(() => {
    if (qrcodeId) return startPolling(qrcodeId);
  }, [qrcodeId, startPolling, pollVersion]);

  const statusLabel = (() => {
    switch (status) {
      case 'loading': return t('settings.bridge.wechatScanning');
      case 'waiting': return t('settings.bridge.wechatScanning');
      case 'scanned': return t('settings.bridge.wechatScanned');
      case 'confirmed': return t('settings.bridge.wechatLoginSuccess');
      case 'need_verifycode': return t('settings.bridge.wechatVerifyPrompt');
      case 'verify_code_blocked': return t('settings.bridge.wechatVerifyBlocked');
      case 'binded_redirect': return t('settings.bridge.wechatAlreadyBound');
      case 'expired': return t('settings.bridge.wechatExpired');
      case 'error': return error || t('settings.bridge.wechatLoginFailed');
      default: return '';
    }
  })();

  const statusClass = status === 'confirmed' ? styles.success
    : (status === 'error' || status === 'expired' || status === 'verify_code_blocked') ? styles.error
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

        <div className={`${styles.statusText} ${statusClass}`} role="status">{statusLabel}</div>
        {status === 'need_verifycode' && (
          <form className={styles.verifyForm} onSubmit={e => {
            e.preventDefault();
            if (!/^\d{1,16}$/.test(verifyCode)) return;
            pendingCodeRef.current = verifyCode; setVerifyCode(''); setStatus('scanned'); setPollVersion(v => v + 1);
          }}>
            <input aria-label={t('settings.bridge.wechatVerifyPrompt')} inputMode="numeric" autoComplete="off" maxLength={16}
              value={verifyCode} onChange={e => setVerifyCode(e.target.value.replace(/\D/g, ''))} autoFocus />
            <button type="submit" disabled={!/^\d{1,16}$/.test(verifyCode)}>{t('settings.bridge.wechatVerifySubmit')}</button>
          </form>
        )}
    </Overlay>
  );
}
