/**
 * WorkflowInlineCard — 聊天流里的 workflow 概览块（信息架构：inline 只给「大概状态」）
 *
 * 聊天流里只显示 workflow 名、终态耗时和状态，不订阅 streamKey、不展开实时流。
 * 详细节点分布在右侧 WorkflowCard。
 */
import { memo } from 'react';
import { formatElapsed } from '../../utils/format-duration';
import { ChatResourceCard } from './ChatResourceCard';
import { WorkflowResourceIcon } from './ChatResourceIcons';

interface WorkflowInlineCardProps {
  block: {
    taskId: string;
    taskTitle: string;
    streamStatus: 'running' | 'done' | 'failed' | 'aborted';
    summary?: string;
    startedAt?: number | null;
    finishedAt?: number | null;
  };
}

const STATUS_LABEL: Record<string, string> = {
  running: '◐ 运行中',
  done: '✓ 已完成',
  failed: '✗ 失败',
  aborted: '⊘ 已终止',
};

const STATUS_TONE = {
  running: 'accent',
  done: 'success',
  failed: 'danger',
  aborted: 'muted',
} as const;

function statusTone(status: WorkflowInlineCardProps['block']['streamStatus']) {
  return STATUS_TONE[status] ?? 'neutral';
}

function statusLabel(status: WorkflowInlineCardProps['block']['streamStatus']) {
  return STATUS_LABEL[status] ?? status;
}

export const WorkflowInlineCard = memo(function WorkflowInlineCard({ block }: WorkflowInlineCardProps) {
  const t: (k: string, v?: Record<string, string | number>) => string = window.t ?? ((k: string) => k);
  let duration = '';
  if (block.finishedAt && block.startedAt) {
    duration = t('activity.duration', { text: formatElapsed(block.finishedAt - block.startedAt) });
  }

  return (
    <ChatResourceCard
      icon={<WorkflowResourceIcon />}
      title={block.taskTitle || t('rightWorkspace.workflow.title')}
      subtitle={duration || block.summary || 'Workflow'}
      statusLabel={statusLabel(block.streamStatus)}
      statusTone={statusTone(block.streamStatus)}
    />
  );
});
