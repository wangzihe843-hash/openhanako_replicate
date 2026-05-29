import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useConfig } from '../hooks/use-config';
import { useStore } from '../stores';
import {
  createLoreEntry,
  deleteLoreEntry,
  toggleLoreEntry,
  updateLoreEntry,
  useXingyeLoreEntries,
  XINGYE_LORE_CATEGORIES,
  XINGYE_LORE_CATEGORY_LABELS,
  type XingyeLoreCategory,
  type XingyeLoreEntry,
  type XingyeLoreInsertionMode,
  type XingyeLoreVisibility,
} from './xingye-lore-store';
import { buildXingyeRelationshipLoreTemplateContent } from './xingye-lore-relationship-template';
import { buildXingyePeerAgentLoreTemplateContent } from './xingye-lore-peer-agent-template';
import {
  createXingyeMemoryCandidate,
  importanceNumberFromLevel,
} from './xingye-memory-candidate-store';
import { resolveXingyeLoreTemplateUserNameSync } from './xingye-speaker-context';
import { LoreEntryCard } from './LoreEntryCard';
import styles from './XingyeShell.module.css';

const LORE_CANDIDATE_REASON = '用户从设定库保存为候选重要记忆';
const LORE_CANDIDATE_FLASH_OK = '已加入候选重要记忆，请到记忆候选中确认写入';

function buildLoreCandidateContent(entry: XingyeLoreEntry): string {
  return `【设定】${entry.title}\n${entry.content}`;
}

interface LoreEditorProps {
  agentId: string;
  /** OpenHanako 当前 agent 名称；用于关系模板占位，缺省为「当前角色」。 */
  agentName?: string | null;
}

const CATEGORY_OPTIONS: Array<{ value: XingyeLoreCategory; label: string }> = XINGYE_LORE_CATEGORIES.map(
  (value) => ({ value, label: XINGYE_LORE_CATEGORY_LABELS[value] }),
);

const INSERTION_OPTIONS: Array<{ value: XingyeLoreInsertionMode; label: string }> = [
  { value: 'manual', label: '手动（不自动注入）' },
  { value: 'keyword', label: '关键词（命中后整段正文）' },
  { value: 'always', label: '始终（默认可引用，宜短）' },
];

const VISIBILITY_OPTIONS: Array<{ value: XingyeLoreVisibility; label: string }> = [
  { value: 'canonical', label: '正式设定' },
  { value: 'private', label: '私有备注' },
  { value: 'draft', label: '草稿' },
];

type LoreDraft = {
  title: string;
  content: string;
  category: XingyeLoreCategory;
  keywords: string;
  priority: number;
  insertionMode: XingyeLoreInsertionMode;
  visibility: XingyeLoreVisibility;
};

function createEmptyDraft(): LoreDraft {
  return {
    title: '',
    content: '',
    category: 'background',
    keywords: '',
    priority: 50,
    insertionMode: 'manual',
    visibility: 'canonical',
  };
}

function entryToDraft(entry: XingyeLoreEntry): LoreDraft {
  return {
    title: entry.title,
    content: entry.content,
    category: entry.category,
    keywords: entry.keywords.join(', '),
    priority: entry.priority,
    insertionMode: entry.insertionMode,
    visibility: entry.visibility,
  };
}

function normalizeAgentNameForTemplate(value: string | null | undefined): string {
  const text = value?.trim();
  return text || '当前角色';
}

