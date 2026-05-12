import { useEffect, useState } from 'react';
import type { Agent } from '../types';
import { getXingyeRoleProfileDisplay, useXingyeRoleProfile } from './xingye-profile-store';
import { MemoryCandidatePanel } from './MemoryCandidatePanel';
import { RelationshipStatePanel } from './RelationshipStatePanel';
import {
  SecretSpaceCategoryView,
  type SecretSpaceCategoryMeta,
} from './SecretSpaceCategoryView';
import { SecretSpaceHome, type SecretSpaceCategoryId } from './SecretSpaceHome';
import type { SecretSpaceSampleRecord } from './secret-space-record-types';
import {
  createXingyeMemoryCandidate,
  importanceNumberFromLevel,
  XINGYE_MEMORY_CANDIDATE_IMPORTANCE_UI_OPTIONS,
  XINGYE_SECRET_SPACE_MANUAL_CANDIDATE_REASON_DEFAULT,
} from './xingye-memory-candidate-store';
import styles from './XingyeShell.module.css';

interface SecretSpacePanelProps {
  agent: Agent | null;
}

const CATEGORY_META: SecretSpaceCategoryMeta[] = [
  {
    id: 'state',
    title: 'TA 的状态',
    description: '与情绪、关系快照相关的视图；在「角色」页编辑资料与关系标签。',
    recordsEmptyTitle: '尚无额外的文字记录',
    recordsEmptyBody:
      '这里预留展示与「状态」相关的短笔记。当前上方为关系与标签面板；下方列表后续可接入工作区，仅 UI 占位。',
  },
  {
    id: 'draft_reply',
    title: 'TA 的草稿箱',
    description: '尚未发送的回复草稿（纯文本）。',
    recordsEmptyTitle: '草稿箱是空的',
    recordsEmptyBody: '还没有未发出的回复草稿。后续可从工作区读取 draft_reply 类记录。',
  },
  {
    id: 'dream',
    title: 'TA 的梦境',
    description: '象征化、片段化的梦记（纯文本）。',
    recordsEmptyTitle: '还没有梦境记录',
    recordsEmptyBody: '梦记只以文字呈现，不接图片或语音解梦。',
  },
  {
    id: 'saved_item',
    title: 'TA 收藏的东西',
    description: '仅展示收藏的文字摘录、事件摘要与对话片段（不含图片/音频/文件）。',
    recordsEmptyTitle: '收藏夹是空的',
    recordsEmptyBody: '此分类只表现纯文本收藏，不做相册式或附件式收藏 UI。',
  },
  {
    id: 'unsent_moment',
    title: 'TA 未发送的朋友圈',
    description: '未发送的朋友圈动态草稿，仅纯文字（无配图、无九宫格）。',
    recordsEmptyTitle: '没有未发送草稿',
    recordsEmptyBody: '朋友圈草稿在此仅以文字呈现；不展示图片排版或语音。',
  },
  {
    id: 'memory_fragment',
    title: '私藏回忆',
    description: '短回忆与碎片句；底部可手动写入「重要记忆候选」（沿用既有工作区逻辑）。',
    recordsEmptyTitle: '还没有回忆片段',
    recordsEmptyBody: '可记录一句场景、气味或对话残片。下方表单仍用于创建记忆候选（非本轮 mock 数据）。',
  },
];

