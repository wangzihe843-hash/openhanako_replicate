/**
 * AssistantMessage — 助手消息，遍历 ContentBlock 按类型渲染
 */

import { memo, useCallback, useMemo, useState } from 'react';
import { StreamingMarkdownContent } from './StreamingMarkdownContent';
import { MoodBlock } from './MoodBlock';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolGroupBlock } from './ToolGroupBlock';
import { PluginCardBlock } from './PluginCardBlock';
import { SubagentCard } from './SubagentCard';
import { SettingsConfirmCard } from './SettingsConfirmCard';
import { MessageActions } from './MessageActions';
import { BLOCK_RENDERERS } from './block-renderers';
import { FileOutputActions } from './FileOutputActions';
const lazyScreenshot = () => import('../../utils/screenshot').then(m => m.takeScreenshot);
import type { ChatMessage, ContentBlock } from '../../stores/chat-types';
import { useStore } from '../../stores';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { openFilePreview, openSkillPreview } from '../../utils/file-preview';
import { openMediaViewerForRef } from '../../utils/open-media-viewer';
import { buildFileRefId, isImageOrSvgExt } from '../../utils/file-kind';
import { openPreview } from '../../stores/preview-actions';
import { selectIsStreamingSession, selectSelectedIdsBySession } from '../../stores/session-selectors';
import { extractSelectedTexts } from '../../utils/message-text';
import { AgentAvatar, resolveAgentDisplayInfo } from '../../utils/agent-display';
import styles from './Chat.module.css';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface Props {
  message: ChatMessage;
  showAvatar: boolean;
  sessionPath: string;
  agentId?: string | null;
  readOnly?: boolean;
  messageRef?: (element: HTMLDivElement | null) => void;
}

export const AssistantMessage = memo(function AssistantMessage({ message, showAvatar, sessionPath, agentId, readOnly = false, messageRef }: Props) {
  const agents = useStore(s => s.agents);
  const globalAgentName = useStore(s => s.agentName) || 'Hanako';
  const globalYuan = useStore(s => s.agentYuan) || 'hanako';
  const isStreaming = useStore(s => selectIsStreamingSession(s, sessionPath));
  const selectedIds = useStore(s => selectSelectedIdsBySession(s, sessionPath));
  const isSelected = selectedIds.includes(message.id);

  // Resolve agent identity from agentId prop; fall back to global values
  const displayInfo = resolveAgentDisplayInfo({
    id: agentId || null,
    agents,
    fallbackAgentName: globalAgentName,
    fallbackAgentYuan: globalYuan,
  });
  const displayName = displayInfo.displayName;
  const displayYuan = displayInfo.yuan || globalYuan;

  const blocks = useMemo(
    () => (message.blocks || []).filter(block => block.type !== 'session_confirmation' || block.surface !== 'input'),
    [message.blocks],
  );

  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    const ids = selectSelectedIdsBySession(useStore.getState(), sessionPath);
    let text: string;
    if (ids.length > 0) {
      text = extractSelectedTexts(sessionPath, ids);
    } else {
      const textBlocks = blocks.filter(
        (b): b is ContentBlock & { type: 'text' } => b.type === 'text'
      );
      if (textBlocks.length === 0) return;
      // eslint-disable-next-line no-restricted-syntax
      const tmp = document.createElement('div');
      tmp.innerHTML = textBlocks.map(b => b.html).join('\n');
      text = tmp.innerText.trim();
    }
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }, [blocks, sessionPath]);

  const handleScreenshot = useCallback(async () => {
    const fn = await lazyScreenshot();
    fn(message.id, sessionPath);
  }, [message.id, sessionPath]);

  return (
    <div className={`${styles.messageGroup} ${styles.messageGroupAssistant}${isSelected ? ` ${styles.messageGroupSelected}` : ''}`}
         ref={messageRef}
         data-message-id={message.id}>
      {showAvatar && (
        <div className={styles.avatarRow}>
          <AgentAvatar
            info={displayInfo}
            className={`${styles.avatar} ${styles.hanaAvatar}`}
            alt={displayName}
          />
          <span className={styles.avatarName}>{displayName}</span>
        </div>
      )}
      <div className={`${styles.message} ${styles.messageAssistant}`}>
        {blocks.map((block, i) => (
          <ContentBlockView
            key={`block-${i}`}
            block={block}
            agentName={displayName}
            agentId={agentId}
            yuan={displayYuan}
            sessionPath={sessionPath}
            messageId={message.id}
            blockIdx={i}
            isStreaming={isStreaming}
          />
        ))}
      </div>
      {!readOnly && (
        <MessageActions
          messageId={message.id}
          sessionPath={sessionPath}
          onCopy={handleCopy}
          onScreenshot={handleScreenshot}
          copied={copied}
          isStreaming={isStreaming}
        />
      )}
    </div>
  );
});

