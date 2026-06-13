import type { ReactNode } from 'react';
import styles from './XingyeShell.module.css';

export type SecretSpaceCategoryId =
  | 'state'
  | 'draft_reply'
  | 'dream'
  | 'saved_item'
  | 'unsent_moment'
  | 'memory_fragment'
  | 'interview';

type ToneKey = 'state' | 'draft' | 'dream' | 'saved' | 'moment' | 'memory' | 'interview';

interface DrawerEntry {
  id: SecretSpaceCategoryId;
  label: string;
  /** monospace 副标，形如 "state · 此刻 / 心情" */
  hint: string;
  tone: ToneKey;
  /** 抽屉正面的"内容偷看" —— SVG 或迷你内容卡 */
  peek: ReactNode;
}

const TONE_CLASS_MAP: Record<ToneKey, string> = {
  state: 'secretSpaceHomeCard_state',
  draft: 'secretSpaceHomeCard_draft',
  dream: 'secretSpaceHomeCard_dream',
  saved: 'secretSpaceHomeCard_saved',
  moment: 'secretSpaceHomeCard_moment',
  memory: 'secretSpaceHomeCard_memory',
  interview: 'secretSpaceHomeCard_interview',
};

function StatePeek() {
  return (
    <div className={styles.secretSpaceHomePeek_state}>
      <svg viewBox="0 0 100 100" aria-hidden focusable="false">
        <path
          fill="#e58e8e"
          d="M50 82 C 24 62 12 46 12 32 C 12 22 20 16 30 16 C 40 16 47 22 50 32 C 53 22 60 16 70 16 C 80 16 88 22 88 32 C 88 46 76 62 50 82 Z"
        />
        <path
          fill="#fff"
          opacity="0.45"
          d="M30 26 C 26 30 26 36 28 40"
          stroke="none"
        />
      </svg>
      <div className={styles.secretSpaceHomePeekCaption_state}>「想着你」</div>
    </div>
  );
}

function DraftPeek() {
  return (
    <div className={styles.secretSpaceHomePeek_draft}>
      <span className={styles.secretSpaceHomePeekDraftLines}>
        <span>其实那天</span>
        <span>我也很想说……</span>
        <span className={styles.secretSpaceHomePeekFade}>（写到一半的话）</span>
      </span>
      <span aria-hidden className={styles.secretSpaceHomePeekCurl} />
      <span aria-hidden className={styles.secretSpaceHomePeekCurlShadow} />
    </div>
  );
}

function DreamPeek() {
  return (
    <div className={styles.secretSpaceHomePeek_dream}>
      <svg viewBox="0 0 100 130" preserveAspectRatio="xMidYMid meet" aria-hidden focusable="false">
        <defs>
          <radialGradient id="xingye-ink-a" cx="0.4" cy="0.45" r="0.55">
            <stop offset="0%" stopColor="#000" stopOpacity="0.78" />
            <stop offset="70%" stopColor="#000" stopOpacity="0.15" />
            <stop offset="100%" stopColor="#000" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="xingye-ink-b" cx="0.55" cy="0.55" r="0.5">
            <stop offset="0%" stopColor="#05070f" stopOpacity="0.9" />
            <stop offset="65%" stopColor="#05070f" stopOpacity="0.2" />
            <stop offset="100%" stopColor="#05070f" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="xingye-ink-c" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0%" stopColor="#000" stopOpacity="0.55" />
            <stop offset="100%" stopColor="#000" stopOpacity="0" />
          </radialGradient>
        </defs>
        <ellipse cx="34" cy="52" rx="30" ry="24" fill="url(#xingye-ink-a)" />
        <ellipse cx="66" cy="80" rx="24" ry="18" fill="url(#xingye-ink-b)" />
        <ellipse cx="80" cy="40" rx="14" ry="10" fill="url(#xingye-ink-c)" />
        <circle cx="78" cy="22" r="1.8" fill="#fff" opacity="0.85" />
        <circle cx="22" cy="18" r="1.3" fill="#fff" opacity="0.7" />
        <circle cx="62" cy="28" r="1.0" fill="#fff" opacity="0.7" />
        <circle cx="88" cy="54" r="1.0" fill="#fff" opacity="0.55" />
        <circle cx="14" cy="42" r="0.8" fill="#fff" opacity="0.55" />
        <circle cx="48" cy="14" r="0.8" fill="#fff" opacity="0.5" />
      </svg>
      <div className={styles.secretSpaceHomePeekCaption_dream}>梦</div>
    </div>
  );
}

