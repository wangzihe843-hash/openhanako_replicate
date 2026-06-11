import { useEffect, useMemo, useState } from 'react';
import type { Agent } from '../types';
import { hanaFetch } from '../hooks/use-hana-fetch';
import { useStore } from '../stores';
import { createLocalServerConnection } from '../services/server-connection';
import { browseAgent, loadAgents } from '../settings/actions';
import { CropOverlay } from '../settings/overlays/CropOverlay';
import { useSettingsStore } from '../settings/store';
import {
  buildOpenHanakoAgentSyncPayload,
  getXingyeRoleProfileDisplay,
  saveXingyeRoleProfile,
  useXingyeRoleProfile,
  type XingyeRoleGender,
  type XingyeCorruptionTendency,
} from './xingye-profile-store';
import { getXingyePersistenceDiagnostics } from './xingye-persistence';
import { CORRUPTION_SEED_BY_TENDENCY } from './xingye-state-init';
import {
  computeInitialCorruption,
  ensureRelationshipState,
  getRelationshipState,
  resetCorruptionToSeed,
  type RelationshipInitProfile,
} from './xingye-state-store';
import { LoreStudioDrawer } from './LoreStudioDrawer';
import type { StudioAppliedResult } from './lore-studio-types';
import { BackgroundPicker } from './BackgroundPicker';
import { LoreEditor } from './LoreEditor';
import { XingyeAgentAvatar } from './XingyeAgentAvatar';
import styles from './XingyeShell.module.css';

interface RoleDetailPanelProps {
  agent: Agent | null;
  isOpenHanakoCurrent: boolean;
  onBack: () => void;
  onChat: (agentId: string) => void;
  onPhone: () => void;
  /** Phase 2：工坊批量生成 peer 角色后请求跳转到某个新角色（由 shell 选中并展开其工坊）。 */
  onOpenAgentStudio?: (agentId: string) => void;
  /** 若等于当前 agent.id，则挂载后自动打开设定工坊（用于跳转落地）。 */
  autoOpenStudioFor?: string | null;
  /** 自动打开已消费，通知 shell 清除标记，避免重复触发。 */
  onAutoOpenStudioConsumed?: () => void;
}