// ── ContentBlock 分发 ──

const ContentBlockView = memo(function ContentBlockView({ block, agentName, agentId, yuan: _yuan, sessionPath, messageId, blockIdx, isStreaming }: {
  block: ContentBlock;
  agentName: string;
  agentId?: string | null;
  yuan: string;
  sessionPath: string;
  messageId: string;
  blockIdx: number;
  isStreaming: boolean;
}) {
  switch (block.type) {
    case 'thinking':
      return <ThinkingBlock content={block.content} sealed={block.sealed} />;
    case 'mood':
      return <MoodBlock yuan={block.yuan} text={block.text} />;
    case 'tool_group':
      return <ToolGroupBlock tools={block.tools} collapsed={block.collapsed} agentName={agentName} />;
    case 'text':
      return <StreamingMarkdownContent html={block.html} source={block.source} active={isStreaming} />;
    case 'file':
      return (
        <FileBlock
          block={block}
          sessionPath={sessionPath}
          messageId={messageId}
          blockIdx={blockIdx}
        />
      );
    case 'screenshot':
      return (
        <ScreenshotBlock
          block={block}
          sessionPath={sessionPath}
          messageId={messageId}
          blockIdx={blockIdx}
        />
      );
    default: {
      const Renderer = BLOCK_RENDERERS[block.type];
      return Renderer ? <Renderer block={block} agentId={agentId} /> : null;
    }
  }
});

// ── 简单子块组件（物种 B，统一接受 { block: any }） ──

const EXT_LABELS: Record<string, string> = {
  pdf: 'PDF', doc: 'Word', docx: 'Word', xls: 'Excel', xlsx: 'Excel',
  ppt: 'Presentation', pptx: 'Presentation', md: 'Markdown', txt: 'Text',
  html: 'HTML', htm: 'HTML', css: 'Stylesheet', json: 'JSON', yaml: 'YAML', yml: 'YAML',
  js: 'JavaScript', ts: 'TypeScript', jsx: 'React', tsx: 'React',
  py: 'Python', rs: 'Rust', go: 'Go', java: 'Java', rb: 'Ruby', php: 'PHP',
  c: 'C', cpp: 'C++', h: 'Header', sh: 'Shell', sql: 'SQL', xml: 'XML',
  csv: 'CSV', svg: 'SVG', skill: 'Skill',
  png: 'Image', jpg: 'Image', jpeg: 'Image', gif: 'Image', webp: 'Image',
};

// file / image block

interface FileBlockCtx {
  sessionPath: string;
  messageId: string;
  blockIdx: number;
}

const ImageOutputCard = memo(function ImageOutputCard({ filePath, label, ext, status, ctx }: { filePath: string; label: string; ext: string; status?: string; ctx: FileBlockCtx }) {
  const [failed, setFailed] = useState(false);
  const displayName = label || filePath.split('/').pop() || filePath;

  if (status === 'expired') return <FileOutputCard filePath={filePath} label={label} ext={ext} status={status} ctx={ctx} />;
  if (failed) return <FileOutputCard filePath={filePath} label={label} ext={ext} status={status} ctx={ctx} />;

  return (
    <div
      className={styles.imageOutputCard}
      onClick={() => openFilePreview(filePath, label, ext, {
        origin: 'session',
        sessionPath: ctx.sessionPath,
        messageId: ctx.messageId,
        blockIdx: ctx.blockIdx,
      })}
      style={{ cursor: 'pointer' }}
    >
      <img
        src={window.platform?.getFileUrl?.(filePath) ?? ''}
        alt={displayName}
        className={styles.imageOutputPreview}
        onError={() => setFailed(true)}
        draggable={false}
      />
    </div>
  );
});