export function LoreEditor({ agentId, agentName }: LoreEditorProps) {
  const entries = useXingyeLoreEntries(agentId);
  const { config } = useConfig();
  const storeUserName = useStore((s) => s.userName);
  const allAgents = useStore((s) => s.agents);
  const userNameForTemplate = useMemo(
    () => resolveXingyeLoreTemplateUserNameSync(config, storeUserName),
    [config, storeUserName],
  );
  const agentNameForTemplate = useMemo(() => normalizeAgentNameForTemplate(agentName), [agentName]);
  // 可被本 agent 描述的其他 agent（排除自己）。供「其他 agent 关系模板」下拉选具体对象。
  const peerAgents = useMemo(
    () => allAgents.filter((a) => a && a.id && a.id !== agentId),
    [allAgents, agentId],
  );
  // '' = 不指定具体 agent（通用占位「对方」）。
  const [selectedPeerId, setSelectedPeerId] = useState<string>('');

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<LoreDraft>(() => createEmptyDraft());
  const [flash, setFlash] = useState<string | null>(null);
  const [savingCandidateId, setSavingCandidateId] = useState<string | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setEditingId(null);
    setDraft(createEmptyDraft());
    setFlash(null);
    setSelectedPeerId('');
  }, [agentId]);

  /** 选中的 peer 从列表消失（被删 / 切换）时回退到「不指定」，避免烤进失效 id。 */
  useEffect(() => {
    if (selectedPeerId && !peerAgents.some((p) => p.id === selectedPeerId)) {
      setSelectedPeerId('');
    }
  }, [peerAgents, selectedPeerId]);

  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  /** editingId 切换时从 store 拉取该条真实字段，避免未保存草稿残留在上一表单引用上。 */
  useLayoutEffect(() => {
    if (editingId == null) return;
    const entry = entriesRef.current.find((e) => e.id === editingId);
    if (!entry) {
      setEditingId(null);
      setDraft(createEmptyDraft());
      return;
    }
    setDraft(entryToDraft(entry));
  }, [editingId]);

  /** 正在编辑的条目被删除时退出编辑态。 */
  useEffect(() => {
    if (editingId == null) return;
    if (!entries.some((e) => e.id === editingId)) {
      setEditingId(null);
      setDraft(createEmptyDraft());
    }
  }, [editingId, entries]);

  useEffect(() => {
    return () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    };
  }, []);

  const showFlash = useCallback((msg: string) => {
    setFlash(msg);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    if (typeof window === 'undefined') return;
    flashTimerRef.current = setTimeout(() => setFlash(null), 5000);
  }, []);

  const handleSaveAsCandidate = useCallback(
    (entry: XingyeLoreEntry) => {
      if (!agentId) return;
      setSavingCandidateId(entry.id);
      try {
        createXingyeMemoryCandidate(agentId, {
          content: buildLoreCandidateContent(entry),
          sourceDomain: 'lore',
          sourceId: entry.id,
          reason: LORE_CANDIDATE_REASON,
          importance: importanceNumberFromLevel('medium'),
          target: 'pinned',
        });
        showFlash(LORE_CANDIDATE_FLASH_OK);
      } catch (error) {
        showFlash(error instanceof Error ? error.message : String(error));
      } finally {
        setSavingCandidateId(null);
      }
    },
    [agentId, showFlash],
  );

  const editingEntry = useMemo(
    () => entries.find((entry) => entry.id === editingId) ?? null,
    [editingId, entries],
  );

  const relationshipTemplateBody = useMemo(
    () =>
      buildXingyeRelationshipLoreTemplateContent({
        userName: userNameForTemplate,
        agentName: agentNameForTemplate,
      }),
    [userNameForTemplate, agentNameForTemplate],
  );

  const applyRelationshipTemplateDefaults = useCallback(
    (base: LoreDraft): LoreDraft => {
      const title = base.title.trim()
        ? base.title
        : `用户身份与关系（${agentNameForTemplate}）`;
      return {
        ...base,
        category: 'relationship',
        content: relationshipTemplateBody,
        insertionMode: 'always',
        visibility: 'canonical',
        title,
      };
    },
    [agentNameForTemplate, relationshipTemplateBody],
  );

  const resetDraft = () => {
    setEditingId(null);
    setDraft(createEmptyDraft());
  };

  /** 仅切换 editingId；正文等由 useLayoutEffect 从 store 注入，避免未保存草稿残留在切换后的表单。 */
  const startEdit = useCallback((entry: XingyeLoreEntry) => {
    setEditingId(entry.id);
  }, []);

  /** 仅在此按钮点击时写入模板正文；选「关系」分类或清空正文不会自动填充。 */
  const handleInsertRelationshipTemplate = useCallback(() => {
    setDraft((current) => {
      if (current.category !== 'relationship') return current;
      const block = buildXingyeRelationshipLoreTemplateContent({
        userName: userNameForTemplate,
        agentName: agentNameForTemplate,
      });
      if (!current.content.trim()) {
        return applyRelationshipTemplateDefaults({ ...current, content: '', category: 'relationship' });
      }
      const message =
        '将在正文末尾追加一段关系设定模板（不删除已有文字）。第三方 NPC 与称呼边界等说明会一并追加。\n\n确定继续？';
      if (typeof window !== 'undefined' && !window.confirm(message)) return current;
      const head = current.content.trimEnd();
      return { ...current, content: `${head}\n\n${block}` };
    });
  }, [agentNameForTemplate, applyRelationshipTemplateDefaults, userNameForTemplate]);

  /** 插入「其他 agent 关系」模板：与用户关系模板平行，描述当前 agent ↔ 另一个 AI agent。
   *  下拉选中具体 peer → 把对方名字 + id 烤进模板；未选 → 通用占位「对方」由作者手填。 */
  const handleInsertPeerAgentTemplate = useCallback(() => {
    const peer = peerAgents.find((p) => p.id === selectedPeerId) ?? null;
    setDraft((current) => {
      if (current.category !== 'relationship') return current;
      const block = buildXingyePeerAgentLoreTemplateContent({
        userName: userNameForTemplate,
        agentName: agentNameForTemplate,
        peerName: peer?.name,
        peerId: peer?.id,
      });
      if (!current.content.trim()) {
        const defaultTitle = peer
          ? `与 ${peer.name} 的关系（${agentNameForTemplate}）`
          : `其他 agent 关系（${agentNameForTemplate}）`;
        const title = current.title.trim() ? current.title : defaultTitle;
        return {
          ...current,
          category: 'relationship',
          content: block,
          insertionMode: 'always',
          visibility: 'canonical',
          title,
        };
      }
      const message =
        '将在正文末尾追加一段「其他 agent 关系」模板（不删除已有文字）。实体区分与称呼边界等说明会一并追加。\n\n确定继续？';
      if (typeof window !== 'undefined' && !window.confirm(message)) return current;
      const head = current.content.trimEnd();
      return { ...current, content: `${head}\n\n${block}` };
    });
  }, [agentNameForTemplate, peerAgents, selectedPeerId, userNameForTemplate]);

  const saveDraft = () => {
    const keywords = Array.from(
      new Set(draft.keywords.split(/[,\n，、]/).map((s) => s.trim()).filter(Boolean)),
    );
    const input = {
      title: draft.title,
      content: draft.content,
      category: draft.category,
      keywords,
      priority: draft.priority,
      insertionMode: draft.insertionMode,
      visibility: draft.visibility,
    };
    if (editingEntry) {
      updateLoreEntry(editingEntry.id, input);
    } else {
      createLoreEntry(agentId, input);
    }
    resetDraft();
  };

  return (
    <div className={styles.loreEditor}>
      <div className={styles.loreEditorHeader}>
        <div>
          <h3 className={styles.detailSectionTitle}>背景故事 / 设定库</h3>
          <div className={styles.loreHintStack}>
            <p className={styles.loreHint}>
              完整背景、世界观、事件、地点和组织保存在星野设定库。每一条设定<strong>条目</strong>是自动注入时的<strong>最小单位</strong>：被选中后，该条目的正文会<strong>整块</strong>交给模型，不会只抽取其中某一句、某一行或某个列表项。设定库条目仅保存在 workspace，不会自动写入 OpenHanako identity / ishiki。
            </p>
            <p className={styles.loreHint}>
              <strong>关键词</strong>模式：任一关键词命中时，会注入该条目的<strong>全部</strong>「条目正文」字段内容，而不是仅匹配到的那一句、那一段或某个要点。
            </p>
            <p className={styles.loreHint}>
              <strong>始终</strong>模式：在「小手机」「秘密空间」等生成任务中，会<strong>默认引用</strong>已启用且设为「始终」的条目。请勿把过长的全文世界观「圣经」塞进「始终」；长文请拆成多条或改用关键词按需注入。
            </p>
            <p className={styles.loreHint}>
              建议按主题拆条，例如：<strong>身份核心</strong>、<strong>关系核心</strong>、<strong>地点</strong>、<strong>组织</strong>、<strong>事件</strong>、<strong>规则</strong>，各写成一条或一组短条目，便于按需命中与阅读。
            </p>
          </div>
        </div>
        {editingEntry && <button type="button" onClick={resetDraft}>取消编辑</button>}
      </div>

      <div className={styles.loreForm} key={editingId ?? '__create__'}>
        <label className={styles.profileField}>
          <span>标题</span>
          <input
            type="text"
            value={draft.title}
            placeholder="例如：灯塔誓约（单条围绕一个主题更易维护）"
            onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
          />
        </label>
        <label className={styles.profileField}>
          <span title="关键词命中或条目被选中时，本框全文会整块注入，不会只摘匹配片段。">条目正文（命中后整段注入）</span>
          <textarea
            value={draft.content}
            placeholder="写入本条目的全部正文。需要拆分时，可把身份核心、关系核心、地点、组织、事件、规则等分到不同条目。"
            rows={5}
            title="任一关键词命中时，会注入本框中的全部内容，而非仅含关键词的那一句。"
            onChange={(event) => setDraft((current) => ({ ...current, content: event.target.value }))}
          />
        </label>
        <div className={styles.loreMetaGrid}>
          <label className={styles.profileField}>
            <span>分类</span>
            <select
              value={draft.category}
              onChange={(event) => setDraft((current) => ({
                ...current,
                category: event.target.value as XingyeLoreCategory,
              }))}
            >
              {CATEGORY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label className={styles.profileField}>
            <span title="「始终」会在小手机、秘密空间等任务中默认引用；「关键词」命中后注入整条目正文；「手动」不自动注入。">插入模式</span>
            <select
              value={draft.insertionMode}
              title="始终：默认可引用，条目宜短。关键词：命中后注入该条目全部正文。手动：不自动注入。"
              onChange={(event) => setDraft((current) => ({ ...current, insertionMode: event.target.value as XingyeLoreInsertionMode }))}
            >
              {INSERTION_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label className={styles.profileField}>
            <span>可见性</span>
            <select
              value={draft.visibility}
              onChange={(event) => setDraft((current) => ({ ...current, visibility: event.target.value as XingyeLoreVisibility }))}
            >
              {VISIBILITY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label className={styles.profileField}>
            <span>优先级</span>
            <input
              type="number"
              min={0}
              max={100}
              value={draft.priority}
              onChange={(event) => setDraft((current) => ({ ...current, priority: Number(event.target.value) }))}
            />
          </label>
        </div>
        <label className={styles.profileField}>
          <span title="仅在「关键词」模式下用于匹配；任一命中即注入本条目的全部「条目正文」，不是只摘命中句。">关键词</span>
          <input
            type="text"
            value={draft.keywords}
            placeholder="逗号或顿号分隔，例如：王国、灯塔、誓约（命中后整段正文都会注入）"
            title="任一关键词命中时，注入本条目的全部正文。"
            onChange={(event) => setDraft((current) => ({ ...current, keywords: event.target.value }))}
          />
        </label>
        {draft.category === 'relationship' ? (
          <div className={styles.loreHintStack} data-testid="lore-relationship-template-panel">
            <p className={styles.loreHint}>
              关系类条目仅作用于当前 agent 的设定库与注入链路，<strong>不会</strong>写入 OpenHanako 全局用户配置；模板中的「{userNameForTemplate}」来自当前 OpenHanako 用户显示名（config / 会话侧），「{agentNameForTemplate}」为当前角色名。仅在下方按钮写入模板正文，不会仅因切换分类而自动填充。
            </p>
            <p className={styles.loreHint}>
              <strong>用户身份/关系</strong>模板描述本角色与<strong>用户</strong>的关系；<strong>其他 agent 关系</strong>模板描述本角色与<strong>另一个 AI agent</strong>的关系（建议每个其他 agent 各写一条），便于本角色定位自己和其他 agent 的关系、避免把对方误当成用户。
            </p>
            {peerAgents.length > 0 ? (
              <label className={styles.profileField} data-testid="lore-peer-agent-picker">
                <span title="选中后，其他 agent 关系模板会自动填入该 agent 的名字与 id；不选则用通用占位「对方」由你手填。">其他 agent（关系模板对象）</span>
                <select
                  aria-label="其他 agent"
                  value={selectedPeerId}
                  onChange={(event) => setSelectedPeerId(event.target.value)}
                >
                  <option value="">（不指定，使用通用占位「对方」）</option>
                  {peerAgents.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name && p.name !== p.id ? `${p.name}（${p.id}）` : p.id}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <div className={styles.loreTemplateButtons}>
              <button type="button" data-testid="lore-relationship-insert-template" onClick={handleInsertRelationshipTemplate}>
                插入用户身份/关系模板…
              </button>
              <button type="button" data-testid="lore-peer-agent-insert-template" onClick={handleInsertPeerAgentTemplate}>
                插入其他 agent 关系模板…
              </button>
            </div>
          </div>
        ) : null}
        <button type="button" className={styles.primaryAction} onClick={saveDraft}>
          {editingEntry ? '保存设定条目' : '新增设定条目'}
        </button>
      </div>

      {flash ? (
        <p className={styles.saveStatus} role="status" data-testid="lore-editor-flash">
          {flash}
        </p>
      ) : null}

      <div className={styles.loreList}>
        {entries.length === 0 ? (
          <p className={styles.loreEmpty}>还没有设定条目。</p>
        ) : (
          entries.map((entry) => (
            <LoreEntryCard
              key={entry.id}
              entry={entry}
              onEdit={startEdit}
              onToggle={(id) => toggleLoreEntry(id)}
              onDelete={(id) => deleteLoreEntry(id)}
              onSaveAsCandidate={handleSaveAsCandidate}
              saveAsCandidateDisabled={savingCandidateId === entry.id}
            />
          ))
        )}
      </div>
    </div>
  );
}