export function RoleDetailPanel({
  agent,
  isOpenHanakoCurrent,
  onBack,
  onChat,
  onPhone,
  onOpenAgentStudio,
  autoOpenStudioFor,
  onAutoOpenStudioConsumed,
}: RoleDetailPanelProps) {
  const profile = useXingyeRoleProfile(agent?.id);
  const agents = useStore((state) => state.agents);
  const storeUserName = useStore((state) => state.userName);
  const [displayName, setDisplayName] = useState('');
  const [shortBio, setShortBio] = useState('');
  const [relationshipLabel, setRelationshipLabel] = useState('');
  const [speakingStyle, setSpeakingStyle] = useState('');
  const [identitySummary, setIdentitySummary] = useState('');
  const [backgroundSummary, setBackgroundSummary] = useState('');
  const [personalitySummary, setPersonalitySummary] = useState('');
  const [behaviorLogic, setBehaviorLogic] = useState('');
  const [values, setValues] = useState('');
  const [taboos, setTaboos] = useState('');
  const [relationshipMode, setRelationshipMode] = useState('');
  const [gender, setGender] = useState<XingyeRoleGender>('unspecified');
  /** 阴暗面预设档位；'' = 自动判断（由关系状态初始化的本地关键词扫描兜底决定）。 */
  const [corruptionTendency, setCorruptionTendency] = useState<XingyeCorruptionTendency | ''>('');
  /** 用户确认过的精确黑化起点（0..100）；null = 未设置精确值，按档位基线走。 */
  const [corruptionSeed, setCorruptionSeed] = useState<number | null>(null);
  /** AI 给出的「非基线」精确值待确认提案；null = 无待确认。确认才会落到 corruptionSeed。 */
  const [pendingSeed, setPendingSeed] = useState<{ seed: number; baseline: number; tier: XingyeCorruptionTendency } | null>(null);
  /** 「重置黑化起点」确认条是否展开；目标/当前值在展开时实时算（避免陈旧）。 */
  const [corruptionResetOpen, setCorruptionResetOpen] = useState(false);
  /** 重置后的反馈文案；null = 无。 */
  const [corruptionResetMsg, setCorruptionResetMsg] = useState<string | null>(null);
  const [allowAutoMoments, setAllowAutoMoments] = useState(false);
  const [allowProactiveDM, setAllowProactiveDM] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [syncState, setSyncState] = useState<'idle' | 'syncing' | 'synced' | 'error'>('idle');
  const [syncError, setSyncError] = useState<string | null>(null);
  const [profileSaveError, setProfileSaveError] = useState<string | null>(null);
  /** 设定工坊抽屉开关 + 写入后的状态条文案。 */
  const [studioOpen, setStudioOpen] = useState(false);
  const [studioStatus, setStudioStatus] = useState<string | null>(null);
  /** 勾选后同步时用 PUT /api/agents/:id/config 写入 agent.name（与设置页助手名一致）；默认不勾选避免误改 OpenHanako 名称。 */
  const [syncOpenHanakoAgentName, setSyncOpenHanakoAgentName] = useState(false);

  useEffect(() => {
    setDisplayName(profile?.displayName ?? '');
    setShortBio(profile?.shortBio ?? '');
    setRelationshipLabel(profile?.relationshipLabel ?? '');
    setSpeakingStyle(profile?.speakingStyle ?? '');
    setIdentitySummary(profile?.identitySummary ?? '');
    setBackgroundSummary(profile?.backgroundSummary ?? '');
    setPersonalitySummary(profile?.personalitySummary ?? '');
    setBehaviorLogic(profile?.behaviorLogic ?? '');
    setValues(profile?.values ?? '');
    setTaboos(profile?.taboos ?? '');
    setRelationshipMode(profile?.relationshipMode ?? '');
    setGender(profile?.gender ?? 'unspecified');
    setCorruptionTendency(profile?.corruptionTendency ?? '');
    setCorruptionSeed(typeof profile?.corruptionSeed === 'number' ? profile.corruptionSeed : null);
    setAllowAutoMoments(profile?.allowAutoMoments ?? false);
    setAllowProactiveDM(profile?.allowProactiveDM ?? false);
    // 从持久化的草稿恢复「待确认精确黑化值」弹层（关面板/切角色/重启后仍在）。pendingSeed 由本 effect
    // 据 profile 单一来源派生——已采用(corruptionSeed 已设)或与档位基线相同则不弹。这也避免了「保存触发
    // profile 刷新冲掉内存里 pendingSeed」的旧竞态：刷新只会按持久化值重算，不会误清。
    const tierForPending = profile?.corruptionTendency;
    const pendingPersisted = typeof profile?.corruptionSeedPending === 'number' ? profile.corruptionSeedPending : null;
    if (
      tierForPending &&
      pendingPersisted !== null &&
      pendingPersisted !== CORRUPTION_SEED_BY_TENDENCY[tierForPending] &&
      typeof profile?.corruptionSeed !== 'number'
    ) {
      setPendingSeed({ seed: pendingPersisted, baseline: CORRUPTION_SEED_BY_TENDENCY[tierForPending], tier: tierForPending });
    } else {
      setPendingSeed(null);
    }
  }, [agent?.id, profile]);

  useEffect(() => {
    setSavedAt(null);
    setSyncState('idle');
    setSyncError(null);
    setProfileSaveError(null);
    setStudioStatus(null);
    setStudioOpen(false);
    // 注：pendingSeed 不在这里清——它由上面的字段初始化 effect 据持久化的 corruptionSeedPending 派生。
    setSyncOpenHanakoAgentName(false);
    setCorruptionResetOpen(false);
    setCorruptionResetMsg(null);
  }, [agent?.id]);

  // 黑化配置一变（手动选档位 / 采纳-清除精确值 / 重新提取），收起重置确认并清掉可能已过时的反馈文案。
  useEffect(() => {
    setCorruptionResetOpen(false);
    setCorruptionResetMsg(null);
  }, [corruptionTendency, corruptionSeed]);

  const [persistRev, setPersistRev] = useState(0);
  useEffect(() => {
    const onPersistence = () => setPersistRev((n) => n + 1);
    window.addEventListener('xingye-persistence-changed', onPersistence);
    return () => window.removeEventListener('xingye-persistence-changed', onPersistence);
  }, []);
  void persistRev;

  // 跳转落地：若被请求自动打开本角色工坊，则展开抽屉并通知 shell 清除标记。
  useEffect(() => {
    if (autoOpenStudioFor && agent?.id && autoOpenStudioFor === agent.id) {
      setStudioStatus(null);
      setStudioOpen(true);
      onAutoOpenStudioConsumed?.();
    }
  }, [autoOpenStudioFor, agent?.id, onAutoOpenStudioConsumed]);

  const persistenceDiag = getXingyePersistenceDiagnostics();

  const syncDraft = useMemo(() => ({
    agentId: agent?.id ?? '',
    displayName,
    shortBio,
    relationshipLabel,
    speakingStyle,
    identitySummary,
    backgroundSummary,
    personalitySummary,
    behaviorLogic,
    values,
    taboos,
    relationshipMode,
    gender,
    updatedAt: profile?.updatedAt ?? new Date(0).toISOString(),
  }), [
    agent?.id,
    displayName,
    shortBio,
    relationshipLabel,
    speakingStyle,
    identitySummary,
    backgroundSummary,
    personalitySummary,
    behaviorLogic,
    values,
    taboos,
    relationshipMode,
    gender,
    profile?.updatedAt,
  ]);
  const syncPayload = useMemo(
    () => (agent ? buildOpenHanakoAgentSyncPayload(agent, syncDraft) : null),
    [agent, syncDraft],
  );

  if (!agent || !syncPayload) {
    return (
      <div className={styles.emptyState}>
        <h2 className={styles.panelTitle}>角色详情</h2>
        <p className={styles.panelDescription}>请选择一个角色查看基础信息。</p>
        <button className={styles.secondaryButton} type="button" onClick={onBack}>
          返回角色列表
        </button>
      </div>
    );
  }

  const resolvedProfile = getXingyeRoleProfileDisplay(agent, profile);

  const handleSave = async () => {
    setProfileSaveError(null);
    try {
      const saved = await saveXingyeRoleProfile(agent.id, {
        displayName,
        shortBio,
        relationshipLabel,
        speakingStyle,
        identitySummary,
        backgroundSummary,
        personalitySummary,
        behaviorLogic,
        values,
        taboos,
        relationshipMode,
        gender,
        corruptionTendency: corruptionTendency || undefined,
        corruptionSeed: corruptionSeed ?? undefined,
        // 还在待确认就把草稿留着（保存其它字段不该把 AI 的精确黑化提案吞掉）；已拍板 / 手动改档位则清空。
        corruptionSeedPending: pendingSeed ? pendingSeed.seed : undefined,
        allowAutoMoments,
        allowProactiveDM,
      });
      setSavedAt(saved.updatedAt);
      // 注：不清 pendingSeed——它由字段初始化 effect 据回流的 profile.corruptionSeedPending 派生。

      // 「黑化起点」改了才把它同步进「TA 的状态」(秘密空间) ——只动黑化、保留其余数值与历史。
      // 刻意不无脑覆盖：黑化「只进难退」靠互动累积，每次保存都重置会抹掉进度。这里用闭包里的
      // 旧 profile 对比 live 值，恰好判断「本次保存是否改动了黑化起点」。
      const prevSeed = typeof profile?.corruptionSeed === 'number' ? profile.corruptionSeed : undefined;
      const seedChanged = (corruptionSeed ?? undefined) !== prevSeed;
      const tierChanged = (corruptionTendency || undefined) !== (profile?.corruptionTendency ?? undefined);
      if (seedChanged || tierChanged) {
        try {
          const next = resetCorruptionToSeed(agent.id, buildCorruptionInitProfile());
          setCorruptionResetOpen(false);
          setCorruptionResetMsg(`黑化起点已保存，并同步到秘密空间「TA 的状态」（当前黑化 ${next.corruption}）。`);
        } catch (error) {
          console.warn('[RoleDetailPanel] failed to sync corruption seed to relationship state:', error);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setProfileSaveError(`保存失败：${message}`);
    }
  };

  /**
   * 直接持久化人设补丁（工坊「确认即存」/ 黑化弹层即时落库都走它）。
   * corruption 给定时，把黑化档位 / 精确值同步到秘密空间「TA 的状态」（只动黑化值）。
   * 注：corruption.tendency 给定时档位优先于关键词扫描，故表单文本字段是否已 setState 同步不影响结果。
   */
  const persistPersonaPatch = async (
    patch: Parameters<typeof saveXingyeRoleProfile>[1],
    corruption?: { tendency: XingyeCorruptionTendency | undefined; seed: number | undefined },
  ) => {
    setProfileSaveError(null);
    try {
      const saved = await saveXingyeRoleProfile(agent.id, patch);
      setSavedAt(saved.updatedAt);
      if (corruption) {
        try {
          const next = resetCorruptionToSeed(agent.id, {
            ...buildCorruptionInitProfile(),
            corruptionTendency: corruption.tendency,
            corruptionSeed: corruption.seed,
          });
          setCorruptionResetMsg(`黑化起点已同步到秘密空间「TA 的状态」（当前黑化 ${next.corruption}）。`);
        } catch (error) {
          console.warn('[RoleDetailPanel] failed to sync corruption to relationship state:', error);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setProfileSaveError(`保存失败：${message}`);
    }
  };

  const handleChangeChatBackground = async (chatBackgroundDataUrl: string | undefined) => {
    setProfileSaveError(null);
    try {
      const saved = await saveXingyeRoleProfile(agent.id, { chatBackgroundDataUrl });
      setSavedAt(saved.updatedAt);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`保存失败：${message}`);
    }
  };

  const handleChangeAvatar = async () => {
    const appStore = useStore.getState();
    const settingsStore = useSettingsStore.getState();
    if (!settingsStore.activeServerConnection && appStore.serverPort) {
      useSettingsStore.setState({
        serverPort: Number(appStore.serverPort),
        serverToken: appStore.serverToken,
        activeServerConnection: createLocalServerConnection({
          serverPort: appStore.serverPort,
          serverToken: appStore.serverToken,
        }),
      });
    }

    await browseAgent(agent.id);

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp';
    input.addEventListener('change', () => {
      if (input.files?.[0]) {
        window.dispatchEvent(new CustomEvent('hana-open-cropper', {
          detail: { role: 'agent', file: input.files[0] },
        }));
      }
    });
    input.click();
  };

  const handleSyncOpenHanakoAgent = async () => {
    setSyncState('syncing');
    setSyncError(null);
    try {
      const displayForName = getXingyeRoleProfileDisplay(agent, syncDraft).displayName.trim() || agent.name;

      const requests: Promise<Response>[] = [];
      if (syncOpenHanakoAgentName) {
        requests.push(
          hanaFetch(`/api/agents/${agent.id}/config`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agent: { name: displayForName } }),
          }),
        );
      }
      requests.push(
        hanaFetch(`/api/agents/${agent.id}/identity`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: syncPayload.identity }),
        }),
        hanaFetch(`/api/agents/${agent.id}/ishiki`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: syncPayload.ishiki }),
        }),
      );

      const results = await Promise.all(requests);
      for (const response of results) {
        const data = await response.json();
        if (data?.error) throw new Error(data.error);
      }
      setSyncState('synced');
      await saveXingyeRoleProfile(agent.id, { lastOpenHanakoSyncAt: new Date().toISOString() });
    } catch (error) {
      setSyncState('error');
      setSyncError(error instanceof Error ? error.message : String(error));
    }
  };

  /**
   * 设定工坊「确认写入」后的回填：lore 已由抽屉直接落盘；这里把人设补丁填进表单，
   * 并把 corruption 提案路由到既有的「精确黑化值待确认」弹层 UX（与原 AI 提取一致）。
   * 只设置补丁里出现的字段——未提及的字段保持不动；只有当给了 corruptionTendency 时才动黑化。
   * yuan 建议与当前 config.agent.yuan 不同时才 PUT config 切换（用户在方案卡里已可改/保持）。
   */
  const handleStudioApplied = async (result: StudioAppliedResult) => {
    const p = result.profilePatch ?? {};
    const patch: Parameters<typeof saveXingyeRoleProfile>[1] = {};
    // 回填表单（即时视觉反馈）+ 收集要落库的补丁；只动补丁里出现的字段。
    const fill = (value: string | undefined, setter: (v: string) => void, key: keyof typeof patch) => {
      if (typeof value === 'string' && value.trim()) {
        const t = value.trim();
        setter(t);
        (patch as Record<string, unknown>)[key as string] = t;
      }
    };
    fill(p.shortBio, setShortBio, 'shortBio');
    fill(p.identitySummary, setIdentitySummary, 'identitySummary');
    fill(p.backgroundSummary, setBackgroundSummary, 'backgroundSummary');
    fill(p.personalitySummary, setPersonalitySummary, 'personalitySummary');
    fill(p.behaviorLogic, setBehaviorLogic, 'behaviorLogic');
    fill(p.values, setValues, 'values');
    fill(p.taboos, setTaboos, 'taboos');
    fill(p.relationshipMode, setRelationshipMode, 'relationshipMode');
    fill(p.speakingStyle, setSpeakingStyle, 'speakingStyle');

    const tier = result.corruptionTendency;
    if (tier) {
      setCorruptionTendency(tier);
      patch.corruptionTendency = tier;
    }

    // 先算 AI 给的精确黑化起点是否偏离档位基线 → 决定是否进「待确认」，并把该草稿一并写进 patch 持久化：
    // 这样关面板 / 切角色 / 重启后这条待确认条仍能从 profile.corruptionSeedPending 恢复（见字段初始化 effect）。
    let pending: { seed: number; baseline: number; tier: XingyeCorruptionTendency } | null = null;
    if (tier) {
      const seedNum = typeof result.corruptionSeed === 'number' && Number.isFinite(result.corruptionSeed)
        ? Math.min(100, Math.max(0, Math.round(result.corruptionSeed)))
        : null;
      if (seedNum !== null && seedNum !== CORRUPTION_SEED_BY_TENDENCY[tier]) {
        pending = { seed: seedNum, baseline: CORRUPTION_SEED_BY_TENDENCY[tier], tier };
      }
      patch.corruptionSeedPending = pending ? pending.seed : undefined; // 非基线 → 存草稿；基线 → 清掉残留草稿
    }

    // 确认即存：直接持久化人设（文本字段 + 黑化档位 + 待确认精确值草稿）。不覆盖关系状态里的黑化值，保护互动漂移。
    if (Object.keys(patch).length > 0) {
      await persistPersonaPatch(patch);
    }
    // 黑化值「没初始化才初始化」：用模型刚基于整段背景给的档位播种（缺档位才退化到关键词扫描）。
    // ensureRelationshipState 只在该角色还没有关系状态时播种；已初始化（可能已漂移）则原样返回、不动。
    // 精确值放到待确认弹层让用户拍板，所以这里只按档位基线初始化（corruptionSeed 留空）。
    ensureRelationshipState(agent.id, {
      relationshipLabel: relationshipLabel || profile?.relationshipLabel || undefined,
      shortBio: patch.shortBio ?? (shortBio || undefined),
      identitySummary: patch.identitySummary ?? (identitySummary || undefined),
      backgroundSummary: patch.backgroundSummary ?? (backgroundSummary || undefined),
      personalitySummary: patch.personalitySummary ?? (personalitySummary || undefined),
      behaviorLogic: patch.behaviorLogic ?? (behaviorLogic || undefined),
      values: patch.values ?? (values || undefined),
      taboos: patch.taboos ?? (taboos || undefined),
      relationshipMode: patch.relationshipMode ?? (relationshipMode || undefined),
      corruptionTendency: tier ?? (corruptionTendency || undefined),
      corruptionSeed: undefined,
    });

    // 即时反馈（field-init effect 会在 profile 落库回流后按持久化值重新对齐，两者一致）。
    if (tier) {
      setCorruptionSeed(null);
      setPendingSeed(pending);
    }

    // 思维底座：与当前不同才切换。走与「同步助手名称」相同的 PUT config 通道（服务端会校验模板存在），
    // 失败只提示、不阻断其余回填——lore / 人设此时都已各自落盘。
    let yuanPart = '';
    const currentYuan = (agent.yuan || 'hanako').trim().toLowerCase();
    if (result.yuan && result.yuan !== currentYuan) {
      try {
        const response = await hanaFetch(`/api/agents/${agent.id}/config`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent: { yuan: result.yuan } }),
        });
        const data = await response.json();
        if (data?.error) throw new Error(data.error);
        yuanPart = `思维底座已切换：${currentYuan} → ${result.yuan}。`;
        try {
          await loadAgents();
        } catch {
          /* 列表刷新失败不致命，下次加载会对齐 */
        }
      } catch (error) {
        yuanPart = `思维底座切换失败：${error instanceof Error ? error.message : String(error)}`;
      }
    }

    const wrote = result.loreCreated + result.loreUpdated;
    const lorePart = wrote > 0 ? `已写入设定库：新增 ${result.loreCreated} 条、更新 ${result.loreUpdated} 条。` : '';
    const personaPart = Object.keys(patch).length > 0 ? '人设已保存。' : '';
    const seedPart = pending ? '黑化精确值请在上方确认。' : '';
    setStudioStatus([lorePart, personaPart, seedPart, yuanPart].filter(Boolean).join(' ') || '已处理。');
  };

  /** 用当前面板里的（含未保存）设定值拼出黑化初始化 profile —— 重置/预览按所见即所得。 */
  const buildCorruptionInitProfile = (): RelationshipInitProfile => ({
    relationshipLabel: relationshipLabel || undefined,
    shortBio: shortBio || undefined,
    identitySummary: identitySummary || undefined,
    backgroundSummary: backgroundSummary || undefined,
    personalitySummary: personalitySummary || undefined,
    behaviorLogic: behaviorLogic || undefined,
    values: values || undefined,
    taboos: taboos || undefined,
    relationshipMode: relationshipMode || undefined,
    corruptionTendency: corruptionTendency || undefined,
    corruptionSeed: corruptionSeed ?? undefined,
  });

  const handleConfirmCorruptionReset = () => {
    if (!agent) return;
    const next = resetCorruptionToSeed(agent.id, buildCorruptionInitProfile());
    setCorruptionResetOpen(false);
    setCorruptionResetMsg(`已把黑化值重置回设定起点 ${next.corruption}。`);
  };

  return (
    <div className={styles.detailPanel}>
      <CropOverlay />
      <div className={styles.panelHeading}>
        <div>
          <p className={styles.eyebrow}>Xingye Role Detail</p>
          <h2 className={styles.panelTitle}>{resolvedProfile.displayName}</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', margin: '10px 0' }}>
            <XingyeAgentAvatar
              agent={agent}
              style={{
                width: 64,
                height: 64,
                borderRadius: '50%',
                objectFit: 'cover',
                border: '1px solid var(--overlay-light)',
                background: 'var(--overlay-subtle)',
              }}
            />
            <button className={styles.secondaryButton} type="button" onClick={handleChangeAvatar}>
              更换头像
            </button>
          </div>
          <p className={styles.panelDescription}>
            星野人设保存在 OpenHanako 数据目录中各 agent 的 xingye/profile.json（通过 /api/xingye/storage 读写）。「更新核心人格摘要」仅写入 OpenHanako identity / ishiki 的短摘要，不包含设定库全文、不写入 pinned 或 memory。可选将星野昵称写入原生助手名（config.agent.name），也不改聊天生成链路。
            {persistenceDiag.mode === 'agent' && (
              <span> 当前已启用 agent scope 持久化（小手机 / 设定库等业务数据）。</span>
            )}
            {persistenceDiag.mode === 'disabled' && (
              <span> 当前未启用星野 agent 持久化（未连接服务器或未选择星野角色）；业务数据不会写入浏览器 localStorage。</span>
            )}
            {persistenceDiag.mode === 'error' && (
              <span> 星野 agent 数据加载失败：{persistenceDiag.lastRefreshError || 'unknown'}。</span>
            )}
          </p>
        </div>
        <button className={styles.secondaryButton} type="button" onClick={onBack}>
          返回列表
        </button>
      </div>

      <section className={styles.detailSection} aria-label="星野基础资料">
        <h3 className={styles.detailSectionTitle}>星野基础资料</h3>
        <div className={styles.profileForm}>
          <label className={styles.profileField}>
            <span>星野昵称</span>
            <input
              type="text"
              value={displayName}
              placeholder={agent.name}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </label>
          <div
            className={styles.profileField}
            role="radiogroup"
            aria-label="角色性别"
            data-testid="xingye-role-gender"
          >
            <span>性别（用于代词约束）</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, paddingTop: 4 }}>
              {(
                [
                  { value: 'female', label: '女（她）' },
                  { value: 'male', label: '男（他）' },
                  { value: 'nonbinary', label: '非二元（TA）' },
                  { value: 'unspecified', label: '不指明' },
                ] as Array<{ value: XingyeRoleGender; label: string }>
              ).map((opt) => (
                <label
                  key={opt.value}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}
                >
                  <input
                    type="radio"
                    name={`xingye-role-gender-${agent.id}`}
                    value={opt.value}
                    checked={gender === opt.value}
                    onChange={() => setGender(opt.value)}
                    data-testid={`xingye-role-gender-${opt.value}`}
                  />
                  <span>{opt.label}</span>
                </label>
              ))}
            </div>
          </div>
          <label className={styles.profileField} data-testid="xingye-role-corruption-tendency">
            <span>阴暗面预设（黑化值起点）</span>
            <select
              value={corruptionTendency}
              onChange={(event) => {
                // 用户手动选档位 = 选定粗粒度基线，清掉残留的精确值与待确认提案，免得状态打架。
                setCorruptionTendency(event.target.value as XingyeCorruptionTendency | '');
                setCorruptionSeed(null);
                setPendingSeed(null);
              }}
              data-testid="xingye-role-corruption-tendency-select"
            >
              <option value="">自动判断（按设定关键词）</option>
              <option value="none">无 · 不黑化</option>
              <option value="latent">潜藏 · 一点占有/不安</option>
              <option value="marked">明显 · 病娇/强占有</option>
            </select>
            <small style={{ opacity: 0.7 }}>
              只决定黑化值的初始起点；留「自动判断」则由角色设定 / 设定库里的关键词决定。
            </small>
          </label>
          {pendingSeed && (
            <div
              data-testid="xingye-corruption-seed-confirm"
              style={{
                margin: '0 0 12px',
                padding: '10px 12px',
                borderRadius: 8,
                border: '1px solid rgba(201,162,74,0.6)',
                background: 'rgba(201,162,74,0.1)',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <span style={{ fontSize: 13, lineHeight: 1.5 }}>
                AI 评估这个角色的黑化起点为 <b>{pendingSeed.seed}</b>（档位「
                {pendingSeed.tier === 'none' ? '无' : pendingSeed.tier === 'latent' ? '潜藏' : '明显'}
                」基线为 {pendingSeed.baseline}）。采用 AI 的精确值，还是按档位基线？
              </span>
              {(() => {
                // 老角色黑化可能已靠互动漂移；两个选项都会经 resetCorruptionToSeed 覆盖当前值——明确警告，别静默清进度。
                const current = getRelationshipState(agent.id)?.corruption;
                return typeof current === 'number' && current !== pendingSeed.baseline ? (
                  <span
                    data-testid="xingye-corruption-seed-overwrite-warn"
                    style={{ fontSize: 12, color: 'rgba(200,80,80,0.95)', lineHeight: 1.5 }}
                  >
                    ⚠ 这个角色当前黑化已是 <b>{current}</b>（含互动累积）；无论「采用」还是「按基线」，都会把它覆盖成对应值。
                  </span>
                ) : null;
              })()}
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  data-testid="xingye-corruption-seed-accept"
                  onClick={() => {
                    const { seed, tier } = pendingSeed;
                    setCorruptionSeed(seed);
                    setPendingSeed(null);
                    void persistPersonaPatch({ corruptionSeed: seed, corruptionSeedPending: undefined, corruptionTendency: tier }, { tendency: tier, seed });
                  }}
                >
                  采用精确值 {pendingSeed.seed}
                </button>
                <button
                  type="button"
                  data-testid="xingye-corruption-seed-reject"
                  onClick={() => {
                    const { tier } = pendingSeed;
                    setCorruptionSeed(null);
                    setPendingSeed(null);
                    void persistPersonaPatch({ corruptionSeed: undefined, corruptionSeedPending: undefined, corruptionTendency: tier }, { tendency: tier, seed: undefined });
                  }}
                >
                  按档位基线 {pendingSeed.baseline}
                </button>
              </div>
            </div>
          )}
          {corruptionSeed !== null && !pendingSeed && (
            <small
              data-testid="xingye-corruption-seed-applied"
              style={{ display: 'block', opacity: 0.8, margin: '-6px 0 12px' }}
            >
              精确黑化起点：<b>{corruptionSeed}</b>（覆盖档位基线）
              {' '}
              <button
                type="button"
                data-testid="xingye-corruption-seed-clear"
                onClick={() => setCorruptionSeed(null)}
                style={{ background: 'none', border: 'none', textDecoration: 'underline', cursor: 'pointer', padding: 0, color: 'inherit' }}
              >
                清除
              </button>
            </small>
          )}
          <div style={{ margin: '0 0 14px' }} data-testid="xingye-corruption-reset">
            {!corruptionResetOpen && (
              <button
                type="button"
                data-testid="xingye-corruption-reset-open"
                onClick={() => { setCorruptionResetOpen(true); setCorruptionResetMsg(null); }}
                style={{ background: 'none', border: '1px solid rgba(128,128,128,0.4)', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', color: 'inherit', fontSize: 13 }}
              >
                重置黑化起点
              </button>
            )}
            {corruptionResetOpen && (() => {
              const target = computeInitialCorruption(agent.id, buildCorruptionInitProfile());
              const current = getRelationshipState(agent.id)?.corruption;
              return (
                <div
                  data-testid="xingye-corruption-reset-confirm"
                  style={{
                    padding: '10px 12px',
                    borderRadius: 8,
                    border: '1px solid rgba(220,90,90,0.5)',
                    background: 'rgba(220,90,90,0.08)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                  }}
                >
                  <span style={{ fontSize: 13, lineHeight: 1.5 }}>
                    把黑化值重置回设定起点 <b>{target}</b>
                    {typeof current === 'number' ? `（当前 ${current}）` : ''}
                    ？当前黑化进度会清掉，其它数值（好感 / 信任 / 忠诚 / 醋意）不变。
                  </span>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button type="button" data-testid="xingye-corruption-reset-confirm-btn" onClick={handleConfirmCorruptionReset}>
                      确定重置为 {target}
                    </button>
                    <button type="button" data-testid="xingye-corruption-reset-cancel" onClick={() => setCorruptionResetOpen(false)}>
                      取消
                    </button>
                  </div>
                </div>
              );
            })()}
            {corruptionResetMsg && !corruptionResetOpen && (
              <small data-testid="xingye-corruption-reset-msg" style={{ display: 'block', opacity: 0.85, marginTop: 6 }}>
                {corruptionResetMsg}
              </small>
            )}
            <small style={{ display: 'block', opacity: 0.6, marginTop: 6, fontSize: 12 }}>
              改了黑化起点并「保存」会自动同步到 TA 的状态；这个按钮用于「设定没变、但想手动把 TA 当前黑化重新对齐到设定起点」（只动黑化，其它数值不变）。
            </small>
          </div>
          <label className={styles.profileField}>
            <span>简介</span>
            <textarea
              value={shortBio}
              placeholder={resolvedProfile.shortBio}
              rows={3}
              onChange={(event) => setShortBio(event.target.value)}
            />
          </label>
          <label className={styles.profileField}>
            <span>关系标签</span>
            <input
              type="text"
              value={relationshipLabel}
              placeholder="朋友、搭子、旅伴..."
              onChange={(event) => setRelationshipLabel(event.target.value)}
            />
          </label>
          <label className={styles.profileField}>
            <span>说话风格</span>
            <textarea
              value={speakingStyle}
              placeholder="理性、直接、克制，有判断力..."
              rows={2}
              onChange={(event) => setSpeakingStyle(event.target.value)}
            />
          </label>
        </div>
      </section>

      <section className={styles.detailSection} aria-label="星野聊天背景">
        <BackgroundPicker
          value={resolvedProfile.chatBackgroundDataUrl}
          onChange={handleChangeChatBackground}
        />
      </section>

      <section className={styles.detailSection} aria-label="角色设定分层">
        <h3 className={styles.detailSectionTitle}>角色设定分层</h3>
        <div className={styles.profileForm}>
          <div className={styles.extractBox}>
            <div className={styles.extractActions}>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => { setStudioStatus(null); setStudioOpen(true); }}
              >
                AI 整理设定
              </button>
              {studioStatus && <span className={styles.saveStatus}>{studioStatus}</span>}
            </div>
            <p className={styles.loreHint}>
              粘贴整段背景故事，AI 会逐步提问并整理成设定库条目；确认后写入设定库，人设建议回填到下面的表单。
            </p>
          </div>
          <label className={styles.profileField}>
            <span>身份摘要</span>
            <textarea
              value={identitySummary}
              placeholder="身份 / 职业 / 物种 / 世界观定位。"
              rows={2}
              onChange={(event) => setIdentitySummary(event.target.value)}
            />
          </label>
          <label className={styles.profileField}>
            <span>背景摘要</span>
            <textarea
              value={backgroundSummary}
              placeholder="只写一句核心背景，不粘贴完整背景故事。"
              rows={2}
              onChange={(event) => setBackgroundSummary(event.target.value)}
            />
          </label>
          <label className={styles.profileField}>
            <span>人格摘要</span>
            <textarea
              value={personalitySummary}
              placeholder="性格基础，例如克制、可靠、敏感但不脆弱。"
              rows={2}
              onChange={(event) => setPersonalitySummary(event.target.value)}
            />
          </label>
          <label className={styles.profileField}>
            <span>行为逻辑</span>
            <textarea
              value={behaviorLogic}
              placeholder="角色如何判断、行动、回应用户。"
              rows={2}
              onChange={(event) => setBehaviorLogic(event.target.value)}
            />
          </label>
          <label className={styles.profileField}>
            <span>价值观</span>
            <textarea
              value={values}
              placeholder="角色重视什么、拒绝什么。"
              rows={2}
              onChange={(event) => setValues(event.target.value)}
            />
          </label>
          <label className={styles.profileField}>
            <span>禁忌 / 边界</span>
            <textarea
              value={taboos}
              placeholder="不该触碰的关系边界、经历边界、表达边界。"
              rows={2}
              onChange={(event) => setTaboos(event.target.value)}
            />
          </label>
          <label className={styles.profileField}>
            <span>关系模式</span>
            <textarea
              value={relationshipMode}
              placeholder="角色如何看待用户，亲密度和边界如何保持。"
              rows={2}
              onChange={(event) => setRelationshipMode(event.target.value)}
            />
          </label>
          <label className={styles.profileToggle}>
            <input
              type="checkbox"
              checked={allowAutoMoments}
              onChange={(event) => setAllowAutoMoments(event.target.checked)}
            />
            <span>允许主动发动态</span>
          </label>
          <label className={styles.profileToggle}>
            <input
              type="checkbox"
              checked={allowProactiveDM}
              onChange={(event) => setAllowProactiveDM(event.target.checked)}
            />
            <span>允许主动私聊</span>
          </label>
        </div>
      </section>

      <section className={styles.detailSection} aria-label="背景故事与设定库">
        <LoreEditor agentId={agent.id} agentName={agent.name} />
      </section>

      <section className={styles.detailSection} aria-label="角色基础信息">
        <div className={styles.detailRow}>
          <span>Agent ID</span>
          <strong>{agent.id}</strong>
        </div>
        <div className={styles.detailRow}>
          <span>OpenHanako 名称</span>
          <strong>{agent.name}</strong>
        </div>
        <div className={styles.detailRow}>
          <span>Yuan</span>
          <strong>{agent.yuan || '未设置'}</strong>
        </div>
        <div className={styles.detailRow}>
          <span>头像</span>
          <strong>{agent.hasAvatar ? '使用 OpenHanako 头像' : '使用 Yuan fallback 头像'}</strong>
        </div>
        <div className={styles.detailRow}>
          <span>主角色</span>
          <strong>{agent.isPrimary ? '是' : '否'}</strong>
        </div>
        <div className={styles.detailRow}>
          <span>OpenHanako 当前角色</span>
          <strong>{isOpenHanakoCurrent ? '是' : '否'}</strong>
        </div>
      </section>

      <section className={styles.detailSection} aria-label="显示预览">
        <h3 className={styles.detailSectionTitle}>显示预览</h3>
        <p className={styles.detailCopy}>{resolvedProfile.shortBio}</p>
      </section>

      <section className={styles.detailSection} aria-label="OpenHanako 核心人格摘要预览">
        <h3 className={styles.detailSectionTitle}>OpenHanako 核心人格摘要预览</h3>
        <div className={styles.syncPreview}>
          <div>
            <span>identity.md</span>
            <pre>{syncPayload.identity}</pre>
          </div>
          <div>
            <span>ishiki.md</span>
            <pre>{syncPayload.ishiki}</pre>
          </div>
        </div>
      </section>

      <div className={styles.syncNameSetting} aria-label="同步助手名称选项">
        <label className={styles.syncNameSettingRow}>
          <input
            type="checkbox"
            checked={syncOpenHanakoAgentName}
            onChange={(event) => setSyncOpenHanakoAgentName(event.target.checked)}
            aria-label="同步助手名称"
          />
          <span className={styles.syncNameSettingTitle}>同步助手名称</span>
        </label>
        <p className={styles.syncNameSettingHint}>
          只修改 OpenHanako 设置页中的显示名称，不会改变助手 ID、模型配置或聊天记录。
        </p>
      </div>

      <div className={styles.detailActions}>
        <button type="button" onClick={handleSave}>
          {persistenceDiag.mode === 'agent' ? '保存到 agent scope' : '保存（需 agent 持久化）'}
        </button>
        <button type="button" onClick={handleSyncOpenHanakoAgent} disabled={syncState === 'syncing'}>
          {syncState === 'syncing' ? '更新中...' : '更新核心人格摘要'}
        </button>
        <button type="button" onClick={() => onChat(agent.id)}>进入聊天</button>
        <button type="button" onClick={onPhone}>TA 的手机</button>
        {savedAt && <span className={styles.saveStatus}>上次保存 {new Date(savedAt).toLocaleString()}</span>}
        {profile?.lastOpenHanakoSyncAt && (
          <span className={styles.saveStatus}>
            上次更新核心人格摘要 {new Date(profile.lastOpenHanakoSyncAt).toLocaleString()}
          </span>
        )}
        {persistenceDiag.lastWorkspaceFlushError && (
          <span className={styles.syncError}>Agent scope 写入失败: {persistenceDiag.lastWorkspaceFlushError}</span>
        )}
        {profileSaveError && <span className={styles.syncError}>{profileSaveError}</span>}
        {syncState === 'synced' && <span className={styles.saveStatus}>已更新 OpenHanako 核心人格摘要</span>}
        {syncState === 'error' && <span className={styles.syncError}>更新失败: {syncError}</span>}
      </div>

      <LoreStudioDrawer
        agent={agent}
        open={studioOpen}
        onClose={() => setStudioOpen(false)}
        displayName={displayName}
        relationshipLabel={relationshipLabel}
        shortBio={shortBio}
        existingProfile={{
          displayName,
          relationshipLabel,
          shortBio,
          identitySummary,
          backgroundSummary,
          personalitySummary,
          behaviorLogic,
          values,
          taboos,
          relationshipMode,
          speakingStyle,
          corruptionTendency: corruptionTendency || undefined,
        }}
        onApplied={handleStudioApplied}
        agents={agents}
        userName={storeUserName}
        onJumpToAgent={onOpenAgentStudio}
      />
    </div>
  );
}