function SavedPeek() {
  return (
    <div className={styles.secretSpaceHomePeek_saved}>
      <div aria-hidden className={styles.secretSpaceHomePeekWoodgrain} />
      <div className={styles.secretSpaceHomePeekCard}>
        <span>「世间的好物 不坚牢，</span>
        <span>彩云易散琉璃脆。」</span>
      </div>
      <div aria-hidden className={styles.secretSpaceHomePeekRibbon} />
    </div>
  );
}

function MomentPeek() {
  return (
    <div className={styles.secretSpaceHomePeek_moment}>
      <div className={styles.secretSpaceHomePeekPhoto}>
        <div className={styles.secretSpaceHomePeekPhotoShade} />
        <div className={styles.secretSpaceHomePeekPhotoCloud} />
        <div className={styles.secretSpaceHomePeekPhotoSun} />
      </div>
      <div className={styles.secretSpaceHomePeekMomentBody}>
        <span>今天天气很好。</span>
        <span className={styles.secretSpaceHomePeekFade}>（最终没发出去）</span>
      </div>
    </div>
  );
}

function MemoryPeek() {
  return (
    <div className={styles.secretSpaceHomePeek_memory}>
      <svg viewBox="0 0 100 130" preserveAspectRatio="xMidYMid meet" aria-hidden focusable="false">
        <g stroke="#8a6a52" strokeWidth="1.6" fill="none" opacity="0.9" strokeLinecap="round">
          <path d="M50 124 L 50 36" />
          <path d="M50 78 Q 38 76 28 64" />
          <path d="M50 78 Q 62 76 72 64" />
          <path d="M50 58 Q 40 54 32 46" />
          <path d="M50 58 Q 60 54 68 46" />
        </g>
        <g fill="#c6a489" opacity="0.95">
          <ellipse cx="26" cy="62" rx="6" ry="3.8" transform="rotate(-22 26 62)" />
          <ellipse cx="74" cy="62" rx="6" ry="3.8" transform="rotate(22 74 62)" />
          <ellipse cx="30" cy="44" rx="5" ry="3.2" transform="rotate(-18 30 44)" />
          <ellipse cx="70" cy="44" rx="5" ry="3.2" transform="rotate(18 70 44)" />
        </g>
        <g fill="#c97e98">
          <ellipse cx="50" cy="22" rx="7" ry="8.5" />
          <ellipse cx="40" cy="26" rx="6" ry="7" transform="rotate(-32 40 26)" />
          <ellipse cx="60" cy="26" rx="6" ry="7" transform="rotate(32 60 26)" />
          <ellipse cx="44" cy="16" rx="5.5" ry="6.5" transform="rotate(-15 44 16)" />
          <ellipse cx="56" cy="16" rx="5.5" ry="6.5" transform="rotate(15 56 16)" />
        </g>
        <circle cx="50" cy="24" r="2.4" fill="#a45a72" />
      </svg>
      <div className={styles.secretSpaceHomePeekStamp}>
        NO.07
        <br />
        2026.05
      </div>
    </div>
  );
}

