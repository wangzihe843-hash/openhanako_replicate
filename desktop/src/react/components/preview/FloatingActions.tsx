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

function CoverArtboardIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="4" width="16" height="12" rx="1.5" />
      <path d="M8.5 20l2-4" />
      <path d="M15.5 20l-2-4" />
      <path d="M9 20h6" />
      <circle cx="8.5" cy="8.5" r="1.2" />
      <path d="M6.8 14l3.4-3.1 2.6 2 2-2.2 2.4 3.3" />
    </svg>
  );
}

function GenerateCoverIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3l1.2 3.3L16.5 7.5l-3.3 1.2L12 12l-1.2-3.3-3.3-1.2 3.3-1.2L12 3z" />
      <path d="M18 13l.8 2.2L21 16l-2.2.8L18 19l-.8-2.2L15 16l2.2-.8L18 13z" />
      <path d="M6 14l.6 1.6L8.2 16.2l-1.6.6L6 18.4l-.6-1.6-1.6-.6 1.6-.6L6 14z" />
    </svg>
  );
}

function GalleryCoverIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="4" width="14" height="12" rx="1.5" />
      <path d="M8 20h8" />
      <path d="M12 16v4" />
      <path d="M8 12.8l2.5-2.4 2 1.8 2-2.2L17 12.8" />
    </svg>
  );
}

function UploadCoverIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 15V4" />
      <path d="M8 8l4-4 4 4" />
      <path d="M5 16v2.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V16" />
    </svg>
  );
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
    dispatchCoverNotice('小花美术馆稍后开放。', 'error');
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
            <CoverArtboardIcon />
          </button>
          {coverMenuOpen && (
            <div className={styles.coverMenu}>
              <button type="button" onClick={handleGenerateCover}>
                <span className={styles.coverMenuIcon}><GenerateCoverIcon /></span>
                <span>生成</span>
              </button>
              <button type="button" onClick={handlePresetCover}>
                <span className={styles.coverMenuIcon}><GalleryCoverIcon /></span>
                <span>小花美术馆</span>
              </button>
              <button type="button" onClick={handleUploadCover}>
                <span className={styles.coverMenuIcon}><UploadCoverIcon /></span>
                <span>自己上传</span>
              </button>
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
