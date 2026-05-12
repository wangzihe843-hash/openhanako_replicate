import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  loadAgentPinnedMemory,
  pinnedListContainsNormalizedContent,
  subscribeAgentPinnedMemoryChanged,
} from '../agent-pinned-memory';
import { hanaFetch } from '../hooks/use-hana-fetch';
import { useStore } from '../stores';
import { useSettingsStore } from '../settings/store';
import {
  confirmXingyeMemoryCandidate,
  formatMemoryCandidateImportanceLabel,
  importanceLevelFromNumber,
  importanceNumberFromLevel,
  rejectXingyeMemoryCandidate,
  type XingyeMemoryCandidate,
  type XingyeMemoryCandidateImportanceLevel,
  type XingyeMemoryCandidateStatus,
  updateXingyeMemoryCandidate,
  useXingyeMemoryCandidates,
  XINGYE_MEMORY_CANDIDATE_IMPORTANCE_UI_OPTIONS,
} from './xingye-memory-candidate-store';
import {
  getXingyeMemoryCandidateConfirmBlockedReason,
  getXingyeMemoryTargetDescription,
  getXingyeMemoryTargetLabel,
  isXingyeMemoryTargetWritable,
} from './xingye-memory-target-policy';
import styles from './XingyeShell.module.css';

type StatusFilter = XingyeMemoryCandidateStatus | 'all';

function statusLabel(s: XingyeMemoryCandidateStatus): string {
  if (s === 'pending') return '待定';
  if (s === 'rejected') return '已拒绝';
  return '已写入';
}

