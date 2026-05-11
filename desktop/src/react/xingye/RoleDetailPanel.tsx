import { useEffect, useMemo, useState } from 'react';
import type { Agent } from '../types';
import { hanaFetch } from '../hooks/use-hana-fetch';
import { useStore } from '../stores';
import { createLocalServerConnection } from '../services/server-connection';
import { browseAgent } from '../settings/actions';
import { CropOverlay } from '../settings/overlays/CropOverlay';
import { useSettingsStore } from '../settings/store';
import {
  buildOpenHanakoAgentSyncPayload,
  getXingyeRoleProfileDisplay,
  saveXingyeRoleProfile,
  useXingyeRoleProfile,
} from './xingye-profile-store';
import { useXingyeLoreEntries } from './xingye-lore-store';
import { BackgroundPicker } from './BackgroundPicker';
import { LoreEditor } from './LoreEditor';
import { RelationshipStatePanel } from './RelationshipStatePanel';
import { XingyeAgentAvatar } from './XingyeAgentAvatar';
import styles from './XingyeShell.module.css';

interface RoleDetailPanelProps {
  agent: Agent | null;
  isOpenHanakoCurrent: boolean;
  onBack: () => void;
  onChat: (agentId: string) => void;
  onPhone: () => void;
}

export function RoleDetailPanel({ agent, isOpenHanakoCurrent, onBack, onChat, onPhone }: RoleDetailPanelProps) {
  const profile = useXingyeRoleProfile(agent?.id);
  const loreEntries = useXingyeLoreEntries(agent?.id);
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
  const [allowAutoMoments, setAllowAutoMoments] = useState(false);
  const [allowProactiveDM, setAllowProactiveDM] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [syncState, setSyncState] = useState<'idle' | 'syncing' | 'synced' | 'error'>('idle');
  const [syncError, setSyncError] = useState<string | null>(null);
  const [profileSaveError, setProfileSaveError] = useState<string | null>(null);
  const [pastedLore, setPastedLore] = useState('');
  const [extractState, setExtractState] = useState<'idle' | 'extracting' | 'done' | 'error'>('idle');
  const [extractError, setExtractError] = useState<string | null>(null);
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
    setAllowAutoMoments(profile?.allowAutoMoments ?? false);
    setAllowProactiveDM(profile?.allowProactiveDM ?? false);
  }, [agent?.id, profile]);

  useEffect(() => {
    setSavedAt(null);
    setSyncState('idle');
    setSyncError(null);
    setProfileSaveError(null);
    setPastedLore('');
    setExtractState('idle');
    setExtractError(null);
    setSyncOpenHanakoAgentName(false);
  }, [agent?.id]);

  const extractionLoreEntries = useMemo(() => loreEntries
    .filter((entry) => entry.enabled && [
      'background',
      'worldview',
      'relationship',
      'event',
      'character',
    ].includes(entry.category))
    .map((entry) => ({
      title: entry.title,
      content: entry.content,
      category: entry.category,
      visibility: entry.visibility,
    })), [loreEntries]);

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
    profile?.updatedAt,
  ]);
  const syncPayload = useMemo(
    () => agent ? buildOpenHanakoAgentSyncPayload(agent, syncDraft) : null,
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

  const handleSave = () => {
    setProfileSaveError(null);
    try {
      const saved = saveXingyeRoleProfile(agent.id, {
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
        allowAutoMoments,
        allowProactiveDM,
      });
      setSavedAt(saved.updatedAt);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setProfileSaveError(`保存失败：${message}`);
    }
  };

  const handleChangeChatBackground = async (chatBackgroundDataUrl: string | undefined) => {
    setProfileSaveError(null);
    try {
      const saved = saveXingyeRoleProfile(agent.id, { chatBackgroundDataUrl });
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
    } catch (error) {
      setSyncState('error');
      setSyncError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleExtractProfile = async () => {
    setExtractState('extracting');
    setExtractError(null);
    try {
      if (extractionLoreEntries.length === 0 && !pastedLore.trim()) {
        throw new Error('请先填写背景故事，或启用至少一条背景 / 世界观 / 关系 / 事件 / 人物设定。');
      }

      const response = await hanaFetch('/api/xingye/extract-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        timeout: 60_000,
        body: JSON.stringify({
          agentId: agent.id,
          displayName,
          relationshipLabel,
          shortBio,
          loreEntries: extractionLoreEntries,
          pastedLore,
        }),
      });
      const data = await response.json();
      if (data?.error) throw new Error(data.error);
      const extracted = data?.profile ?? {};

      if (typeof extracted.shortBio === 'string' && extracted.shortBio.trim()) setShortBio(extracted.shortBio.trim());
      if (typeof extracted.identitySummary === 'string') setIdentitySummary(extracted.identitySummary.trim());
      if (typeof extracted.backgroundSummary === 'string') setBackgroundSummary(extracted.backgroundSummary.trim());
      if (typeof extracted.personalitySummary === 'string') setPersonalitySummary(extracted.personalitySummary.trim());
      if (typeof extracted.behaviorLogic === 'string') setBehaviorLogic(extracted.behaviorLogic.trim());
      if (typeof extracted.values === 'string') setValues(extracted.values.trim());
      if (typeof extracted.taboos === 'string') setTaboos(extracted.taboos.trim());
      if (typeof extracted.relationshipMode === 'string') setRelationshipMode(extracted.relationshipMode.trim());
      if (typeof extracted.speakingStyle === 'string') setSpeakingStyle(extracted.speakingStyle.trim());
      setExtractState('done');
    } catch (error) {
      setExtractState('error');
      setExtractError(error instanceof Error ? error.message : String(error));
    }
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
            星野资料保存在本地资料层；默认同步只写入 OpenHanako identity / ishiki。可选将星野昵称写入原生助手名（config.agent.name），不写入 memory，也不改聊天生成链路。
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

      <RelationshipStatePanel
        agent={agent}
        profile={{
          ...resolvedProfile,
          relationshipLabel: relationshipLabel || resolvedProfile.relationshipLabel,
        }}
      />

      <section className={styles.detailSection} aria-label="角色设定分层">
        <h3 className={styles.detailSectionTitle}>角色设定分层</h3>
        <div className={styles.profileForm}>
          <div className={styles.extractBox}>
            {extractionLoreEntries.length === 0 && (
              <label className={styles.profileField}>
                <span>可粘贴背景故事</span>
                <textarea
                  value={pastedLore}
                  placeholder="没有启用的背景设定时，可以把完整背景故事粘贴在这里再提取。"
                  rows={5}
                  onChange={(event) => setPastedLore(event.target.value)}
                />
              </label>
            )}
            <div className={styles.extractActions}>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={handleExtractProfile}
                disabled={extractState === 'extracting'}
              >
                {extractState === 'extracting' ? '提取中...' : 'AI 提取设定'}
              </button>
              {extractState === 'done' && <span className={styles.saveStatus}>已填入表单，保存后才会生效</span>}
              {extractState === 'error' && <span className={styles.syncError}>提取失败: {extractError}</span>}
            </div>
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
        <LoreEditor agentId={agent.id} />
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

      <section className={styles.detailSection} aria-label="同步到 OpenHanako Agent 预览">
        <h3 className={styles.detailSectionTitle}>同步到 OpenHanako Agent 预览</h3>
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
        <button type="button" onClick={handleSave}>保存星野资料</button>
        <button type="button" onClick={handleSyncOpenHanakoAgent} disabled={syncState === 'syncing'}>
          {syncState === 'syncing' ? '同步中...' : '同步到 OpenHanako Agent'}
        </button>
        <button type="button" onClick={() => onChat(agent.id)}>进入聊天</button>
        <button type="button" onClick={onPhone}>TA 的手机</button>
        {savedAt && <span className={styles.saveStatus}>已保存 {new Date(savedAt).toLocaleString()}</span>}
        {profileSaveError && <span className={styles.syncError}>{profileSaveError}</span>}
        {syncState === 'synced' && <span className={styles.saveStatus}>已同步到 OpenHanako Agent</span>}
        {syncState === 'error' && <span className={styles.syncError}>同步失败: {syncError}</span>}
      </div>
    </div>
  );
}