function InterviewPeek() {
  /*
   * 「片头计数器」B 方案（film noir）：
   *   顶部行  - 左：INTERVIEW · TAKE 01 + 副 mono；右：REC pill 红灯
   *   中央    - 大数字「5」(opacity 0.18) + 十字 leader cross
   *   底部行  - REEL 07 · STUDIO · UNSEEN 三段 mono 元信息（mood 字眼，不是实数据）
   *
   * 抽屉外层 .secretSpaceHomeCard_interview 已经是暗色底，这里只填充 peek 槽。
   * 父组件 SecretSpaceHomeCard 仍在下方渲染 label（TA 的独家专访）+ hint，
   * peek 内不要再写 title，避免重复。
   */
  return (
    <div className={styles.secretSpaceHomePeek_interview}>
      <div className={styles.secretSpaceHomePeekInterviewTopRow}>
        <div className={styles.secretSpaceHomePeekInterviewKickers}>
          <span className={styles.secretSpaceHomePeekInterviewKicker}>INTERVIEW · TAKE 01</span>
          <span className={styles.secretSpaceHomePeekInterviewSubKicker}>5 Q · 弹幕 · 幕后</span>
        </div>
        <span className={styles.secretSpaceHomePeekInterviewRecPill} aria-hidden>
          <span className={styles.secretSpaceHomePeekInterviewRecDot} />
          REC
        </span>
      </div>

      <div className={styles.secretSpaceHomePeekInterviewCenter} aria-hidden>
        <div className={styles.secretSpaceHomePeekInterviewLeaderCross} />
        <div className={styles.secretSpaceHomePeekInterviewBigDigit}>5</div>
      </div>

      <div className={styles.secretSpaceHomePeekInterviewMetaLine}>
        <span>REEL 07</span>
        <span className={styles.secretSpaceHomePeekInterviewMetaSep}>·</span>
        <span>STUDIO</span>
        <span className={styles.secretSpaceHomePeekInterviewMetaSep}>·</span>
        <span className={styles.secretSpaceHomePeekInterviewMetaAccent}>UNSEEN</span>
      </div>
    </div>
  );
}

function ForumPeek() {
  /*
   * 论坛小号偷看：左上 # 版块 chip、右上未读私信红徽、居中两个交叠的讨论气泡
   * （浅色那只是「网友/帖子」，实心强调那只是「TA」），底部 mono「@匿名 · 马甲」。
   * 用 SVG 画气泡（无描边、靠填色区分，避免交叠处出现接缝），与其它入口卡同等精致。
   */
  return (
    <div className={styles.secretSpaceHomePeek_forum}>
      <span className={styles.secretSpaceHomePeekForumBoard}># 树洞</span>
      <span className={styles.secretSpaceHomePeekForumBadge}>3</span>
      <svg
        className={styles.secretSpaceHomePeekForumArt}
        viewBox="0 0 156 112"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden
        focusable="false"
      >
        {/* 后方：网友的帖子气泡（浅填充 + 尾巴 + 两条文字） */}
        <path d="M30 56 l-9 14 l22 -7 z" fill="rgba(91,110,225,0.16)" />
        <rect x="12" y="12" width="86" height="46" rx="13" fill="rgba(91,110,225,0.16)" />
        <rect x="26" y="26" width="56" height="5" rx="2.5" fill="rgba(91,110,225,0.42)" />
        <rect x="26" y="38" width="38" height="5" rx="2.5" fill="rgba(91,110,225,0.26)" />
        {/* 前方：TA 的发言气泡（实心强调 + 尾巴 + 两条白字） */}
        <path d="M128 92 l11 15 l-21 -6 z" fill="#5b66d6" />
        <rect x="66" y="50" width="78" height="46" rx="14" fill="#5b66d6" />
        <rect x="80" y="64" width="50" height="5.5" rx="2.75" fill="rgba(255,255,255,0.92)" />
        <rect x="80" y="76" width="32" height="5.5" rx="2.75" fill="rgba(255,255,255,0.6)" />
        {/* TA 的匿名头像，骑在自己气泡左上角 */}
        <circle cx="68" cy="50" r="10.5" fill="#eef1ff" />
        <circle cx="68" cy="50" r="8" fill="#8a93ea" />
      </svg>
      <span className={styles.secretSpaceHomePeekForumCaption}>@匿名 · 马甲</span>
    </div>
  );
}