const FileOutputCard = memo(function FileOutputCard({ filePath, label, ext, status, ctx }: { filePath: string; label: string; ext: string; status?: string; ctx: FileBlockCtx }) {
  const expired = status === 'expired';
  const expiredLabel = window.t('chat.fileExpired');
  const handlePreview = () => {
    if (expired) return;
    openFilePreview(filePath, label, ext, {
      origin: 'session',
      sessionPath: ctx.sessionPath,
      messageId: ctx.messageId,
      blockIdx: ctx.blockIdx,
    });
  };

  const displayName = label || filePath.split('/').pop() || filePath;
  const typeLabel = expired ? expiredLabel : (EXT_LABELS[ext] || ext.toUpperCase());

  return (
    <div
      className={`${styles.fileOutputCard}${expired ? ` ${styles.fileOutputExpired}` : ` ${styles.fileOutputPreviewable}`}`}
      onClick={handlePreview}
      style={{ cursor: expired ? 'default' : 'pointer' }}
      aria-disabled={expired}
    >
      <div className={styles.fileOutputIcon}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
      </div>
      <div className={styles.fileOutputInfo}>
        <div className={styles.fileOutputName}>{displayName}</div>
        <div className={styles.fileOutputType}>
          {typeLabel}{!expired && ext ? ` \u00b7 ${ext.toUpperCase()}` : ''}
        </div>
      </div>
      {!expired && (
        <FileOutputActions filePath={filePath} displayName={displayName} />
      )}
    </div>
  );
});

const FileBlock = memo(function FileBlock({ block, sessionPath, messageId, blockIdx }: {
  block: any;
  sessionPath: string;
  messageId: string;
  blockIdx: number;
}) {
  const ctx: FileBlockCtx = { sessionPath, messageId, blockIdx };
  // 扩展名识别统一走中心表（inferKindByExt via isImageOrSvgExt）
  return isImageOrSvgExt(block.ext)
    ? <ImageOutputCard filePath={block.filePath} label={block.label} ext={block.ext} status={block.status} ctx={ctx} />
    : <FileOutputCard filePath={block.filePath} label={block.label} ext={block.ext} status={block.status} ctx={ctx} />;
});

// COMPAT(create_artifact, remove no earlier than v0.133):
// Old sessions may still contain `artifact` content blocks. New preview
// surface consumes them as PreviewItem records.

const LegacyArtifactBlock = memo(function LegacyArtifactBlock({ block }: { block: any }) {
  const handleClick = () => {
    const previewItem = {
      id: block.artifactId,
      type: block.artifactType,
      title: block.title,
      content: block.content,
      language: block.language,
      fileId: block.fileId,
      filePath: block.filePath,
      ext: block.ext,
      mime: block.mime,
      kind: block.kind,
      storageKind: block.storageKind,
      status: block.status,
      missingAt: block.missingAt,
    };
    openPreview(previewItem);
  };
  const expired = block.status === 'expired';

  return (
    <div className={styles.legacyArtifactCard} onClick={handleClick} style={{ cursor: 'pointer' }}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
        <line x1="3" y1="9" x2="21" y2="9" />
      </svg>
      <span>{block.title || block.artifactType}</span>
      {expired && <span className={styles.legacyArtifactExpiredBadge}>{window.t('chat.fileExpired')}</span>}
    </div>
  );
});

// plugin_card block

const PluginCardWrapper = memo(function PluginCardWrapper({ block, agentId }: { block: any; agentId?: string | null }) {
  return <PluginCardBlock card={block.card} agentId={agentId} />;
});

// screenshot block

