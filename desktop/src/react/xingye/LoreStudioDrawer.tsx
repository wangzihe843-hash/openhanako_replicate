import { useEffect, useMemo, useRef, useState } from 'react';
import type { Agent } from '../types';
import styles from './LoreStudioDrawer.module.css';
import {
  listLoreEntries,
  useXingyeLoreEntries,
  XINGYE_LORE_CATEGORY_LABELS,
  type XingyeLoreCategory,
  type XingyeLoreInsertionMode,
} from './xingye-lore-store';
import { scanPeerUpgradeCandidates } from './lore-studio-peer';
import { createPeerAgent } from './lore-studio-peer-create';
import { getVirtualContacts } from './xingye-phone-store';
import { loadAgents } from '../settings/actions';
import {
  postLoreStudioTurn,
  toFineTuneEntries,
  toLoreAnchors,
  toWireTranscript,
  LoreStudioError,
} from './lore-studio-api';
import { applyLoreEntries, flattenProfilePatch } from './lore-studio-apply';
import { emptyStudioSession, loadStudioSession, saveStudioSession } from './lore-studio-session';
import {
  STUDIO_YUAN_OPTIONS,
  type StudioAppliedResult,
  type StudioMessage,
  type StudioPeerCandidate,
  type StudioPlanLoreEntry,
  type StudioPlanTurn,
  type StudioProfileField,
  type StudioQuestionsTurn,
  type StudioSession,
  type StudioYuanKey,
} from './lore-studio-types';

interface LoreStudioDrawerProps {
  agent: Agent;
  open: boolean;
  onClose: () => void;
  /** 当前面板里的（含未保存）人设值，给模型做接地 / 反推。 */
  displayName: string;
  relationshipLabel: string;
  shortBio: string;
  existingProfile: Record<string, unknown>;
  /** 确认写入后回传：lore 已落盘，人设补丁回填到面板表单。 */
  onApplied: (result: StudioAppliedResult) => void;
  /** 现有角色列表（用于 Phase 2 检测「哪些非 user 关系还没有对应角色」）。 */
  agents?: { id: string; name: string }[];
  /** 用户名（写 peer 关系模版时区分用户/peer/自己）。 */
  userName?: string;
  /** Phase 2：批量生成 peer 角色后跳转到第一个新角色的工坊。 */
  onJumpToAgent?: (agentId: string) => void;
}

// 强类型：少写一个字段的标签会在编译期报错（与 INSERTION_MODE_LABELS 同档，防将来加字段漏标签静默显英文）。
const PROFILE_FIELD_LABELS: Record<StudioProfileField, string> = {
  shortBio: '简介',
  identitySummary: '身份摘要',
  backgroundSummary: '背景摘要',
  personalitySummary: '人格摘要',
  behaviorLogic: '行为逻辑',
  values: '价值观',
  taboos: '禁忌',
  relationshipMode: '关系模式',
  speakingStyle: '说话风格',
};

const INSERTION_MODE_LABELS: Record<XingyeLoreInsertionMode, string> = {
  always: '常驻 (always)',
  keyword: '关键词 (keyword)',
  manual: '手动 (manual)',
};

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

type AnswerState = Record<string, { selected: string[]; custom: string }>;