function formatTs(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

interface MemoryCandidatePanelProps {
  agentId: string | null;
  /** 写入目标助手展示名（与 agentId 对应） */
  agentName?: string | null;
}

export function MemoryCandidatePanel({ agentId, agentName }: MemoryCandidatePanelProps) {
  const candidates = useXingyeMemoryCandidates(agentId);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [flash, setFlash] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [remotePins, setRemotePins] = useState<string[] | null>(null);
  const [remotePinsError, setRemotePinsError] = useState<string | null>(null);

  const currentAgentId = useStore(s => s.currentAgentId);
  const currentChatAgentName = useStore(s => s.agentName);
  const settingsViewingId = useSettingsStore(s => s.settingsAgentId || s.currentAgentId);
  const settingsReady = useSettingsStore(s => s.ready);

  const writeTargetLabel = agentName?.trim() ? `${agentName.trim()} / ${agentId}` : (agentId ?? '');

  const reloadRemotePins = useCallback(async () => {
    if (!agentId) return;
    setRemotePinsError(null);
    try {
      const pins = await loadAgentPinnedMemory(agentId, hanaFetch);
      setRemotePins(pins);
    } catch (e) {
      setRemotePins(null);
      setRemotePinsError(e instanceof Error ? e.message : String(e));
    }
  }, [agentId]);

  useEffect(() => {
    if (!agentId) {
      setRemotePins(null);
      setRemotePinsError(null);
      return;
    }
    void reloadRemotePins();
  }, [agentId, reloadRemotePins]);

  useEffect(() => {
    if (!agentId) return;
    return subscribeAgentPinnedMemoryChanged((detail) => {
      if (detail.agentId !== agentId) return;
      void reloadRemotePins();
    });
  }, [agentId, reloadRemotePins]);

  const filtered = useMemo(() => {
    if (filter === 'all') return candidates;
    return candidates.filter((c) => c.status === filter);
  }, [candidates, filter]);

  const showFlash = useCallback((msg: string) => {
    setFlash(msg);
    window.setTimeout(() => setFlash(null), 5000);
  }, []);

  const chatMismatch = !!agentId && !!currentAgentId && agentId !== currentAgentId;
  const settingsMismatch =
    !!agentId &&
    !!settingsViewingId &&
    settingsViewingId !== agentId &&
    settingsReady;

  if (!agentId) {
    return (
      <p className={styles.secretSpacePlaceholder} data-testid="memory-candidate-panel-empty">
        请选择角色后管理重要记忆候选。
      </p>
    );
  }

  return (
    <div className={styles.detailSection} data-testid="memory-candidate-panel">
      <h4 className={styles.detailSectionTitle}>重要记忆候选</h4>
      <p className={styles.secretSpacePlaceholder} style={{ marginTop: 0 }} data-testid="memory-candidate-write-target">
        将写入 OpenHanako 置顶记忆（pinned）目标：<strong>{writeTargetLabel}</strong>
      </p>
      {chatMismatch ? (
        <p className={styles.secretSpacePlaceholder} style={{ marginTop: 0 }} role="status">
          当前 OpenHanako 聊天助手为「{currentChatAgentName}」；与上述写入目标不同。设置页默认展示当前助手时，请切换到写入目标对应的助手卡片后再查看「置顶记忆」。
        </p>
      ) : null}
      {settingsMismatch ? (
        <p className={styles.secretSpacePlaceholder} style={{ marginTop: 0 }} role="status">
          若设置页正在浏览其他助手，需切换到与写入目标相同的助手后才能看到这条置顶记忆。
        </p>
      ) : null}
      {remotePinsError ? (
        <p className={styles.saveStatus} role="alert">
          无法与服务器对账 pinned：{remotePinsError}
        </p>
      ) : null}
      <div className={styles.profileForm}>
        <label className={styles.profileField}>
          <span>按状态筛选</span>
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as StatusFilter)}
            aria-label="筛选候选状态"
          >
            <option value="all">全部</option>
            <option value="pending">待定</option>
            <option value="rejected">已拒绝</option>
            <option value="written">已写入</option>
          </select>
        </label>
        {flash ? (
          <p className={styles.saveStatus} role="status" data-testid="memory-candidate-flash">
            {flash}
          </p>
        ) : null}
        {filtered.length === 0 ? (
          <p className={styles.secretSpacePlaceholder}>暂无候选。</p>
        ) : (
          <ul className={styles.secretSpaceRecordList} style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {filtered.map((c) => (
              <MemoryCandidateCard
                key={c.id}
                agentId={agentId}
                writeTargetLabel={writeTargetLabel}
                candidate={c}
                busy={busyId === c.id}
                remotePins={remotePins}
                onBusy={(id) => setBusyId(id)}
                onFlash={showFlash}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function MemoryCandidateCard({
  agentId,
  writeTargetLabel,
  candidate: c,
  busy,
  remotePins,
  onBusy,
  onFlash,
}: {
  agentId: string;
  writeTargetLabel: string;
  candidate: XingyeMemoryCandidate;
  busy: boolean;
  remotePins: string[] | null;
  onBusy: (id: string | null) => void;
  onFlash: (msg: string) => void;
}) {
  const [draftContent, setDraftContent] = useState(c.content);
  const [draftReason, setDraftReason] = useState(c.reason ?? '');
  const [draftLevel, setDraftLevel] = useState<XingyeMemoryCandidateImportanceLevel>(() =>
    importanceLevelFromNumber(c.importance),
  );

  useEffect(() => {
    setDraftContent(c.content);
    setDraftReason(c.reason ?? '');
    setDraftLevel(importanceLevelFromNumber(c.importance));
  }, [c.id, c.content, c.reason, c.importance, c.updatedAt]);

  const canEdit = c.status === 'pending';
  const targetWritable = isXingyeMemoryTargetWritable(c.target);
  const canConfirm = c.status === 'pending' && targetWritable;
  const confirmBlockedReason =
    c.status === 'pending' && !targetWritable ? getXingyeMemoryCandidateConfirmBlockedReason(c.target) : '';

  const writtenButMissingFromPinned =
    c.status === 'written' &&
    remotePins !== null &&
    !pinnedListContainsNormalizedContent(remotePins, c.content);

  const handleSaveEdits = () => {
    if (!canEdit) return;
    try {
      updateXingyeMemoryCandidate(agentId, c.id, {
        content: draftContent,
        reason: draftReason.trim() || undefined,
        importance: importanceNumberFromLevel(draftLevel),
      });
      onFlash('已保存修改。');
    } catch (e) {
      onFlash(e instanceof Error ? e.message : String(e));
    }
  };

  const handleReject = async () => {
    if (!canEdit) return;
    onBusy(c.id);
    try {
      rejectXingyeMemoryCandidate(agentId, c.id);
      onFlash('已拒绝该候选。');
    } catch (e) {
      onFlash(e instanceof Error ? e.message : String(e));
    } finally {
      onBusy(null);
    }
  };

  const handleConfirm = async () => {
    if (!canConfirm) return;
    onBusy(c.id);
    try {
      const { alreadyInPinned } = await confirmXingyeMemoryCandidate(agentId, c.id);
      onFlash(
        alreadyInPinned
          ? `pinned 中已有相同内容；已标记为已写入。（目标：${writeTargetLabel}）`
          : `已成功写入 OpenHanako pinned。（目标：${writeTargetLabel}）`,
      );
    } catch (e) {
      onFlash(e instanceof Error ? e.message : String(e));
    } finally {
      onBusy(null);
    }
  };

  return (
    <li
      className={styles.secretSpaceRecordItem}
      style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}
      data-testid={`memory-candidate-row-${c.id}`}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'baseline' }}>
        <strong data-testid={`memory-candidate-status-${c.id}`}>{statusLabel(c.status)}</strong>
        {writtenButMissingFromPinned ? (
          <span className={styles.secretSpaceRecordMeta} data-testid={`memory-candidate-pinned-stale-${c.id}`}>
            已从 pinned 移除
          </span>
        ) : null}
        <span
          className={styles.secretSpaceRecordMeta}
          title={getXingyeMemoryTargetDescription(c.target)}
          data-testid={`memory-candidate-target-${c.id}`}
        >
          目标 {getXingyeMemoryTargetLabel(c.target)}
        </span>
        <span className={styles.secretSpaceRecordMeta}>
          重要度 {formatMemoryCandidateImportanceLabel(c.importance)}
        </span>
        {c.sourceDomain ? (
          <span className={styles.secretSpaceRecordMeta}>来源 {c.sourceDomain}</span>
        ) : null}
      </div>
      {writtenButMissingFromPinned ? (
        <p className={styles.secretSpacePlaceholder} style={{ margin: 0 }} data-testid={`memory-candidate-stale-note-${c.id}`}>
          已写入过，但当前 OpenHanako pinned 中已不存在该条内容；不会自动写回。若仍需置顶，请重新确认写入。
        </p>
      ) : null}
      {confirmBlockedReason ? (
        <p className={styles.secretSpacePlaceholder} style={{ margin: 0 }} data-testid={`memory-candidate-blocked-${c.id}`}>
          {confirmBlockedReason}
        </p>
      ) : null}
      {canEdit ? (
        <>
          <label className={styles.profileField}>
            <span>内容</span>
            <textarea
              value={draftContent}
              onChange={(e) => setDraftContent(e.target.value)}
              rows={3}
              aria-label="候选记忆内容"
            />
          </label>
          <label className={styles.profileField}>
            <span>理由</span>
            <textarea
              value={draftReason}
              onChange={(e) => setDraftReason(e.target.value)}
              rows={2}
              aria-label="候选记忆理由"
            />
          </label>
          <label className={styles.profileField}>
            <span>重要度</span>
            <select
              value={draftLevel}
              onChange={(e) => setDraftLevel(e.target.value as XingyeMemoryCandidateImportanceLevel)}
              aria-label="候选记忆重要度"
            >
              {XINGYE_MEMORY_CANDIDATE_IMPORTANCE_UI_OPTIONS.map((opt) => (
                <option key={opt.level} value={opt.level}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <button type="button" className={styles.secondaryButton} onClick={handleSaveEdits} disabled={busy}>
              保存修改
            </button>
            <button type="button" className={styles.secondaryButton} onClick={handleReject} disabled={busy}>
              拒绝
            </button>
            {canConfirm ? (
              <button type="button" className={styles.secondaryButton} onClick={handleConfirm} disabled={busy}>
                确认写入
              </button>
            ) : null}
          </div>
        </>
      ) : (
        <>
          <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{c.content}</p>
          {c.reason ? <p className={styles.secretSpacePlaceholder} style={{ margin: 0 }}>理由：{c.reason}</p> : null}
        </>
      )}
      <div className={styles.secretSpaceRecordMeta} style={{ fontSize: '0.75rem' }}>
        创建 {formatTs(c.createdAt)} · 更新 {formatTs(c.updatedAt)}
        {c.writtenAt ? ` · 写入 ${formatTs(c.writtenAt)}` : ''}
      </div>
    </li>
  );
}
