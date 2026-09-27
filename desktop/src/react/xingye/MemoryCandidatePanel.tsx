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
  sceneSummaryContent,
  setXingyeSceneCandidateValidity,
  type XingyeMemoryCandidate,
  type XingyeMemoryCandidateImportanceLevel,
  type XingyeMemoryCandidateStatus,
  type XingyeSceneSection,
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

/** 角章上的楷书 glyph —— 让状态视觉化为一枚印。 */
function stampGlyph(s: XingyeMemoryCandidateStatus): string {
  if (s === 'pending') return '候';
  if (s === 'rejected') return '弃';
  return '收';
}

function formatTs(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

const FILTER_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'pending', label: '待定' },
  { value: 'written', label: '已写入' },
  { value: 'rejected', label: '已拒绝' },
];

interface MemoryCandidatePanelProps {
  agentId: string | null;
  /** 写入目标助手展示名（与 agentId 对应） */
  agentName?: string | null;
  onNavigateSceneSource?: (sessionId: string, entryId: string) => Promise<void>;
}

export function MemoryCandidatePanel({ agentId, agentName, onNavigateSceneSource }: MemoryCandidatePanelProps) {
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
  const hasPinnedCandidates = candidates.some(candidate => candidate.target === 'pinned');

  const reloadRemotePins = useCallback(async () => {
    if (!agentId || !hasPinnedCandidates) return;
    setRemotePinsError(null);
    try {
      const pins = await loadAgentPinnedMemory(agentId, hanaFetch);
      setRemotePins(pins);
    } catch (e) {
      setRemotePins(null);
      setRemotePinsError(e instanceof Error ? e.message : String(e));
    }
  }, [agentId, hasPinnedCandidates]);

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

  const counts = useMemo(() => {
    const acc = { all: candidates.length, pending: 0, written: 0, rejected: 0 };
    for (const c of candidates) {
      acc[c.status] += 1;
    }
    return acc;
  }, [candidates]);

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
    <section className={styles.memoryCandidatePanel} data-testid="memory-candidate-panel">
      <header className={styles.memoryCandidateHeader}>
        <p className={styles.memoryCandidateKicker}>OPENHANAKO · REVIEW</p>
        <h4 className={styles.memoryCandidateTitle}>重要记忆与场景候选</h4>
        <p className={styles.memoryCandidateWriteTarget} data-testid="memory-candidate-write-target">
          <span className={styles.memoryCandidateWriteTargetArrow}>↳ 当前角色</span>
          <span className={styles.memoryCandidateWriteTargetChip}>{writeTargetLabel}</span>
        </p>
        {hasPinnedCandidates && chatMismatch ? (
          <p className={styles.memoryCandidateNotice} role="status">
            当前 OpenHanako 聊天助手为「{currentChatAgentName}」；与上述写入目标不同。设置页默认展示当前助手时，请切换到写入目标对应的助手卡片后再查看「置顶记忆」。
          </p>
        ) : null}
        {hasPinnedCandidates && settingsMismatch ? (
          <p className={styles.memoryCandidateNotice} role="status">
            若设置页正在浏览其他助手，需切换到与写入目标相同的助手后才能看到这条置顶记忆。
          </p>
        ) : null}
        {hasPinnedCandidates && remotePinsError ? (
          <p className={styles.memoryCandidateError} role="alert">
            无法与服务器对账 pinned：{remotePinsError}
          </p>
        ) : null}
      </header>

      <div className={styles.memoryCandidateFilters} role="group" aria-label="状态筛选">
        {FILTER_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            className={styles.memoryCandidateFilterChip}
            data-active={filter === opt.value}
            onClick={() => setFilter(opt.value)}
          >
            <span>{opt.label}</span>
            <span className={styles.memoryCandidateFilterCount}>{counts[opt.value]}</span>
          </button>
        ))}
        <select
          className={styles.memoryCandidateSrOnlySelect}
          value={filter}
          onChange={(e) => setFilter(e.target.value as StatusFilter)}
          aria-label="筛选候选状态"
          tabIndex={-1}
        >
          <option value="all">全部</option>
          <option value="pending">待定</option>
          <option value="rejected">已拒绝</option>
          <option value="written">已写入</option>
        </select>
      </div>

      {flash ? (
        <p className={styles.memoryCandidateFlash} role="status" data-testid="memory-candidate-flash">
          {flash}
        </p>
      ) : null}

      {filtered.length === 0 ? (
        <p className={styles.memoryCandidateEmpty}>暂无候选 · 这里会安静地等你新的「重要」。</p>
      ) : (
        <ul className={styles.memoryCandidateStack}>
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
              onNavigateSceneSource={onNavigateSceneSource}
            />
          ))}
        </ul>
      )}
    </section>
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
  onNavigateSceneSource,
}: {
  agentId: string;
  writeTargetLabel: string;
  candidate: XingyeMemoryCandidate;
  busy: boolean;
  remotePins: string[] | null;
  onBusy: (id: string | null) => void;
  onFlash: (msg: string) => void;
  onNavigateSceneSource?: (sessionId: string, entryId: string) => Promise<void>;
}) {
  const [draftContent, setDraftContent] = useState(c.content);
  const [draftReason, setDraftReason] = useState(c.reason ?? '');
  const [draftLevel, setDraftLevel] = useState<XingyeMemoryCandidateImportanceLevel>(() =>
    importanceLevelFromNumber(c.importance),
  );
  const [draftSections, setDraftSections] = useState<XingyeSceneSection[]>(c.sceneSummary?.sections ?? []);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);
  const sceneSectionsSignature = JSON.stringify(c.sceneSummary?.sections ?? []);
  const sceneSourcesSignature = JSON.stringify(c.sceneSummary?.sourceRefs ?? []);
  const sceneSessionId = c.sceneSummary?.sessionId;

  useEffect(() => {
    setDraftContent(c.content);
    setDraftReason(c.reason ?? '');
    setDraftLevel(importanceLevelFromNumber(c.importance));
    setDraftSections(JSON.parse(sceneSectionsSignature) as XingyeSceneSection[]);
  }, [c.id, c.content, c.reason, c.importance, sceneSectionsSignature]);

  useEffect(() => {
    if (!sceneSessionId) return;
    let active = true;
    setValidating(true);
    setValidationError(null);
    void (async () => {
      try {
        const response = await hanaFetch('/api/xingye/scene-summary/validate', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId,
            sessionId: sceneSessionId,
            sourceRefs: JSON.parse(sceneSourcesSignature),
            sections: JSON.parse(sceneSectionsSignature),
          }),
        });
        const data = await response.json();
        if (!response.ok) {
          if (active && response.status === 400 && /session|source|branch/i.test(String(data?.error || ''))) {
            setXingyeSceneCandidateValidity(agentId, c.id, 'stale');
          }
          throw new Error(data?.error || '无法复核场景来源');
        }
        if (!active) return;
        setXingyeSceneCandidateValidity(agentId, c.id, data.valid === true ? 'valid' : 'stale');
        if (!data.valid) setValidationError(data.reason || '原消息已变化');
      } catch (error) {
        if (active) setValidationError(error instanceof Error ? error.message : String(error));
      } finally {
        if (active) setValidating(false);
      }
    })();
    return () => { active = false; };
  }, [agentId, c.id, sceneSessionId, sceneSourcesSignature, sceneSectionsSignature]);

  const canEdit = c.status === 'pending';
  const targetWritable = isXingyeMemoryTargetWritable(c.target);
  const sceneEditsDirty = !!c.sceneSummary && JSON.stringify(draftSections) !== JSON.stringify(c.sceneSummary.sections);
  const canConfirm = c.status === 'pending' && targetWritable
    && (!c.sceneSummary || (!sceneEditsDirty && !validating && !validationError && c.sceneSummary.validity === 'valid'));
  const confirmBlockedReason =
    c.status === 'pending' && !targetWritable ? getXingyeMemoryCandidateConfirmBlockedReason(c.target) : '';

  const writtenButMissingFromPinned =
    c.target === 'pinned' && c.status === 'written' &&
    remotePins !== null &&
    !pinnedListContainsNormalizedContent(remotePins, c.content);

  const importanceLevel = importanceLevelFromNumber(c.importance);

  const handleSaveEdits = () => {
    if (!canEdit) return;
    try {
      if (c.sceneSummary) {
        if (draftSections.length === 0) throw new Error('请保留至少一条场景条目');
        const sections = draftSections.filter(section => section.text.trim()).map(section => ({ ...section, text: section.text.trim() }));
        if (sections.length === 0) throw new Error('场景条目不能为空');
        updateXingyeMemoryCandidate(agentId, c.id, {
          content: sceneSummaryContent(sections),
          sceneSummary: { ...c.sceneSummary, sections, validity: 'unknown' },
        });
        onFlash('已保存场景修改，正在重新核对原消息。');
        return;
      }
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
        c.target === 'scene_archive'
          ? '场景摘要已采纳并保存在当前角色档案；不会自动进入对话上下文。'
          : alreadyInPinned
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
      className={styles.memoryCandidateSlip}
      data-status={c.status}
      data-testid={`memory-candidate-row-${c.id}`}
    >
      <div className={styles.memoryCandidateStamp} aria-hidden="true">
        {stampGlyph(c.status)}
      </div>

      <div className={styles.memoryCandidateSlipHead}>
        <strong
          className={styles.memoryCandidateStatusText}
          data-testid={`memory-candidate-status-${c.id}`}
        >
          {c.target === 'scene_archive' && c.status === 'written' ? '已采纳' : statusLabel(c.status)}
        </strong>
        {writtenButMissingFromPinned ? (
          <span
            className={styles.memoryCandidateChipWarn}
            data-testid={`memory-candidate-pinned-stale-${c.id}`}
          >
            已从 pinned 移除
          </span>
        ) : null}
        <span
          className={styles.memoryCandidateChip}
          title={getXingyeMemoryTargetDescription(c.target)}
          data-testid={`memory-candidate-target-${c.id}`}
        >
          目标 · {getXingyeMemoryTargetLabel(c.target)}
        </span>
        {c.sourceDomain ? (
          <span className={styles.memoryCandidateChip}>来源 · {c.sourceDomain === 'scene_summary' ? '场景摘要' : c.sourceDomain}</span>
        ) : null}
        {!c.sceneSummary ? <span className={styles.memoryCandidateImportance} title={`重要度：${formatMemoryCandidateImportanceLabel(c.importance)}`}>
          <span className={styles.memoryCandidateImportanceLabel}>重要度</span>
          <span className={styles.memoryCandidateImportanceTrack} data-level={importanceLevel}>
            <span /><span /><span />
          </span>
          <span className={styles.memoryCandidateImportanceText}>
            {formatMemoryCandidateImportanceLabel(c.importance)}
          </span>
        </span> : null}
      </div>

      {writtenButMissingFromPinned ? (
        <p
          className={styles.memoryCandidateStaleNote}
          data-testid={`memory-candidate-stale-note-${c.id}`}
        >
          已写入过，但当前 OpenHanako pinned 中已不存在该条内容；不会自动写回。若仍需置顶，请重新确认写入。
        </p>
      ) : null}
      {confirmBlockedReason ? (
        <p
          className={styles.memoryCandidateBlocked}
          data-testid={`memory-candidate-blocked-${c.id}`}
        >
          {confirmBlockedReason}
        </p>
      ) : null}

      {c.sceneSummary ? (
        <div className={styles.memoryCandidateForm} data-testid={`scene-summary-${c.id}`}>
          <p className={styles.memoryCandidateNotice}>原消息 {c.sceneSummary.sourceRefs.length} 条 · {validating ? '正在复核来源' : c.sceneSummary.validity === 'stale' ? '来源已失效' : c.sceneSummary.validity === 'valid' ? '来源已核对' : '待复核'}</p>
          {validationError ? <p role="alert" className={styles.memoryCandidateBlocked}>{validationError}</p> : null}
          {(canEdit ? draftSections : c.sceneSummary.sections).map((section, index) => (
            <div key={`${c.id}-${index}`} className={styles.memoryCandidateField}>
              <strong>{section.inference ? '推断 / 归纳' : '原文直证'}</strong>
              {canEdit ? (
                <>
                  <select aria-label={`场景条目 ${index + 1} 类别`} value={section.kind} onChange={event => setDraftSections(prev => prev.map((item, i) => i === index ? { ...item, kind: event.target.value as XingyeSceneSection['kind'], inference: true, evidence: [] } : item))}>
                    <option value="role">角色</option><option value="location">地点</option><option value="event">关键事件</option><option value="open_thread">未决事项</option>
                  </select>
                  <textarea aria-label={`场景条目 ${index + 1} 内容`} rows={2} value={section.text} onChange={event => setDraftSections(prev => prev.map((item, i) => i === index ? { ...item, text: event.target.value, inference: true, evidence: [] } : item))} />
                  <button type="button" onClick={() => setDraftSections(prev => prev.filter((_, i) => i !== index))}>移除条目</button>
                </>
              ) : <p>{section.text}</p>}
              {section.evidence.map(evidence => (
                <button key={`${evidence.entryId}-${evidence.quote}`} type="button" onClick={() => {
                  if (onNavigateSceneSource) void onNavigateSceneSource(c.sceneSummary!.sessionId, evidence.entryId).catch(error => onFlash(error instanceof Error ? error.message : String(error)));
                }} disabled={!onNavigateSceneSource} title="跳转到当前分支的原消息">
                  原文：{evidence.quote.slice(0, 120)} ↗
                </button>
              ))}
            </div>
          ))}
          {canEdit ? <button type="button" onClick={() => setDraftSections(prev => [...prev, { kind: 'event', text: '', inference: true, evidence: [] }])}>新增推断 / 归纳</button> : null}
        </div>
      ) : null}

      {canEdit && !c.sceneSummary ? (
        <div className={styles.memoryCandidateForm}>
          <label className={styles.memoryCandidateField}>
            <span>内容</span>
            <textarea
              value={draftContent}
              onChange={(e) => setDraftContent(e.target.value)}
              rows={3}
              aria-label="候选记忆内容"
            />
          </label>
          <label className={styles.memoryCandidateField}>
            <span>理由</span>
            <textarea
              value={draftReason}
              onChange={(e) => setDraftReason(e.target.value)}
              rows={2}
              aria-label="候选记忆理由"
            />
          </label>
          <label className={styles.memoryCandidateField}>
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
          <div className={styles.memoryCandidateActions}>
            <button
              type="button"
              className={styles.memoryCandidateAction}
              onClick={handleSaveEdits}
              disabled={busy}
            >
              保存修改
            </button>
            <button
              type="button"
              className={styles.memoryCandidateAction}
              onClick={handleReject}
              disabled={busy}
            >
              拒绝
            </button>
            {canConfirm ? (
              <button
                type="button"
                className={styles.memoryCandidateActionPrimary}
                onClick={handleConfirm}
                disabled={busy}
              >
                确认写入
              </button>
            ) : null}
          </div>
        </div>
      ) : !c.sceneSummary ? (
        <div className={styles.memoryCandidateBodyRead}>
          <p className={styles.memoryCandidateBody}>{c.content}</p>
          {c.reason ? <aside className={styles.memoryCandidateReason}>{c.reason}</aside> : null}
        </div>
      ) : c.status === 'pending' ? (
        <div className={styles.memoryCandidateActions}>
          <button type="button" className={styles.memoryCandidateAction} onClick={handleSaveEdits} disabled={busy}>保存场景修改</button>
          <button type="button" className={styles.memoryCandidateAction} onClick={() => void handleReject()} disabled={busy}>放弃</button>
          <button type="button" className={styles.memoryCandidateActionPrimary} onClick={() => void handleConfirm()} disabled={busy || !canConfirm}>采纳场景</button>
        </div>
      ) : null}

      <div className={styles.memoryCandidateFooter}>
        <span>创建 {formatTs(c.createdAt)}</span>
        <span className={styles.memoryCandidateFooterSep}>·</span>
        <span>更新 {formatTs(c.updatedAt)}</span>
        {c.writtenAt ? (
          <>
            <span className={styles.memoryCandidateFooterSep}>·</span>
            <span>{c.target === 'scene_archive' ? '采纳' : '写入'} {formatTs(c.writtenAt)}</span>
          </>
        ) : null}
      </div>
    </li>
  );
}
