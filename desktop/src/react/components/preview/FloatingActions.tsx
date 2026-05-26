import { useCallback, useEffect, useRef, useState } from 'react';
import styles from './FloatingActions.module.css';
import {
  applyMarkdownCoverImage,
  dispatchCoverNotice,
  requestMarkdownCoverGeneration,
} from '../../utils/markdown-cover-generation';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { useStore } from '../../stores';
import { extOfName, inferKindByExt } from '../../utils/file-kind';

interface Props {
  content: string;
  filePath?: string;
  contentType?: string;
  language?: string | null;
  showMarkdownPreviewToggle?: boolean;
  markdownPreviewActive?: boolean;
  onToggleMarkdownPreview?: () => void;
}

export function FloatingActions({
  content,
  filePath,
  contentType,
  language,
  showMarkdownPreviewToggle = false,
  markdownPreviewActive = false,
  onToggleMarkdownPreview,
}: Props) {
  const [copyLabel, setCopyLabel] = useState<string | null>(null);
  const [coverBusy, setCoverBusy] = useState(false);
  const [coverMenuOpen, setCoverMenuOpen] = useState(false);
  const [coverToolEnabled, setCoverToolEnabled] = useState(false);
  const currentAgentId = useStore(s => s.currentAgentId);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const coverMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  useEffect(() => {
    if (!coverMenuOpen) return;
    const close = (event: PointerEvent) => {
      if (coverMenuRef.current?.contains(event.target as Node)) return;
      setCoverMenuOpen(false);
    };
    window.addEventListener('pointerdown', close, true);
    return () => window.removeEventListener('pointerdown', close, true);
  }, [coverMenuOpen]);

  useEffect(() => {
    if (contentType !== 'markdown' || !filePath || !currentAgentId) {
      setCoverToolEnabled(false);
      return;
    }
    let cancelled = false;
    const params = new URLSearchParams({ agentId: currentAgentId });
    hanaFetch(`/api/desk/beautify/status?${params.toString()}`)
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setCoverToolEnabled(Boolean(data?.available && data?.enabled));
      })
      .catch(() => {
        if (!cancelled) setCoverToolEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, [contentType, currentAgentId, filePath]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(content).then(() => {
      const _t = window.t ?? ((p: string) => p);
      setCopyLabel(_t('attach.copied'));
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopyLabel(null), 1500);
    });
  }, [content]);

  const handleScreenshot = useCallback(async () => {
    const { takeArticleScreenshot } = await import('../../utils/screenshot');
    await takeArticleScreenshot(content, {
      filePath,
      articleType: contentType,
      language,
    });
  }, [content, contentType, filePath, language]);

  const handleGenerateCover = useCallback(async () => {
    if (!filePath || contentType !== 'markdown') return;
    setCoverMenuOpen(false);
    setCoverBusy(true);
    try {
      const result = await requestMarkdownCoverGeneration({ filePath });
      dispatchCoverNotice(
        result.ok ? '已创建 cover 后台任务。' : `Cover 生成失败：${result.error}`,
        result.ok ? 'success' : 'error',
      );
    } catch (err) {
      dispatchCoverNotice(`Cover 生成失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setCoverBusy(false);
    }
  }, [contentType, filePath]);

  const handleUploadCover = useCallback(async () => {
    if (!filePath || contentType !== 'markdown') return;
    setCoverMenuOpen(false);
    const paths = await window.platform?.selectFiles?.();
    const imageFilePath = paths?.[0];
    if (!imageFilePath) return;
    const kind = inferKindByExt(extOfName(imageFilePath));
    if (kind !== 'image' && kind !== 'svg') {
      dispatchCoverNotice('请选择图片文件作为 cover。', 'error');
      return;
    }
    setCoverBusy(true);
    try {
      const result = await applyMarkdownCoverImage({ filePath, imageFilePath });
      dispatchCoverNotice(
        result.ok ? '已应用上传图片为 cover。' : `Cover 应用失败：${result.error}`,
        result.ok ? 'success' : 'error',
      );
    } catch (err) {
      dispatchCoverNotice(`Cover 应用失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setCoverBusy(false);
    }
  }, [contentType, filePath]);

  const handlePresetCover = useCallback(() => {
    setCoverMenuOpen(false);
    dispatchCoverNotice('系统预制头图稍后开放。', 'error');
  }, []);

  const t = window.t ?? ((p: string) => p);

  return (
    <div className={styles.floatingActions} data-react-managed>
      <button className={styles.actionBtn} onClick={handleCopy}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
        <span>{copyLabel ?? t('attach.copy')}</span>
      </button>
      {contentType === 'markdown' && filePath && coverToolEnabled && (
        <div className={styles.coverActionWrap} ref={coverMenuRef}>
          <button
            className={`${styles.actionBtn}${coverBusy ? ` ${styles.actionBtnBusy}` : ''}${coverMenuOpen ? ` ${styles.actionBtnActive}` : ''}`}
            onClick={() => setCoverMenuOpen(open => !open)}
            title="制作 cover"
            aria-label="制作 cover"
            disabled={coverBusy}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 20h5l10-10a3 3 0 0 0-5-5L4 15v5z" />
              <path d="M13.5 6.5l4 4" />
              <path d="M4 15l5 5" />
            </svg>
          </button>
          {coverMenuOpen && (
            <div className={styles.coverMenu}>
              <button type="button" onClick={handleGenerateCover}>AI 生成</button>
              <button type="button" onClick={handlePresetCover}>系统预制</button>
              <button type="button" onClick={handleUploadCover}>自己上传</button>
            </div>
          )}
        </div>
      )}
      {showMarkdownPreviewToggle && (
        <button
          className={`${styles.actionBtn}${markdownPreviewActive ? ` ${styles.actionBtnActive}` : ''}`}
          onClick={onToggleMarkdownPreview}
          title={t(markdownPreviewActive ? 'preview.exitMarkdownPreview' : 'preview.markdownPreview')}
          aria-label={t('preview.markdownPreview')}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </button>
      )}
      <button className={styles.actionBtn} onClick={handleScreenshot} title={t('common.screenshot')} aria-label={t('common.screenshot')}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
          <circle cx="12" cy="13" r="4" />
        </svg>
      </button>
    </div>
  );
}