/** UI 骨架用 mock，不从工作区读取 */
const SECRET_SPACE_UI_MOCK_RECORDS: Record<SecretSpaceCategoryId, SecretSpaceSampleRecord[]> = {
  state: [],
  draft_reply: [
    {
      key: 'dr1',
      title: '想发又删掉的回复',
      createdAt: '2026-02-08T09:12:00.000Z',
      updatedAt: '2026-02-09T11:40:00.000Z',
      summary: '想道谢却删掉的半句话，情绪偏克制。',
      body: '「谢谢你那天陪我走到车站。我其实…不太会说这些，但我想让你知道这对我挺重要的。」',
      meta: '草稿 · 未发送',
      source: '私信草稿箱',
      tags: ['未发送', '车站'],
      kind: 'draft_reply',
    },
    {
      key: 'dr2',
      title: '给工作群的一句客气话',
      createdAt: '2026-02-10T16:05:00.000Z',
      summary: '今晚先交结论、细节明天对齐的职场客气稿。',
      body: '「我这边今晚可以把一版结论先贴出来，细节我们明天对齐。」',
      meta: '草稿 · 待发送',
      kind: 'draft_reply',
    },
  ],
  dream: [
    {
      key: 'dm1',
      title: '电梯里一直在下雨',
      createdAt: '2026-02-11T07:30:00.000Z',
      summary: '积水月台、无骨伞与沉默的短梦，偏象征。',
      body: [
        '电梯门打开不是楼层，而是一小片积水的月台。有人递给我一把没伞骨的伞，说「拿着，别出声」。',
        '',
        '我照做了。雨声被金属厢壁折成很细很细的线，像有人用指甲在刮同一处漆。楼层数字在闪，却永远停在一个我不认识的两位数。',
        '',
        '后来门又关上了。镜子里的我衣领湿了一圈，但鞋面是干的。我想开口问「这是哪」，却发现声音落在地上变成了硬币，滚进缝隙里不见了。',
        '',
        '醒来时窗外真的在下雨。我盯着天花板很久，才确认手里没有伞，也没有人在旁边提醒我别出声。',
      ].join('\n'),
      meta: '昨夜 · 象征片段',
      kind: 'dream',
    },
  ],
  saved_item: [
    {
      key: 'sv1',
      title: '收藏：一句台词',
      createdAt: '2026-01-20T12:00:00.000Z',
      summary: '把今天交给明天的自己，一句短台词收藏。',
      body: '「今天先到这里，剩下的交给明天的自己。」',
      meta: '文字摘录',
      kind: 'saved_item',
    },
    {
      key: 'sv2',
      title: '收藏：小事记',
      createdAt: '2026-01-22T08:45:00.000Z',
      summary: '雨天便利店门口多等五分钟的小事备忘。',
      body: '周三下雨，TA 在便利店门口多等了我五分钟。',
      meta: '事件摘要',
      kind: 'saved_item',
    },
    {
      key: 'sv3',
      title: '收藏：对话片段',
      createdAt: '2026-02-01T21:15:00.000Z',
      summary: '关于逞强与把软弱藏起来的两句对话摘录。',
      body: '对方：你真的不用逞强。\nTA：我只是…还不太习惯把软弱放在别人看得见的地方。',
      meta: '对话片段（纯文本）',
      kind: 'saved_item',
    },
  ],
  unsent_moment: [
    {
      key: 'um1',
      title: '朋友圈草稿',
      createdAt: '2026-02-07T19:50:00.000Z',
      summary: '坏路灯与等车回忆，未发的一条纯文字草稿。',
      body:
        '本来以为只是普通的一天，结果晚上路过那盏坏掉的路灯，突然想起很久以前也有人陪我等过车。',
      meta: '纯文字 · 未配图',
      kind: 'unsent_moment',
    },
  ],
  memory_fragment: [
    {
      key: 'mf1',
      title: '碎片：气味',
      createdAt: '2026-02-05T13:20:00.000Z',
      summary: '洗衣粉与雨水叠在一起时，人会莫名安静下来的感觉。',
      body: [
        '洗衣粉和雨的味道叠在一起，会让人莫名其妙平静下来。',
        '',
        '那并不是某种「好闻」的评判，更像一种身体先认出来的秩序：潮湿把灰尘压住，清洁剂把尖锐的气味磨圆。你甚至不必真的去回忆某件事，神经就已经把肩膀放低了一点。',
        '',
        '我想起小时候晾衣绳上的床单，雨来之前母亲会匆匆收起，衣夹碰撞出很轻的金属声。那时我觉得世界很大，雨很远；后来才发现，很多安全感都来自这种琐碎、重复、几乎不会被写进故事里的动作。',
        '',
        '现在我在城市里闻不到同样的洗衣粉牌子，但偶尔在楼道或洗衣房遇到相近的气味，仍会停半秒。不是悲伤，也不是快乐，更像一种确认：我还记得怎样呼吸。',
      ].join('\n'),
      meta: '私藏回忆',
      kind: 'memory_fragment',
    },
  ],
};

function metaById(id: SecretSpaceCategoryId): SecretSpaceCategoryMeta {
  const found = CATEGORY_META.find((m) => m.id === id);
  if (!found) {
    throw new Error(`Unknown secret space category: ${id}`);
  }
  return found;
}

