import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import styles from './FloatingActions.module.css';
import { COVER_GALLERY_ITEMS, type CoverGalleryItem } from './cover-gallery-assets';
import {
  applyMarkdownCoverImage,
  applyMarkdownCoverPreset,
  dispatchCoverNotice,
  requestMarkdownCoverGeneration,
} from '../../utils/markdown-cover-generation';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { Tooltip } from '../../ui';
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

type CoverGenerationStatus = {
  enabled?: boolean;
  executorAgentId?: string | null;
  disabledReason?: string | null;
  message?: string | null;
  settingsTarget?: string | null;
};

type CoverStatus = {
  systemCover?: {
    available?: boolean;
  };
  agentGenerate?: CoverGenerationStatus;
  available?: boolean;
  enabled?: boolean;
  agentId?: string | null;
};

function getAgentGenerateDisabledText(status: CoverGenerationStatus): string {
  if (status.message) return status.message;
  switch (status.disabledReason) {
    case 'beautify-disabled':
      return '需要先在主 Agent 的工具设置里开启小花美术。';
    case 'default-image-model-missing':
      return '需要先在设置里配置默认生图模型。';
    case 'default-image-model-invalid':
      return '默认生图模型不可用，需要在设置里重新配置。';
    case 'image-gen-unavailable':
      return '生图工具未启用，需要先在设置里开启。';
    case 'agent-unavailable':
      return '主 Agent 暂不可用，无法发起 Agent 生成。';
    default:
      return '当前不能使用 Agent 生成。';
  }
}

function CoverPaletteIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3.5a8.5 8.5 0 0 0 0 17h1.4a1.55 1.55 0 0 0 1.1-2.65l-.18-.18a1.18 1.18 0 0 1 .83-2.02H17a4 4 0 0 0 4-4c0-4.5-3.86-8.15-9-8.15z" />
      <circle cx="7.7" cy="10.2" r="1" />
      <circle cx="10.2" cy="7.4" r="1" />
      <circle cx="14" cy="7.6" r="1" />
      <circle cx="16.7" cy="10.3" r="1" />
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
  const [coverGalleryOpen, setCoverGalleryOpen] = useState(false);
  const [coverStatus, setCoverStatus] = useState<CoverStatus | null>(null);
  const [brokenCoverGalleryIds, setBrokenCoverGalleryIds] = useState<ReadonlySet<string>>(() => new Set());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const coverMenuRef = useRef<HTMLDivElement | null>(null);
  const floatingActionsRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  useEffect(() => {
    if (!coverMenuOpen && !coverGalleryOpen) return;
    const close = (event: PointerEvent) => {
      if (floatingActionsRef.current?.contains(event.target as Node)) return;
      setCoverMenuOpen(false);
      setCoverGalleryOpen(false);
    };
    window.addEventListener('pointerdown', close, true);
    return () => window.removeEventListener('pointerdown', close, true);
  }, [coverGalleryOpen, coverMenuOpen]);

  useEffect(() => {
    if (contentType !== 'markdown' || !filePath) {
      setCoverStatus(null);
      return;
    }
    let cancelled = false;
    hanaFetch('/api/desk/beautify/status')
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setCoverStatus(data || null);
      })
      .catch(() => {
        if (!cancelled) setCoverStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [contentType, filePath]);

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
    const generationStatus = coverStatus?.agentGenerate ?? {};
    const generationEnabled = Boolean(generationStatus.enabled ?? coverStatus?.enabled);
    if (!filePath || contentType !== 'markdown' || !generationEnabled) return;
    setCoverMenuOpen(false);
    setCoverBusy(true);
    try {
      const executorAgentId = generationStatus.executorAgentId || coverStatus?.agentId || undefined;
      const result = await requestMarkdownCoverGeneration({ filePath, executorAgentId });
      dispatchCoverNotice(
        result.ok ? '已创建 cover 后台任务。' : `Cover 生成失败：${result.error}`,
        result.ok ? 'success' : 'error',
      );
    } catch (err) {
      dispatchCoverNotice(`Cover 生成失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setCoverBusy(false);
    }
  }, [contentType, coverStatus, filePath]);

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
    setCoverGalleryOpen(true);
  }, []);

  const handleApplyPresetCover = useCallback(async (item: CoverGalleryItem) => {
    if (!filePath || contentType !== 'markdown') return;
    setCoverBusy(true);
    try {
      const result = await applyMarkdownCoverPreset({ filePath, presetId: item.id });
      dispatchCoverNotice(
        result.ok ? `已应用「${item.title}」为 cover。` : `Cover 应用失败：${result.error}`,
        result.ok ? 'success' : 'error',
      );
      if (result.ok) setCoverGalleryOpen(false);
    } catch (err) {
      dispatchCoverNotice(`Cover 应用失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setCoverBusy(false);
    }
  }, [contentType, filePath]);

  const visibleCoverGalleryItems = useMemo(
    () => COVER_GALLERY_ITEMS.filter(item => !brokenCoverGalleryIds.has(item.id)),
    [brokenCoverGalleryIds],
  );

  const systemCoverAvailable = Boolean(coverStatus?.systemCover?.available ?? coverStatus?.available);
  const agentGenerateStatus = coverStatus?.agentGenerate ?? {};
  const agentGenerateEnabled = Boolean(agentGenerateStatus.enabled ?? coverStatus?.enabled);
  const agentGenerateDisabledText = getAgentGenerateDisabledText(agentGenerateStatus);

  const handleCoverGalleryImageError = useCallback((itemId: string) => {
    setBrokenCoverGalleryIds((current) => {
      if (current.has(itemId)) return current;
      const next = new Set(current);
      next.add(itemId);
      return next;
    });
  }, []);

  const t = window.t ?? ((p: string) => p);

  return (
    <div className={styles.floatingActions} data-react-managed ref={floatingActionsRef}>
      <button className={styles.actionBtn} onClick={handleCopy}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
        <span>{copyLabel ?? t('attach.copy')}</span>
      </button>
      {contentType === 'markdown' && filePath && systemCoverAvailable && (
        <div className={styles.coverActionWrap} ref={coverMenuRef}>
          <Tooltip content="制作 cover" placement="bottom" align="end">
            {({ ref, ...tooltipProps }) => (
              <button
                ref={(node) => ref(node)}
                className={`${styles.actionBtn}${coverBusy ? ` ${styles.actionBtnBusy}` : ''}${coverMenuOpen ? ` ${styles.actionBtnActive}` : ''}`}
                onClick={() => setCoverMenuOpen(open => !open)}
                aria-label="制作 cover"
                disabled={coverBusy}
                {...tooltipProps}
              >
                <CoverPaletteIcon />
              </button>
            )}
          </Tooltip>
          {coverMenuOpen && (
            <div className={styles.coverMenu}>
              <Tooltip
                content={agentGenerateDisabledText}
                disabled={agentGenerateEnabled}
                placement="left"
                align="center"
              >
                {({ ref, ...tooltipProps }) => (
                  <span
                    className={styles.coverMenuTooltipAnchor}
                    ref={(node) => ref(node)}
                    {...tooltipProps}
                  >
                    <button
                      type="button"
                      onClick={handleGenerateCover}
                      disabled={coverBusy || !agentGenerateEnabled}
                    >
                      <span className={styles.coverMenuIcon}><GenerateCoverIcon /></span>
                      <span>Agent 生成</span>
                    </button>
                  </span>
                )}
              </Tooltip>
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
      {coverGalleryOpen && (
        <div className={styles.coverGalleryCard} role="dialog" aria-label="小花美术馆">
          <div className={styles.coverGalleryHeader}>
            <div>
              <div className={styles.coverGalleryTitle}>小花美术馆</div>
            </div>
            <button
              type="button"
              className={styles.coverGalleryClose}
              onClick={() => setCoverGalleryOpen(false)}
              aria-label="关闭小花美术馆"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M18 6L6 18" />
                <path d="M6 6l12 12" />
              </svg>
            </button>
          </div>
          <div className={styles.coverGalleryGrid}>
            {visibleCoverGalleryItems.map(item => (
              <button
                key={item.id}
                type="button"
                className={styles.coverGalleryItem}
                onClick={() => handleApplyPresetCover(item)}
                disabled={coverBusy}
                aria-label={item.title}
                title={item.title}
              >
                <span className={styles.coverGalleryThumb}>
                  <img
                    src={item.src}
                    alt=""
                    draggable={false}
                    loading="lazy"
                    decoding="async"
                    onError={() => handleCoverGalleryImageError(item.id)}
                  />
                </span>
                <span className={styles.coverGalleryName}>{item.title}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {showMarkdownPreviewToggle && (
        <Tooltip content={t(markdownPreviewActive ? 'preview.exitMarkdownPreview' : 'preview.markdownPreview')} placement="bottom" align="end">
          {({ ref, ...tooltipProps }) => (
            <button
              ref={(node) => ref(node)}
              className={`${styles.actionBtn}${markdownPreviewActive ? ` ${styles.actionBtnActive}` : ''}`}
              onClick={onToggleMarkdownPreview}
              aria-label={t('preview.markdownPreview')}
              {...tooltipProps}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </button>
          )}
        </Tooltip>
      )}
      <Tooltip content={t('common.screenshot')} placement="bottom" align="end">
        {({ ref, ...tooltipProps }) => (
          <button
            ref={(node) => ref(node)}
            className={styles.actionBtn}
            onClick={handleScreenshot}
            aria-label={t('common.screenshot')}
            {...tooltipProps}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
              <circle cx="12" cy="13" r="4" />
            </svg>
          </button>
        )}
      </Tooltip>
    </div>
  );
}