export function LoreStudioDrawer({
  agent,
  open,
  onClose,
  displayName,
  relationshipLabel,
  shortBio,
  existingProfile,
  onApplied,
  agents = [],
  userName = '',
  onJumpToAgent,
}: LoreStudioDrawerProps) {
  const loreEntries = useXingyeLoreEntries(agent.id);

  const [session, setSession] = useState<StudioSession>(() => emptyStudioSession(agent.id));
  const [intro, setIntro] = useState('');
  const [composer, setComposer] = useState('');
  const [answers, setAnswers] = useState<AnswerState>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Phase 2：peer 升级建议 / 批量生成
  const [peerPhase, setPeerPhase] = useState<'none' | 'loading' | 'suggest' | 'creating' | 'done'>('none');
  const [peerSuggestions, setPeerSuggestions] = useState<StudioPeerCandidate[]>([]);
  const [peerSelected, setPeerSelected] = useState<Record<string, boolean>>({});
  const [peerError, setPeerError] = useState<string | null>(null);
  const [createdAgents, setCreatedAgents] = useState<{ agentId: string; name: string }[]>([]);

  const hydratedRef = useRef(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // 按当前 agent 加载会话；切 agent / 重新打开都会重载，各自记录不丢。
  useEffect(() => {
    if (!open || !agent?.id) return;
    let cancelled = false;
    hydratedRef.current = false;
    setError(null);
    setComposer('');
    setAnswers({});
    setPeerPhase('none');
    setPeerSuggestions([]);
    setPeerSelected({});
    setPeerError(null);
    setCreatedAgents([]);
    (async () => {
      let loaded: StudioSession | null;
      try {
        loaded = await loadStudioSession(agent.id);
      } catch (err) {
        if (cancelled) return;
        // 读失败（文件存在但损坏 / 传输错误）：**不**起空会话覆写真实记录。停在「未 hydrate」，
        // 此时持久化 effect 因 hydratedRef.current 仍为 false 不会 writeJson，磁盘上的旧会话得以保全。
        console.warn('[LoreStudioDrawer] load studio session failed:', err);
        setError('读取已保存的整理会话失败——为避免覆盖已存在的记录，本次不会自动保存。请关闭后重开，或检查存储连接。');
        return;
      }
      if (cancelled) return;
      const next = loaded ?? emptyStudioSession(agent.id);
      setSession(next);
      setIntro(next.backgroundStory ?? '');
      hydratedRef.current = true;
    })();
    return () => {
      cancelled = true;
    };
  }, [open, agent?.id]);

  // 持久化（hydrate 之后、有内容才写）。
  useEffect(() => {
    if (!open || !hydratedRef.current) return;
    if (!session.messages.length && !session.backgroundStory && !session.draftPlan) return;
    void saveStudioSession(session);
  }, [session, open]);

  // 新消息滚到底。
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [session.messages.length, loading]);

  const started = session.backgroundStory.trim() !== '' || session.messages.length > 0;

  const lastMessage = session.messages[session.messages.length - 1];
  const activeQuestions: StudioQuestionsTurn | null =
    lastMessage?.role === 'assistant' && lastMessage.turn.type === 'questions' ? lastMessage.turn : null;

  async function runTurn(opts: { userText?: string; backgroundStory?: string } = {}) {
    if (loading) return;
    setLoading(true);
    setError(null);

    const baseMessages = session.messages;
    const nextMessages: StudioMessage[] = opts.userText
      ? [...baseMessages, { id: newId(), role: 'user', text: opts.userText, createdAt: new Date().toISOString() }]
      : baseMessages;
    const backgroundStory = opts.backgroundStory ?? session.backgroundStory;

    // optimistic：先把用户消息 / 背景上屏
    setSession((s) => ({
      ...s,
      backgroundStory,
      phase: 'questioning',
      messages: nextMessages,
    }));
    setComposer('');
    setAnswers({});

    try {
      const peerContext = session.peerContext;
      const { turn } = await postLoreStudioTurn({
        agentId: agent.id,
        displayName,
        relationshipLabel,
        shortBio,
        currentYuan: agent.yuan,
        existingProfile,
        existingLoreAnchors: toLoreAnchors(loreEntries),
        backgroundStory,
        transcript: toWireTranscript(nextMessages),
        mode: 'extract',
        // peer 微调：刚分出来的新角色，把已带来的世界观/关系正文喂给模型据新背景改写。
        ...(peerContext ? { peerContext, fineTuneEntries: toFineTuneEntries(loreEntries) } : {}),
      });

      const assistantMsg: StudioMessage = { id: newId(), role: 'assistant', turn, createdAt: new Date().toISOString() };
      setSession((s) => ({
        ...s,
        messages: [...nextMessages, assistantMsg],
        phase: turn.type === 'plan' ? 'planning' : 'questioning',
        draftPlan: turn.type === 'plan' ? clonePlan(turn) : s.draftPlan,
      }));
    } catch (e) {
      const msg =
        e instanceof LoreStudioError
          ? e.message + (e.raw ? `（模型返回：${e.raw.slice(0, 120)}…）` : '')
          : e instanceof Error
            ? e.message
            : String(e);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  function toggleOption(qId: string, label: string, multiSelect: boolean) {
    setAnswers((prev) => {
      const cur = prev[qId] ?? { selected: [], custom: '' };
      let selected: string[];
      if (multiSelect) {
        selected = cur.selected.includes(label)
          ? cur.selected.filter((l) => l !== label)
          : [...cur.selected, label];
      } else {
        selected = cur.selected.includes(label) ? [] : [label];
      }
      return { ...prev, [qId]: { ...cur, selected } };
    });
  }

  function setCustom(qId: string, custom: string) {
    setAnswers((prev) => ({ ...prev, [qId]: { ...(prev[qId] ?? { selected: [], custom: '' }), custom } }));
  }

  const canSubmitAnswers = useMemo(() => {
    if (!activeQuestions) return false;
    return activeQuestions.questions.some((q) => {
      const a = answers[q.id];
      return !!a && (a.selected.length > 0 || a.custom.trim() !== '');
    });
  }, [activeQuestions, answers]);

  function submitAnswers() {
    if (!activeQuestions) return;
    const lines = activeQuestions.questions.map((q) => {
      const a = answers[q.id] ?? { selected: [], custom: '' };
      const parts = [...a.selected];
      if (a.custom.trim()) parts.push(a.custom.trim());
      return `${q.prompt}\n→ ${parts.length ? parts.join('；') : '（跳过）'}`;
    });
    void runTurn({ userText: lines.join('\n\n') });
  }

  function updateDraftEntry(index: number, patch: Partial<StudioPlanLoreEntry>) {
    setSession((s) => {
      if (!s.draftPlan) return s;
      const loreEntries2 = s.draftPlan.loreEntries.map((e, i) => (i === index ? { ...e, ...patch } : e));
      return { ...s, draftPlan: { ...s.draftPlan, loreEntries: loreEntries2 } };
    });
  }

  function removeDraftEntry(index: number) {
    setSession((s) => {
      if (!s.draftPlan) return s;
      return { ...s, draftPlan: { ...s.draftPlan, loreEntries: s.draftPlan.loreEntries.filter((_, i) => i !== index) } };
    });
  }

  /** 改/移除方案里的思维底座建议；undefined = 保持当前（确认时不动 config），同时清掉过时理由。 */
  function updateDraftYuan(yuan: StudioYuanKey | undefined) {
    setSession((s) => {
      if (!s.draftPlan) return s;
      return { ...s, draftPlan: { ...s.draftPlan, yuan, ...(yuan === undefined ? { yuanRationale: undefined } : {}) } };
    });
  }

  async function handleConfirm() {
    const plan = session.draftPlan;
    if (!plan) return;
    const res = applyLoreEntries(agent.id, plan.loreEntries);
    onApplied({
      loreCreated: res.created.length,
      loreUpdated: res.updated.length,
      profilePatch: flattenProfilePatch(plan.profilePatch),
      corruptionTendency: plan.corruptionTendency,
      corruptionSeed: plan.corruptionSeed,
      yuan: plan.yuan,
    });
    // 确认后这个新角色不再是「刚分出来待微调」状态，清掉 peerContext。
    setSession((s) => ({ ...s, phase: 'done', peerContext: undefined }));

    // Phase 2：检测「非 user 关系里还没有对应角色」的实体（确定性名字匹配）。
    const freshLore = listLoreEntries(agent.id);
    // 已 link 到某 agent 的虚拟联系人也视为「已成角色」——排除出候选，避免给同一个人再造重复 agent
    // （即便其联系人显示名不等于该 agent 的显示名、绕过了 agentNames 过滤）。
    const linkedContactNames = getVirtualContacts(agent.id)
      .filter((c) => typeof c.linkedAgentId === 'string' && c.linkedAgentId.trim() !== '')
      .map((c) => c.displayName);
    const otherAgentNames = agents.filter((a) => a.id !== agent.id).map((a) => a.name);
    const scan = scanPeerUpgradeCandidates({
      loreEntries: freshLore,
      agentNames: otherAgentNames,
      linkedContactNames,
    });
    if (!scan.candidates.length) {
      // 没有可升级的关系 → 直接收起，回详情页（处理黑化弹层 / 保存人设）。
      onClose();
      return;
    }

    // 让模型判断这些候选里哪些值得升级、给出关系定性。
    setPeerPhase('loading');
    setPeerError(null);
    try {
      const { turn } = await postLoreStudioTurn({
        agentId: agent.id,
        displayName,
        relationshipLabel,
        shortBio,
        existingProfile,
        existingLoreAnchors: toLoreAnchors(freshLore),
        backgroundStory: session.backgroundStory,
        transcript: toWireTranscript(session.messages),
        mode: 'peer-suggest',
        peerCandidateNames: scan.candidates.map((c) => c.name),
        // 别名兜底：确定性扫描只挡得住同名/包含，候选若是已有角色的绰号/旧称要靠模型据名单排除。
        existingAgentNames: Array.from(
          new Set([...otherAgentNames, ...linkedContactNames].map((n) => n.trim()).filter(Boolean)),
        ),
      });
      if (turn.type === 'peer-suggestions' && turn.candidates.length) {
        setPeerSuggestions(turn.candidates);
        setPeerSelected(Object.fromEntries(turn.candidates.map((c) => [c.name, true])));
        setPeerPhase('suggest');
      } else {
        onClose();
      }
    } catch (e) {
      setPeerError(e instanceof Error ? e.message : String(e));
      setPeerPhase('suggest'); // 出错也停在 peer 步，给「跳过并关闭」出口
    }
  }

  async function handleGeneratePeers() {
    const selected = peerSuggestions.filter((c) => peerSelected[c.name]);
    if (!selected.length) return;
    setPeerPhase('creating');
    setPeerError(null);
    const worldview = listLoreEntries(agent.id).filter((e) => e.category === 'worldview');
    const created: { agentId: string; name: string }[] = [];
    for (const cand of selected) {
      try {
        const r = await createPeerAgent({
          candidate: cand,
          source: { agentId: agent.id, name: displayName || agent.name, yuan: agent.yuan },
          worldviewEntries: worldview,
          userName,
        });
        created.push(r);
      } catch (e) {
        setPeerError(`生成「${cand.name}」失败：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    setCreatedAgents(created);
    setPeerPhase('done');
    try {
      await loadAgents();
    } catch {
      /* 刷新失败不致命 */
    }
    // 一键跳转：进第一个新角色的工坊（其余已建好，可随时切过去，各自 session 不丢）。
    if (created.length && onJumpToAgent) {
      onJumpToAgent(created[0].agentId);
    }
  }

  function togglePeer(name: string) {
    setPeerSelected((prev) => ({ ...prev, [name]: !prev[name] }));
  }

  if (!open) return null;

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="角色设定工坊">
      <div className={styles.drawer}>
        <div className={styles.header}>
          <div>
            <div className={styles.headerTitle}>AI 整理设定 · {displayName || agent.name}</div>
            <div className={styles.headerSub}>从背景故事提取设定库与人设 · 不确定时会先提问</div>
          </div>
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>

        <div className={styles.body} ref={bodyRef}>
          {!started && (
            <>
              <div className={styles.introHint}>
                {session.peerContext
                  ? `这个角色刚从「${session.peerContext.sourceName}」分出来，已带来共享世界观和你与「${session.peerContext.sourceName}」的关系。把这个角色的完整背景故事粘贴进来，我会据此微调这些、填好你们的关系，再补全 TA 自己的设定。`
                  : '把这个角色的完整背景故事粘贴进来。我会逐步提问（族群如何相处、TA 在某情境下会怎么做、与用户/其他角色/配角的关系等），问清后再给出可确认的设定方案。'}
              </div>
              <textarea
                className={styles.introTextarea}
                rows={10}
                value={intro}
                placeholder="粘贴完整背景故事…"
                onChange={(e) => setIntro(e.target.value)}
              />
            </>
          )}

          {started && session.backgroundStory.trim() && (
            <div className={styles.storyBubble}>
              <div className={styles.storyLabel}>背景故事</div>
              <div className={`${styles.bubble} ${styles.bubbleUser}`}>{session.backgroundStory}</div>
            </div>
          )}

          {session.messages.map((m, idx) => (
            <MessageView
              key={m.id}
              message={m}
              isActiveQuestions={!!activeQuestions && idx === session.messages.length - 1}
              answers={answers}
              onToggleOption={toggleOption}
              onSetCustom={setCustom}
            />
          ))}

          {session.draftPlan &&
            session.draftPlan.loreEntries.length + (session.draftPlan.profilePatch?.length ?? 0) + (session.draftPlan.yuan ? 1 : 0) > 0 && (
            <PlanCard
              plan={session.draftPlan}
              currentYuan={agent.yuan}
              onUpdateEntry={updateDraftEntry}
              onRemoveEntry={removeDraftEntry}
              onUpdateYuan={updateDraftYuan}
            />
          )}

          {peerPhase !== 'none' && (
            <div className={styles.planCard}>
              <div className={styles.planTitle}>这些关系可以升级为独立角色</div>
              <div className={styles.planSummary}>
                当前世界里还没有对应角色的关系。升级后会自动带过去当前角色的世界观，并在双方各写一条彼此的关系设定（关系数值用模版播种，不会被瞎编）。
              </div>
              {peerPhase === 'loading' && <div className={styles.loading}>正在分析可升级的关系…</div>}
              {peerError && <div className={styles.errorText}>{peerError}</div>}
              {(peerPhase === 'suggest' || peerPhase === 'creating') &&
                peerSuggestions.map((c) => (
                  <label key={c.name} className={styles.planEntry} style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
                    <input
                      type="checkbox"
                      checked={!!peerSelected[c.name]}
                      disabled={peerPhase === 'creating'}
                      onChange={() => togglePeer(c.name)}
                      style={{ marginTop: 3 }}
                    />
                    <div>
                      <div style={{ fontWeight: 600 }}>
                        {c.name}
                        {c.roleInWorld ? <span className={styles.qCategory}>· {c.roleInWorld}</span> : null}
                      </div>
                      {c.whyUpgrade && <div className={styles.chipDetail}>{c.whyUpgrade}</div>}
                      {c.suggestedRelationshipToCurrent && (
                        <div className={styles.patchRationale}>关系：{c.suggestedRelationshipToCurrent}</div>
                      )}
                    </div>
                  </label>
                ))}
              {peerPhase === 'creating' && <div className={styles.loading}>正在生成角色并带过去世界观与关系…</div>}
              {peerPhase === 'done' && (
                <div className={styles.successBanner}>
                  已生成 {createdAgents.length} 个角色（已带过去世界观与双向关系）：{createdAgents.map((a) => a.name).join('、') || '（无）'}。
                </div>
              )}
            </div>
          )}

          {loading && <div className={styles.loading}>整理中…</div>}
          {error && (
            <div className={styles.errorText}>
              出错了：{error}{' '}
              <button type="button" className={styles.secondaryBtn} onClick={() => void runTurn()} disabled={loading}>
                重试
              </button>
            </div>
          )}
        </div>

        <div className={styles.footer}>
          {peerPhase !== 'none' ? (
            <div className={styles.actions}>
              {peerPhase === 'suggest' && (
                <button
                  type="button"
                  className={styles.primaryBtn}
                  disabled={!peerSuggestions.some((c) => peerSelected[c.name])}
                  onClick={() => void handleGeneratePeers()}
                >
                  一键生成并跳转（{peerSuggestions.filter((c) => peerSelected[c.name]).length}）
                </button>
              )}
              {peerPhase === 'creating' && (
                <button type="button" className={styles.primaryBtn} disabled>
                  生成中…
                </button>
              )}
              <button type="button" className={styles.secondaryBtn} onClick={onClose} disabled={peerPhase === 'creating'}>
                {peerPhase === 'done' ? '关闭' : '跳过并关闭'}
              </button>
            </div>
          ) : !started ? (
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.primaryBtn}
                disabled={loading || !intro.trim()}
                onClick={() => void runTurn({ backgroundStory: intro.trim() })}
              >
                开始整理
              </button>
            </div>
          ) : (
            <>
              {activeQuestions && (
                <div className={styles.actions}>
                  <button
                    type="button"
                    className={styles.primaryBtn}
                    disabled={loading || !canSubmitAnswers}
                    onClick={submitAnswers}
                  >
                    提交回答
                  </button>
                </div>
              )}

              {session.draftPlan && session.draftPlan.loreEntries.length > 0 && (
                <div className={styles.actions}>
                  <button type="button" className={styles.primaryBtn} disabled={loading} onClick={() => void handleConfirm()}>
                    确认写入（{session.draftPlan.loreEntries.length} 条设定）
                  </button>
                </div>
              )}

              <div className={styles.composerRow}>
                <textarea
                  className={styles.composerTextarea}
                  rows={2}
                  value={composer}
                  placeholder="自由回答 / 让我解释某条 / 提出修改意见…"
                  onChange={(e) => setComposer(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && composer.trim() && !loading) {
                      e.preventDefault();
                      void runTurn({ userText: composer.trim() });
                    }
                  }}
                />
                <button
                  type="button"
                  className={styles.secondaryBtn}
                  disabled={loading || !composer.trim()}
                  onClick={() => void runTurn({ userText: composer.trim() })}
                >
                  发送
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function clonePlan(plan: StudioPlanTurn): StudioPlanTurn {
  return {
    ...plan,
    loreEntries: plan.loreEntries.map((e) => ({ ...e, tempId: e.tempId ?? newId(), keywords: [...e.keywords] })),
    profilePatch: plan.profilePatch?.map((p) => ({ ...p })),
  };
}

interface MessageViewProps {
  message: StudioMessage;
  isActiveQuestions: boolean;
  answers: AnswerState;
  onToggleOption: (qId: string, label: string, multiSelect: boolean) => void;
  onSetCustom: (qId: string, custom: string) => void;
}

function MessageView({ message, isActiveQuestions, answers, onToggleOption, onSetCustom }: MessageViewProps) {
  if (message.role === 'user') {
    return (
      <div className={`${styles.msgRow} ${styles.msgRowUser}`}>
        <div className={`${styles.bubble} ${styles.bubbleUser}`}>{message.text}</div>
      </div>
    );
  }

  const turn = message.turn;

  if (turn.type === 'message') {
    return (
      <div className={styles.msgRow}>
        <div className={`${styles.bubble} ${styles.bubbleAssistant}`}>{turn.text}</div>
      </div>
    );
  }

  if (turn.type === 'plan') {
    return (
      <div className={styles.msgRow}>
        <div className={`${styles.bubble} ${styles.bubbleAssistant}`}>
          {turn.summary || '我整理出了一份设定方案，见下方。'}
        </div>
      </div>
    );
  }

  if (turn.type === 'peer-suggestions') {
    return (
      <div className={styles.msgRow}>
        <div className={`${styles.bubble} ${styles.bubbleAssistant}`}>
          {turn.intro || '以下角色或许值得升级为独立角色：'}
          {'\n'}
          {turn.candidates.map((c) => `• ${c.name}${c.roleInWorld ? `（${c.roleInWorld}）` : ''}`).join('\n')}
        </div>
      </div>
    );
  }

  // questions
  return (
    <div className={styles.msgRow}>
      <div className={`${styles.bubble} ${styles.bubbleAssistant}`}>
        {turn.intro && <div style={{ marginBottom: 8 }}>{turn.intro}</div>}
        {turn.questions.map((q) => (
          <div key={q.id} className={styles.question}>
            <div className={styles.qPrompt}>
              {q.prompt}
              {q.category && <span className={styles.qCategory}>· {XINGYE_LORE_CATEGORY_LABELS[q.category] ?? q.category}</span>}
            </div>
            {isActiveQuestions ? (
              <>
                <div className={styles.options}>
                  {q.options.map((opt, i) => {
                    const selected = (answers[q.id]?.selected ?? []).includes(opt.label);
                    return (
                      <button
                        key={`${q.id}-${i}`}
                        type="button"
                        className={`${styles.chip} ${selected ? styles.chipSelected : ''}`}
                        onClick={() => onToggleOption(q.id, opt.label, q.multiSelect === true)}
                      >
                        <span>{opt.label}</span>
                        {opt.detail && <span className={styles.chipDetail}>{opt.detail}</span>}
                      </button>
                    );
                  })}
                </div>
                {q.allowCustom !== false && (
                  <input
                    className={styles.customInput}
                    value={answers[q.id]?.custom ?? ''}
                    placeholder="或自定义回答…"
                    onChange={(e) => onSetCustom(q.id, e.target.value)}
                  />
                )}
              </>
            ) : (
              <div className={styles.answered}>（已回答）</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

interface PlanCardProps {
  plan: StudioPlanTurn;
  /** 角色当前的 config.agent.yuan（可能是候选集外的 kong 等），用于「与当前一致」提示。 */
  currentYuan?: string;
  onUpdateEntry: (index: number, patch: Partial<StudioPlanLoreEntry>) => void;
  onRemoveEntry: (index: number) => void;
  onUpdateYuan: (yuan: StudioYuanKey | undefined) => void;
}

function PlanCard({ plan, currentYuan, onUpdateEntry, onRemoveEntry, onUpdateYuan }: PlanCardProps) {
  // 按分类分组，保留原顺序；记录每条在原数组里的 index 以便编辑。
  const groups = useMemo(() => {
    const order: XingyeLoreCategory[] = [];
    const map = new Map<XingyeLoreCategory, { entry: StudioPlanLoreEntry; index: number }[]>();
    plan.loreEntries.forEach((entry, index) => {
      if (!map.has(entry.category)) {
        map.set(entry.category, []);
        order.push(entry.category);
      }
      map.get(entry.category)!.push({ entry, index });
    });
    return order.map((cat) => ({ cat, items: map.get(cat)! }));
  }, [plan.loreEntries]);

  return (
    <div className={styles.planCard}>
      <div className={styles.planTitle}>设定方案（确认前可改）</div>
      {plan.summary && <div className={styles.planSummary}>{plan.summary}</div>}

      {groups.map(({ cat, items }) => (
        <div key={cat} className={styles.planGroup}>
          <div className={styles.planGroupLabel}>{XINGYE_LORE_CATEGORY_LABELS[cat] ?? cat}</div>
          {items.map(({ entry, index }) => (
            <div key={entry.tempId ?? index} className={styles.planEntry}>
              <div className={styles.entryHead}>
                <input
                  className={styles.entryTitleInput}
                  value={entry.title}
                  onChange={(e) => onUpdateEntry(index, { title: e.target.value })}
                />
                {entry.isUpdate && <span className={styles.badge}>更新</span>}
                <button type="button" className={styles.removeBtn} onClick={() => onRemoveEntry(index)} aria-label="移除">
                  移除
                </button>
              </div>
              <textarea
                className={styles.entryContent}
                rows={3}
                value={entry.content}
                onChange={(e) => onUpdateEntry(index, { content: e.target.value })}
              />
              <div className={styles.entryRow}>
                <select
                  className={styles.modeSelect}
                  value={entry.insertionMode}
                  onChange={(e) => onUpdateEntry(index, { insertionMode: e.target.value as XingyeLoreInsertionMode })}
                >
                  {(['always', 'keyword', 'manual'] as XingyeLoreInsertionMode[]).map((mode) => (
                    <option key={mode} value={mode}>
                      {INSERTION_MODE_LABELS[mode]}
                    </option>
                  ))}
                </select>
                {entry.manualSuggested && entry.insertionMode !== 'manual' && (
                  <span className={styles.badgeWarn}>建议手动</span>
                )}
              </div>
              {entry.manualSuggested && entry.manualReason && (
                <div className={styles.manualHint}>建议手动注入：{entry.manualReason}</div>
              )}
              {entry.insertionMode === 'keyword' && (
                <>
                  <input
                    className={styles.entryKeywords}
                    value={entry.keywords.join('，')}
                    placeholder="关键词（逗号分隔）"
                    onChange={(e) =>
                      onUpdateEntry(index, {
                        keywords: e.target.value
                          .split(/[,，、\n]/)
                          .map((k) => k.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                  {entry.keywords.length === 0 && (
                    <span className={styles.manualHint} style={{ color: 'rgba(200,80,80,0.95)' }}>
                      ⚠ keyword 模式需要关键词，否则这条永远不会被注入。
                    </span>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      ))}

      {plan.profilePatch && plan.profilePatch.length > 0 && (
        <div className={styles.planGroup}>
          <div className={styles.planGroupLabel}>人设调整（回填到表单，保存后生效）</div>
          <div className={styles.patchList}>
            {plan.profilePatch.map((p, i) => (
              <div key={`${p.field}-${i}`} className={styles.patchItem}>
                <span className={styles.patchField}>{PROFILE_FIELD_LABELS[p.field] ?? p.field}：</span>
                {p.value}
                {p.rationale && <div className={styles.patchRationale}>理由：{p.rationale}</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      {plan.yuan && (
        <div className={styles.planGroup} data-testid="studio-plan-yuan">
          <div className={styles.planGroupLabel}>思维底座（Yuan · 确认后切换）</div>
          <div className={styles.patchList}>
            <div className={styles.patchItem}>
              <div className={styles.entryRow}>
                <select
                  className={styles.modeSelect}
                  data-testid="studio-plan-yuan-select"
                  value={plan.yuan}
                  onChange={(e) => onUpdateYuan(e.target.value as StudioYuanKey)}
                >
                  {STUDIO_YUAN_OPTIONS.map((o) => (
                    <option key={o.key} value={o.key}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className={styles.removeBtn}
                  data-testid="studio-plan-yuan-remove"
                  onClick={() => onUpdateYuan(undefined)}
                  aria-label="保持当前底座"
                >
                  保持当前
                </button>
              </div>
              <div className={styles.chipDetail}>
                {STUDIO_YUAN_OPTIONS.find((o) => o.key === plan.yuan)?.summary}
                {currentYuan && plan.yuan === currentYuan.trim().toLowerCase()
                  ? '（与当前一致，确认后不变）'
                  : `（当前：${currentYuan || 'hanako'}）`}
              </div>
              {plan.yuanRationale && <div className={styles.patchRationale}>理由：{plan.yuanRationale}</div>}
            </div>
          </div>
        </div>
      )}

      {plan.notes && <div className={styles.planSummary}>📝 {plan.notes}</div>}
    </div>
  );
}