const ENTRIES: DrawerEntry[] = [
  { id: 'state', label: 'TA 的状态', hint: 'state · 此刻 / 心情', tone: 'state', peek: <StatePeek /> },
  { id: 'draft_reply', label: 'TA 的草稿箱', hint: 'draft · 没说出口的话', tone: 'draft', peek: <DraftPeek /> },
  { id: 'dream', label: 'TA 的梦境', hint: 'dream · 不可解的片段', tone: 'dream', peek: <DreamPeek /> },
  { id: 'saved_item', label: 'TA 收藏的', hint: 'saved · 摘抄 / 片段', tone: 'saved', peek: <SavedPeek /> },
  { id: 'unsent_moment', label: '未发的朋友圈', hint: 'unsent · 草稿动态', tone: 'moment', peek: <MomentPeek /> },
  { id: 'memory_fragment', label: '私藏回忆', hint: 'memory · 碎片 / 标本', tone: 'memory', peek: <MemoryPeek /> },
  { id: 'interview', label: 'TA 的独家专访', hint: 'interview · 录制 / 弹幕 / 幕后', tone: 'interview', peek: <InterviewPeek /> },
];

interface SecretSpaceHomeProps {
  onSelectCategory: (id: SecretSpaceCategoryId) => void;
  /** 打开「TA 的论坛小号」mini-app（独立于普通分类抽屉，走 SecretSpacePanel 的 forum view）。 */
  onOpenForum: () => void;
}

export function SecretSpaceHome({ onSelectCategory, onOpenForum }: SecretSpaceHomeProps) {
  return (
    <div className={styles.secretSpaceHome} data-testid="secret-space-home">
      <div className={styles.secretSpaceHomeCabinetHeader}>
        <div className={styles.secretSpaceHomeCabinetKicker}>HER · SECRET CABINET</div>
        <h3 className={styles.secretSpaceHomeCabinetTitle}>TA 藏起来的那些东西</h3>
        <p className={styles.secretSpaceHomeCabinetSub}>
          —— 抽屉里藏着好几个角落，请轻轻一格一格打开。
        </p>
      </div>
      <div className={styles.secretSpaceHomeCabinetBody}>
        <div className={styles.secretSpaceHomeGrid}>
          {ENTRIES.map((e) => {
            const toneClass = styles[TONE_CLASS_MAP[e.tone]];
            const className = toneClass
              ? `${styles.secretSpaceHomeCard} ${toneClass}`
              : styles.secretSpaceHomeCard;
            return (
              <button
                key={e.id}
                type="button"
                className={className}
                data-testid={`secret-space-entry-${e.id}`}
                data-tone={e.tone}
                onClick={() => onSelectCategory(e.id)}
              >
                <span aria-hidden className={styles.secretSpaceHomeCardHandle} />
                <div className={styles.secretSpaceHomeCardPeek}>{e.peek}</div>
                <div className={styles.secretSpaceHomeCardFooter}>
                  <div className={styles.secretSpaceHomeCardTitle}>{e.label}</div>
                  <div className={styles.secretSpaceHomeCardHint}>{e.hint}</div>
                </div>
              </button>
            );
          })}
          <button
            type="button"
            className={`${styles.secretSpaceHomeCard} ${styles.secretSpaceHomeCard_forum}`}
            data-testid="secret-space-entry-forum"
            data-tone="forum"
            onClick={onOpenForum}
          >
            <span aria-hidden className={styles.secretSpaceHomeCardHandle} />
            <div className={styles.secretSpaceHomeCardPeek}>
              <ForumPeek />
            </div>
            <div className={styles.secretSpaceHomeCardFooter}>
              <div className={styles.secretSpaceHomeCardTitle}>TA 的论坛小号</div>
              <div className={styles.secretSpaceHomeCardHint}>forum · 帖子 / 评论 / 私信</div>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}