export function SecretSpacePanel({ agent }: SecretSpacePanelProps) {
  const profile = useXingyeRoleProfile(agent?.id);
  const [view, setView] = useState<'home' | 'category'>('home');
  const [activeCategory, setActiveCategory] = useState<SecretSpaceCategoryId | null>(null);
  const [samplesByCategory] = useState<Record<SecretSpaceCategoryId, SecretSpaceSampleRecord[]>>(
    () => ({ ...SECRET_SPACE_UI_MOCK_RECORDS }),
  );

  const [manualContent, setManualContent] = useState('');
  const [manualReason, setManualReason] = useState(XINGYE_SECRET_SPACE_MANUAL_CANDIDATE_REASON_DEFAULT);
  const [manualLevel, setManualLevel] = useState<'low' | 'medium' | 'high'>('medium');
  const [manualError, setManualError] = useState<string | null>(null);

  useEffect(() => {
    if (!agent?.id) {
      setManualContent('');
      setManualReason(XINGYE_SECRET_SPACE_MANUAL_CANDIDATE_REASON_DEFAULT);
      setManualLevel('medium');
      setManualError(null);
      setView('home');
      setActiveCategory(null);
    }
  }, [agent?.id]);

  const handleCreateManualCandidate = () => {
    if (!agent?.id) return;
    setManualError(null);
    const content = manualContent.trim();
    if (!content) {
      setManualError('请填写候选记忆内容。');
      return;
    }
    try {
      createXingyeMemoryCandidate(agent.id, {
        content,
        reason: manualReason.trim() || XINGYE_SECRET_SPACE_MANUAL_CANDIDATE_REASON_DEFAULT,
        importance: importanceNumberFromLevel(manualLevel),
        sourceDomain: 'secret_space',
        sourceId: 'manual-secret-space',
        target: 'pinned',
      });
      setManualContent('');
      setManualReason(XINGYE_SECRET_SPACE_MANUAL_CANDIDATE_REASON_DEFAULT);
      setManualLevel('medium');
    } catch (e) {
      setManualError(e instanceof Error ? e.message : String(e));
    }
  };

  const displayProfile = agent ? getXingyeRoleProfileDisplay(agent, profile) : null;

  const memoryFragmentFooter =
    agent?.id ? (
      <div className={styles.profileForm} data-testid="secret-space-manual-candidate">
        <p className={styles.secretSpacePlaceholder} style={{ marginTop: 0 }}>
          手动保存为「重要记忆候选」（仅工作区与列表；确认后写入 OpenHanako <code className={styles.inlineCode}>pinned.md</code>）。
        </p>
        <label className={styles.profileField}>
          <span>候选记忆内容</span>
          <textarea
            value={manualContent}
            onChange={(e) => setManualContent(e.target.value)}
            rows={3}
            placeholder="输入一条你希望记住的要点…"
            aria-label="候选记忆内容"
          />
        </label>
        <label className={styles.profileField}>
          <span>重要度</span>
          <select
            value={manualLevel}
            onChange={(e) => setManualLevel(e.target.value as 'low' | 'medium' | 'high')}
            aria-label="候选记忆重要度"
          >
            {XINGYE_MEMORY_CANDIDATE_IMPORTANCE_UI_OPTIONS.map((opt) => (
              <option key={opt.level} value={opt.level}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.profileField}>
          <span>理由</span>
          <textarea
            value={manualReason}
            onChange={(e) => setManualReason(e.target.value)}
            rows={2}
            aria-label="候选记忆理由"
          />
        </label>
        {manualError ? <p className={styles.saveStatus}>{manualError}</p> : null}
        <button type="button" className={styles.secondaryButton} onClick={handleCreateManualCandidate}>
          创建候选记忆
        </button>
        <MemoryCandidatePanel agentId={agent.id} />
      </div>
    ) : null;

  if (!agent) {
    return (
      <div className={styles.panelInner}>
        <h2 className={styles.panelTitle}>秘密空间</h2>
        <p className={styles.panelDescription}>
          请在「角色」页选择一个角色后，再查看 TA 的状态与秘密空间占位内容。
        </p>
      </div>
    );
  }

  const openCategory = (id: SecretSpaceCategoryId) => {
    setActiveCategory(id);
    setView('category');
  };

  const goHome = () => {
    setView('home');
    setActiveCategory(null);
  };

  const activeMeta = activeCategory ? metaById(activeCategory) : null;
  const activeSamples = activeCategory ? samplesByCategory[activeCategory] : [];

  const stateSection =
    activeCategory === 'state' && displayProfile ? (
      <div data-testid="secret-space-relationship-panel">
        <RelationshipStatePanel agent={agent} profile={displayProfile} />
      </div>
    ) : null;

  const categoryFooter =
    activeCategory === 'memory_fragment' ? memoryFragmentFooter : null;

  return (
    <div className={styles.panelInner}>
      <h2 className={styles.panelTitle}>秘密空间</h2>
      <p className={styles.panelDescription}>
        角色侧隐藏内容的导航骨架：按分类进入占位视图（本轮不接工作区列表、不经 OpenHanako 聊天管线）。
      </p>

      {view === 'home' ? (
        <SecretSpaceHome onSelectCategory={openCategory} />
      ) : activeMeta ? (
        <SecretSpaceCategoryView
          meta={activeMeta}
          onBack={goHome}
          stateSection={stateSection}
          records={activeSamples}
          footer={categoryFooter}
        />
      ) : null}
    </div>
  );
}