const ScreenshotBlock = memo(function ScreenshotBlock({ block, sessionPath, messageId, blockIdx }: {
  block: any;
  sessionPath: string;
  messageId: string;
  blockIdx: number;
}) {
  // screenshot 无 path 但 id 由 buildFileRefId 生成，与 selectSessionFiles 一致，能命中 session 图片序列
  const handleClick = () => {
    const id = buildFileRefId({
      source: 'session-block-screenshot',
      sessionPath,
      messageId,
      blockIdx,
      path: '',
    });
    openMediaViewerForRef({
      id,
      kind: 'image',
      source: 'session-block-screenshot',
      name: `screenshot-${messageId}-${blockIdx}.png`,
      path: '',
      mime: block.mimeType,
      sessionMessageId: messageId,
      inlineData: { base64: block.base64, mimeType: block.mimeType },
    }, { origin: 'session', sessionPath });
  };

  return (
    <div className={styles.browserScreenshot} onClick={handleClick} style={{ cursor: 'pointer' }}>
      <img src={`data:${block.mimeType};base64,${block.base64}`} alt={window.t('chat.browserScreenshot')} />
    </div>
  );
});

// skill block

const SkillBlock = memo(function SkillBlock({ block }: { block: any }) {
  const skillFilePath = typeof block.installedSkillSource?.filePath === 'string'
    ? block.installedSkillSource.filePath
    : block.skillFilePath;
  return (
    <div className={styles.skillCard} onClick={() => openSkillPreview(block.skillName, skillFilePath)} style={{ cursor: 'pointer' }}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2L2 7l10 5 10-5-10-5z" />
        <path d="M2 17l10 5 10-5" />
        <path d="M2 12l10 5 10-5" />
      </svg>
      <span>{block.skillName}</span>
    </div>
  );
});

// cron_confirm block

const CronConfirmBlock = memo(function CronConfirmBlock({ block }: { block: any }) {
  const [status, setStatus] = useState(block.status);
  const label = (block.jobData.label as string) || (block.jobData.prompt as string)?.slice(0, 40) || '';

  const handleApprove = async () => {
    try {
      if (block.confirmId) {
        await hanaFetch(`/api/confirm/${block.confirmId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'confirmed' }),
        });
      } else {
        await hanaFetch('/api/desk/cron', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'add', ...block.jobData }),
        });
      }
      setStatus('approved');
    } catch { /* silent */ }
  };

  const handleReject = async () => {
    if (block.confirmId) {
      try {
        await hanaFetch(`/api/confirm/${block.confirmId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'rejected' }),
        });
      } catch { /* silent */ }
    }
    setStatus('rejected');
  };

  if (status !== 'pending') {
    return (
      <div className={styles.cronConfirmCard}>
        <div className={styles.cronConfirmTitle}>{label}</div>
        <div className={`${styles.cronConfirmStatus} ${status === 'approved' ? styles.cronConfirmStatusApproved : styles.cronConfirmStatusRejected}`}>
          {status === 'approved' ? window.t('common.approved') : window.t('common.rejected')}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.cronConfirmCard}>
      <div className={styles.cronConfirmTitle}>{label}</div>
      <div className={styles.cronConfirmActions}>
        <button className={`${styles.cronConfirmBtn} ${styles.cronConfirmBtnApprove}`} onClick={handleApprove}>{window.t('common.approve')}</button>
        <button className={`${styles.cronConfirmBtn} ${styles.cronConfirmBtnReject}`} onClick={handleReject}>{window.t('common.reject')}</button>
      </div>
    </div>
  );
});

// settings_confirm block

const SettingsConfirmBlock = memo(function SettingsConfirmBlock({ block }: { block: any }) {
  return <SettingsConfirmCard {...block} />;
});

// ── 注册所有物种 B 渲染器 ──
// 注：`file` 与 `screenshot` 需 session 上下文（sessionPath/messageId/blockIdx），
// 统一走 ContentBlockView 的 switch 内联分发，不注册到全局表中。
BLOCK_RENDERERS['subagent'] = SubagentCard;
BLOCK_RENDERERS['artifact'] = LegacyArtifactBlock;
BLOCK_RENDERERS['plugin_card'] = PluginCardWrapper;
BLOCK_RENDERERS['skill'] = SkillBlock;
BLOCK_RENDERERS['cron_confirm'] = CronConfirmBlock;
BLOCK_RENDERERS['settings_confirm'] = SettingsConfirmBlock;
